# Capacitor Android B1 Stage 1 spike

Date: 2026-07-17
Status: Stage 1 accepted for development after two API 36 runtime passes; production remains locked

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

## Verification evidence

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

The Linux host's isolated API 36 `rf_pixel_36` AVD could not boot because that host has no `/dev/kvm`. Runtime validation was therefore moved to the Alienware test machine, where Android Emulator `36.6.11`, API 36 `default;x86_64`, and WHPX hardware acceleration were verified. No source build ran there because its default Node/JDK versions differ from the pinned B1 toolchain.

The exact Linux-built APKs used for runtime validation were:

- app: `86156286f7144cacd56200671faa4ce8a9fae9ef1e61c1d2805501a7e86d9f57`;
- AndroidTest after the lifecycle polling fix: `eca8de412b1305bee05d505967890295619bff44a809f94819d1644959e5e6f5`.

The first hardware-accelerated run exposed a real synchronization defect in the test: it failed immediately when the first one-second JavaScript callback missed its deadline instead of continuing the documented bounded polling loop. The test was fixed to keep polling and to assert only after the overall deadline.

After that fix, both a running-emulator install and a second cold `-wipe-data` boot with fresh APK installs passed:

- device API: `36`;
- package: `com.ziraai.posdiagnostics.dev`;
- tests: `OK (2 tests)`;
- instrumentation result: `INSTRUMENTATION_CODE: -1`;
- covered behavior: development app ID, diagnostic DOM load, `ActivityScenario.recreate()`, and diagnostic DOM load after recreation.

This closes the Stage 1 runtime blocker and permits Stage 2 development of fake/read-only catalog UI under the existing boundary gates. It does not authorize production publication, real authentication, order/payment writes, printing, fiscal operations, production signing, or an update lane.
