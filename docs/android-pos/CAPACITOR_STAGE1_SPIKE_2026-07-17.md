# Capacitor Android B1 Stage 1 spike

Date: 2026-07-17
Status: development-only static diagnostic shell; runtime recreation test blocked by the current host

## Pinned toolchain

- Node.js `22.22.2`
- npm `10.8.2`
- Capacitor core/CLI/Android `8.4.2`
- Android Gradle Plugin `8.13.0`
- Gradle `8.14.3`
- Gradle distribution SHA-256 `ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c`
- JDK `21.0.11`
- Android compile SDK `36`
- Android target SDK `36`
- provisional minimum SDK `28`

The repository's existing Node 20 engine declaration is intentionally unchanged. This spike runs on the reviewed Node 22 lane without claiming that the desktop dependency baseline has migrated.

## Scope and safety boundary

- Development application ID: `com.ziraai.posdiagnostics.dev`.
- The generated native project is checked in at `android-pos/` and uses the default local Android debug signer only.
- The isolated entry is `src/renderer/android-pos/main.ts`; it imports no desktop/shared POS UI.
- The screen is static HTML/CSS. It has no auth, token storage, network request, order, stock, payment, fiscal, print, update, SQLite, or publication path.
- The merged manifest declares no Internet permission, disables backup, rejects cleartext traffic, and contains no file-sharing provider.
- The merged-manifest gate rejects every permission except Capacitor's app-scoped dynamic-receiver permission, which must remain signature-protected.
- Both backup and Android 12+ device-transfer rules exclude the complete app root as defense in depth behind `allowBackup=false`.
- Capacitor logging, mixed content, WebView debugging, Cordova wildcard origins, and Google Services wiring are explicitly disabled. No release signer or signing secret exists in this repository.

## Mandatory gates

Source graph gate:

```bash
npm run test:android:boundaries:source
```

Built web bundle gate (after `npm run build:android:web`):

```bash
npm run test:android:boundaries:bundle
```

Full Stage 1 source plus bundle gate:

```bash
npm run test:android:boundaries
```

Exact toolchain and merged-manifest gates:

```bash
npm run android:preflight
npm run test:android:policy
npm run test:android:manifests
```

Native synchronization and build gates:

```bash
npm run android:sync
npm run android:build:verify
```

`android:sync` is intentionally fail-closed: it reruns the source and Vite-bundle gates, rebuilds the web output, copies it into the native project, and then scans `android-pos/app/src/main/assets/public`. This prevents a stale or different web bundle from being packaged after a green source-only check.

`android:build:verify` intentionally runs only `:app:test`, `:app:assembleDebug`, and `:app:assembleDebugAndroidTest`, with Gradle daemon and parallel execution disabled. Do not replace these with unqualified aggregate tasks: `assembleDebugAndroidTest` also selects the generated empty Cordova module's test APK and currently fails its unrelated duplicate-Kotlin-class check.

With the isolated API 36 emulator online, the activity-recreation test is:

```bash
npm run test:android:instrumentation
```

It launches the real `MainActivity`, verifies the static diagnostic DOM, calls `ActivityScenario.recreate()`, and verifies the DOM again. It does not invoke a network or business path.

The source graph and final Vite web assets must both pass. A source-only result is insufficient.

## Verification evidence and remaining blocker

The following gates passed on the Linux build host:

- exact Android toolchain preflight;
- 53/53 cross-platform boundary tests, including dormant network APIs and built-bundle URL detection;
- Android Stage 1 policy tests;
- source graph and final Vite bundle scan;
- reproducible fail-closed `android:sync`, including a scan of the exact copied native web assets;
- merged debug and release manifest verification;
- Gradle unit tests, `assembleDebug`, and `assembleDebugAndroidTest`;
- the existing Windows/Electron TypeScript and Vite build.

The B1 `package.json` and lockfile were also copied to an isolated Windows checkout at `C:\Users\pc\POS-zira-b1-win-baseline-20260717`. Under Node `22.23.1`/npm `10.9.8`, `npm ci` and `npm run build` passed. The full Windows suite passed 237 test files and 2059 tests with 13 skips; the only failed suite was the pre-existing E2E harness incompatibility where nested `npx tsc` returns npm `EUSAGE`. The installed counter app and live source checkout were not changed or restarted.

`connectedDebugAndroidTest` was attempted twice on the isolated API 36 `rf_pixel_36` AVD. This host has no `/dev/kvm`; the software-emulated AVD did not reach `sys.boot_completed`, and ddmlib reported `ShellCommandUnresponsive`/unknown API level before executing a test. The recreation test is compiled into the AndroidTest APK but has not passed at runtime. B1 must remain development-only and cannot unlock Stage 2 or any production lane until that test passes on a hardware-accelerated emulator or a real test tablet.
