package pl.zira.tvads

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import pl.zira.tvads.discovery.NsdAdvertiser
import pl.zira.tvads.discovery.NsdDiscovery
import pl.zira.tvads.discovery.SubnetScanner
import pl.zira.tvads.net.AdApiClient
import pl.zira.tvads.player.PlaybackPlan
import pl.zira.tvads.player.PlaybackItem
import pl.zira.tvads.player.RepeatMode
import pl.zira.tvads.prefs.HostStore
import pl.zira.tvads.updater.TvAppUpdater
import java.io.Closeable
import java.io.File
import java.net.URL

class MainActivity : Activity() {
    companion object {
        private const val REQ_NEARBY_WIFI = 4101
        private const val IMAGE_CONNECT_TIMEOUT_MS = 8000
        private const val IMAGE_READ_TIMEOUT_MS = 15000
        private const val TARGET_IMAGE_WIDTH = 1920
        private const val TARGET_IMAGE_HEIGHT = 1080
    }

    private lateinit var playerView: PlayerView
    private lateinit var imageView: ImageView
    private lateinit var overlay: LinearLayout
    private lateinit var statusText: TextView
    private var player: ExoPlayer? = null
    private lateinit var hostStore: HostStore
    private var discovery: NsdDiscovery? = null
    private var advertiser: NsdAdvertiser? = null
    private var sse: Closeable? = null
    private val scope = CoroutineScope(Dispatchers.Main + Job())
    private var base: String? = null
    private var currentVersion: String? = null
    private var loadJob: kotlinx.coroutines.Job? = null
    private var playerRetryJob: kotlinx.coroutines.Job? = null
    private var imageJob: kotlinx.coroutines.Job? = null
    private var activePlan: PlaybackPlan? = null
    private var activeIndex = 0
    private var updateJob: kotlinx.coroutines.Job? = null
    private var updateInProgress = false
    private var pendingUpdateApk: File? = null
    private var lastUpdateCheckAt = 0L
    private var consecutiveLoadFailures = 0
    private var subnetScanning = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)
        playerView = findViewById(R.id.playerView)
        imageView = findViewById(R.id.imageView)
        overlay = findViewById(R.id.overlay)
        statusText = findViewById(R.id.statusText)
        findViewById<Button>(R.id.enterIpBtn).setOnClickListener {
            startActivity(android.content.Intent(this, PairingActivity::class.java))
        }
        findViewById<Button>(R.id.rescanBtn).setOnClickListener {
            // Rescan = restart mDNS discovery AND sweep the /24 — the sweep is
            // what actually finds the POS when the router blocks multicast.
            showOverlay("Đang quét lại (mDNS + dải mạng)...")
            connect()
            runSubnetScan(manual = true)
        }
        hostStore = HostStore(this)
        advertiser = NsdAdvertiser(this)
        player = ExoPlayer.Builder(this).build().also { playerView.player = it }
        player?.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) hideOverlay()
                if (state == Player.STATE_ENDED) playNext()
            }
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                // Real retry: a transient network blip must not strand the
                // screen on an error overlay forever (SSE may still be alive,
                // so nothing else would ever wake the player up again).
                showOverlay("Lỗi phát quảng cáo: " + (error.message ?: "") + " — tự thử lại sau 5s")
                playerRetryJob?.cancel()
                playerRetryJob = scope.launch {
                    delay(5000)
                    if (isActive) activePlan?.let { playCurrent(it) } ?: loadAndPlay()
                }
            }
        })
        ensureWifiDiscoveryPermissionThenConnect()
    }

    private fun ensureWifiDiscoveryPermissionThenConnect() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED
        ) {
            showOverlay("Cho phép Nearby devices để TV tự tìm POS qua WiFi...")
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES), REQ_NEARBY_WIFI)
            return
        }
        connect()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_NEARBY_WIFI) {
            connect()
        }
    }

    private fun showOverlay(msg: String) {
        statusText.text = msg
        overlay.visibility = View.VISIBLE
    }

    private fun hideOverlay() {
        overlay.visibility = View.GONE
    }

    private fun connect() {
        base = hostStore.lastBase
        if (base != null) {
            showOverlay("Đang kết nối " + base + " ...")
            loadAndPlay()
        } else {
            showOverlay("Đang tìm POS trên mạng WiFi...")
        }
        discovery?.close()
        discovery = NsdDiscovery(this).apply {
            start { found ->
                runOnUiThread {
                    if (base != found) {
                        base = found
                        hostStore.lastBase = found
                        loadAndPlay()
                    }
                }
            }
        }
        if (base == null) {
            scope.launch {
                delay(8000)
                if (base == null && !subnetScanning) {
                    startActivity(android.content.Intent(this@MainActivity, PairingActivity::class.java))
                }
            }
        }
    }

    private fun loadAndPlay() {
        val b = base ?: return
        loadJob?.cancel()
        loadJob = scope.launch {
            try {
                val playlist = withContext(Dispatchers.IO) { AdApiClient(b).fetchPlaylist() }
                consecutiveLoadFailures = 0
                currentVersion = playlist.version
                advertiser?.start(b)
                applyPlan(PlaybackPlan.from(playlist, b))
                openEvents(b)
                maybeCheckForUpdate(b, force = false)
            } catch (e: Exception) {
                consecutiveLoadFailures++
                showOverlay("Không kết nối được " + b + " — thử lại sau 5s (lần " + consecutiveLoadFailures + ")")
                // The POS may have moved to a new DHCP address while mDNS is
                // blocked by the router — after 3 straight failures, sweep the
                // subnet ourselves instead of hammering a dead IP forever.
                if (consecutiveLoadFailures >= 3) runSubnetScan(manual = false)
                delay(5000)
                if (isActive && base == b) loadAndPlay()
            }
        }
    }

    /** Sweep local /24 subnets for the POS ad server. Adopts the first hit
     *  that differs from the current base. Safe to call repeatedly. */
    private fun runSubnetScan(manual: Boolean) {
        if (subnetScanning) return
        subnetScanning = true
        scope.launch {
            try {
                val found = withContext(Dispatchers.IO) {
                    SubnetScanner.scan { done, total ->
                        if (done % 25 == 0 || done == total) {
                            runOnUiThread { statusText.text = "Đang quét mạng tìm POS... $done/$total" }
                        }
                    }
                }
                val target = found.firstOrNull()
                when {
                    target != null && target != base -> {
                        statusText.text = "Tìm thấy POS: " + target.removePrefix("http://")
                        base = target
                        hostStore.lastBase = target
                        consecutiveLoadFailures = 0
                        loadAndPlay()
                    }
                    target == null && manual ->
                        statusText.text = "Không tìm thấy POS trong mạng (cổng ${SubnetScanner.DEFAULT_PORT})"
                    // target == current base: host answers the sweep but the app
                    // path is failing — keep the normal retry loop running.
                }
            } catch (_: Exception) {
            } finally {
                subnetScanning = false
            }
        }
    }

    private fun applyPlan(plan: PlaybackPlan) {
        val p = player ?: return
        imageJob?.cancel()
        activePlan = plan
        activeIndex = 0
        if (plan.items.isEmpty()) {
            // An empty playlist never reaches STATE_READY, so the stale
            // "connecting" overlay would sit there forever. Say what's up;
            // the SSE playlist-changed event reloads us once videos exist.
            p.clearMediaItems()
            imageView.visibility = View.GONE
            playerView.visibility = View.VISIBLE
            showOverlay("Chưa có quảng cáo — thêm ảnh hoặc video trong POS → Cài đặt → TV Quảng cáo")
            return
        }
        p.volume = if (plan.muted) 0f else (plan.volume / 100f)
        p.repeatMode = Player.REPEAT_MODE_OFF
        playCurrent(plan)
    }

    private fun playCurrent(plan: PlaybackPlan) {
        val item = plan.items.getOrNull(activeIndex) ?: return
        if (item.type == "image") {
            showImage(item, plan)
        } else {
            playVideo(item)
        }
    }

    private fun playVideo(item: PlaybackItem) {
        imageJob?.cancel()
        imageView.visibility = View.GONE
        playerView.visibility = View.VISIBLE
        val p = player ?: return
        p.stop()
        p.clearMediaItems()
        p.setMediaItem(MediaItem.fromUri(item.url))
        p.prepare()
        p.playWhenReady = true
    }

    private fun showImage(item: PlaybackItem, plan: PlaybackPlan) {
        val p = player ?: return
        p.stop()
        p.clearMediaItems()
        playerView.visibility = View.GONE
        imageView.visibility = View.VISIBLE
        hideOverlay()
        imageJob?.cancel()
        imageJob = scope.launch {
            try {
                val bmp = withContext(Dispatchers.IO) {
                    loadBitmapFromUrl(item.url)
                }
                imageView.setImageBitmap(bmp)
                delay(item.durationMs.coerceIn(2000L, 60000L))
                if (isActive && activePlan === plan) playNext()
            } catch (e: Exception) {
                showOverlay("Lỗi tải ảnh quảng cáo — tự thử lại sau 5s")
                delay(5000)
                if (isActive && activePlan === plan) playCurrent(plan)
            }
        }
    }

    private fun loadBitmapFromUrl(url: String): Bitmap {
        val conn = URL(url).openConnection().apply {
            connectTimeout = IMAGE_CONNECT_TIMEOUT_MS
            readTimeout = IMAGE_READ_TIMEOUT_MS
        }
        val bytes = conn.getInputStream().use { it.readBytes() }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val decode = BitmapFactory.Options().apply {
            inSampleSize = calculateInSampleSize(bounds, TARGET_IMAGE_WIDTH, TARGET_IMAGE_HEIGHT)
            inPreferredConfig = Bitmap.Config.RGB_565
        }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decode)
            ?: error("image decode failed")
    }

    private fun calculateInSampleSize(options: BitmapFactory.Options, reqWidth: Int, reqHeight: Int): Int {
        val height = options.outHeight
        val width = options.outWidth
        var inSampleSize = 1
        if (height <= 0 || width <= 0) return 1
        if (height > reqHeight || width > reqWidth) {
            var halfHeight = height / 2
            var halfWidth = width / 2
            while ((halfHeight / inSampleSize) >= reqHeight && (halfWidth / inSampleSize) >= reqWidth) {
                inSampleSize *= 2
            }
        }
        return inSampleSize.coerceAtLeast(1)
    }

    private fun playNext() {
        val plan = activePlan ?: return
        if (plan.items.isEmpty()) return
        activeIndex = if (plan.repeatMode == RepeatMode.ONE) activeIndex else (activeIndex + 1) % plan.items.size
        playCurrent(plan)
    }

    private fun openEvents(b: String) {
        sse?.close()
        sse = AdApiClient(b).openEvents(
            onChanged = { runOnUiThread { reloadIfChanged(b) } },
            onClosed = {
                scope.launch {
                    delay(5000)
                    if (base == b) { reloadIfChanged(b); openEvents(b) }
                }
            },
        )
    }

    private fun reloadIfChanged(b: String) {
        scope.launch {
            try {
                val pl = withContext(Dispatchers.IO) { AdApiClient(b).fetchPlaylist() }
                if (pl.version != currentVersion) {
                    currentVersion = pl.version
                    applyPlan(PlaybackPlan.from(pl, b))
                }
                maybeCheckForUpdate(b, force = false)
            } catch (_: Exception) {}
        }
    }

    private fun maybeCheckForUpdate(b: String, force: Boolean) {
        if (updateInProgress) return
        val now = System.currentTimeMillis()
        if (!force && now - lastUpdateCheckAt < 6 * 60 * 60 * 1000L) return
        lastUpdateCheckAt = now
        updateJob?.cancel()
        updateJob = scope.launch {
            try {
                val updater = TvAppUpdater(this@MainActivity)
                val update = withContext(Dispatchers.IO) { updater.check(b) } ?: return@launch
                updateInProgress = true
                showOverlay("Có bản Zira TV Ads ${update.latestVersionName}. Đang tải cập nhật...")
                val apk = updater.download(b, update)
                pendingUpdateApk = apk
                val opened = updater.openInstaller(apk)
                if (opened) {
                    pendingUpdateApk = null
                    updateInProgress = false
                } else {
                    showOverlay("Cho phép cài app không rõ nguồn, rồi quay lại Zira TV Ads để tiếp tục cập nhật.")
                }
            } catch (e: Exception) {
                updateInProgress = false
                pendingUpdateApk = null
                showOverlay("Không cập nhật được TV app: " + (e.message ?: "unknown"))
                delay(5000)
                if (isActive && activePlan != null) hideOverlay()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        val apk = pendingUpdateApk ?: return
        if (!apk.exists()) {
            pendingUpdateApk = null
            updateInProgress = false
            return
        }
        try {
            val opened = TvAppUpdater(this).openInstaller(apk)
            if (opened) {
                pendingUpdateApk = null
                updateInProgress = false
                showOverlay("Mở trình cài đặt Zira TV Ads...")
            }
        } catch (e: Exception) {
            updateInProgress = false
            pendingUpdateApk = null
            showOverlay("Không mở được trình cài đặt: " + (e.message ?: "unknown"))
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            window.decorView.systemUiVisibility =
                (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
        }
    }

    override fun onDestroy() {
        scope.cancel()
        imageJob?.cancel()
        updateJob?.cancel()
        sse?.close(); discovery?.close(); advertiser?.close()
        player?.release(); player = null
        super.onDestroy()
    }
}
