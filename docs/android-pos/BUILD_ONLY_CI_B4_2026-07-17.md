# GLM-B4 build-only CI evidence

Status: EXPERIMENTAL BUILD EVIDENCE IMPLEMENTED, RELEASE SAFETY `NO-GO`
Date: 2026-07-17
Branch: `codex/android-pos-build-ci`
Base commit: `82dd02a`

## Delivery state

| State | Result |
|---|---|
| Planned | Yes |
| Implemented on feature branch | Yes |
| Landed on canonical branch | No |
| Pushed to GitHub | No |
| CI-built remotely | No |
| Published to R2 or Play | No; forbidden in this packet |
| Deployed or verified live | No |

This packet creates build evidence only. It does not create Android production identity, signing, Play delivery, Windows auto-update, Android auto-update, or cross-platform feature synchronization.

## Workflow behavior

`.github/workflows/android-pos-build-only.yml` has read-only repository permission and no secret, environment, release, R2, Play, or mutable channel operation. Checkout credentials are not persisted and every external action is pinned to a full commit SHA.

The intended job graph is:

1. build-only publication/security policy tests, build metadata tests, and shared platform boundary tests on Linux, followed by the fail-closed R12 gate;
2. the pinned development Android toolchain, source/generated/native boundary scans, Gradle tests, debug APK and AndroidTest APK builds, merged debug/release manifest checks, and generated/native CSP checks on Linux;
3. Windows TypeScript/renderer compilation and boundary tests on a Windows runner.

While R12 exists, the first job exits 12 after uploading its structured gate report; dependent Android and Windows jobs are intentionally skipped. They were validated locally but have not run in remote CI. This prevents an ordinary B4 workflow run from producing a candidate after detecting the hidden dependency.

Artifacts have names containing the full Git SHA, workflow run ID, and run attempt. Android and Windows metadata are generated independently, but both bind to the same Git SHA and package product version. Android uses the workflow run number as its CI-only build number; Windows uses the separate workflow run ID. Android also embeds the shared product version as `versionName` and the validated Android CI build number as `versionCode`. Each metadata document records its run identity, artifact SHA-256, compatibility, platform build number, and separate nullable fields for upload, Play app-signing, and enterprise sideload certificate fingerprints. Development artifacts deliberately leave those three production certificate fields null.

The manual Windows installer job runs only on a Windows runner. It invokes the R12 preflight before `electron-builder`; if the blocker is later resolved through a separately reviewed plan, packaging is explicitly passed `--publish never` and validates that an installer exists before metadata/upload.

## `BLOCKED_R12`

`package.json` currently injects this hidden resource into the Windows installer:

`android-tv-ads/app/build/outputs/apk/release/app-release.apk`

The APK is ignored and absent in a clean checkout. A residual local file would be worse: it could silently package stale or debug-signed bytes. The detector therefore blocks from the configuration dependency whether the file is absent or present. It handles string or object resource entries and alternate APK/TV paths, returns structured `BLOCKED_R12` evidence and exit code 12, and uploads that report even though the job fails.

This packet does not remove, build, copy, hash, sign, or bypass that Android TV APK. An owner-reviewed follow-up must choose one of these product-level outcomes:

- remove the TV APK dependency and update the runtime contract; or
- produce it as an independently signed, versioned, hashed, and provenance-verified dependency with signing-continuity rules.

Until that decision is implemented and reviewed, a clean Windows installer is not a valid B4 artifact.

## Security gates

The policy rejects:

- `pull_request_target`, write permissions, GitHub secret references, R2/Play publication, cloud-copy commands, and Electron publication other than `--publish never`;
- any action outside the exact allowlist, any action not pinned to a full commit SHA, mutable artifact channel names, or artifact names missing Git SHA/run ID/run attempt;
- production Android identity, installer/self-updater permissions, backup, cleartext, debuggable release builds, unsafe Capacitor server/navigation/WebView settings, and weak CSP;
- any CSP directive outside the exact reviewed allowlist, or a mismatch in source, generated web bundle, or exact web assets copied into the native Android project;
- hidden Android TV APK packaging with a machine-readable `BLOCKED_R12` result.

Merged-manifest verification separately denies unexpected permissions, FileProvider exposure, unexpected providers, and exported non-launcher components.

## Known gaps and production traps

- Android remains `com.ziraai.posdiagnostics.dev`, development/debug delivery only. No Play flavor exists, so this packet cannot claim Play eligibility.
- Android now embeds the shared package product version and the validated per-run Android CI build number. A protected monotonic production version-code allocator is still required; GitHub CI run numbers must not be described as Play-safe monotonic allocation across workflow changes, reruns, or tracks.
- Windows installer signing is disabled in current package configuration. A compiled CI archive is not an installable or production-eligible Windows release.
- `package.json` still declares Node 20 engines while the reviewed Android toolchain requires Node `22.22.2`. B4 pins Node 22 in its own workflow but does not broaden the engine/runtime contract.
- **Release-safety NO-GO:** the pre-existing `.github/workflows/build.yml` is a legacy tag/R2 publication lane with production secrets and mutable `latest.yml`. Tags bypass B4 completely. B4 neither invokes nor changes that production lane because disabling it may interrupt the current Windows update channel. It must be separately owner-approved, disabled, or redesigned before repository-wide release safety can be claimed.
- Major runner labels (`ubuntu-latest`, `windows-latest`) can drift even though actions and language toolchains are pinned. Remote CI evidence is still required after landing.
- Clean `npm ci` currently reports 42 dependency advisories (4 critical, 21 high, 15 moderate, 2 low). B4 does not run `npm audit fix --force`; dependency remediation needs a separately reviewed compatibility packet before production eligibility.
- No combined cross-platform release manifest is produced while the Windows installer is blocked. A failed or blocked installer cannot promote or mutate a channel manifest.
- This work does not address production authentication, order writes, payments, printing/fiscal operations, production SQLite encryption/recovery, physical tablet/scanner validation, Chesaigon rollout, or Contabo deployment.

## Local acceptance commands

```bash
npm run test:ci:build-only-policy
npm run test:build-metadata
npm test
npm run test:boundaries
npm run build
npm run android:build:verify
npm run test:android:manifests
node scripts/verify-build-only-ci.mjs --require-built-assets
npm run test:ci:windows-package-preflight  # expected exit 12: BLOCKED_R12
```

On this Linux host the focused B4/Android/build checks pass. The full suite retains the pre-existing platform/harness baseline: 231 test files pass, 12 fail, with 2049 tests passing, 14 failing, and 13 skipped. Failures include Windows-path fixtures running on Linux, Electron Store initialization without an Electron user-data path, and Electron E2E without X11. Windows CI is configured to run the full suite without a waiver, so remote evidence must decide the Windows result.

Passing the focused non-installer checks means the build-only gate implementation is internally consistent. It is not evidence that the application is ready to publish or use in production.
