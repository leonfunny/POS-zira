package pl.zira.tvads.cache

import android.content.Context
import pl.zira.tvads.model.Playlist
import pl.zira.tvads.net.PlaylistParser
import java.io.File

class OfflinePlaylistStore(context: Context) {
    private val playlistFile = File(context.filesDir, "last-tv-playlist.json")

    fun save(playlist: Playlist) {
        val raw = playlist.rawJson ?: return
        playlistFile.writeText(raw)
    }

    fun load(): Playlist? = try {
        if (!playlistFile.exists()) null else PlaylistParser.parse(playlistFile.readText())
    } catch (_: Exception) {
        null
    }
}
