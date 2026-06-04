package pl.zira.tvads.player

import pl.zira.tvads.model.Playlist
import pl.zira.tvads.net.UrlBuilder

enum class RepeatMode { ALL, ONE }

data class PlaybackPlan(val urls: List<String>, val repeatMode: RepeatMode, val muted: Boolean, val volume: Int) {
    companion object {
        fun from(playlist: Playlist, base: String): PlaybackPlan {
            if (playlist.playbackMode == "repeat-one" && playlist.repeatVideoId != null) {
                val target = playlist.videos.firstOrNull { it.id == playlist.repeatVideoId }
                if (target != null) {
                    return PlaybackPlan(
                        listOf(UrlBuilder.absolute(base, target.url)),
                        RepeatMode.ONE, playlist.muted, playlist.volume,
                    )
                }
            }
            return PlaybackPlan(
                playlist.videos.map { UrlBuilder.absolute(base, it.url) },
                RepeatMode.ALL, playlist.muted, playlist.volume,
            )
        }
    }
}
