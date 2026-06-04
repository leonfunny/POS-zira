# Zira TV Ads — Android TV signage player

App Android cho **Google TV**: tự tìm POS (POS-zira) qua WiFi nội bộ (mDNS `_zira-ads._tcp`),
tải playlist video quảng cáo từ POS và phát full-screen, loop. Mọi cài đặt điều khiển từ POS
(chọn video, chế độ phát nhiều/lặp-1, mute/volume); đổi ở POS → TV cập nhật ngay qua SSE.

Đây là **client** của module "TV Quảng cáo" phía POS (xem
`docs/superpowers/specs/2026-06-03-tv-ads-signage-design.md`).

## Cấu trúc

```
app/src/main/kotlin/pl/zira/tvads/
  model/Playlist.kt          # data classes
  net/PlaylistParser.kt      # JSON /playlist.json -> Playlist   (unit-tested)
  net/UrlBuilder.kt          # base + /video/x -> URL tuyệt đối   (unit-tested)
  net/AdApiClient.kt         # OkHttp: fetch playlist + SSE /events
  player/PlaybackPlan.kt     # Playlist -> danh sách URL + repeat mode (unit-tested)
  discovery/NsdDiscovery.kt  # NsdManager tìm _zira-ads._tcp (+ MulticastLock)
  prefs/HostStore.kt         # nhớ IP POS lần trước
  MainActivity.kt            # ExoPlayer + wiring (discovery/SSE/retry)
  PairingActivity.kt         # nhập IP thủ công (fallback khi không tìm thấy)
  BootReceiver.kt            # tự chạy khi bật TV
app/src/test/kotlin/...      # JUnit (parser, playback-plan)
```

## Build (cần Android SDK + JDK 17)

```bash
# yêu cầu: ANDROID_HOME trỏ tới Android SDK (platforms;android-34, build-tools;34.0.0), JDK 17
gradle :app:assembleRelease        # hoặc ./gradlew nếu có wrapper
# -> app/build/outputs/apk/release/app-release.apk  (debug-signed, sideload được ngay)
gradle :app:testDebugUnitTest      # chạy unit test logic thuần
```

## Cài lên Google TV (sideload)

1. Trên Google TV: **Settings → System → About → bấm "Android TV OS build" 7 lần** để bật Developer options.
2. **Settings → System → Developer options → bật "Install unknown apps"** (hoặc cho app sideload như *Downloader*).
3. Cài APK bằng một trong các cách:
   - **adb** (cùng LAN): `adb connect <ip-tv>:5555 && adb install app-release.apk`
   - hoặc copy APK lên USB / dùng app *Downloader* nhập link tải APK.
4. Mở app **Zira TV Ads**. Nếu POS (cùng WiFi, đã bật "TV Quảng cáo" + có ≥1 video) đang chạy,
   app tự tìm thấy và phát. Nếu không tìm thấy sau ~8s → màn hình nhập IP: gõ `IP-POS:17893`.

## Yêu cầu phía POS

POS-zira phải bật tính năng trong **Settings → TV Quảng cáo**: bật, thêm video mp4 (H.264),
chọn chế độ phát. POS chạy server LAN cổng mặc định **17893** + quảng bá mDNS. TV và POS phải
cùng mạng WiFi nội bộ.
