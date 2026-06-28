package pl.zira.tvads

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import pl.zira.tvads.discovery.SubnetScanner
import pl.zira.tvads.net.UrlBuilder
import pl.zira.tvads.prefs.HostStore
import java.util.concurrent.TimeUnit

class PairingActivity : Activity() {
    companion object {
        private const val REQ_NEARBY_WIFI = 4102
    }

    private val scope = CoroutineScope(Dispatchers.Main + Job())
    private var scanning = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pairing)
        val input = findViewById<EditText>(R.id.ipInput)
        val status = findViewById<TextView>(R.id.scanStatus)
        findViewById<Button>(R.id.connectBtn).setOnClickListener {
            val raw = input.text.toString().trim()
            if (raw.isEmpty()) return@setOnClickListener
            val base = normalize(raw)
            scope.launch {
                val ok = withContext(Dispatchers.IO) { health(base) }
                if (ok) {
                    proceed(base)
                } else {
                    Toast.makeText(this@PairingActivity, "Không kết nối được $base", Toast.LENGTH_LONG).show()
                }
            }
        }
        // Manual LAN sweep — works even when the router blocks mDNS multicast.
        val scanBtn = findViewById<Button>(R.id.scanBtn)
        scanBtn.setOnClickListener {
            if (!ensureWifiDiscoveryPermission()) return@setOnClickListener
            if (scanning) return@setOnClickListener
            scanning = true
            scanBtn.isEnabled = false
            status.text = "Đang quét mạng nội bộ (cổng ${SubnetScanner.DEFAULT_PORT})..."
            scope.launch {
                val found = try {
                    withContext(Dispatchers.IO) {
                        SubnetScanner.scan { done, total ->
                            if (done % 25 == 0 || done == total) {
                                runOnUiThread { status.text = "Đang quét... $done/$total" }
                            }
                        }
                    }
                } catch (e: Exception) {
                    emptyList()
                }
                scanning = false
                scanBtn.isEnabled = true
                when {
                    found.isEmpty() -> status.text =
                        "Không tìm thấy POS trong mạng. Kiểm tra POS đã bật \"TV Quảng cáo\" và cùng WiFi/LAN với TV."
                    else -> {
                        status.text = "Tìm thấy POS: ${found.joinToString(", ") { it.removePrefix("http://") }}"
                        proceed(found.first())
                    }
                }
            }
        }
    }

    private fun proceed(base: String) {
        HostStore(this).lastBase = base
        Toast.makeText(this, "Đã kết nối $base", Toast.LENGTH_SHORT).show()
        startActivity(Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
    }

    private fun normalize(raw: String): String {
        val noScheme = raw.removePrefix("http://").removePrefix("https://").trimEnd('/')
        return "http://" + if (noScheme.contains(":")) noScheme else "$noScheme:17893"
    }

    private fun health(base: String): Boolean = try {
        val c = OkHttpClient.Builder().connectTimeout(4, TimeUnit.SECONDS).readTimeout(4, TimeUnit.SECONDS).build()
        c.newCall(Request.Builder().url(UrlBuilder.absolute(base, "/health")).build()).execute().use {
            it.isSuccessful && (it.body?.string()?.contains("zira-ads") == true)
        }
    } catch (e: Exception) { false }

    private fun ensureWifiDiscoveryPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED) return true
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES), REQ_NEARBY_WIFI)
        return false
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
