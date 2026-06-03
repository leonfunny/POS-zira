package pl.zira.tvads

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import pl.zira.tvads.net.UrlBuilder
import pl.zira.tvads.prefs.HostStore
import java.util.concurrent.TimeUnit

class PairingActivity : Activity() {
    private val scope = CoroutineScope(Dispatchers.Main + Job())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pairing)
        val input = findViewById<EditText>(R.id.ipInput)
        findViewById<Button>(R.id.connectBtn).setOnClickListener {
            val raw = input.text.toString().trim()
            if (raw.isEmpty()) return@setOnClickListener
            val base = normalize(raw)
            scope.launch {
                val ok = withContext(Dispatchers.IO) { health(base) }
                if (ok) {
                    HostStore(this@PairingActivity).lastBase = base
                    startActivity(Intent(this@PairingActivity, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                    finish()
                } else {
                    Toast.makeText(this@PairingActivity, "Không kết nối được $base", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun normalize(raw: String): String {
        val noScheme = raw.removePrefix("http://").removePrefix("https://").trimEnd('/')
        return "http://" + if (noScheme.contains(":")) noScheme else "$noScheme:17893"
    }

    private fun health(base: String): Boolean = try {
        val c = OkHttpClient.Builder().connectTimeout(4, TimeUnit.SECONDS).readTimeout(4, TimeUnit.SECONDS).build()
        c.newCall(Request.Builder().url(UrlBuilder.absolute(base, "/health")).build()).execute().use { it.isSuccessful }
    } catch (e: Exception) { false }
}
