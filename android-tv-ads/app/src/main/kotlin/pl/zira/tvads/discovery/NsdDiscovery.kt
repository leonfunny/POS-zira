// app/src/main/kotlin/pl/zira/tvads/discovery/NsdDiscovery.kt
package pl.zira.tvads.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.io.Closeable

class NsdDiscovery(context: Context) : Closeable {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private var listener: NsdManager.DiscoveryListener? = null

    /** onFound delivers "http://<host>:<port>" for the first resolved POS. */
    fun start(onFound: (String) -> Unit) {
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                nsd.resolveService(info, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(s: NsdServiceInfo, e: Int) {}
                    override fun onServiceResolved(s: NsdServiceInfo) {
                        val host = s.host?.hostAddress ?: return
                        onFound("http://$host:${s.port}")
                    }
                })
            }
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        }
        listener = l
        nsd.discoverServices("_zira-ads._tcp.", NsdManager.PROTOCOL_DNS_SD, l)
    }

    override fun close() {
        listener?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }
        listener = null
    }
}
