package pl.zira.tvads.player

import pl.zira.tvads.model.Playlist
import pl.zira.tvads.net.UrlBuilder

enum class RepeatMode { ALL, ONE }

data class PlaybackItem(val id: String, val url: String, val type: String, val durationMs: Long)

data class PlaybackPlan(val items: List<PlaybackItem>, val repeatMode: RepeatMode, val muted: Boolean, val volume: Int) {
    companion object {
        fun from(playlist: Playlist, base: String): PlaybackPlan {
            if (playlist.playbackMode == "repeat-one" && playlist.repeatVideoId != null) {
                val target = playlist.media.firstOrNull { it.id == playlist.repeatVideoId }
                if (target != null) {
                    return PlaybackPlan(
                        listOf(PlaybackItem(target.id, UrlBuilder.absolute(base, target.url), target.type, target.durationMs ?: 7000L)),
                        RepeatMode.ONE, playlist.muted, playlist.volume,
                    )
                }
            }
            return PlaybackPlan(
                playlist.media.map { PlaybackItem(it.id, UrlBuilder.absolute(base, it.url), it.type, it.durationMs ?: 7000L) },
                RepeatMode.ALL, playlist.muted, playlist.volume,
            )
        }
    }
}
