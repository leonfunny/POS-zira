package pl.zira.tvads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import pl.zira.tvads.net.PlaylistParser

class PlaylistParserTest {
    @Test fun parsesFullPayload() {
        val json = """
          {"version":"abc123","playbackMode":"sequential","repeatVideoId":null,
           "muted":true,"volume":0,
           "videos":[{"id":"a","url":"/video/a","order":0},{"id":"b","url":"/video/b","order":1}]}
        """.trimIndent()
        val p = PlaylistParser.parse(json)
        assertEquals("abc123", p.version)
        assertEquals("sequential", p.playbackMode)
        assertNull(p.repeatVideoId)
        assertEquals(true, p.muted)
        assertEquals(0, p.volume)
        assertEquals(2, p.videos.size)
        assertEquals("a", p.videos[0].id)
        assertEquals("/video/a", p.videos[0].url)
    }

    @Test fun parsesRepeatOne() {
        val json = """{"version":"v","playbackMode":"repeat-one","repeatVideoId":"x",
          "muted":false,"volume":50,"videos":[{"id":"x","url":"/video/x","order":0}]}"""
        val p = PlaylistParser.parse(json)
        assertEquals("repeat-one", p.playbackMode)
        assertEquals("x", p.repeatVideoId)
        assertEquals(false, p.muted)
        assertEquals(50, p.volume)
    }
}
