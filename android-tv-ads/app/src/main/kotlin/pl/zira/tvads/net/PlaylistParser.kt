package pl.zira.tvads.net

import org.json.JSONObject
import pl.zira.tvads.model.AdVideo
import pl.zira.tvads.model.Playlist

object PlaylistParser {
    fun parse(json: String): Playlist {
        val o = JSONObject(json)
        val arr = o.getJSONArray("videos")
        val videos = (0 until arr.length()).map { i ->
            val v = arr.getJSONObject(i)
            AdVideo(v.getString("id"), v.getString("url"), v.getInt("order"))
        }.sortedBy { it.order }
        return Playlist(
            version = o.getString("version"),
            playbackMode = o.getString("playbackMode"),
            repeatVideoId = if (o.isNull("repeatVideoId")) null else o.getString("repeatVideoId"),
            muted = o.getBoolean("muted"),
            volume = o.getInt("volume"),
            videos = videos,
        )
    }
}
