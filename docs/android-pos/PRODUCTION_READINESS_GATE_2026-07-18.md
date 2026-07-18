# Production readiness register and executable gate

Status: IMPLEMENTED AS FAIL-CLOSED EVIDENCE TOOLING; RELEASE VERDICT `NO-GO`
Date: 2026-07-18
Branch: `codex/android-pos-build-ci`
Base commit: `6dbf180`
Parent plan: `IMPLEMENTATION_PLAN_2026-07-17.md`; blocker register of record: `OPEN_BACKEND_CONTRACT_DECISIONS.md`

## Delivery state

| State | Result |
|---|---|
| Planned | Yes |
| Implemented on feature branch | Yes |
| Landed on canonical branch | No |
| Pushed to GitHub | No |
| Published/deployed/verified live | No; forbidden in this packet |

This packet (and its same-day follow-up wave below) touches only evidence
tooling, build scripts, and the build-only CI workflow. It changes no
application runtime behavior, no Android identity, no signing, no publication
channel, and no backend state. Passing its tests is not production readiness;
the gate exists precisely to prove the opposite until every blocker closes
with owner-reviewed evidence.

## What was added

- `scripts/verify-production-readiness.mjs` — executable gate. Prints every
  readiness item with PASS/BLOCKED and a detail line, then a `GO`/`NO-GO`
  verdict. Exit codes: `0` only on `GO`; `13` on `NO-GO`; `1` on hard policy
  failures (malformed register, committed signing material, configuration
  ahead of an owner decision).
- `docs/android-pos/production-readiness-register.json` — machine-readable
  owner-decision register. Fourteen entries, all `blocked`. Approving one
  requires `evidence {approvedBy, date, reference}`; the gate rejects an
  approval without complete evidence, unknown/duplicate/missing entries, and
  any decision value other than `blocked`/`approved`.
- `tests/production-readiness-gate.test.ts` — 62 executable tests: each
  detector in both directions on synthetic fixtures, register schema
  validation, fail-closed coupling, and the real-repository verdict.
- npm scripts `gate:production-readiness` and `test:production-readiness`.

## Evidence sources

Checks read build inputs and built artifacts, not prose:

| Item | Evidence |
|---|---|
| `dev-application-id` | `android-pos/app/build.gradle` applicationId/namespace |
| `play-flavor` | Gradle `productFlavors` block |
| `release-signing` | Gradle `signingConfigs` + release build type wiring |
| `version-code-source` | Gradle versionCode binding (`ZIRA_ANDROID_BUILD_NUMBER`) |
| `build-only-security-policy` | `analyzeBuildOnlyPolicy` (workflow YAML, manifest, network config, Capacitor config, CSP) |
| `hidden-tv-apk-r12` | `package.json build.extraResources` (structured `BLOCKED_R12`) |
| `merged-manifest-evidence` | Merged debug/release `AndroidManifest.xml` artifacts under `android-pos/app/build/intermediates/merged_manifests` (backup, cleartext, debuggable, installer permissions, package identity) |
| `legacy-publish-lane` | Every workflow in `.github/workflows` other than the build-only pipeline, scanned for R2/Play/electron-builder publication and tag-triggered installer builds |
| `node-engines-contract` | `package.json` engines vs the pinned Node 22 toolchain |
| `signing-material-hygiene` | Tracked file list (`git ls-files`, fs walk fallback) scanned for `*.jks`, `*.keystore`, `*.p12`, `*.pfx`, `*.pepk`, committed `*.apk`/`*.aab`, `keystore/key/signing/release.properties`, `google-services.json`, `agconnect-services.json`; plus a content scan of tracked gradle/properties sources for literal `storePassword`/`keyPassword` values (environment-sourced values pass) |
| `electron-publish-defaults` | `package.json` `build.publish` vs any electron-builder script missing `--publish never` (electron-builder defaults to `onTagOrDraft` on tagged CI runs; `--dir` builds never publish) |
| `release-artifact-ci` | `scripts/run-android-build.mjs` must exercise release-variant assembly |
| `local-publish-scripts` | Presence of `scripts/build-and-upload.sh`/`.ts`, which can mutate the R2 `latest.yml` update channel gated only by environment variables |
| 14 owner-decision entries | `production-readiness-register.json` |

## Fail-closed semantics

1. The verdict is `GO` only when every automatic item passes, every register
   entry is approved with complete evidence, and there are no hard failures.
   Anything else is `NO-GO` with a non-zero exit code.
2. The gate fails closed in both directions. Clearing an automatic blocker by
   editing configuration while its owner decision is still `blocked` — for
   example setting a production applicationId, adding a `play` flavor, or
   wiring release signing before the corresponding register approval — is a
   hard failure (`configuration is ahead of its owner decision`), not a pass.
3. Committed signing material anywhere in the tracked tree is always a hard
   failure, independent of every other state.
4. Editing the register is not approval. The gate can only verify that the
   evidence fields are present; review must verify the referenced evidence is
   real. Register edits go through the same commit review as code.

## Current verdict (2026-07-18, this checkout)

`NO-GO` — 22 blocked (8 automatic + 14 owner decisions), 5 passing
(`build-only-security-policy`, `merged-manifest-evidence`,
`signing-material-hygiene`, `electron-publish-defaults`,
`release-artifact-ci`), 0 hard failures, exit code 13.

Automatic blockers: development applicationId, no Play flavor, no release
signing contract, per-run CI versionCode, `BLOCKED_R12`, legacy
`.github/workflows/build.yml` R2 publish lane, Node 20 engines contract, and
the ungated local `build-and-upload` R2 scripts.

Three of the automatic checks came from an independent Claude-GLM read-only
audit (2026-07-18) that confirmed all originally planned checks against
file:line evidence and identified the publish-default, release-assembly, and
local-upload gaps.

## Same-day follow-up wave (no owner decision consumed)

Two automatic blockers were closed through reviewed configuration changes
that need no owner decision, and the register evidence is now recorded in CI:

1. `electron-publish-defaults` cleared: `dist` and `dist:win` are pinned to
   `--publish never`. The legacy `build.yml` python R2 upload and the local
   `build-and-upload.ts` upload are deliberate manual paths and keep working;
   only electron-builder's implicit `onTagOrDraft` publication is removed.
2. `release-artifact-ci` cleared: `scripts/run-android-build.mjs` now builds
   `:app:assembleRelease` and `:app:bundleRelease` and fails closed — it
   requires `app-release-unsigned.apk`, refuses a signed `app-release.apk`
   (which would mean release signing appeared without its owner-approved
   packet), and requires the release `.aab`. Both artifacts are unsigned and
   therefore uninstallable/unpublishable. The CI staging of these artifacts
   is dormant in steady state: the `android-build` job is skipped while the
   `security-policy` job exits 12 at the R12 gate, so remote release evidence
   appears only after `BLOCKED_R12` is resolved. Verified locally: the built
   `.aab` contains no `META-INF` signature entries and the release APK is the
   `-unsigned` variant. Note for the owner: `--publish never` suppresses only
   electron-builder's implicit generic-provider PUT to `img.zira.pl` — both
   legacy lanes upload from on-disk artifacts themselves and keep working —
   but confirm nothing depended on that implicit PUT.
3. The build-only workflow's `security-policy` job now records
   `readiness-register.json` via `--evidence-report` (exit 0 on a legitimate
   `NO-GO`, exit 1 on hard policy failures) and uploads it as an immutable
   artifact before the R12 gate exits.

## Dev-lock lockstep

Two existing guards intentionally *enforce* the development state:
`scripts/verify-build-only-ci.mjs` requires the dev applicationId, and
`tests/android-stage1-policy.test.ts` forbids any `signingConfigs` block.
Flipping the Gradle configuration to production values therefore breaks the
`build-only-security-policy` item (and CI) until those guards are revised in
the same reviewed packet. This is deliberate: reaching `GO` is impossible
without a coordinated, reviewed change to the guards, the configuration, and
the owner register together — there is no single-file path to a production
artifact.

A direct consequence: a fully-`GO` end-to-end fixture is impossible to
construct today, because `build-only-security-policy` requires the dev
applicationId while `dev-application-id` requires a production one. The
verdict logic is therefore unit-tested through the exported `computeVerdict`
helper (GO, blocked, failure, and empty-item paths), and a fixture proves a
fully approved register turns all owner-decision items `PASS` while automatic
blockers still force `NO-GO`.

## Known limits

- Gradle checks parse `build.gradle` text. They are build *inputs*, not merged
  artifacts; the merged-manifest item supplies the artifact-level view for the
  security attributes and package identity. A future flavor/signing packet
  should extend the merged-manifest and AAB metadata checks as those artifacts
  start to exist.
- The gate does not verify backend state. `backend-p0-closure` and
  `server-kill-switch` are owner-decision entries whose evidence must come
  from the separate backend release process.
- The gate has no dedicated CI step, but its 61 tests run transitively in the
  build-only workflow because that workflow executes `npm test`. The
  real-repository assertions are a living snapshot of the current blocker
  set: any legitimate approval or configuration change forces a reviewed test
  edit. That is intentional — the snapshot is itself a gate.
- The gate is wired into `.github/workflows/android-pos-build-only.yml` as an
  evidence-report step only (`--evidence-report`): a legitimate `NO-GO` keeps
  the build-only pipeline green while the register state is recorded as an
  immutable artifact; hard policy failures still fail the job. It is
  deliberately not a verdict step — a build-only pipeline must stay green
  while production is legitimately `NO-GO`.

## Local acceptance commands

```bash
npm run test:production-readiness   # 62 tests
npm run gate:production-readiness   # prints items, exits 13 (NO-GO)
npm run test:ci:build-only-policy   # unchanged, still passes
npm run test:build-metadata         # unchanged, still passes
```
