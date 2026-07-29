# R12 Windows installer decision — 2026-07-29

## Owner decision

For the Chesaigon receipt-latency release, Paul limited the solution to the
Windows POS application and system configuration because installing a separate
POS2 receipt printer is not currently feasible. The Windows installer must not
carry or depend on the unrelated Android TV APK.

The selected R12 option is therefore **removal from the Electron/Windows
`extraResources` list**. This is not approval to build, copy, sign, publish, or
otherwise manufacture an Android TV artifact.

## Evidence and scope

- The installed Chesaigon Zira AI 1.0.25 application on both POS machines does
  not contain `tv-ads/app-release.apk`.
- The source checkout contains no provenance-reviewed APK at the configured
  path, so retaining the dependency would make a clean Windows build
  impossible or risk packaging stale local bytes.
- Removal changes no capability present in the currently installed Windows
  application.
- The Android POS production-readiness decisions, signing, Play distribution,
  and legacy publication lanes remain blocked and are outside this decision.

## Verification

The Windows package preflight must report no `BLOCKED_R12` entry after the
configuration change. The repository-wide production gate must remain
`NO-GO` for its other independent Android production blockers.
