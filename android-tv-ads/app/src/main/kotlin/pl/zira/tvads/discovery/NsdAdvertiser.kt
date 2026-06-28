package pl.zira.tvads.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.provider.Settings
import java.io.Closeable

class NsdAdvertiser(context: Context) : Closeable {
    private val appContext = context.applicationContext
    private val nsd = appContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private var listener: NsdManager.RegistrationListener? = null
    private var activePosHost: String? = null

    fun start(posBase: String) {
        val posHost = normalizePosHost(posBase)
        if (listener != null && activePosHost == posHost) return
        close()

        val info = NsdServiceInfo().apply {
            serviceName = serviceName()
            serviceType = "_zira-tv._tcp."
            port = 9
            setAttribute("model", Build.MODEL.take(40))
            setAttribute("manufacturer", Build.MANUFACTURER.take(40))
            setAttribute("deviceId", deviceId())
            setAttribute("posHost", posHost.take(80))
        }
        val l = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {}
            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                if (listener === this) listener = null
            }
            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {}
            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
        }
        listener = l
        activePosHost = posHost
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
    }

    override fun close() {
        listener?.let {
            try { nsd.unregisterService(it) } catch (_: Exception) {}
        }
        listener = null
        activePosHost = null
    }

    private fun serviceName(): String {
        val model = Build.MODEL.replace(Regex("[^A-Za-z0-9._-]+"), "-").trim('-').ifBlank { "TV" }
        return "Zira TV-$model-${deviceId().takeLast(4)}".take(60)
    }

    private fun deviceId(): String = try {
        Settings.Secure.getString(appContext.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
    } catch (_: Exception) {
        "unknown"
    }

    private fun normalizePosHost(posBase: String): String =
        posBase.removePrefix("http://").removePrefix("https://").trimEnd('/')
}
