# Claude-GLM work packets — Zira POS Android shared runtime

Status: REVIEWED WORK SPLIT
Date: 2026-07-17
Parent plan: `docs/android-pos/IMPLEMENTATION_PLAN_2026-07-17.md`
Execution rule: a packet may start only when all dependencies and the named gate are satisfied.

## 1. Verdict and boundaries

Claude-GLM review work began with three verified P0 defects; the authoritative backend register now contains eight P0 release blockers plus multiple P1 architecture/release traps. The useful automation boundary is therefore:

- **Safe now:** read-only inventory, docs, executable characterization tests, AST/import boundary tooling, type-only extraction, synthetic Android/SQLite spikes, and build-only CI with no publication.
- **Blocked:** Android writes, electronic/offline payment, real print/fiscal jobs, backend entity/migration, signing secrets, Play/R2 publication, production deploy, and any change/restart on `chesaigon`.

Phase -1 selected the full-history feature checkout `/var/www/www/enail/POS-zira-android-dev-20260717` at base `f0ee58b`; the old shallow download remains evidence only. Safety commits are not considered landed until the reconciliation packet is implemented and tested.

## 2. Agent ownership

| Agent | Primary responsibility | Review status |
|---|---|---|
| `claude_glm_arch` | source provenance, shared application/port boundary, auth/state ownership, executable domain fixtures | review completed |
| `claude_glm_android` | Capacitor/Android toolchain, adaptive tablet behavior, SQLite/security/update/build constraints | review completed |
| `claude_glm_backend_prod` | backend auth/idempotency/print/fiscal contract and eNail production-lane traps | review completed |

Agents own evidence and scoped diffs, not production decisions. Root/senior review integrates results and decides whether the next packet becomes eligible.

## 3. Global rules for every packet

1. Start with `git status --short --branch`, exact branch/HEAD, and the applicable `AGENTS.md`.
2. Preserve unrelated WIP; do not clean, stash, reset, checkout over, or broadly format user files.
3. One packet equals one narrow branch/diff. No packet may silently absorb another packet's scope. A root-owned integration branch may contain multiple separately reviewed packet commits, but it is not itself evidence that any packet passed its named gate.
4. Every output states `planned`, `implemented on feature branch`, `landed on canonical`, `built`, `deployed`, and `verified live` separately.
5. Tests must be executable behavior tests, not only source-string assertions.
6. Fixtures use synthetic/sanitized data; no production credentials, receipt payloads, customer data, signing keys, or real printer IDs.
7. No agent may push/merge/tag/publish/deploy unless Paul separately requests that exact action after review.

## 4. Wave A — eligible preparation packets

### GLM-A1 — API/auth/idempotency contract matrix

Owner: `claude_glm_arch` with backend cross-check by `claude_glm_backend_prod`
Status: PROVISIONAL DRAFT ONLY until Phase -1 names immutable POS and backend SHAs
Runtime impact: none; docs only

Scope:

- Map each Android MVP operation to exact route, HTTP method, auth principal, role, feature gate, tenant source, idempotency fields/header, timeout, retry, authoritative reconciliation route, and error states.
- Cover staff login/refresh/logout, catalog/category/barcode, order create/history, shift open/active/close, printer assignments, print create/status/safe-retry, and fiscal event recording.
- State explicitly that Android order/shift/print/fiscal routes use staff JWT by default. Android does not store the salon-wide print-agent `pa_` key or call `/print-agent/connect`; any future separate credential is terminal-scoped.
- Mark current P0/P1 contract defects and whether each blocks read, write, payment, or fiscal operation.

Deliverables:

- `docs/android-pos/API_AUTH_CONTRACT_MATRIX.md`
- `docs/android-pos/OPEN_BACKEND_CONTRACT_DECISIONS.md`

Acceptance:

- Every row cites exact client and backend file:line evidence.
- The document header records immutable POS and backend SHAs; before Phase -1 exits it is marked provisional and cannot unlock runtime work.
- Windows 1.0.23 behavior and proposed Android behavior are separate columns.
- No route is labelled idempotent without naming the database uniqueness/reconciliation behavior.
- Diff contains docs only.

Forbidden:

- No controller/service/entity/migration change.
- No live HTTP write, login, API-key validation, order, or print-job call.

### GLM-A2 — Three-ledger and state-ownership specification

Owner: `claude_glm_arch`
Status: PROVISIONAL DRAFT ONLY until Phase -1 names immutable POS and backend SHAs
Runtime impact: none; docs/tests design only

Scope:

- Specify separate ownership for:
  - immutable order upload journal/outbox;
  - catalog/read-model `local_sync_log`;
  - ERP/financial `pos_event_outbox`.
- Define stable IDs, payload hash, tenant/device binding, transaction boundary, state transitions, retry authority, reconciliation, diagnostics, retention, and dead-letter ownership.
- Define shift-close behavior when local unresolved work exists.
- Define a separate shift-command journal and server idempotency/reconciliation contract for open/close; if the contract is absent, Android shift writes remain disabled/read-only.
- Define cart/draft durability separately from submitted order durability.

Deliverable:

- `docs/android-pos/STATE_OWNERSHIP_AND_LEDGER_SPEC.md`

Acceptance:

- One state diagram per ledger.
- One transaction table showing which rows commit atomically.
- At least nine chaos cases have expected terminal/unresolved outcomes.
- Explicit statement: `pos_event_outbox` never uploads the order itself.
- Output cannot unlock A4/A5 until Phase -1 and the API contract review both exit GO.

### GLM-A3 — Android transitive boundary verifier

Owner: `claude_glm_arch`
Status: A3a READY after canonical checkout; A3b runs after B1 creates the real entry
Runtime impact: test/tooling only

Scope:

- A3a: build the verifier against synthetic entry/import fixtures, with no dependency on an Android project.
- A3b: after B1 Stage 1 creates the real minimal Android entry, run the same verifier against every transitively reachable real module before shared UI is imported.
- Fail on `window.electronAPI`, Electron imports, Node built-ins/globals, main-process repositories, direct Capacitor use in core/application, and unsafe top-level platform side effects.
- Include positive and intentionally forbidden fixtures.

Expected files:

- `scripts/verify-cross-platform-boundaries.mjs`
- focused tests/fixtures under `tests/`

Acceptance:

- The verifier fails on a fixture containing only global `window.electronAPI` access, even with no Electron import.
- The verifier catches a transitive forbidden import, not only the synthetic or real entry file.
- Existing `npm test`, renderer typecheck, main build, and renderer build are unchanged.
- No application runtime file is migrated in this packet.

### GLM-A4a — Canonical POS domain types

Owner: `claude_glm_arch`
Status: QUEUED after Phase -1, A1/A2 review, and a recorded Windows baseline
Runtime impact: type-only extraction

Scope:

- Add canonical cart/order/tender/shift type definitions with compatibility re-exports from an exact pre-reviewed file allowlist.
- Do not move reducers, payload builders, timers, repositories, API calls, IPC, or state ownership.

Acceptance:

- Zero emitted/runtime behavior diff.
- Existing tests, renderer typecheck, main build, and renderer build match baseline.

### GLM-A4b — Legacy executable characterization and seam inventory

Owner: `claude_glm_arch`
Status: QUEUED after A4a; test-only
Runtime impact: tests/fixtures only

Scope:

- Execute current exported behavior for cash, disabled legacy CARD/BLIK/split shapes, weighted quantity, VAT, discount, NIP, shift/staff, and current Windows 1.0.23 order sync.
- Freeze UUID/time and record the actual legacy DTO/header behavior, including that Windows 1.0.23 does not send the strong `Idempotency-Key` header.
- Produce a seam map for logic still embedded in renderer/main orchestration. If it cannot be called without runtime extraction, mark it `UNCHARACTERIZED_BLOCKER`; do not add source-string assertions or silently extract it.

Acceptance:

- Fixtures distinguish current legacy behavior from the proposed Android contract.
- CARD/BLIK/split are disabled compatibility cases, never approved runtime payment flows.
- Output proposes exact files/functions for A5 without modifying them.

### GLM-A5 — Pure payload/idempotency builder extraction

Owner: `claude_glm_arch`
Status: BLOCKED until A4b evidence and a separate scoped-diff review are GO
Runtime impact: narrow runtime refactor with no behavior change

Scope:

- Extract one pre-approved pure builder at a time from the exact renderer/main seams identified by A4b.
- Preserve Windows legacy payload behavior behind compatibility tests; separately expose the stronger Android request contract only as non-wired pure code.

Acceptance:

- Windows before/after payload fixtures are byte/semantic equivalent as applicable.
- Proposed Android retry preserves identical local ID, `Idempotency-Key`, `clientAttemptId`, DTO, and payload hash; reused key with changed payload becomes conflict/manual.
- No HTTP wiring, Android entry, payment enablement, or backend change.

## 5. Wave B — synthetic Android packets

### GLM-B1 — Capacitor 8 toolchain and read-only shell spike

Owner: `claude_glm_android`
Status: Stage 1 and Stage 2 synthetic catalog ACCEPTED for development after A3b and API 36 recreation passes; production and real data remain locked
Runtime impact: development-only Android shell; no production application ID/signing

Prerequisites:

- Canonical full-history branch is selected.
- The isolated Windows Node 22/npm 10 clean-install/test/build baseline is recorded; its single E2E harness failure and the still-pending installer/update smoke remain explicit blockers.
- Owner has not yet approved a final package ID, Play app, or signer.

Scope:

- Pin exact Node 22/npm 10/Capacitor 8/AGP 8.13/Gradle 8.14.3/JDK 21/SDK 36 versions in the spike.
- Stage 1 adds a minimal Android entry that renders an isolated static diagnostic screen and imports no shared POS UI.
- Run A3b on that real entry/import graph.
- Stage 2 may add fake/read-only shared catalog UI only after A3b passes.
- Use a development package ID and debug signer.
- Prove Windows dependency/test/build behavior under Node 22 before proposing repository engine/CI changes.
- Support rotation, portrait fallback, split window, activity recreation, and safe-area/keyboard behavior; landscape is only the reference viewport.

Acceptance:

- `npm ci`, POS tests, typecheck, main build, renderer build all pass or match the recorded baseline under Node 22.
- `cap sync`, Gradle unit test, and debug assemble pass on a clean environment.
- The Stage 1 Android bundle passes A3b before Stage 2 shared imports; the final packet contains no business write path.
- Rotating/recreating the activity preserves only synthetic UI state expected by the test.

Forbidden:

- No production app ID, release keystore, Play/R2 upload, staff production login, API key, order, or print route.

### GLM-B2 — Native SQLite synthetic ADR/spike

Owner: `claude_glm_android`
Status: QUEUED after B1 and A2
Runtime impact: isolated synthetic database only

Scope:

- Compare a reviewed community plugin with a feature-oriented custom plugin.
- Evaluate Java/JDK/AGP compatibility, SQLCipher/export implications, deprecated dependencies, WAL/checkpoint, transaction behavior, corruption preservation, schema upgrade, diagnostic export, and process-death behavior.
- Implement only a fake catalog and fake order-journal schema.
- Add `allowBackup=false`, Android 12+ `dataExtractionRules`, legacy `fullBackupContent`, and no-backup secret/device-identity locations.

Acceptance:

- Atomic order + items + upload intent test.
- Migration N to N+1 and failed-migration preservation test.
- Kill/reopen, reboot, storage pressure, corrupt DB, reinstall, cloud-restore, and device-transfer exclusion evidence.
- No real POS order schema migration is approved merely because the spike passes.

Owner gate after packet:

- Senior/owner selects plugin vs custom implementation, encryption/export posture, and recovery policy.

### GLM-B3 — Scanner/HID and adaptive-layout hardware spike

Owner: `claude_glm_android`
Status: BLOCKED until two named tablets and scanner hardware exist
Runtime impact: diagnostic screen only

Scope:

- Camera EAN13/CODE128 scan and USB keyboard-wedge path.
- Focus/IME, suffix key, rapid repeat, duplicate suppression, permission refusal, sleep/wake, rotation, split-window, and resume.

Acceptance:

- Results matrix for each named device/scanner/Android/WebView version.
- No scan invokes cart, payment, order, stock, or print behavior.

### GLM-B4 — Build-only dual-platform CI and security gates

Owner: `claude_glm_android`
Status: QUEUED after B1
Runtime impact: CI artifacts only; no publication

Scope:

- Separate shared tests, Windows build, Android build, manifest generation, and static Android policy checks.
- Upload immutable CI artifacts only.
- Prove same Git SHA/product version, independent platform build numbers, SHA-256, compatibility metadata, and separate upload/Play-app-signing/sideload certificate fingerprint fields.
- Fail Play flavor on installer permission/self-updater, backup enabled, cleartext/debuggable, unsafe navigation/bridge/exported component, or missing CSP.
- Detect the current hidden Android TV APK resource dependency and fail with an actionable message.
- On that detection return `BLOCKED_R12`. This packet must not remove, build, copy, or sign the Android TV APK.

Acceptance:

- Workflow has no R2/Play production secrets or publish step.
- A failed required build cannot update any mutable channel manifest.
- Windows installer validation runs on Windows; Android runs on the pinned supported toolchain.

## 6. Wave C — backend/fiscal packets requiring separate review

### GLM-C1 — P0 backend regression tests and fix proposal

Owner: `claude_glm_backend_prod` for evidence/tests; senior backend owner for runtime fix
Status: TEST DESIGN READY; RUNTIME FIX BLOCKED pending a separate explicit implementation request
Runtime impact: none in this plan

Required tests:

1. A salon cannot find or mutate another salon's fiscal receipt using `printJobId`, `orderId`, `b2bOrderId`, or printer ID.
2. An existing receipt's `salonId` is immutable.
3. Referenced print job/order/printer must belong to the authenticated salon.
4. `COMPLETED -> PRINTED`.
5. `FAILED + SAFE_BEFORE_PRINT -> NOT_PRINTED`.
6. `FAILED + UNCERTAIN_AFTER_PRINT -> UNKNOWN`.
7. Failed job with missing proof/failure class -> `UNKNOWN`.
8. `UNKNOWN` never permits automatic retry.
9. `UNKNOWN` cannot be downgraded by an ordinary client event; only authoritative late `COMPLETED` evidence may promote it to `PRINTED`.
10. Manual reconciliation requires owner role, reason, evidence, actor, and audit timestamp.
11. `PRINTED` remains terminal/sticky; all transitions consider source authority as well as enum value.

Release constraint:

- This is a separate eNail backend security/reliability release. It must start from the canonical eNail trunk, use exact committed source/dist files, pass the guarded deploy gate, and verify the built Contabo artifact. The Android plan authorizes none of those mutation/deploy steps.

### GLM-C2 — Server-side Android device/kill-switch RFC

Owner: `claude_glm_backend_prod`
Status: READY as docs/tests design; implementation blocked

Scope:

- Compare a dedicated POS-device registration/session model with a staff-session-only client; do not reuse print-agent identity.
- Require staff JWT for Android sale, shift, printer discovery, print create/status, and fiscal routes.
- Prohibit Android storage/use of the salon-wide `pa_` key and prohibit `/print-agent/connect`. If a future separate credential is needed, it is terminal-scoped and does not own printers or WebSocket presence.
- Define server-enforced per-salon/device gates, default false: device/session access, catalog, sales, offline sales, remote fiscal, minimum app version.
- Include audit log, revoke/unpair, bounded refresh lifetime, lost-device response, and compatibility with Windows 1.0.23.

Acceptance:

- No trust decision depends on a client-supplied `clientPlatform` header alone.
- Android never registers/forks as an online print agent, stores the salon-wide `pa_` key, or steals printer assignments.
- RFC states whether persistence/migration is needed and why.

### GLM-C3 — Production release/migration audit

Owner: `claude_glm_backend_prod`
Status: READY; docs only

Scope:

- Require a clean session worktree based on canonical `origin/feat/product-admin-create-product`; do not implement in the shared dirty root.
- Map any proposed backend files to the current transitional guarded lane and fixed deploy root `/var/www/www/enail`.
- Before deploy, require fetched canonical/`origin/production`, local HEAD equal canonical, affected backend tree clean, and stop on any production-only blob guard. Never use `--allow-prod-ahead`.
- Require exact one-to-one committed `.ts -> .js` file pairs, isolated build from the production snapshot, and SHA-256 verification before ship.
- State that `scripts/release-contabo.sh`, `--migrate`, direct SSH source edits/builds, rsync/SCP, direct PM2, generic deploy scripts, manual production push, and Contabo builds are forbidden.
- Require the installed pre-push hook checksum to match on Netcup and Contabo source checkouts.
- Identify when a migration diff freezes the minimal lane and requires a separate backup/recovery/owner-approved release plan.

Acceptance:

- Checklist explicitly separates planned, committed on feature branch, landed canonical, built, guarded deployed, production snapshot, and verified-live states.
- No command in this docs packet changes branch, stages/commits/pushes, deploys, migrates, restarts, or writes production state.

Deliverable:

- `docs/android-pos/BACKEND_RELEASE_GATES.md`

## 7. Tasks not suitable for autonomous Claude-GLM execution

- Reconcile/cherry-pick fiscal or DB safety commits into canonical without human review.
- Fix/deploy the live P0 backend bugs without a separate explicit implementation and deploy request.
- Create/alter backend entities or run any migration.
- Use production JWT, `pa_` key, customer/order data, Play service account, R2 secret, or signing key.
- Create real order/payment/refund/fiscal/print jobs, retry an unknown print, print receipts/Z-reports, or open a cash drawer.
- Integrate or simulate provider authorization as real CARD/BLIK capture.
- Publish a tag, R2 `latest.yml`, Play track, private app, or managed-device policy.
- Build on Contabo or mutate/restart production services.
- Modify/build/install/restart `C:\Users\pc\POS-zira` or `C:\Program Files\Zira AI` without a later explicit Windows rollout request.
- Merge/push canonical or production branches.

## 8. Review checkpoints

After each packet, root/senior review returns one verdict:

- `GO`: packet is complete and the next dependency may start.
- `GO_WITH_CHANGES`: narrow corrections are required, but no architecture reset.
- `NO-GO`: contract/security evidence invalidates the next packet.

No packet completion is evidence of production readiness. Production requires separate artifact, deployment, hardware, reconciliation, and owner-approval evidence.
