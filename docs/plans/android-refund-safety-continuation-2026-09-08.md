# Android refund safety continuation — 2026-09-08

## Requirements and release boundary

Continue Windows/Android restaurant POS parity without allowing an ambiguous server response to become a cash payout or stock increment. OWNER/MANAGER refund authority stays server enforced; no STAFF elevation. No live refund, printer operation, production deployment, or installed database change in this slice.

## Architecture and decisions before implementation

1. Share the existing pure Windows payload mapper. Preserve exact authoritative order-item IDs in both UI selection paths; send ordinary `items` or legacy/Billiard `lines`, never both. Minor-unit UI money converts to PLN once.
2. Add a separate strict authoritative refund-response validator. Bind order, request and item IDs, quantities, delta and cumulative amounts. Never infer success or fabricate missing audit lines.
3. Add Android schema 9 and a refund-attempt repository: PREPARED/UNKNOWN/CONFIRMED/REJECTED, immutable request payload and original scope. Unresolved attempts lock the local and backend order. Confirmation and local projection callback share one transaction. Persistence flush remains the caller's responsibility; clearing a salon refuses unresolved attempts.
4. Remove Android's unsafe verbatim-DTO runtime path. Keep the existing unavailable refund-detail gate and make direct refund calls fail closed, with no network or database mutation. A complete durable coordinator and explicit same-request reconciliation UI are required before enabling execution. Shipping a partially integrated money workflow is not an acceptable intermediate release.

Trade-off: a temporary explicit unavailable result is preferable to exposing a partially safe refund implementation. This is not feature parity yet. Journal/validator are preparatory components, not evidence that replay recovery works end-to-end.

## File ownership and impact

- client_metadata_sync: shared/refund-backend-payload.ts, main compatibility re-export, refund-request.ts, OrderHistoryModal.tsx, shared electron IPC type, exact-ID payload/UI tests and two stale IPC source assertions.
- backend_release_review: shared/refund-authority.ts and strict authority tests. No backend mutations needed for the already-supported exact item contract.
- native_release_readiness: Android db/schema.ts (additive v9), db/refund-attempt-repo.ts, db/db.ts clearSalonData guard, journal/migration tests.
- Parent: Android shim/real-transport.ts unsafe-path removal, shim/transport.ts and shim/stubs.ts contract comments, tests/android-refund.test.ts fail-closed regression coverage, verification and plan/status documentation.

No backend entity/API/migration change. No new public UI or translation key in this slice; an existing error display receives a precise unavailable reason. No cache/timer/realtime additions.

## Risks and verification

- Duplicate payout / wrong tenant: do not enable runtime until immutable-context coordinator, single-flight, flush-before-POST, UNKNOWN recovery and explicit reconciliation are wired and tested.
- Wrong duplicate-product line: full/partial UI tests must use reversed authoritative item IDs, not local line IDs or product-ID matching.
- Money conversion: mapper tests and strict response tests cover PLN/grosze and malformed amounts.
- Migration/data loss: fresh and v8-to-v9 SQL.js tests, reopen, immutable replay, transaction rollback, unresolved salon-clear guard.
- False confidence: replace old tests asserting unsafe verbatim POST/restock, retain independent accounting coverage, run focused tests plus Windows and Android builds/boundary checks. No production-ready claim.

## Next implementation slice (not enabled here)

Authenticated authoritative refund detail; exact remaining-quantity validation; original backend shift/tenders; frozen payload persisted before POST; original-scope replay after restart; strict response validation; once-only cumulative local projection and stock refresh; explicit reconciliation UI with no automatic payout/print; device-level disconnect/restart checks.

## Implemented and independently verified

- Shared mapper and main compatibility re-export, exact item IDs through FULL/PARTIAL selection, ordinary request+item audit dedup. Existing Billiard and legacy no-ID contracts retained.
- Discovery expanded the UI fix surgically: separate authoritative refund snapshot prevents sync-success/sync-failure events from replacing server item IDs with local IDs; Refund Next fetches authority again. Quantity and amount breakdown now honor explicit order-item identity instead of consuming another row with the same product. An unknown explicit ID is not rebound to a different row.
- Parent added raw detail identity validation in the actual Windows getRefundDetail callback before the display adapter can synthesize an ID. Checks exact order, unique IDs, declared tenant/parent ownership and the authenticated epoch/token/server URL after each read. New callback-execution tests use the actual handler source, mocked API and real pure adapter/validator; they do not boot Electron or access production.
- Shared authority validator has 98 focused tests (refund response and raw detail identity). It is **not yet wired into Android monetary execution**; Windows response mutation handling still uses its existing validator. New detail identity guard is wired into Windows read preparation.
- Android schema9/journal has 24 focused tests for immutable records, two order locks, once-only transaction projection, rollback, migration/reopen and persistence failures. No live runtime dispatch creates these attempts yet. clearSalonData now refuses unresolved journal records.
- Parent removed the old Android verbatim-POST/guessed-success/request-restock path. FULL/PARTIAL/repeated/malformed direct calls return explicit unavailable with no HTTP, order, inventory or report mutation. Refund detail and refund printing remain unavailable. This is an intentional release safety gate, not completed refund parity.

Verification after all source froze:

- 60 selected suites: 1039 PASS, 13 opt-in Chromium tests initially skipped. Explicit opt-in Chromium rerun: all 13 PASS. Post-build Android catalog suite: 3 PASS. **1055 distinct tests across 61 suites verified**, with no remaining skipped test in this selected set. Other repeated Billiard/focused runs overlap and are not added.
- Chromium checked built Windows and Android CSS, category bands/text contrast, menu/checkout bounds from 390x844 to 2560x1440 and Android 1280x800/1024x768/800x1280. Synthetic catalog/browser fixtures, not native Android acceptance.
- `npm run build` PASS (renderer typecheck, main compile, Windows renderer). `npm run android:sync` PASS (153 source files / 5 bundle files / 7 native asset files). `git diff --check` PASS. Existing bundle-size, Browserslist and sql.js browser-external warnings remain.
- Additional changed files after discovery: refund-quantities.ts, refund-breakdown.ts, main/modules/pos.module.ts; tests/refund-breakdown.test.ts and new tests/refund-detail-boundary.test.ts. Detailed agent plans record owned tests and red-to-green cases.

No commit/land/deploy, new APK, device installation, real refund, printing, installed database mutation or signing. Existing test APK and canonical release manifest are stale for this source. Next work is the durable Android refund coordinator plus explicit reconciliation UX, not flipping the current gate.
