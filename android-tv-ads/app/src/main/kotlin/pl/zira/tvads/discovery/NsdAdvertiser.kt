package pl.zira.tvads.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import java.io.Closeable

/**
 * Advertises this TV on the LAN as _zira-tv._tcp so the POS desktop app
 * can discover connected TVs without requiring manual IP entry.
 * Start when connected to a POS; stop/close when disconnecting.
 */
class NsdAdvertiser(context: Context) : Closeable {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private var regListener: NsdManager.RegistrationListener? = null

    fun start(posHost: String) {
        stop()
        val info = NsdServiceInfo().apply {
            serviceName = "ZiraTV-${Build.MODEL}".take(60)
            serviceType = "_zira-tv._tcp."
            port = 17894
            setAttribute("model", Build.MODEL.take(32))
            // Store posHost without scheme so it fits in a DNS TXT record
            setAttribute("pos", posHost.removePrefix("http://").removePrefix("https://").take(64))
        }
        val l = object : NsdManager.RegistrationListener {
            override fun onRegistrationFailed(i: NsdServiceInfo, e: Int) {}
            override fun onUnregistrationFailed(i: NsdServiceInfo, e: Int) {}
            override fun onServiceRegistered(i: NsdServiceInfo) {}
            override fun onServiceUnregistered(i: NsdServiceInfo) {}
        }
        regListener = l
        try {
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
        } catch (_: Exception) {}
    }

    override fun close() = stop()

    fun stop() {
        regListener?.let { try { nsd.unregisterService(it) } catch (_: Exception) {} }
        regListener = null
    }
}
