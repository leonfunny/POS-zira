package pl.zira.tvads.model

data class AdVideo(val id: String, val url: String, val order: Int)

data class Playlist(
    val version: String,
    val playbackMode: String,   // 'sequential' | 'repeat-one'
    val repeatVideoId: String?,
    val muted: Boolean,
    val volume: Int,
    val videos: List<AdVideo>,
)
