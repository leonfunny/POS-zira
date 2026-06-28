package pl.zira.tvads.updater

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import pl.zira.tvads.model.TvAppUpdate
import pl.zira.tvads.net.AdApiClient
import pl.zira.tvads.net.UrlBuilder
import java.io.File
import java.security.MessageDigest

class TvAppUpdater(private val activity: Activity) {
    suspend fun check(base: String): TvAppUpdate? {
        val update = AdApiClient(base).fetchTvAppUpdate()
        val apkUrl = update.apkUrl
        if (update.latestVersionCode <= currentVersionCode() || apkUrl.isNullOrBlank()) return null
        return update
    }

    suspend fun download(base: String, update: TvAppUpdate): File = withContext(Dispatchers.IO) {
        val rel = update.apkUrl ?: error("missing APK URL")
        val outDir = File(activity.cacheDir, "tv-app-update").apply { mkdirs() }
        val out = File(outDir, "zira-tv-ads-${update.latestVersionCode}.apk")
        AdApiClient(base).downloadTo(UrlBuilder.absolute(base, rel), out)
        update.apkSize?.let {
            if (out.length() != it) error("APK size mismatch")
        }
        update.apkSha256?.let {
            val actual = sha256(out)
            if (!actual.equals(it, ignoreCase = true)) error("APK checksum mismatch")
        }
        out
    }

    fun openInstaller(apk: File): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                data = Uri.parse("package:${activity.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            return false
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.startActivity(intent)
        return true
    }

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

    private fun currentVersionCode(): Long {
        val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
    }
}
