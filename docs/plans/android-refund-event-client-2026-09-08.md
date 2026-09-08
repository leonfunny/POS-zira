# Android canonical refund-event client integration

Status: implementation in stages; production opt-in remains OFF until every gate below passes.

## Stage 5 verified result — event-aware shift reporting (not runtime activation)

- Android close reports now keep unconverted legacy cumulative refund accounting separate from canonical event accounting. Converted order cumulative money is excluded; each validated event delta and its exact CASH/CARD/BLIK/BANK_TRANSFER allocation is applied once to the event's refund shift. Finalized Schema12 snapshots still return unchanged before any recalculation.
- Reporting revalidates the persisted event row, shift binding, order context, confirmed journal, frozen V1 payload and authority, ordinary refund response, canonical event, cumulative chain, original/used tender capacities and order audit projection. Missing, ambiguous, malformed or coordinated-but-inconsistent evidence fails closed and leaves the shift open. OTHER remains blocked rather than mapped to cash.
- Verification after rebasing onto `main@438bb81`: 111 focused tests passed; the serial non-browser suite passed 396 files with 1 skipped (4,319 tests passed, 13 skipped); Electron smoke passed 13/13 separately. Renderer/main/Windows build, Android web build, production-readiness policy, build-only CI policy and boundary checks passed (162 reachable source files / 5 bundle files).
- V1 HTTP dispatch is still OFF. No capability/coordinator activation, cross-shift gate removal, remote-close outbox, native asset sync, APK, device install, real refund, backend deployment or production release is included. Next: guarded capability/coordinator integration with session/device/journal checks, then remote-close recovery and native acceptance.

## Stage 4 verified result — canonical confirmation storage (not runtime activation)

- Schema13 adds nullable order context and a uniquely keyed event ledger without backfilling history. Migration preserves legacy money, snapshots and original UNKNOWN request bytes; tenant clearing keeps the existing unresolved-request prohibition and device identity.
- New storage-only repository validates frozen request, authoritative response, canonical event, exact minor-unit delta, full cumulative audit chain, original/remaining tender capacities and original salon/server/operator/device/shift evidence. First conversion requires zero prior refund. Event insert, order projection and journal confirmation commit together. Exact terminal replay validates the full ledger without requiring an open shift or applying money twice.
- Independent review found a local settlement gap, fixed before freeze: safe received/change money must retain exactly the order total, tip/discount must be zero, tender header and allocations must agree, and local backend-order mapping must be unique. Ambiguous local records are refused. Prior audit must retain full canonical semantic fields, not a lossy adapter projection.
- Legacy detail/refund/reconciliation/write paths reject event-marked orders or event rows, including evidence appearing during awaits. Version-tagged UNKNOWN requests cannot fall through legacy replay. New close reports for event-bearing shifts remain explicitly blocked pending event-aware accounting; previously frozen reports remain readable.
- Parent independently ran **49 suites / 1,087 tests PASS**, including 80 event repository, 11 migration and 19 isolation-gate tests. Renderer typecheck, Android web build and boundary checks (159 reachable source files / 5 bundle files) pass. The new repository is not yet reachable from runtime; its tests and typecheck, not the bundle scan, verify it. SQL.js persistence/reopen and rollback tests are simulated local evidence, not native or live-backend acceptance.
- No V1 HTTP dispatch/capability negotiation, event-aware shift reporting or recoverable remote-close outbox yet. Caller authentication/context guard and latched durable flush are still required when integrating this synchronous repository. Same-sale-shift and supported-tender restrictions remain. No backend edits, native asset sync, APK, device install, real refund, commit or production deployment.
- Design-reasoning kept storage separate from protocol activation and rejected inferred legacy history. Next: event-aware report aggregation with immutable snapshots, then guarded coordinator integration and recovery tests; production stays NO-GO.

## Stage 3 verified result — immutable close reports (historical)

- Schema12 adds nullable `close_report_json`, no historical backfill or UNKNOWN-byte rewrite. New closes atomically save existing legacy report plus cash/date. Saved report validation permits signed net totals but rejects malformed/mismatched identity/dates/cash and unsafe numeric fields.
- Repeat closes return the saved report after durable flush, ignoring replacement closing cash; known historical closed rows with NULL report return null without ghost-close HTTP. Corrupt snapshots never recalculate. Public close DTO is copied before the pending-refund guard's first await, fixing an immediate caller-mutation race.
- Parent independent **46 suites / 977 distinct tests PASS**, including 40 snapshot repository tests, 10 transport tests and migration/restart/flush-failure/trigger rollback coverage. Renderer typecheck, Android web build, boundary159source/5bundle and diff check pass. Source review by separate subagent found no new severe defect in this bounded scope.
- V1 refund/event ledger and recoverable remote-close outbox are still NOT implemented/activated. Snapshot freezes the existing legacy monetary calculation; it does not fix legacy split allocation or remote-close acknowledgement. No backend edit, commit, native asset sync, APK, device verification or production deployment.
- Design-reasoning separated immutable report lifecycle from the new event accounting model to preserve historic evidence. Next stage should use the zero-prior-refund cutover design below, not the earlier nonzero legacy baseline proposal.

## Stage 4 design: canonical confirmation storage, still no V1 dispatch

Schema13 adds nullable `orders.refund_event_context_json` and `pos_refund_events` with unique request_id plus server_url, salon_id, local_order_id, backend_order_id, local_shift_id, backend_shift_id, machine_id, operator_id, occurred_at, positive integer delta_amount_minor and canonical event_json. No event backfill, no historical order conversion. Tenant clearing removes confirmed event projection along with existing order/journal data, but the existing pending-attempt prohibition stays first.

New `shim/db/refund-event-repo.ts` exposes `createRefundEventRepo(database).confirmCanonicalRefund({requestId,localOrderId,responseJson,scope:{serverUrl,salonId,operatorId,machineId}})`. It reads frozen journal `expected_json` with protocolVersion:1, authority, event, originalTenderCapacities, localFingerprint, inputJson and priorRefundLines. Validate original payload V1 version/machine/request/shift/items/tenders against frozen expectations. Validate ordinary response AND canonical event; exact delta/cumulative with integer money, no legacy one-cent tolerance. No arbitrary callback from caller.

Use existing journal confirmAndApply transaction callback to validate current state, insert event, set immutable context marker, update cumulative/order audit/status and confirm journal together. Context marker stores {serverUrl,salonId,machineId,backendOrderId,originalTenderCapacities}. First conversion requires zero prior local/server refund, empty audit and no other confirmed legacy attempt; later confirms require complete validated ledger matching cumulative and capacities. Keep same-local-sale-shift and supported methods CASH/CARD/BLIK/BANK_TRANSFER for this storage stage. New confirmations require verified backend binding, active matching local shift with no close snapshot, correct local order and frozen fingerprint. Terminal CONFIRMED replay instead validates original response/event and full ledger, returns applied:false without requiring an open shift or rewriting data. Caller still owns auth/token guards and durable flush; this synchronous repository does no HTTP, stock, payout or printing.

Until event-aware reports and dispatch are wired, legacy coordinator/getRefundDetail and markRefunded must reject marked V1 orders. Closing a shift containing marked orders or canonical events must fail explicitly rather than use legacy cumulative/proportional accounting. This is a safety gate, not event-report implementation. No runtime path creates V1 attempts in this stage.

File map: create refund-event-repo.ts and its focused SQL.js tests; modify schema.ts/db.ts and add schema13 migration tests; modify order-repo.ts and refund-coordinator.ts only for legacy write/report gates plus focused regressions. Schema test assertions advance to13. Risks/tests: same-ID idempotency/restart, changed expected/response, invalid scope/binding, event/response mismatch, missing/duplicated/tampered ledger, capacity overflow, zero-baseline conversion refusal, transaction trigger rollback, closed-shift and terminal replay distinction, preserved UNKNOWN bytes and explicit legacy/report refusal. No backend/API/UI changes, no production activation. Financial ledger complexity high; splitting storage from HTTP activation keeps legacy payloads unchanged.

## Stage 3 design: immutable local close reports before event accounting

Implement the close-report prerequisite first. Android currently recomputes totals while closing and stores only cash/date; a later refund or sync change must not rewrite a report already issued. Schema12 adds nullable `shifts.close_report_json`, without backfilling historical closed shifts. New close computes the existing legacy report and atomically saves report JSON plus close fields in one synchronous transaction. The repository returns an unchanged saved snapshot for repeat closes (ignore new closingCash for an already finalized report); malformed or mismatched saved data is an error, not recomputed history. Old closed rows without snapshots remain historical/unavailable.

Transport returns a saved snapshot on repeat close after the existing durability flush barrier, without another backend close POST. It must distinguish a known closed row from a truly absent ghost shift. Existing pending-refund/session locks stay in front of this path. Snapshot reuse does not imply automatic reprinting or a new close action. Fresh close inputs are copied before awaits and cash must be a nonnegative safe integer grosze. Persisted snapshot validation checks identity, close/open timestamps and fixed numeric report fields; it does not recalculate from mutable orders.

File map: modify `shim/db/schema.ts` (v12), `shim/db/order-repo.ts` (transaction + validated snapshot reader), `shim/real-transport.ts` (repeat-read path and input freeze). Add `tests/android-shift-report-snapshot.test.ts` and `tests/android-shift-report-transport.test.ts`; update exact current-schema assertions in existing migration tests. No new endpoint/backend/permissions/UI, no migration of old UNKNOWN requests or event backfill. Legacy tender accounting stays unchanged in this stage; event ledger/aggregation and durable remote-close outbox remain separate unimplemented steps. Risk: returning fabricated historical reports, duplicate close POST, partially saved closure; tests: old rows null, repeated migration, exact restart snapshot, later order changes ignored, malformed snapshot rejection, transaction rollback and flush failure, repeated transport close emits no HTTP.

Trade-off: freeze verified existing calculation now versus mixing report lifecycle with a new monetary model. Choose the former, keeping the later event model gated until independently tested. Complexity moderate; additive migration only. Windows is untouched.

### Ledger design correction from backend review (storage implemented in Stage 4; reporting pending)

The earlier proposed nonzero legacy baseline is unnecessary for the current backend V1: it rejects legacy prior refunds. First V1 conversion must instead require local/server prior refunded total zero, empty refund audit and no confirmed/unresolved legacy attempt. Subsequent events require a complete local canonical ledger matching the fresh server cumulative and remaining tender capacities. Missing history from another device means refuse, not proportional inference.

Future confirmation should read frozen `protocolVersion`, `authority`, `event`, original tender capacities and fingerprint from journal; validate both response layers and exact delta; insert event, update order and confirm journal in one existing synchronous transaction (do not nest BEGIN around confirmAndApply). Terminal replay verifies saved event/full cumulative ledger without requiring an open shift. A new event requires its refund shift still open with no close report; never alter a finalized snapshot. Report equation: legacy cumulative for unconverted sales in the shift plus exact event deltas for that refund shift, excluding V1 order cumulative to prevent double subtraction. Signed net sales/tender values remain valid. This supersedes the nonzero baseline suggestion below but does not activate V1.

## Stage 2 verified result — device/shift binding

- Shared persistent device UUID now used by restaurant runtime and shift open; invalid stored identities are rejected without rotation. Caller flush is awaited even for an existing identity.
- Open captures scalar inputs and original config/token/server across awaits. The guarded API checks before/after token, HTTP and success/error JSON; it does not refresh/replay POST on 401.
- Schema11 adds nullable backend binding evidence without backfill. Explicit matching server shift ID, machine, salon and open state produce durable binding JSON. Missing evidence remains legacy-only; conflicting declared IDs (including empty/null aliases), machine, salon or closed state reject mapping.
- Parent independently ran **41 suites / 919 tests PASS** (all Android-name suites plus shared refund-event, refund-authority and provenance migration tests). Renderer typecheck and Android web build pass; boundary159source/5bundle passes. Simulated HTTP with real SQL.js image export/reopen; no native device or production verification.
- V1 refund dispatch/capability negotiation, event ledger, snapshots and remote-close recovery remain unimplemented. Schema11 stores evidence only; it does not activate V1. Legacy UNKNOWN payloads remain byte-preserved. No backend edits, commit, APK, native asset sync or deployment.

## Stage 1 verified result (historical)

- Implemented pure `refund-event.ts` helpers: explicit V1 capability, exact frozen event validation and BigInt largest-remainder allocation over known remaining capacity. These are not yet invoked by the refund runtime.
- Fixed initial open/close and late backend-shift-link persistence barriers in Android real transport. Storage failure latches session/shift/create-order/refund entry points until restart. A late link failure does not undo the backend open already sent. This is not a global database-write fence.
- Parent independent verification: **11 suites / 534 distinct tests PASS**, including 225 V1 helper tests and 20 lifecycle tests. Renderer typecheck, Windows main compilation, Android web build pass. Source/bundle boundary verification passes (158 source files / 5 bundle files). No native asset sync, APK build, device test, real refund, backend edit, commit or deployment.
- Schema remains v10. Device binding, canonical-event persistence, report snapshots, remote-close recovery and coordinator activation remain open. Cross-shift/split gates remain unchanged; no claim of complete parity or production readiness.
- Design-reasoning review intentionally kept legacy data untouched and deferred protocol activation until durable accounting exists.

## Requirements and scope

## Stage 2 implementation design: device and shift evidence

Use one synchronous get-or-create helper for the existing device singleton, followed by the caller's existing latched flush barrier. Validate stored UUIDs; do not rotate invalid identities. Restaurant runtime and shift open share this helper. Before shift HTTP, verify the captured configuration/token/server still match after persistence; API open receives a context guard around its own token await to avoid dispatch under a replaced account.

Schema v11 adds nullable `shifts.backend_binding_json`, with no backfill. Existing legacy `backend_id` handling remains compatible when the response omits device evidence. Persist a V1-ready binding only for explicit matching `id`/`salonId`/`machineId` and `closedAt: null`, storing normalized server URL too. Contradictory declared device/closed state rejects the entire mapping. Missing fields never become verified evidence. This is declared server binding, not device authentication, and does not enable V1 refunds by itself.

File map: create `shim/db/device-identity.ts` and `tests/android-device-identity.test.ts`; modify `shim/restaurant-runtime.ts`, `shim/real-transport.ts`, `port/api-client.ts`, `shim/db/schema.ts`, and focused lifecycle/API/schema tests. No backend writes, no new endpoint, UI, permissions or cache; no old refund attempt rewrite. Preserve existing supported legacy paths. Tests cover retained identity/restart/concurrent initialization/corrupt identity; additive repeated v10 migration; explicit/missing/wrong binding; account change during save/token waits; save failure and late response. Event ledger migration moves to a later schema version, separate from v11 binding evidence.

Android is an independent POS. Owner/manager refunds must bind the original server, salon, operator, device and refund shift. Money is authoritative on the server. Windows legacy requests and persisted Android PREPARED/UNKNOWN request bytes must remain unchanged. This is a financial integration, not a visual redesign.

## Architecture and order

1. Add a pure strict canonical event validator and exact integer-minor-unit remaining-tender allocator. Validate the existing refund response separately, then require the event identity, delta and tender allocation to match the frozen request. No coercion or guessed tenant/device/shift.
2. Reuse Android's persistent device identity. Verify the capability response explicitly advertises numeric refundEventVersion 1 and bind newly opened backend shifts to that device. Cache only within a verified server/salon/auth context. Never infer support from HTTP success or legacy responses.
3. Add an immutable local event projection committed atomically with journal confirmation and cumulative order update. Preserve legacy journal rows and keep old requests on their original protocol. Migration must not invent historical refund shifts.
4. Change shift accounting to subtract each new event once from its refund shift; preserve verified legacy accounting separately. Persist close report snapshots before enabling cross-shift refunds. Prove old-sale/new-refund-shift and restart behavior first.
5. Wire coordinator opt-in only after steps 2–4. Freeze version/device/shift in journal expectations, validate replay with original scope, and never retry UNKNOWN with a new ID. Split and old-shift refunds remain disabled until their accounting and reconciliation tests pass.

## Trade-offs

- Separate V1 helpers versus changing shared legacy helpers: choose separate helpers to avoid silently changing Windows rounding or old Android payloads.
- All-at-once protocol activation versus staged gates: choose staged implementation, keeping current behavior until durable accounting is verified.
- Infer historic refund events versus retain legacy evidence: never infer; ambiguous historic state must stay unsupported for V1.
- Backend event-history API is not present. Prior-event capacity must be completely reconciled from durable canonical evidence or the client must refuse, not estimate it.

## File impact

First stage creates `src/shared/refund-event.ts`, `tests/refund-event.test.ts` and this plan. No schema/API/runtime activation in that stage.

Subsequent stages affect Android `port/api-client.ts`, `shim/real-transport.ts`, `shim/refund-coordinator.ts`, `shim/db/schema.ts`, `shim/db/order-repo.ts`, `shim/db/refund-attempt-repo.ts`, device identity reuse and their focused tests. Final schema/event repository details require review of legacy UNKNOWN and report snapshot lifecycles before implementation. No backend or Windows runtime changes are planned here.

## Risks and tests

- Double refund / replay: immutable original request and atomic durable confirmation, restart/flush-failure tests.
- Wrong tenant/device/operator/shift: reject every mismatched or missing binding before local confirmation.
- Rounding or excess tender refunds: safe integer grosze, complete remaining capacity, exact sum, deterministic tie handling, tiny multi-tender partial tests.
- Historical report mutation: separate legacy baseline from future event deltas and immutable close snapshots; no guessed backfill.
- Capability absent or malformed: no V1 dispatch.
- Rollout: focused tests, renderer typecheck, Android web build and boundary checks; native device/production remain separate unpassed gates.

No new UI text in stage 1; existing English error boundary remains unchanged. Later user-facing messages must use the existing renderer translation system. No new permissions, queues, sockets or server schema changes.

## Pre-activation durability fix discovered during audit

`real-transport.ts` currently swallows open/close shift persistence failures. Fix those two barriers before event activation: await durable save before reporting success or dispatching the backend shift request. If save fails, latch financial actions until restart because the in-memory shift may differ from the durable image. Apply the latch to existing session/shift/sale reservations and refund entry points. Do not roll back memory after an uncertain storage write or pretend a second close is successful. Tests in `android-refund-lifecycle.test.ts` must cover failed open/close, no backend dispatch, repeat actions blocked, and persisted image recovery. This does not replace the later remote-close journal/report snapshot requirement.

## Reviewed follow-on migration constraints (not yet implemented)

- Reuse `pos_device_identity`, currently initialized by restaurant runtime and retained when salon data is cleared. Extract shared initialization for retail/restaurant; flush even an existing identity before using it in HTTP. Invalid identity is an error, not a reason to rotate it.
- Existing `backend_id` alone does not prove device binding. New opens must send the persistent machine ID; old shifts require explicit server verification, never a client-side guessed backfill.
- Prefer lazy per-order cutover: a nullable legacy-baseline field stays null until the first verified V1 confirmation. In the same transaction, freeze previous cumulative legacy amount and its existing sale-shift/tender accounting, insert the new event, update cumulative and confirm the journal. The baseline is explicitly legacy evidence, not a fabricated canonical event.
- Legacy UNKNOWN requests replay unchanged before a cutover, enforced by the unresolved per-order lock. Once cut over, prohibit new legacy requests even if capability disappears.
- Reports consume either an unconverted order's cumulative legacy refund, or its frozen baseline plus exact canonical events, never both. Validate cumulative equals baseline plus event sum. Freeze close reports before enabling old-sale/current-refund-shift behavior.
- The current payment report has no OTHER bucket. Keep OTHER V1 activation disabled until its report/UI accounting is designed; never map it to cash. The pure contract validator still recognizes the server's valid OTHER method.
- Remote close remains best-effort today. A recoverable close outbox/status is a separate required gate; the local save latch does not claim to solve remote acknowledgement loss.
