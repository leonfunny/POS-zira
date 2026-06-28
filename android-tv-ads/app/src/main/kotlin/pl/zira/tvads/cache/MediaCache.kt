package pl.zira.tvads.cache

import android.content.Context
import android.net.Uri
import okhttp3.OkHttpClient
import okhttp3.Request
import pl.zira.tvads.model.AdMedia
import pl.zira.tvads.model.Playlist
import pl.zira.tvads.net.UrlBuilder
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class MediaCache(context: Context) {
    private val dir = File(context.cacheDir, "tv-ad-media").apply { mkdirs() }
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.MINUTES)
        .build()

    fun prepare(
        playlist: Playlist,
        base: String,
        onProgress: (done: Int, total: Int) -> Unit = { _, _ -> },
    ): Map<String, String> {
        val cached = mutableMapOf<String, String>()
        val items = playlist.media.filter { shouldCache(it) }
        val total = items.size
        items.forEachIndexed { index, item ->
            val target = targetFile(item)
            try {
                if (!isValid(target, item)) {
                    download(UrlBuilder.absolute(base, item.url), target, item)
                }
                if (isValid(target, item)) cached[item.id] = Uri.fromFile(target).toString()
            } catch (_: Exception) {
                if (target.exists() && isValid(target, item, allowUnknownHash = true)) {
                    cached[item.id] = Uri.fromFile(target).toString()
                }
            } finally {
                onProgress(index + 1, total)
            }
        }
        cleanup(playlist)
        return cached
    }

    fun cachedUrlsFor(playlist: Playlist): Map<String, String> =
        playlist.media.mapNotNull { item ->
            val target = targetFile(item)
            if (target.exists() && isValid(target, item, allowUnknownHash = true)) {
                item.id to Uri.fromFile(target).toString()
            } else {
                null
            }
        }.toMap()

    private fun shouldCache(item: AdMedia): Boolean =
        item.url.startsWith("http://") || item.url.startsWith("https://") || item.source == "cloud"

    private fun download(url: String, target: File, item: AdMedia) {
        val tmp = File(target.parentFile, target.name + ".tmp")
        if (tmp.exists()) tmp.delete()
        client.newCall(Request.Builder().url(url).build()).execute().use { resp ->
            if (!resp.isSuccessful) error("media HTTP ${resp.code}")
            val body = resp.body ?: error("empty media body")
            tmp.outputStream().use { out -> body.byteStream().copyTo(out) }
        }
        if (!isValid(tmp, item)) error("media verification failed")
        if (target.exists()) target.delete()
        if (!tmp.renameTo(target)) error("media rename failed")
    }

    private fun isValid(file: File, item: AdMedia, allowUnknownHash: Boolean = false): Boolean {
        if (!file.exists() || file.length() <= 0L) return false
        item.size?.let { if (it > 0L && file.length() != it) return false }
        val expected = item.sha256
        if (!expected.isNullOrBlank()) return sha256(file).equals(expected, ignoreCase = true)
        return allowUnknownHash || item.size == null || item.size == file.length()
    }

    private fun targetFile(item: AdMedia): File {
        val ext = extensionFor(item)
        val digest = sha256Text("${item.id}:${item.url}:${item.sha256 ?: ""}").take(16)
        return File(dir, safeName("${item.id}-$digest$ext"))
    }

    private fun extensionFor(item: AdMedia): String {
        val path = runCatching { Uri.parse(item.url).path ?: "" }.getOrDefault("")
        val ext = path.substringAfterLast('.', "").lowercase()
        val allowed = setOf("mp4", "m4v", "mov", "jpg", "jpeg", "png", "webp")
        if (ext in allowed) return ".$ext"
        return if (item.type == "image") ".jpg" else ".mp4"
    }

    private fun cleanup(playlist: Playlist) {
        val keep = playlist.media.map { targetFile(it).name }.toSet()
        dir.listFiles()?.forEach { file ->
            if (file.isFile && !file.name.endsWith(".tmp") && file.name !in keep) file.delete()
        }
    }

    private fun safeName(name: String): String = name.replace(Regex("[^A-Za-z0-9._-]+"), "_")

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buf)
                if (read <= 0) break
                md.update(buf, 0, read)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun sha256Text(value: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray())
            .joinToString("") { "%02x".format(it) }
}
