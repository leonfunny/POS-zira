package pl.zira.tvads

import org.junit.Assert.assertEquals
import org.junit.Test
import pl.zira.tvads.model.AdMedia
import pl.zira.tvads.model.AdVideo
import pl.zira.tvads.model.Playlist
import pl.zira.tvads.net.UrlBuilder
import pl.zira.tvads.player.PlaybackPlan
import pl.zira.tvads.player.RepeatMode

class PlaybackPlanTest {
	    private fun pl(mode: String, repeat: String?) = Playlist(
	        "v", mode, repeat, true, 0,
	        listOf(
	            AdMedia("a", "/media/a", 0, "image", 5000, null, null, null),
	            AdMedia("b", "/media/b", 1, "video", null, null, null, null),
	        ),
	        listOf(AdVideo("a", "/video/a", 0), AdVideo("b", "/video/b", 1)),
	    )

    @Test fun absoluteUrl() {
        assertEquals("http://192.168.1.5:17893/video/a",
            UrlBuilder.absolute("http://192.168.1.5:17893", "/video/a"))
    }

    @Test fun absoluteUrlKeepsAlreadyAbsoluteUrl() {
        assertEquals("https://enail.pro/uploads/ziratv.apk",
            UrlBuilder.absolute("http://192.168.1.5:17893", "https://enail.pro/uploads/ziratv.apk"))
    }

    @Test fun sequentialPlaysAllRepeatAll() {
        val plan = PlaybackPlan.from(pl("sequential", null), "http://h:1")
        assertEquals(listOf("http://h:1/media/a", "http://h:1/media/b"), plan.items.map { it.url })
        assertEquals(listOf("image", "video"), plan.items.map { it.type })
        assertEquals(RepeatMode.ALL, plan.repeatMode)
    }

    @Test fun repeatOnePlaysOnlyTargetRepeatOne() {
        val plan = PlaybackPlan.from(pl("repeat-one", "b"), "http://h:1")
        assertEquals(listOf("http://h:1/media/b"), plan.items.map { it.url })
        assertEquals(RepeatMode.ONE, plan.repeatMode)
    }

	    @Test fun repeatOneWithMissingTargetFallsBackToAll() {
	        val plan = PlaybackPlan.from(pl("repeat-one", "zzz"), "http://h:1")
	        assertEquals(listOf("http://h:1/media/a", "http://h:1/media/b"), plan.items.map { it.url })
	        assertEquals(RepeatMode.ALL, plan.repeatMode)
	    }

	    @Test fun cachedUrlsWinOverNetworkUrls() {
	        val plan = PlaybackPlan.from(pl("sequential", null), "http://h:1", mapOf("b" to "file:///cache/b.mp4"))
	        assertEquals(listOf("http://h:1/media/a", "file:///cache/b.mp4"), plan.items.map { it.url })
	    }
	}
