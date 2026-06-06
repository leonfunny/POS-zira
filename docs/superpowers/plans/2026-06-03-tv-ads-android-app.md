# TV Quảng Cáo — Plan 2: Android TV App "Zira TV Ads" (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native Android (Kotlin) app for Google TV that auto-discovers the POS over LAN (mDNS), pulls the ad playlist, and plays the videos full-screen on loop — all settings driven by the POS, instant updates via SSE.

**Architecture:** Single-Activity Android app. ExoPlayer (Media3) plays a playlist built from the POS `/playlist.json`. `NsdManager` discovers `_zira-ads._tcp`; a manual IP/QR pairing screen is the fallback. An SSE client on `/events` triggers playlist reloads. Pure logic (JSON parsing, URL building, playback-mode mapping) is isolated and JVM-unit-tested; the Android/UI glue is verified by a compiling Gradle build + manual on-device run.

**Tech Stack:** Kotlin, Android Gradle Plugin 8.x, JDK 17, AndroidX Media3 (ExoPlayer), `NsdManager`, OkHttp (HTTP + SSE), JUnit. Lives in `android-tv-ads/` inside the POS-zira repo (separate Gradle project / "app con").

**Frozen API contract from Plan 1** (do NOT change): POS advertises mDNS service type `_zira-ads._tcp` (TXT `name=<salon>`). Endpoints on `http://<host>:<port>`:
- `GET /health` → `{ "ok": true, "app": "zira-ads" }`
- `GET /playlist.json` → `{ version, playbackMode: 'sequential'|'repeat-one', repeatVideoId: string|null, muted: bool, volume: 0..100, videos: [{ id, url: '/video/<id>', order }] }`
- `GET /video/:id` → mp4, supports HTTP Range (206)
- `GET /events` → SSE; event `playlist-changed`, data `{ version }`

**Build/test environment:** Android SDK + JDK 17 installed on Alienware (`C:\Android\sdk`, `JAVA_HOME` = MS OpenJDK 17). Verify on Alienware via SSH:
- Pure unit tests: `./gradlew :app:testDebugUnitTest`
- Compile + APK: `./gradlew :app:assembleRelease` (or `assembleDebug`)
- Manual: sideload APK → run on Google TV.

---

## File Structure (under `android-tv-ads/`)

- `settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `local.properties` (SDK path), `gradlew`/`gradlew.bat` + wrapper.
- `app/build.gradle.kts` — Android app module (Media3, OkHttp, JUnit).
- `app/src/main/AndroidManifest.xml` — LEANBACK launcher, INTERNET/NETWORK_STATE/BOOT permissions.
- `app/src/main/kotlin/pl/zira/tvads/`
  - `model/Playlist.kt` — data classes.
  - `net/PlaylistParser.kt` — pure: JSON → Playlist (JVM-testable).
  - `net/UrlBuilder.kt` — pure: base + relative → absolute URL (JVM-testable).
  - `player/PlaybackPlan.kt` — pure: payload → ordered media-id list + repeat mode (JVM-testable).
  - `net/AdApiClient.kt` — OkHttp fetch playlist + SSE listener (Android).
  - `discovery/NsdDiscovery.kt` — NsdManager wrapper (Android).
  - `prefs/HostStore.kt` — remember last host:port (Android).
  - `MainActivity.kt` — ExoPlayer full-screen player + wiring (Android).
  - `PairingActivity.kt` — manual IP entry fallback (Android).
  - `BootReceiver.kt` — relaunch on boot (Android).
- `app/src/test/kotlin/pl/zira/tvads/` — JUnit tests for the pure pieces.

---

## Task 1: Gradle project scaffold that builds

**Files:** all gradle files + minimal manifest + empty Activity.

- [ ] **Step 1: Create `settings.gradle.kts`**
```kotlin
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "zira-tv-ads"
include(":app")
```

- [ ] **Step 2: Create root `build.gradle.kts`**
```kotlin
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
```

- [ ] **Step 3: Create `gradle.properties`**
```properties
org.gradle.jvmargs=-Xmx2048m
android.useAndroidX=true
kotlin.code.style=official
```

- [ ] **Step 4: Create `app/build.gradle.kts`**
```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "pl.zira.tvads"
    compileSdk = 34

    defaultConfig {
        applicationId = "pl.zira.tvads"
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug") // self-signed for sideload
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["main"].java.srcDirs("src/main/kotlin")
    sourceSets["test"].java.srcDirs("src/test/kotlin")
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    testImplementation("junit:junit:4.13.2")
}
```

- [ ] **Step 5: Create `app/src/main/AndroidManifest.xml`**
```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />

    <!-- Android TV: no touchscreen required, leanback optional so it also installs on phones for testing -->
    <uses-feature android:name="android.software.leanback" android:required="false" />
    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />

    <application
        android:allowBackup="true"
        android:label="Zira TV Ads"
        android:banner="@mipmap/ic_launcher"
        android:icon="@mipmap/ic_launcher"
        android:theme="@style/Theme.ZiraTvAds">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:screenOrientation="landscape"
            android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <activity android:name=".PairingActivity" android:exported="false" />

        <receiver
            android:name=".BootReceiver"
            android:exported="true"
            android:enabled="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>
    </application>
</manifest>
```

- [ ] **Step 6: Minimal theme + launcher icon + empty MainActivity** so it compiles.
  - `app/src/main/res/values/themes.xml`:
```xml
<resources>
    <style name="Theme.ZiraTvAds" parent="android:Theme.Material.NoActionBar.Fullscreen" />
</resources>
```
  - Provide a launcher/banner icon: create `app/src/main/res/mipmap-mdpi/ic_launcher.png` (any small PNG is fine for now — copy from the repo's existing R2 branding or generate a solid-color 48x48 PNG; if none handy, use Android default by setting `android:icon="@android:drawable/sym_def_app_icon"` and `android:banner="@android:drawable/sym_def_app_icon"` in the manifest instead of `@mipmap/ic_launcher` to avoid a missing-resource build error).
  - `app/src/main/kotlin/pl/zira/tvads/MainActivity.kt`:
```kotlin
package pl.zira.tvads

import android.app.Activity
import android.os.Bundle

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
    }
}
```
  - Stub `PairingActivity.kt` and `BootReceiver.kt` so the manifest resolves:
```kotlin
package pl.zira.tvads
import android.app.Activity
class PairingActivity : Activity()
```
```kotlin
package pl.zira.tvads
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
```

- [ ] **Step 7: Generate the Gradle wrapper + build on Alienware.**
On Alienware (via SSH), from `android-tv-ads/`: ensure `local.properties` has `sdk.dir=C\:\\Android\\sdk`, then `gradle wrapper --gradle-version 8.7` (or copy a wrapper). Then:
Run: `./gradlew :app:assembleDebug` (with `JAVA_HOME` = JDK 17, `ANDROID_HOME=C:\Android\sdk`).
Expected: BUILD SUCCESSFUL, an `app/build/outputs/apk/debug/app-debug.apk` produced.

- [ ] **Step 8: Commit**
```bash
git add android-tv-ads
git commit -m "feat(tv-ads-android): gradle scaffold + manifest, builds an empty APK"
```

---

## Task 2: Playlist model + JSON parser (pure, JVM-tested)

**Files:** `model/Playlist.kt`, `net/PlaylistParser.kt`, `app/src/test/kotlin/.../PlaylistParserTest.kt`

- [ ] **Step 1: Write the failing test**
```kotlin
// app/src/test/kotlin/pl/zira/tvads/PlaylistParserTest.kt
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
```

- [ ] **Step 2: Run, expect FAIL** (on Alienware): `./gradlew :app:testDebugUnitTest --tests pl.zira.tvads.PlaylistParserTest`

- [ ] **Step 3: Implement model + parser** (use `org.json.JSONObject`, available on Android & in the JVM unit-test classpath via the Android stubs — if `org.json` is not on the unit-test classpath, add `testImplementation("org.json:json:20240303")` to `app/build.gradle.kts`).
```kotlin
// app/src/main/kotlin/pl/zira/tvads/model/Playlist.kt
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
```
```kotlin
// app/src/main/kotlin/pl/zira/tvads/net/PlaylistParser.kt
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
```

- [ ] **Step 4: Run, expect PASS:** `./gradlew :app:testDebugUnitTest --tests pl.zira.tvads.PlaylistParserTest`
- [ ] **Step 5: Commit**
```bash
git add android-tv-ads/app/src/main/kotlin/pl/zira/tvads/model android-tv-ads/app/src/main/kotlin/pl/zira/tvads/net/PlaylistParser.kt android-tv-ads/app/src/test android-tv-ads/app/build.gradle.kts
git commit -m "feat(tv-ads-android): playlist model + JSON parser (unit-tested)"
```

---

## Task 3: URL builder + PlaybackPlan (pure, JVM-tested)

**Files:** `net/UrlBuilder.kt`, `player/PlaybackPlan.kt`, tests.

- [ ] **Step 1: Write the failing test**
```kotlin
// app/src/test/kotlin/pl/zira/tvads/PlaybackPlanTest.kt
package pl.zira.tvads

import org.junit.Assert.assertEquals
import org.junit.Test
import pl.zira.tvads.model.AdVideo
import pl.zira.tvads.model.Playlist
import pl.zira.tvads.net.UrlBuilder
import pl.zira.tvads.player.PlaybackPlan
import pl.zira.tvads.player.RepeatMode

class PlaybackPlanTest {
    private fun pl(mode: String, repeat: String?) = Playlist(
        "v", mode, repeat, true, 0,
        listOf(AdVideo("a", "/video/a", 0), AdVideo("b", "/video/b", 1)),
    )

    @Test fun absoluteUrl() {
        assertEquals("http://192.168.1.5:17893/video/a",
            UrlBuilder.absolute("http://192.168.1.5:17893", "/video/a"))
    }

    @Test fun sequentialPlaysAllRepeatAll() {
        val plan = PlaybackPlan.from(pl("sequential", null), "http://h:1")
        assertEquals(listOf("http://h:1/video/a", "http://h:1/video/b"), plan.urls)
        assertEquals(RepeatMode.ALL, plan.repeatMode)
    }

    @Test fun repeatOnePlaysOnlyTargetRepeatOne() {
        val plan = PlaybackPlan.from(pl("repeat-one", "b"), "http://h:1")
        assertEquals(listOf("http://h:1/video/b"), plan.urls)
        assertEquals(RepeatMode.ONE, plan.repeatMode)
    }

    @Test fun repeatOneWithMissingTargetFallsBackToAll() {
        val plan = PlaybackPlan.from(pl("repeat-one", "zzz"), "http://h:1")
        assertEquals(listOf("http://h:1/video/a", "http://h:1/video/b"), plan.urls)
        assertEquals(RepeatMode.ALL, plan.repeatMode)
    }
}
```

- [ ] **Step 2: Run, expect FAIL:** `./gradlew :app:testDebugUnitTest --tests pl.zira.tvads.PlaybackPlanTest`

- [ ] **Step 3: Implement**
```kotlin
// app/src/main/kotlin/pl/zira/tvads/net/UrlBuilder.kt
package pl.zira.tvads.net

object UrlBuilder {
    /** base = "http://host:port" (no trailing slash), rel = "/video/x". */
    fun absolute(base: String, rel: String): String =
        base.trimEnd('/') + (if (rel.startsWith("/")) rel else "/$rel")
}
```
```kotlin
// app/src/main/kotlin/pl/zira/tvads/player/PlaybackPlan.kt
package pl.zira.tvads.player

import pl.zira.tvads.model.Playlist
import pl.zira.tvads.net.UrlBuilder

enum class RepeatMode { ALL, ONE }

data class PlaybackPlan(val urls: List<String>, val repeatMode: RepeatMode, val muted: Boolean, val volume: Int)

object PlaybackPlan {
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
```

- [ ] **Step 4: Run, expect PASS:** `./gradlew :app:testDebugUnitTest --tests pl.zira.tvads.PlaybackPlanTest`
- [ ] **Step 5: Commit**
```bash
git add android-tv-ads/app/src/main/kotlin/pl/zira/tvads/net/UrlBuilder.kt android-tv-ads/app/src/main/kotlin/pl/zira/tvads/player/PlaybackPlan.kt android-tv-ads/app/src/test/kotlin/pl/zira/tvads/PlaybackPlanTest.kt
git commit -m "feat(tv-ads-android): url builder + playback-plan mapping (unit-tested)"
```

---

## Task 4: AdApiClient — fetch playlist + SSE (Android)

**Files:** `net/AdApiClient.kt`, `prefs/HostStore.kt`

- [ ] **Step 1: Implement HostStore** (SharedPreferences: remember last `host:port`)
```kotlin
// app/src/main/kotlin/pl/zira/tvads/prefs/HostStore.kt
package pl.zira.tvads.prefs

import android.content.Context

class HostStore(context: Context) {
    private val prefs = context.getSharedPreferences("zira_tv_ads", Context.MODE_PRIVATE)
    var lastBase: String?
        get() = prefs.getString("lastBase", null)
        set(value) { prefs.edit().putString("lastBase", value).apply() }
}
```

- [ ] **Step 2: Implement AdApiClient** (OkHttp; `fetchPlaylist` suspending; `openEvents` returns a Closeable that invokes `onChanged` when an SSE `playlist-changed` frame arrives — minimal SSE: read the response line-by-line off the event stream).
```kotlin
// app/src/main/kotlin/pl/zira/tvads/net/AdApiClient.kt
package pl.zira.tvads.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import pl.zira.tvads.model.Playlist
import java.io.Closeable
import java.util.concurrent.TimeUnit

class AdApiClient(private val base: String) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // SSE needs no read timeout
        .build()

    suspend fun fetchPlaylist(): Playlist = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(UrlBuilder.absolute(base, "/playlist.json")).build()
        client.newCall(req).execute().use { resp ->
            val body = resp.body?.string() ?: error("empty playlist body")
            if (!resp.isSuccessful) error("playlist HTTP ${resp.code}")
            PlaylistParser.parse(body)
        }
    }

    /** Long-lived SSE connection; calls onChanged() on each 'playlist-changed' event.
     *  Returns a Closeable to cancel. Caller runs this off the main thread. */
    fun openEvents(onChanged: () -> Unit, onClosed: () -> Unit): Closeable {
        val req = Request.Builder().url(UrlBuilder.absolute(base, "/events"))
            .header("Accept", "text/event-stream").build()
        val call = client.newCall(req)
        Thread {
            try {
                call.execute().use { resp ->
                    val src = resp.body?.source() ?: return@use
                    var lastEvent = ""
                    while (!src.exhausted()) {
                        val line = src.readUtf8Line() ?: break
                        when {
                            line.startsWith("event:") -> lastEvent = line.removePrefix("event:").trim()
                            line.startsWith("data:") && lastEvent == "playlist-changed" -> onChanged()
                        }
                    }
                }
            } catch (_: Exception) {
            } finally { onClosed() }
        }.apply { isDaemon = true }.start()
        return Closeable { call.cancel() }
    }
}
```

- [ ] **Step 3: Compile-check on Alienware:** `./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL (no device needed). (No unit test here — networking is exercised manually on device in Task 8.)

- [ ] **Step 4: Commit**
```bash
git add android-tv-ads/app/src/main/kotlin/pl/zira/tvads/net/AdApiClient.kt android-tv-ads/app/src/main/kotlin/pl/zira/tvads/prefs/HostStore.kt
git commit -m "feat(tv-ads-android): OkHttp playlist fetch + SSE events client"
```

---

## Task 5: NsdDiscovery — mDNS discovery (Android)

**Files:** `discovery/NsdDiscovery.kt`

- [ ] **Step 1: Implement** (NsdManager discovers `_zira-ads._tcp`, resolves first service → `http://host:port`, calls `onFound`). Service type string for NsdManager is `"_zira-ads._tcp."` (trailing dot).
```kotlin
// app/src/main/kotlin/pl/zira/tvads/discovery/NsdDiscovery.kt
package pl.zira.tvads.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.io.Closeable

class NsdDiscovery(context: Context) : Closeable {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private var listener: NsdManager.DiscoveryListener? = null

    /** onFound delivers "http://<host>:<port>" for the first resolved POS. */
    fun start(onFound: (String) -> Unit) {
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                nsd.resolveService(info, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(s: NsdServiceInfo, e: Int) {}
                    override fun onServiceResolved(s: NsdServiceInfo) {
                        val host = s.host?.hostAddress ?: return
                        onFound("http://$host:${s.port}")
                    }
                })
            }
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        }
        listener = l
        nsd.discoverServices("_zira-ads._tcp.", NsdManager.PROTOCOL_DNS_SD, l)
    }

    override fun close() {
        listener?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }
        listener = null
    }
}
```

- [ ] **Step 2: Compile-check:** `./gradlew :app:assembleDebug` → BUILD SUCCESSFUL.
- [ ] **Step 3: Commit**
```bash
git add android-tv-ads/app/src/main/kotlin/pl/zira/tvads/discovery/NsdDiscovery.kt
git commit -m "feat(tv-ads-android): NsdManager mDNS discovery of _zira-ads._tcp"
```

---

## Task 6: MainActivity — ExoPlayer player + wiring (Android)

**Files:** `MainActivity.kt` (replace the stub), `res/layout/activity_main.xml`

- [ ] **Step 1: Layout** `app/src/main/res/layout/activity_main.xml`
```xml
<?xml version="1.0" encoding="utf-8"?>
<androidx.media3.ui.PlayerView xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/playerView"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:keepScreenOn="true"
    app:use_controller="false"
    app:resize_mode="fit"
    xmlns:app="http://schemas.android.com/apk/res-auto" />
```

- [ ] **Step 2: Implement MainActivity** — discovery → fetch playlist → build PlaybackPlan → ExoPlayer; SSE reload; manual-IP fallback; immersive + keep awake; reconnect on failure.
```kotlin
// app/src/main/kotlin/pl/zira/tvads/MainActivity.kt
package pl.zira.tvads

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import pl.zira.tvads.discovery.NsdDiscovery
import pl.zira.tvads.net.AdApiClient
import pl.zira.tvads.player.PlaybackPlan
import pl.zira.tvads.player.RepeatMode
import pl.zira.tvads.prefs.HostStore
import java.io.Closeable

class MainActivity : Activity() {
    private lateinit var playerView: PlayerView
    private var player: ExoPlayer? = null
    private lateinit var hostStore: HostStore
    private var discovery: NsdDiscovery? = null
    private var sse: Closeable? = null
    private val scope = CoroutineScope(Dispatchers.Main + Job())
    private var base: String? = null
    private var currentVersion: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)
        playerView = findViewById(R.id.playerView)
        hostStore = HostStore(this)
        player = ExoPlayer.Builder(this).build().also { playerView.player = it }
        connect()
    }

    private fun connect() {
        base = hostStore.lastBase
        if (base != null) { loadAndPlay() }
        // Always (re)start discovery; if it finds a POS, prefer it.
        discovery?.close()
        discovery = NsdDiscovery(this).apply {
            start { found ->
                runOnUiThread {
                    if (base != found) {
                        base = found
                        hostStore.lastBase = found
                        loadAndPlay()
                    }
                }
            }
        }
        if (base == null) {
            // no remembered host + waiting for discovery → offer manual pairing after a grace period
            scope.launch {
                delay(8000)
                if (base == null) startActivity(android.content.Intent(this@MainActivity, PairingActivity::class.java))
            }
        }
    }

    private fun loadAndPlay() {
        val b = base ?: return
        scope.launch {
            try {
                val playlist = withContext(Dispatchers.IO) { AdApiClient(b).fetchPlaylist() }
                currentVersion = playlist.version
                val plan = PlaybackPlan.from(playlist, b)
                applyPlan(plan)
                openEvents(b)
            } catch (e: Exception) {
                // retry shortly (network not ready / POS off)
                delay(5000)
                loadAndPlay()
            }
        }
    }

    private fun applyPlan(plan: PlaybackPlan) {
        val p = player ?: return
        p.repeatMode = if (plan.repeatMode == RepeatMode.ONE) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_ALL
        p.volume = if (plan.muted) 0f else (plan.volume / 100f)
        p.setMediaItems(plan.urls.map { MediaItem.fromUri(it) })
        p.prepare()
        p.playWhenReady = true
    }

    private fun openEvents(b: String) {
        sse?.close()
        sse = AdApiClient(b).openEvents(
            onChanged = { runOnUiThread { reloadIfChanged(b) } },
            onClosed = { /* reconnect handled by next reloadIfChanged/loadAndPlay cycle */ },
        )
    }

    private fun reloadIfChanged(b: String) {
        scope.launch {
            try {
                val pl = withContext(Dispatchers.IO) { AdApiClient(b).fetchPlaylist() }
                if (pl.version != currentVersion) {
                    currentVersion = pl.version
                    applyPlan(PlaybackPlan.from(pl, b))
                }
            } catch (_: Exception) {}
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            window.decorView.systemUiVisibility =
                (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        sse?.close(); discovery?.close(); player?.release()
    }
}
```
> NOTE: Media3 1.4.1 PlayerView/ExoPlayer APIs are stable but marked `@UnstableApi` for some symbols. If the build fails with "unstable API" errors, add `@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)` on `MainActivity` (or add `freeCompilerArgs += "-opt-in=androidx.media3.common.util.UnstableApi"` to `kotlinOptions` in `app/build.gradle.kts`). Apply whichever the compiler asks for.

- [ ] **Step 3: Build:** `./gradlew :app:assembleDebug` → BUILD SUCCESSFUL.
- [ ] **Step 4: Commit**
```bash
git add android-tv-ads/app/src/main/kotlin/pl/zira/tvads/MainActivity.kt android-tv-ads/app/src/main/res/layout/activity_main.xml android-tv-ads/app/build.gradle.kts
git commit -m "feat(tv-ads-android): ExoPlayer player + discovery/SSE wiring in MainActivity"
```

---

## Task 7: PairingActivity — manual IP fallback (Android)

**Files:** `PairingActivity.kt` (replace stub), `res/layout/activity_pairing.xml`

- [ ] **Step 1: Layout** `activity_pairing.xml` — a title, an EditText for `IP:port` (default port hint 17893), and a Connect button (focusable for D-pad).
```xml
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical" android:gravity="center"
    android:padding="48dp"
    android:layout_width="match_parent" android:layout_height="match_parent">
    <TextView android:layout_width="wrap_content" android:layout_height="wrap_content"
        android:text="Nhập IP POS (vd 192.168.1.5:17893)" android:textSize="22sp" />
    <EditText android:id="@+id/ipInput" android:layout_width="360dp" android:layout_height="wrap_content"
        android:inputType="text" android:hint="192.168.1.5:17893" android:textSize="22sp" />
    <Button android:id="@+id/connectBtn" android:layout_width="wrap_content" android:layout_height="wrap_content"
        android:text="Kết nối" android:textSize="22sp" />
</LinearLayout>
```

- [ ] **Step 2: Implement** — normalize input to `http://host:port` (default port 17893 if omitted), `GET /health`; on success store base + return to MainActivity; on failure show a toast.
```kotlin
// app/src/main/kotlin/pl/zira/tvads/PairingActivity.kt
package pl.zira.tvads

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import pl.zira.tvads.net.UrlBuilder
import pl.zira.tvads.prefs.HostStore
import java.util.concurrent.TimeUnit

class PairingActivity : Activity() {
    private val scope = CoroutineScope(Dispatchers.Main + Job())
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pairing)
        val input = findViewById<EditText>(R.id.ipInput)
        findViewById<Button>(R.id.connectBtn).setOnClickListener {
            val raw = input.text.toString().trim()
            if (raw.isEmpty()) return@setOnClickListener
            val base = normalize(raw)
            scope.launch {
                val ok = withContext(Dispatchers.IO) { health(base) }
                if (ok) {
                    HostStore(this@PairingActivity).lastBase = base
                    startActivity(Intent(this@PairingActivity, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                    finish()
                } else {
                    Toast.makeText(this@PairingActivity, "Không kết nối được $base", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun normalize(raw: String): String {
        val noScheme = raw.removePrefix("http://").removePrefix("https://").trimEnd('/')
        return "http://" + if (noScheme.contains(":")) noScheme else "$noScheme:17893"
    }

    private fun health(base: String): Boolean = try {
        val c = OkHttpClient.Builder().connectTimeout(4, TimeUnit.SECONDS).readTimeout(4, TimeUnit.SECONDS).build()
        c.newCall(Request.Builder().url(UrlBuilder.absolute(base, "/health")).build()).execute().use { it.isSuccessful }
    } catch (e: Exception) { false }
}
```

- [ ] **Step 3: Build:** `./gradlew :app:assembleDebug` → BUILD SUCCESSFUL.
- [ ] **Step 4: Commit**
```bash
git add android-tv-ads/app/src/main/kotlin/pl/zira/tvads/PairingActivity.kt android-tv-ads/app/src/main/res/layout/activity_pairing.xml
git commit -m "feat(tv-ads-android): manual IP pairing fallback screen"
```

---

## Task 8: Release APK + full verification

**Files:** none (build + manual)

- [ ] **Step 1: Run all unit tests:** `./gradlew :app:testDebugUnitTest` → all PASS.
- [ ] **Step 2: Build release APK:** `./gradlew :app:assembleRelease`
Expected: BUILD SUCCESSFUL; `app/build/outputs/apk/release/app-release.apk` exists (debug-signed for sideload).
- [ ] **Step 3: Retrieve the APK** from Alienware (scp to the user / R2) and document the sideload steps for Google TV (enable Developer options → Unknown sources; install via `adb install` or a sideload app like "Downloader").
- [ ] **Step 4: Manual on-device E2E** (with POS running Plan 1 on the same LAN, ad feature enabled, ≥1 video):
  - Launch app → it discovers POS (or use pairing screen) → playlist plays full-screen, looping.
  - In POS Settings change playback mode / add a video / toggle mute → TV updates within a few seconds (SSE).
  - Kill Wi-Fi then restore → app recovers and resumes.
  - Reboot TV → app auto-starts (BOOT_COMPLETED) and resumes playback.
- [ ] **Step 5: Commit any fixes found during manual testing**, then this plan is complete.

---

## Self-Review notes

- **Spec coverage:** mDNS discovery (T5), manual IP fallback (T7), playlist fetch + 2 playback modes (T2,T3,T6), instant SSE update (T4,T6), muted/volume from POS (T3,T6), keep-screen-on + immersive + boot-start (T1 manifest, T6), sideload APK (T1,T8). QR pairing from the design is REDUCED to manual IP entry (YAGNI; QR can be added later by having POS show a QR of `ip:port` — not required for MVP).
- **Pure-logic isolation:** PlaylistParser, UrlBuilder, PlaybackPlan are JVM-unit-tested (no device). Android glue (OkHttp/NSD/ExoPlayer/Activities) is verified by a compiling Gradle build + on-device manual run.
- **Placeholder scan:** every code step has complete code; the only intentional "adapt if compiler asks" notes are the Media3 `@UnstableApi` opt-in and the `org.json` test dependency — both with concrete remedies.
- **Type consistency:** `Playlist`/`AdVideo` shapes, `PlaybackPlan.from(playlist, base)`, `RepeatMode.{ALL,ONE}`, `UrlBuilder.absolute(base, rel)`, `AdApiClient(base).fetchPlaylist()/openEvents(...)`, `HostStore.lastBase`, `NsdDiscovery.start{onFound}` are consistent across tasks.
- **Build env:** all gradle commands run on Alienware via SSH (`JAVA_HOME`=JDK17, `ANDROID_HOME=C:\Android\sdk`); the Netcup clone only authors files.
