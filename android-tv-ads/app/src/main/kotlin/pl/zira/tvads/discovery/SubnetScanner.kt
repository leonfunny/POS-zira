package pl.zira.tvads.discovery

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Brute-force LAN sweep fallback for when the router blocks mDNS multicast:
 * derive the TV's own /24 subnet(s) (WiFi or Ethernet), try TCP :17893 on
 * every host, then confirm the responder really is the POS ad server via
 * GET /health (body must identify as "zira-ads").
 */
object SubnetScanner {
    const val DEFAULT_PORT = 17893
    private const val CONNECT_TIMEOUT_MS = 350
    private const val MAX_PARALLEL = 48

    /** Site-local IPv4 addresses of this device (WiFi or Ethernet). */
    fun localIpv4(): List<String> = try {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }
            .filter { it.isSiteLocalAddress }
            .mapNotNull { it.hostAddress }
            .filter { it.contains('.') && !it.contains(':') }
    } catch (_: Exception) { emptyList() }

    /** "192.168.0.23" -> "192.168.0." (null if not a dotted IPv4). */
    fun subnetPrefix(ip: String): String? {
        val parts = ip.split('.')
        if (parts.size != 4) return null
        if (parts.any { it.toIntOrNull() == null }) return null
        return "${parts[0]}.${parts[1]}.${parts[2]}."
    }

    /**
     * Scan all local /24 subnets (max 2) for hosts answering /health with
     * app=zira-ads. Returns base URLs like "http://192.168.0.105:17893".
     * onProgress is invoked from IO threads — marshal to UI yourself.
     */
    suspend fun scan(
        port: Int = DEFAULT_PORT,
        onProgress: (done: Int, total: Int) -> Unit = { _, _ -> },
    ): List<String> = coroutineScope {
        val own = localIpv4()
        val prefixes = own.mapNotNull { subnetPrefix(it) }.distinct().take(2)
        if (prefixes.isEmpty()) return@coroutineScope emptyList()
        val ownSet = own.toSet()
        val targets = prefixes.flatMap { p -> (1..254).map { "$p$it" } }.filter { it !in ownSet }
        val total = targets.size
        val done = AtomicInteger(0)
        val sem = Semaphore(MAX_PARALLEL)
        val http = OkHttpClient.Builder()
            .connectTimeout(1, TimeUnit.SECONDS)
            .readTimeout(1, TimeUnit.SECONDS)
            .build()
        targets.map { ip ->
            async(Dispatchers.IO) {
                sem.withPermit {
                    val hit = tcpOpen(ip, port) && isZiraAds(http, ip, port)
                    onProgress(done.incrementAndGet(), total)
                    if (hit) "http://$ip:$port" else null
                }
            }
        }.awaitAll().filterNotNull()
    }

    private fun tcpOpen(ip: String, port: Int): Boolean = try {
        Socket().use { s -> s.connect(InetSocketAddress(ip, port), CONNECT_TIMEOUT_MS); true }
    } catch (_: Exception) { false }

    private fun isZiraAds(http: OkHttpClient, ip: String, port: Int): Boolean = try {
        http.newCall(Request.Builder().url("http://$ip:$port/health").build()).execute().use { r ->
            r.isSuccessful && (r.body?.string()?.contains("zira-ads") == true)
        }
    } catch (_: Exception) { false }
}
