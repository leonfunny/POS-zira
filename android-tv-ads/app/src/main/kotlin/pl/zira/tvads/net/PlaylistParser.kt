package pl.zira.tvads.net

import org.json.JSONObject
import pl.zira.tvads.model.AdMedia
import pl.zira.tvads.model.AdVideo
import pl.zira.tvads.model.Playlist

object PlaylistParser {
    fun parse(json: String): Playlist {
        val o = JSONObject(json)
        val mediaArr = o.optJSONArray("media")
        val media = if (mediaArr != null) {
            (0 until mediaArr.length()).map { i ->
                val v = mediaArr.getJSONObject(i)
                AdMedia(
                    id = v.getString("id"),
                    url = v.getString("url"),
	                    order = v.getInt("order"),
	                    type = v.optString("type", "video"),
	                    durationMs = if (v.has("durationMs")) v.optLong("durationMs") else null,
	                    source = v.optString("source", "").takeIf { it.isNotBlank() },
	                    size = if (v.has("size")) v.optLong("size") else null,
	                    sha256 = v.optString("sha256", "").takeIf { it.matches(Regex("^[a-fA-F0-9]{64}$")) }?.lowercase(),
	                )
	            }.sortedBy { it.order }
        } else {
            emptyList()
        }
        val arr = o.getJSONArray("videos")
        val videos = (0 until arr.length()).map { i ->
            val v = arr.getJSONObject(i)
            AdVideo(v.getString("id"), v.getString("url"), v.getInt("order"))
        }.sortedBy { it.order }
	        val resolvedMedia = media.ifEmpty {
	            videos.map { AdMedia(it.id, it.url, it.order, "video", null, null, null, null) }
	        }
        return Playlist(
            version = o.getString("version"),
            playbackMode = o.getString("playbackMode"),
            repeatVideoId = if (o.isNull("repeatVideoId")) null else o.getString("repeatVideoId"),
            muted = o.getBoolean("muted"),
	            volume = o.getInt("volume"),
	            media = resolvedMedia,
	            videos = videos,
	            rawJson = json,
	        )
	    }
	}
