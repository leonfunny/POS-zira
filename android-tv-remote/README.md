# Zira TV Remote — Android phone controller

Small Android phone app for controlling the POS Zira TV Ads playlist through the POS LAN remote page.

Flow:

1. Open POS Zira > Settings > TV Ads.
2. Scan or copy the Phone remote URL shown by the POS.
3. Open Zira TV Remote, paste/connect.
4. Use the in-app file picker to upload images/videos to the POS playlist.

The app is intentionally a thin WebView wrapper around the POS `/remote` controller so it stays compatible with the TV Ads server API and can upload local phone media quickly.

Build:

```bash
./gradlew :app:assembleRelease
```

APK:

```text
app/build/outputs/apk/release/app-release.apk
```
