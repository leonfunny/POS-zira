package pl.zira.tvads

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.view.WindowManager
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
import pl.zira.tvads.discovery.NsdDiscovery
import pl.zira.tvads.net.AdApiClient
import pl.zira.tvads.player.PlaybackPlan
import pl.zira.tvads.player.RepeatMode
import pl.zira.tvads.prefs.HostStore
import java.io.Closeable

class MainActivity : Activity() {
    private lateinit var playerView: PlayerView
    private var player: ExoPlayer? = null
    private lateinit var hostStore: HostStore
    private var discovery: NsdDiscovery? = null
    private var sse: Closeable? = null
    private val scope = CoroutineScope(Dispatchers.Main + Job())
    private var base: String? = null
    private var currentVersion: String? = null
    private var loadJob: kotlinx.coroutines.Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)
        playerView = findViewById(R.id.playerView)
        hostStore = HostStore(this)
        player = ExoPlayer.Builder(this).build().also { playerView.player = it }
        connect()
    }

    private fun connect() {
        base = hostStore.lastBase
        if (base != null) { loadAndPlay() }
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
                if (base == null) startActivity(android.content.Intent(this@MainActivity, PairingActivity::class.java))
            }
        }
    }

    private fun loadAndPlay() {
        val b = base ?: return
        loadJob?.cancel()
        loadJob = scope.launch {
            try {
                val playlist = withContext(Dispatchers.IO) { AdApiClient(b).fetchPlaylist() }
                currentVersion = playlist.version
                applyPlan(PlaybackPlan.from(playlist, b))
                openEvents(b)
            } catch (e: Exception) {
                delay(5000)
                if (isActive && base == b) loadAndPlay()
            }
        }
    }

    private fun applyPlan(plan: PlaybackPlan) {
        val p = player ?: return
        p.repeatMode = if (plan.repeatMode == RepeatMode.ONE) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_ALL
        p.volume = if (plan.muted) 0f else (plan.volume / 100f)
        p.setMediaItems(plan.urls.map { MediaItem.fromUri(it) })
        p.prepare()
        p.playWhenReady = true
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
            } catch (_: Exception) {}
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
        sse?.close(); discovery?.close()
        player?.release(); player = null
        super.onDestroy()
    }
}
