package pl.zira.tvads.model

data class AdMedia(
    val id: String,
    val url: String,
    val order: Int,
    val type: String,
    val durationMs: Long?,
    val source: String?,
    val size: Long?,
    val sha256: String?,
)

data class AdVideo(val id: String, val url: String, val order: Int)

data class Playlist(
    val version: String,
    val playbackMode: String,   // 'sequential' | 'repeat-one'
    val repeatVideoId: String?,
    val muted: Boolean,
    val volume: Int,
    val media: List<AdMedia>,
    val videos: List<AdVideo>,
    val rawJson: String? = null,
)
