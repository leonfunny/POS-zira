# Design reasoning: Android durable refund execution

Continuation audit: cross-shift/split expansion is blocked on an authoritative backend shift/tender contract. See [server change request](android-refund-event-accounting-server-request-2026-09-08.md). The existing narrow coordinator remains unchanged; the earlier no-backend-change statement applies only to that initial slice, not to expanded accounting or production readiness.

## Requirements and scope

Wire the existing schema9 journal and authority validator into Android refund execution and explicit reconciliation. OWNER/MANAGER only, authenticated original salon/user/server scope. Windows behavior must remain unchanged. No real payment, printer, deployment or installed database operation during tests.

Initial supported slice is synced ordinary local sales in the same currently-open local shift. SERVER history imports and closed-shift refunds are refused because Android closeShift subtracts refund amounts from the sale's shift, not a separate refund-event ledger. Billiard, ambiguous legacy money, positive discounts/tips/fees and unsupported tenders are refused rather than approximated. These are explicit parity gaps.

## Architecture

- Existing GET cash/invoiced detail supplies authoritative item identities/money. Existing POST refund supports exact items and immutable same-ID replay; no backend endpoint/migration change.
- Pure intent preparation validates raw identity and money, exact remaining quantities, renderer amount and original sale tender; converts grosze to PLN once. Parent stores canonical payload bytes and original expectation/prior audit in schema9.
- Coordinator serializes financial actions. Capture config object identity, salon/user/role/server/token before awaits; recheck before every dispatch/projection. Bind persistent scope independently of token so the same user can recover after restart/re-authentication.
- PREPARED plus explicit successful flush before any monetary request; UNKNOWN plus flush before POST. HTTP never automatically refreshes/replays. Any uncertain dispatch remains UNKNOWN; no fresh request ID can bypass its order lock.
- Verify authoritative result, then journal confirmation and cumulative local refund/audit update in one synchronous transaction, then successful flush before returning confirmation. No stock increment from the request. An authoritative catalog refresh may update stock after confirmation under the same context; failure is reported, never converted to refund failure/retry.
- Storage failure latches restart-required for this runtime, including when in-memory CONFIRMED is newer than the durable UNKNOWN image. Do not rely solely on in-memory journal status to unlock session/shift changes.
- Explicit reconciliation resends ONLY the saved original payload after scope/shift validation. Confirmed replay returns reconciled, never a new payout/print success. GET detail never submits a refund.
- Lifecycle mutex covers login/logout/closeShift; closeShift refuses unresolved attempts. New refund cannot begin while those transitions await. Same-shift restriction avoids adding a speculative accounting ledger.

## Frontend

Shared refund detail state remains authoritative. Android-only optional reconciliation method/response fields expose pending original request. Pending UI requires explicit action; after reconciliation refresh detail and warn to verify prior cash payout. No automatic drawer/payment/receipt action. Missing optional method keeps Windows behavior unchanged. Use existing translation system/fallbacks; no new page/framework.

## File ownership

- Parent CREATE shim/refund-coordinator.ts, tests/android-refund-coordinator.test.ts; MODIFY shim/real-transport.ts lifecycle/refund wiring and tests/android-refund.test.ts; verification/docs.
- client_metadata_sync CREATE shared/android-refund-intent.ts and tests/android-refund-intent.test.ts, scoped plan.
- backend_release_review MODIFY Android port/api-client.ts refund HTTP boundary; CREATE tests/android-refund-api-boundary.test.ts and plan.
- native_release_readiness MODIFY shared/electron.d.ts, shim/transport.ts, shim/stubs.ts, OrderHistoryModal.tsx reconciliation UX; CREATE scoped UI tests/plan.
- Parent additionally MODIFY Android schema.ts (additive v10 shifts.backend_id), schema-version assertions and lifecycle tests. Existing v9 did not store server shift identity; openPosShift responses were discarded. The added field is nullable, never backfilled by assuming local ID equals server ID.

## Trade-offs and risks

- Same-shift/no ambiguous pricing versus broad parity: choose narrow verified execution now; a later ledger/pricing slice is required for historical/discounted sales.
- Explicit replay versus automatic network retry: require explicit reconciliation to avoid presenting repeat payouts.
- Local stock refresh versus increment: never synthesize inventory; successful server-authoritative refresh only.
- Session/flush races: mutex, scope fences and restart latch. Context change after server commit leaves original request recoverable with no new-scope projection.
- Rejected/unknown distinction: until a response proves no mutation, preserve UNKNOWN rather than unlocking a new ID. Persistent endpoint/business rejection can require external reconciliation; no client workaround.

## Acceptance

Mock HTTP + real SQL.js/persistence: success, same-ID replay, two partial refunds, duplicate products, timeout-after-commit/restart, malformed/wrong response, changed payload/scope/shift, pre/post flush failure, concurrent calls, session/shift transition gates, stock/audit once only. API tests no401replay. UI tests explicit original-ID reconciliation without payout/print. Then Windows build, Android sync/boundaries and focused/broad regressions. Native hardware/production acceptance remains separate.

## Completed implementation and verified scope

- Coordinator is wired into real Android getRefundDetail/refund/reconcile ports and shared UI. Schema9 immutable attempts are now used by execution rather than remaining preparatory helpers. All dispatch errors remain conservatively UNKNOWN; there is no automatic new-ID escape for a permanent business rejection. Such cases can require external reconciliation.
- Intent helper requires explicit canonical gross prices/quantities, exact server IDs, valid prior audit, reconciled cumulative totals and original tender. It follows the backend original-total ratio for intermediate partial quantities and exact remaining-money residual for the final quantity, not a guessed remaining-price ratio. Unit prices may retain four decimal PLN / fractional grosze; monetary totals stay integer grosze.
- Parent narrowed operational scope further to one tender whose canonical allocation matches the local sale. Split refunds remain blocked because cumulative local shift tender allocation can disagree with per-event rounding. Discount/tip/fee/Billiard/legacy ambiguity and closed-shift/SERVER-import refunds remain unsupported. Existing unmapped shifts cannot refund; no fictitious backend link is inserted.
- Schema10 saves verified UUID backend shift ID from new open responses, rejects conflicting id/shiftId/declared salon and late token/config responses. Duplicate open is refused. Closing a mapped shift uses its backend ID. Existing asynchronous offline shift-open/close behavior is not claimed as complete server shift reconciliation.
- Persistent scope is server/salon/user; request authentication additionally fences config object identity (including switch-away/back), token, original local order fingerprint, source, payment method/tenders and local/backend shift identity. Same-ID pending replay uses saved payload bytes and original expectations, not fresh server state. Confirmed replay checks current local mapping/accounting and returns reconciliation only, never another initial-refund success.
- Atomic confirmation writes cumulative refund status and merged exact-ID audit in the journal transaction, with no request-derived stock increments. Successful stock refresh replaces affected inventory only from authenticated canonical catalog data and only if local stock did not change during the await. Missing/offline/stale stock refresh produces a confirmed-refund warning, not a refund retry.
- Flush failure latches the runtime against subsequent refunds and financial/session transitions; after restart a durable UNKNOWN request can replay once even if the prior instance had an unsaved in-memory CONFIRMED result. Tests execute this failure sequence with exported/reopened SQLite images.
- Lifecycle reservation blocks login/logout/open/close/new-sale overlap while a refund is active and blocks close/tenant switch around unresolved attempts. A targeted regression showed logout must still be allowed to cancel the read-only entitlement wait after login identity publication; tokenized transition reservations preserve that behavior without releasing another operation's lock.
- Reconciliation UI detects pending original request by read, requires explicit original-ID action, blocks double clicks and stale-order responses, and does not invoke payment/drawer/printing. Stock warning is visible after both initial success and reconciliation. New copy currently uses existing tOr English fallbacks; seven-locale completion is not claimed.

## Final verification (parent)

- Broad selected regression gate: 65 suites, 1171 PASS / 13 opt-in Chromium tests skipped in that command. Explicit opt-in rerun of all 13 Chromium tests plus post-build Android catalog3 PASS. **1187 distinct tests across 66 suites verified**, with no skipped tests remaining in this selected set. Agent/focused reruns overlap and are not added.
- Key focused suites: coordinator28, HTTP20, intent45, lifecycle16, reconciliation UI13, authority108. Includes timeout-after-commit + restart/replay, pre/post dispatch flush failures, shared product-line identity, wrong/partial responses, context/shift/login races, exact original request, v9→v10 nullable mapping migration, no fresh-ID bypass, and stock warning/no repeated refund.
- Final `npm run build` PASS (renderer typecheck, main compile, Windows renderer). Final `npm run android:sync` PASS (158 source files / 5 bundles / 7 copied native assets). Chromium verifies actual built Windows/Android CSS and menu/checkout bounds from mobile portrait to desktop/tablet. These fixtures are not an installed Android/native-device acceptance run.
- `git diff --check` PASS. Existing sql.js browser externalization, bundle-size and Browserslist warnings remain.
- Graph was initially generation08:50 stale; coverage identified changed/untracked relevant files. Final coverage call failed with transport closed, so source verification and tests are authoritative; no exhaustive graph claim. Default wiki path was unavailable.

No new backend mutation, live refund, payment, print, installed database edit, commit/land/deploy, signing, APK generation or installation. Previous APK and canonical release manifest do not contain this source. Next parity work: cross-shift/per-tender refund event accounting, discounted/tipped/fee pricing, legacy shift/server reconciliation, fiscal-only/PDF/refund receipt support, translations and native-device fault/acceptance tests before production promotion.
