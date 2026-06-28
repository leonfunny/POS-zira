package pl.zira.tvads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import pl.zira.tvads.net.PlaylistParser
import pl.zira.tvads.net.TvAppUpdateParser

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
        assertEquals(2, p.media.size)
        assertEquals("a", p.videos[0].id)
        assertEquals("/video/a", p.videos[0].url)
        assertEquals("/video/a", p.media[0].url)
        assertEquals("video", p.media[0].type)
    }

    @Test fun parsesMixedMediaPayload() {
        val json = """
          {"version":"abc123","playbackMode":"sequential","repeatVideoId":null,
           "muted":true,"volume":0,
           "media":[{"id":"a","url":"/media/a","order":0,"type":"image","durationMs":8000},{"id":"b","url":"/media/b","order":1,"type":"video"}],
           "videos":[{"id":"b","url":"/video/b","order":1}]}
        """.trimIndent()
        val p = PlaylistParser.parse(json)
        assertEquals(2, p.media.size)
        assertEquals("image", p.media[0].type)
        assertEquals(8000L, p.media[0].durationMs)
        assertEquals("video", p.media[1].type)
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

    @Test fun parsesTvAppUpdatePayload() {
        val json = """{"latestVersionCode":6,"latestVersionName":"1.3.0",
          "apkUrl":"/tv-app/app-release.apk","apkSize":123,"apkSha256":"abc"}"""
        val update = TvAppUpdateParser.parse(json)
        assertEquals(6, update.latestVersionCode)
        assertEquals("1.3.0", update.latestVersionName)
        assertEquals("/tv-app/app-release.apk", update.apkUrl)
        assertEquals(123L, update.apkSize)
        assertEquals("abc", update.apkSha256)
    }
}
