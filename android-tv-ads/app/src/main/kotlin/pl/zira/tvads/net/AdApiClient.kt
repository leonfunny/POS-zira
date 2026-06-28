package pl.zira.tvads.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import pl.zira.tvads.model.Playlist
import pl.zira.tvads.model.TvAppUpdate
import java.io.File
import java.io.Closeable
import java.util.concurrent.TimeUnit

class AdApiClient(private val base: String) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // SSE needs no read timeout
        .build()

    suspend fun fetchPlaylist(): Playlist = withContext(Dispatchers.IO) {
        val fetchClient = client.newBuilder()
            .readTimeout(10, TimeUnit.SECONDS)
            .callTimeout(15, TimeUnit.SECONDS)
            .build()
        val req = Request.Builder().url(UrlBuilder.absolute(base, "/playlist.json")).build()
        fetchClient.newCall(req).execute().use { resp ->
            val body = resp.body?.string() ?: error("empty playlist body")
            if (!resp.isSuccessful) error("playlist HTTP ${resp.code}")
            PlaylistParser.parse(body)
        }
    }

    suspend fun fetchTvAppUpdate(): TvAppUpdate = withContext(Dispatchers.IO) {
        val fetchClient = client.newBuilder()
            .readTimeout(10, TimeUnit.SECONDS)
            .callTimeout(15, TimeUnit.SECONDS)
            .build()
        val req = Request.Builder().url(UrlBuilder.absolute(base, "/tv-app/update.json")).build()
        fetchClient.newCall(req).execute().use { resp ->
            val body = resp.body?.string() ?: error("empty update body")
            if (!resp.isSuccessful) error("update HTTP ${resp.code}")
            TvAppUpdateParser.parse(body)
        }
    }

    suspend fun downloadTo(url: String, target: File): Unit = withContext(Dispatchers.IO) {
        val fetchClient = client.newBuilder()
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(120, TimeUnit.SECONDS)
            .build()
        val req = Request.Builder().url(url).build()
        fetchClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) error("download HTTP ${resp.code}")
            val body = resp.body ?: error("empty APK body")
            target.outputStream().use { out -> body.byteStream().copyTo(out) }
        }
    }

    /** Long-lived SSE connection; calls onChanged() on each 'playlist-changed' event.
     *  Returns a Closeable to cancel. Caller runs this off the main thread. */
    fun openEvents(onChanged: () -> Unit, onClosed: () -> Unit): Closeable {
        val req = Request.Builder().url(UrlBuilder.absolute(base, "/events"))
            .header("Accept", "text/event-stream").build()
        val call = client.newCall(req)
        Thread {
            try {
                call.execute().use { resp ->
                    val src = resp.body?.source() ?: return@use
                    var lastEvent = ""
                    while (!src.exhausted()) {
                        val line = src.readUtf8Line() ?: break
                        when {
                            line.startsWith("event:") -> lastEvent = line.removePrefix("event:").trim()
                            line.startsWith("data:") && lastEvent == "playlist-changed" -> onChanged()
                            line.isEmpty() -> lastEvent = "" // end of one SSE frame
                        }
                    }
                }
            } catch (_: Exception) {
            } finally { onClosed() }
        }.apply { isDaemon = true }.start()
        return Closeable { call.cancel() }
    }
}
