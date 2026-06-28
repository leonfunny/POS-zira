package pl.zira.tvads.model

data class TvAppUpdate(
    val latestVersionCode: Int,
    val latestVersionName: String,
    val apkUrl: String?,
    val apkSize: Long?,
    val apkSha256: String?,
)
