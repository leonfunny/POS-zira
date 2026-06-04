// app/src/main/kotlin/pl/zira/tvads/discovery/NsdDiscovery.kt
package pl.zira.tvads.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import java.io.Closeable

class NsdDiscovery(context: Context) : Closeable {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private var mlock: WifiManager.MulticastLock? = null
    private var listener: NsdManager.DiscoveryListener? = null

    /** onFound delivers "http://<host>:<port>" for the first resolved POS. */
    fun start(onFound: (String) -> Unit) {
        mlock = wifi.createMulticastLock("zira-ads").apply { setReferenceCounted(false); acquire() }
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                nsd.resolveService(info, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(s: NsdServiceInfo, e: Int) {}
                    override fun onServiceResolved(s: NsdServiceInfo) {
                        // POS advertises its REAL LAN IPv4 in the TXT record ("ip").
                        // Prefer it: multi-homed POS machines (WSL/VPN adapters) may
                        // resolve to a virtual address the TV cannot reach.
                        val txtIp = try {
                            s.attributes?.get("ip")?.let { String(it) }?.takeIf { it.isNotBlank() }
                        } catch (_: Exception) { null }
                        val host = txtIp ?: s.host?.hostAddress ?: return
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
        mlock?.let { if (it.isHeld) it.release() }; mlock = null
    }
}
