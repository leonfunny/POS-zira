# POS Zira source reconciliation for Android shared-runtime work

Date: 2026-07-17
Scope: Wave A1/A2 source-of-truth audit only. No safety commit was cherry-picked and no runtime code was changed.

## Decision

Use `origin/main` at `f0ee58bcd1e5217a4926353f0aff1fefd122941f` as the only Android/shared-runtime base.

Do **not** merge or cherry-pick the safety branch as a unit. Reimplement two security/fiscal fixes with hardening, reapply one bounded scheduler fix after validation, replace two unsafe/incompatible designs, and skip two commits whose intent is already present upstream.

Recommended disposition:

- Port intent with production hardening: `3b48b5f`, `08e130f`.
- Reapply after focused tests: `116e68e`.
- Redesign; never cherry-pick unchanged: `05ec166`, `489906c`.
- Skip as upstream-superseded: `67a4439`, `b081d55`.

This reconciliation does not make Android sales production-ready. In particular, the shared fiscal retry work must remain disabled until the server-side tenant and `UNCERTAIN_AFTER_PRINT` blockers are fixed and verified.

## Immutable source facts

| Ref | SHA | Meaning |
| --- | --- | --- |
| Canonical base | `origin/main` = `f0ee58bcd1e5217a4926353f0aff1fefd122941f` | Full-history upstream checkout; branch starting point |
| Safety branch | `safety-local/fix/review-blockers-20260712` = `b081d55e6b4f4be327257c94424f48b562ae54a9` | Seven local safety commits to audit, not a merge source |
| Merge base | `667e2102bca5e14217fb16a747030ab85b766f50` | Last shared commit |
| Divergence | 15 upstream-only / 7 safety-only commits | Requires commit-by-commit reconciliation |

Repository checks:

- Full clone: `git rev-parse --is-shallow-repository` returned `false`.
- Patch identity: `git cherry -v origin/main safety-local/fix/review-blockers-20260712` marked all seven with `+`; none is byte-for-byte patch-equivalent upstream.
- Semantic identity is different from patch identity: `67a4439` and `b081d55` were replaced by later upstream designs and must not be reintroduced.
- Clean base before this documentation-only write: `main...origin/main` with no modified source files.
- Wiki/ADR vault was not present at the documented default locations and was not found using the repo's identifying `AGENTS.md` text. No wiki was modified.

## Commit matrix

### 1. `3b48b5f` — staff PIN gate must fail closed

Disposition: **PORT INTENT WITH HARDENING**, security-critical. The exact patch currently applies cleanly, but it is not a complete production authentication design.

Why it is still needed:

- `origin/main` still routes public self-checkout `staffVerify` to `DELETE_CONFIRM_VERIFY` in `src/preload/preload-self-checkout.ts:63-64`.
- There is no `SELF_CHECKOUT_STAFF_VERIFY`, `selfCheckoutStaffCode`, or main-process lockout implementation on upstream.
- The patch is not semantically replaced by any of the 15 upstream-only commits.

Dependencies and order:

- Independent of the Android extraction itself; land before enabling any self-checkout/assisted-payment surface.
- Keep its fail-closed default. Do not add a legacy `123456` fallback for Android.
- Configuration must have an owner/operator setup path before assisted payment is considered usable; absence of configuration must continue blocking authorization.

Production traps in the safety patch:

- The settings field is `type="text"`, so the current code is displayed in clear text in the UI.
- The code is persisted as plaintext in the general `%APPDATA%/Zira AI/config.json` config rather than a credential store or salted verifier.
- The authoritative lockout is process memory. Restarting the application resets it, so it is not durable rate limiting.
- The renderer keeps a second lockout state in addition to the main-process gate. Two independent counters/timers can produce confusing state and must not become two sources of truth.
- This is a device-local shared secret, not staff identity. Android must use staff JWT/role authorization and must not copy this PIN mechanism as its authentication model.

Acceptance checks:

1. Run `tests/self-checkout-staff-verify.test.ts` and the existing self-checkout smoke suite.
2. Verify blank and `123456` configurations reject every code.
3. Verify three wrong attempts lock in the main process and a renderer/window remount cannot reset the lock.
4. Verify correct configured code works after lockout expiry.
5. Verify no public renderer path can invoke the permissive delete-confirm channel for payment authorization.
6. Mask the setup field, never log/echo the code, and define secure storage or a salted verifier appropriate to the threat model.
7. Persist rate-limit state or explicitly prove kiosk users cannot restart/escape the managed application; keep one authoritative counter.

### 2. `08e130f` — failed fiscal receipt must not silently close the sale

Disposition: **PORT INTENT WITH OPERATOR/AUDIT GATE**, fiscal-safety critical. The exact patch currently applies cleanly, but its bypass action is not automatically production-safe.

Why it is still needed:

- `origin/main` still implements `showFiscalWarningThenClose()` and calls `finishCompletedPayment()` after four seconds in `src/renderer/components/pos/PaymentModal.tsx:343-348`.
- Retry failure clears the recovery state and enters that auto-close path at `PaymentModal.tsx:364-375`.
- The mount-time printer probe can still be false when payment reaches fiscal routing; current routing directly consumes `hasFiscalPrinter` at `PaymentModal.tsx:533-540` and can skip at `565-566`.

Dependencies and order:

- May land before `05ec166`, but the combined fiscal behavior must be tested after both are present.
- Preserve the newer upstream order/fiscal-receipt synchronization at `f0ee58b`; do not weaken or bypass its backend-order guard.
- The explicit "complete without fiscal receipt" action is an operator acknowledgement, not an automatic fallback. Product/legal approval is required before exposing that action in an Android sales build.

Production trap in the safety patch:

- Replacing a silent four-second close with a visible `Complete without fiscal receipt` button is safer, but an unrestricted cashier bypass can still normalize non-fiscalized sales. If the action is allowed at all, require an authorized staff/manager identity, mandatory reason, immutable audit event, and a reconciliation queue. Otherwise remove the bypass and permit only retry/escalation.

Acceptance checks:

1. Run `tests/payment-modal-print-feedback.test.ts` plus payment/fiscal suites.
2. Simulate fiscal printer probe latency and verify the final payment path awaits a fresh probe.
3. Simulate print failure and repeated retry failure; the sale UI must remain in persistent recovery with no timer-based close.
4. Verify retry reuses the safe idempotent fiscal path and cannot create a second paragon.
5. Verify cash, card, BLIK, transfer, invoice, split tender, and no-printer branches independently.
6. Verify bypass is absent or manager-authorized and journaled with operator, reason, order, printer/job IDs, and timestamp.

### 3. `67a4439` — failed category fetch must not wipe local categories

Disposition: **SKIP; UPSTREAM-SUPERSEDED** by `2f9df914` (`fix(products): make native workspace restart-safe and lossless`).

Evidence of replacement:

- Upstream `getPosProducts()` returns `categoriesComplete` in `src/main/network/api-client.ts:2073-2085`.
- A failed public-category request returns `{ categories: [], complete: false }` at `api-client.ts:2258-2279`.
- Both full and delta sync prune only when `data.categoriesComplete` is true at `src/main/sync/product-sync.ts:243-256` and `377-393`.
- Upstream includes regression coverage in `tests/product-sync-category-prune.test.ts` and `tests/api-client-product-normalization.test.ts`.

Why the old patch must not be replayed:

- Its `categoriesAuthoritative` field conflicts with the newer cursor-v2 `categoriesComplete` contract and product-sync guard.
- Reintroducing a second authority flag creates ambiguous pruning behavior and could bypass the newer restore-point/guard flow.

Acceptance checks for the upstream replacement:

1. Run `tests/product-sync-category-prune.test.ts` and `tests/api-client-product-normalization.test.ts`.
2. Force category HTTP timeout/429/5xx with product payload categories present; local categories not in the partial payload must survive.
3. Verify a successful authoritative empty category snapshot can still prune deleted categories.
4. Verify both full and cursor-v2 delta sync enforce the same rule.

### 4. `05ec166` — poll in-flight fiscal jobs and safely unwedge

Disposition: **REDESIGN; DO NOT CHERRY-PICK UNCHANGED**. The exact patch currently applies, but production safety depends on backend truth and its fresh-key recovery is not durable across calls/restarts.

Why it is still needed:

- `origin/main` still treats `ALREADY_IN_FLIGHT` as a stop result in `src/main/printing/shared-fiscal-printer.ts:193-201` instead of polling through the measured print window.
- Current code has no `SHARED_FISCAL_TOTAL_WAIT_MS`, `stillPrinting`, or `shouldMintFreshFiscalKey` gate.
- The current submit path returns the first terminal result and has no one-time fresh-key recovery at `shared-fiscal-printer.ts:334-367`.

Mandatory production gates before port/enabling:

1. Backend receipt mutation must be tenant-scoped and must never overwrite an existing receipt's `salonId` from an untrusted/mismatched job.
2. Backend must preserve `UNCERTAIN_AFTER_PRINT`; it must not map every failed print job to a retryable fiscal failure.
3. Contract tests must prove `failureClass` is returned consistently by create, status, and retry endpoints.
4. Android remains outside the print-agent identity and shared-printer execution path; this patch is for the Windows/POS1-POS2 route only.

Critical trap in the safety patch:

- `freshKeyUsed` is only an in-memory local variable for one `submitSharedFiscalPrint()` call, while the fresh key includes `Date.now()`. A later cashier retry or application restart starts again from the original terminal `SAFE_BEFORE_PRINT` job and can mint another new key. If the first fresh job printed but its response was lost/delayed, this can create a duplicate paragon. "Once" is therefore once per invocation, not once per order/failure lineage.

Port rules:

- Preserve `f0ee58b` backend-order-before-receipt-sync behavior.
- A fresh key is allowed only for terminal `FAILED`/`CANCELLED` plus exact `SAFE_BEFORE_PRINT`.
- `UNCERTAIN_AFTER_PRINT`, `FINAL`, missing failure class, `SENT`, or timed-out/in-flight must never mint a new key.
- The 30-second budget must surface `stillPrinting` and must not journal a false failed attempt.
- A backend 409 idempotency conflict must stop with an operator reconciliation message.
- Persist a durable reissue record keyed by tenant/device/order/original-job. The one permitted replacement key must be generated once, flushed before dispatch, and reused after timeout/restart; never derive it from a new `Date.now()` on each call.
- Persist the original job ID, replacement job ID/key, payload hash, dispatch state, failure class, and final reconciliation state. No UI retry may bypass this journal.

Acceptance checks:

1. Run `tests/shared-fiscal-fresh-key.test.ts` plus all shared-print retry/fiscal sync tests.
2. Test `SENT -> COMPLETED` at 9 s, 20 s, and just under 30 s; each produces one confirmed receipt.
3. Test poll timeout; result is non-terminal/still-printing and no failed journal or automatic new job is written.
4. Test each failure class and status combination; only terminal `SAFE_BEFORE_PRINT` gets one fresh-key job.
5. Test 409, network timeout before response, response loss after dispatch, app restart, and backend restart.
6. Count physical ELZAB output in every scenario; acceptance is zero duplicate paragons.
7. Invoke recovery repeatedly and restart between dispatch and response; assert the same persisted replacement key is reused and only one replacement job exists.

### 5. `116e68e` — daily Z-report must not remain blocked forever

Disposition: **REAPPLY**, exact patch currently applies cleanly.

Why it is still needed:

- Upstream still returns permanent `max_attempts_reached` once the stored budget is exhausted at `src/main/modules/fiscal-daily-report.module.ts:227-240`.
- A cold start with no previous successful daily report still uses no fiscal-receipt anchor at `fiscal-daily-report.module.ts:116-127`.
- No upstream-only commit after merge-base replaces either behavior.

Dependencies and order:

- Built on the Warsaw/DST helpers introduced by merge-base commit `667e210`; those helpers are present on `origin/main`.
- Land independently of Android UI extraction, but validate on a copy of a real database before Windows rollout.
- This is a recovery policy, not permission for Android to control fiscal hardware.

Acceptance checks:

1. Run `tests/fiscal-daily-report-module.test.ts` and `tests/fiscal-daily-report-date.test.ts`.
2. Verify max attempts remain blocked within the same Europe/Warsaw day.
3. Verify exactly a bounded retry opportunity occurs after Warsaw day rollover, including DST transition days.
4. Verify a fresh install with a confirmed fiscal receipt in the seven-day lookback can catch up.
5. Verify no sales/receipts means no spurious Z-report.
6. Test clock skew and malformed/null `updated_at`; fail safely and log an actionable reason.

### 6. `489906c` — recover shift closes hidden by migration v52

Disposition: **REPLACE; NEVER CHERRY-PICK UNCHANGED**. The underlying v52 data-loss risk is still present, but the submitted migration is not compatible with upstream and is too broad for an automatic production migration.

Hard conflicts and traps:

- The patch declares migration `version: 54`; upstream already uses version 54 for `local_variant_import_intent_snapshot` at `src/main/database/migrations.ts:1595-1611`, followed by versions 55 and 56. Replaying it would create a duplicate migration version and can permanently skip one migration depending on runner semantics.
- Migration v52 set every historical closed backend shift to `close_synced = 1` at `migrations.ts:1571-1582`; the schema has no provenance bit that distinguishes a close truly delivered to the backend from an offline close incorrectly marked delivered.
- The proposed recovery resets **all** matching recent rows. It intentionally replays already-delivered closes and assumes every server response is safely idempotent/terminal. That assumption needs endpoint evidence and production-data bounds before any fleet migration.
- Time-relative SQL `datetime('now', '-14 days')` makes the affected set depend on installation time and is difficult to reproduce in rollback/audit.

Required replacement design:

1. Allocate the next unused migration version (currently 57) only after re-fetching upstream and rechecking the version tail.
2. Produce a read-only per-device preview: candidate count, oldest/newest `closed_at`, backend IDs, and current sync/error state.
3. Verify the backend close endpoint is idempotent for already-closed shifts and cannot alter another salon's shift.
4. Prefer an explicit recovery marker/journal or a one-shot owner-reviewed repair command over silently reopening ambiguous rows on every upgraded till.
5. If a migration remains necessary, persist which rows it reopened and why; bound candidates using an immutable release cutoff, not only device `now`.
6. Back up and restore-test the SQLite database before canary rollout.

Acceptance checks:

1. Migration version uniqueness test over the full array.
2. Fixtures for: genuinely pending offline close, already-delivered close, terminal 404/already-closed, wrong-tenant backend ID, missing backend ID, old stale close, and clock skew.
3. Crash/restart at each point between marking candidate, API dispatch, recording response, and terminal shelving.
4. Canary preview and post-run reconciliation must show no duplicate financial effects and no endlessly retried close.
5. Rollback is database restore plus source-aware recovery; do not assume migration down is possible.

### 7. `b081d55` — product create static contract assertions

Disposition: **SKIP; UPSTREAM-SUPERSEDED** by `d39e04d` and later native workspace changes (`7ac330f` and descendants).

Evidence of replacement:

- Current upstream test already recognizes `basePayload` and its explicit barcode/idempotency exclusions at `tests/product-admin-create-contract.test.ts:20-24`.
- Current create call asserts the newer `createAttempt` object at `product-admin-create-contract.test.ts:41-48`.
- The safety commit's older assertion searches for `createProduct({`, which no longer represents current code and would weaken the test.

Acceptance checks for the upstream replacement:

1. Run `tests/product-admin-create-contract.test.ts`.
2. Verify create requests contain `priceGrossGrosze`, never `retailPrice`.
3. Verify duplicate barcode and SKU checks occur before `createProduct(createAttempt)`.
4. Verify barcode plus idempotency key remain stable across ambiguous transport retries and rotate only on a confirmed generated-barcode collision.

## Safe application sequence

The order below is about review and validation, not automatic deployment:

1. Branch from exact `origin/main` SHA `f0ee58bcd1e5217a4926353f0aff1fefd122941f`.
2. Record this base SHA in the Android/shared-runtime branch and CI artifacts.
3. Skip `67a4439` and `b081d55`; run the upstream replacement tests first.
4. Port the fail-closed intent of `3b48b5f` with masked/secure verification and one durable authoritative rate limiter; then run self-checkout security tests.
5. Port the persistent-recovery intent of `08e130f` with a manager/audit gate or no bypass; then run payment/fiscal recovery tests.
6. Reapply `116e68e`, then run daily-report and Warsaw/DST tests.
7. Fix and verify the backend tenant/failure-class P0s before porting any `05ec166` behavior.
8. Redesign the intent of `05ec166` around a durable one-replacement journal; run physical-printer, repeated invocation, restart, timeout, and duplicate-paragon tests.
9. Keep `489906c` out of the branch. Review and implement a separate migration-57-or-repair-command design only after read-only fleet previews and backend idempotency proof.
10. Only after the reconciled Windows baseline is green should shared-domain extraction start. Android remains cash-only and cannot inherit Electron, print-agent, fiscal, shift-close, or hardware adapters.

## Branch-level acceptance gate

Reconciliation is accepted only when all of the following are true:

- `git merge-base HEAD origin/main` is the recorded base or a reviewed descendant; no merge from the safety branch exists.
- Git history contains explicit ports/reimplementations only for the approved dispositions above.
- Full typecheck/build and focused tests pass on Node/JDK versions defined by the implementation plan.
- Windows regression tests cover login, product/category sync, cart/payment recovery, fiscal sync, daily report, shift recovery, restart, and updater behavior.
- Server contract tests prove tenant isolation and `UNCERTAIN_AFTER_PRINT` preservation before shared fiscal fresh-key recovery is enabled.
- SQLite migration versions are unique; no version-54 safety migration is present.
- The Android dependency-boundary scan proves no import of Electron, Node filesystem/process, SQLite native driver, print-agent identity, printer/fiscal modules, updater, or Windows-only adapters.
- No production deploy, Chesaigon install, or Android sales rollout occurs from this reconciliation task.

## Verification limitation for this audit

After the initial audit, `npm ci` was run from the committed lockfile on Node 22.22.2/npm 10.8.2. It completed with the expected Node-engine warning because the package still declares Node 20.x.

The unmodified upstream full suite is **not green on this Linux build host**: `226` files passed, `12` failed; `1968` tests passed, `14` failed, and `13` Electron E2E tests were skipped after launch failed without X11/`DISPLAY`. The failures are baseline/environment findings, not caused by the docs/boundary verifier:

- Windows-path assertions in `database-backup-service.test.ts` use backslash expectations while the Linux path implementation returns mixed separators;
- several suites instantiate `electron-store` without a valid Electron app user-data path;
- Electron E2E cannot start without an X server;
- `ssh-tunnel-startup.test.ts` hits the same Electron-store initialization gap.

After adding the boundary suite, a fresh full run reported `227` files passed, `12` failed; `2012` tests passed, `14` failed, and `13` skipped. The failure set and causes remained the same baseline platform/environment findings above. Final namespace-alias and decorator regression cases were then added, and the focused boundary suite passed 49/49.

This means “full suite green” cannot yet be used as a Linux extraction gate. The project needs a Linux-safe unit-test boundary (or documented platform-specific suite split) before runtime extraction. The independent Node boundary verifier remains green and does not depend on Electron.

The compile/build baseline does pass on Node 22: renderer typecheck, main-process TypeScript build, and Vite renderer production build all completed successfully. Vite reports a roughly 1 MB main renderer chunk and stale Browserslist data; these are optimization/maintenance findings, not build failures.

The live Windows source checkout is not the toolchain gate: `chesaigon` reports Node 24.14.1/npm 11.18.0 despite the package declaring Node 20/npm 10, and it remains clean at `f0ee58b`. Instead, an isolated checkout at `C:\Users\pc\POS-zira-node22-baseline-20260717` was installed and tested with Node 22.23.1/npm 10.9.8. Clean install and `npm run build` passed; 237 test files and 2059 tests passed with 13 skips. The sole failed suite was the Electron E2E harness before launch: its nested `npx tsc -p tsconfig.main.json` call returned npm `EUSAGE` under the isolated npm 10 Windows runner.

Therefore the Windows Node 22 source compile baseline is established, but the reconciled Windows release baseline is not yet green. The E2E helper must be made toolchain-stable and rerun, followed by installer creation, installed-app smoke, and update-from-1.0.23 verification. No live counter source, installed app, local database, machine identity, printer/fiscal assignment, or running process was changed by the isolated baseline.
