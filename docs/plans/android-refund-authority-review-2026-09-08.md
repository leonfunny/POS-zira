# Android refund authority review — 2026-09-08

Status: source audit complete; Android refund mutation is NOT ready to enable. This document is the only owned write; no refund requests, SQL writes, runtime edits, deployment, or payment operations were performed.

## Plan

1. Trace the shared refund UI through Android and Windows transports; verify units and exact order/item identities.
2. Inspect the backend cash/invoiced detail and refund contracts, tenant/role checks, and replay behavior from exact source.
3. Compare authoritative response handling, partial-refund history, local stock, persistence, and context changes.
4. Specify the minimum safe implementation and regression tests before enabling Android refund detail/actions.

## Evidence limitations

Tier 2 review. The supplied POS graph generation is stale (2026-09-08T08:50:16Z); relevant paths report metadata changes and call traces are incomplete. Exact current source is the authority. Remote backend source is inspected directly because the available local graph does not prove the remote revision. This is not a live-payment or device verification.

POS graph search returned nine refund-related symbols, with no further pagination. Coverage checked all nine cited POS runtime paths below: all report `metadata_changed`, no recorded parse gaps. Each material finding uses the current source rather than stale graph snippets. Backend read from netcup `/var/www/www/enail/.worktrees/android-pos-restaurant-parity-20260908`, HEAD `c6576a518311b81171d566c4c919f7e2355bce85`; the separately implemented restaurant line-link changes remain outside this audit's ownership. Backend conclusions concern this development source, not proof of deployed production parity.

## Verified backend authority contract

- `backend/src/modules/b2b/controllers/b2b-pos.controller.ts:53`: JWT, roles, POS_SYSTEM feature guards apply to the controller. Cash detail at line132 and invoiced detail at line144 both invoke the SAME `findOrderById(id, user.salonId, true)`; these routes are not independent cash/invoice authorization lanes. OWNER/MANAGER/STAFF may read. Refund POST at line409 permits OWNER/MANAGER, NOT STAFF. A staff login may view history but must not be promised refund permission.
- `services/b2b-pos.service.ts:2096`: detail resolves `{id, salonId, orderTypeDiscriminator: POS}`, loads items/product, and scopes tender lookup to order+salon. It exposes the order entity (including `id`, `salonId`, `refundedLines`, cumulative `refundAmount`) and exact `items[].id`. The price adapter exposes explicit net/gross unit and total values; legacy display fields are gross for BRUTTO. Do not infer prices from product catalog or multiply VAT twice. Items have no ordered-relation guarantee.
- `dto/refund-pos-order.dto.ts`: request amounts/tender amounts are PLN, not integer grosze. Normal products can use exact `items:[{orderItemId, quantity, restock}]`; Billiard instead requires immutable `billiardLineKey`. Do not send both `items` and `lines`. Restaurant `localLineId` is NOT a refund `orderItemId`.
- `services/b2b-pos.service.ts:2637`: refund replay key is scoped to salon+order. Same key compares original business payload (including stock flags, shift and tender splits), returning cached response only for a match. Different/unverifiable payload yields 409. Missing key creates a fresh server ledger ID, so cannot safely deduplicate a client retry.
- `services/b2b-pos.service.ts:3030`: transaction locks the salon+POS order with `FOR UPDATE`, checks replay again, and rejects changed state with `POS_REFUND_STATE_CHANGED_RETRY`. Server validates canonical per-item quantities, already-refunded quantities and money. Preserve this behavior; client must refresh/reconcile rather than blindly generate a new request.
- Response is `{success:true, orderId, orderNumber, status, refundAmount, totalRefundedAmount, refundedLines, stockMovementIds, refundReason}`. `refundAmount` is THIS CALL'S delta in PLN; `totalRefundedAmount` is cumulative. Returned lines contain authoritative `orderItemId`, quantity, unit, price, amount, restock and request ID. The response does not include salonId: bind it to the immutable request context and require matching orderId. Detail/sync `refundAmount` is cumulative, unlike POST delta.
- Commit precedes subsequent full-order retrieval/event emission (`services/b2b-pos.service.ts:3254–3298`). Therefore an HTTP failure or transport loss is not proof that no refund happened; same-ID reconciliation is necessary.

## Blocking findings

### P1 — Android money request is in the wrong unit

`src/renderer/components/pos/refund-request.ts:24` forwards the shared UI's grosze amount and lines. `OrderHistoryModal.tsx:644–671` uses it. Android `shim/real-transport.ts:1296–1388` passes this object verbatim to `port/api-client.ts:825`, which JSON-serializes it unchanged. Windows `src/main/pos/refund-backend-payload.ts::toRefundBackendPayload` converts amount, unitPrice, refundAmount, manualAdjustmentAmount and tender allocations by `/100`.

Example: 2000 grosze must become 20 PLN, not 2000 PLN. Backend PARTIAL checks the supplied amount against remaining value before deriving canonical line money, so this commonly rejects legitimate refunds. FULL ignores supplied amount and canonical line pricing limits impact; this finding is not a claim that every request pays 100 times too much. Fix the boundary before enabling mutation.

### P1 — Duplicate products lose exact line identity on BOTH clients

Shared `OrderHistoryModal.tsx:559–577,644–660` drops the authoritative item ID when forming refund lines; `refund-request.ts` has no orderItemId field. Windows ordinary `toRefundBackendPayload` sends variant/SKU lines, not exact item IDs. Backend `b2b-pos.service.ts:2770–2830` indexes product/variant/SKU in Maps, with the last matching item winning. Two rows for the same product (e.g. different restaurant notes/course/prices) are therefore ambiguous; selecting both can also trigger duplicate-line rejection.

Minimal fix: retain and validate the server `items[].id` from authoritative detail through UI selection and transport; build backend `items[]` with that ID. Check membership in the exact order, uniqueness, canonical product identity and remaining quantity. No index, product-only, name, SKU or restaurant localLineId fallback. This is a shared contract fix worth applying to Windows too, not a reason to reproduce the Windows bug on Android. Existing backend items[] support is sufficient; no backend change is required for exact normal-product line addressing.

### P1 — Non-authoritative success and unsafe local side effects

Android `real-transport.ts:1296–1388` treats any nonnull response as success, estimates missing cumulative value from the request, and can accept a nonnull `{success:false}`. It does not verify response orderId, allowed status, canonical delta/cumulative totals or matching returned line identities. Local restock uses requested lines rather than authoritative stock effects; same-ID PARTIAL replay can apply that increment again.

Use strict shared response validation plus identity checks. Windows `validateRefundBackendResponse` already distinguishes `confirmedComplete`, `mutatedButIncomplete`, `rejected`; port/reuse the pure validation rather than duplicate money logic. Strengthen exact order/line checks where missing. Do not require a stock movement for a non-stock-tracked item merely because restock was requested. Prefer authoritative stock sync after refund; never blindly `stock += request.quantity` on replay.

### P1 — No durable unknown-outcome/replay protocol in Android

UI request ID is a React ref (`OrderHistoryModal.tsx:521,662`) and can disappear on close/restart. Android transport does not require a UUID request ID, freeze the DTO, or persist pending/unknown/confirmed reconciliation state before POST. A timeout is reduced to a generic failure. Changing user or retrying with a new ID can therefore produce a second valid operation after the first already committed.

Require stable valid UUID; persist immutable scope/order/shift/payload/request ID BEFORE POST, and flush it successfully. Serialize same-order mutations. A replay must use that exact saved payload, even if the active shift changes. Unknown outcome: no payout, local restock, fresh ID or refund reprint; reconcile authoritative detail and replay only the original ID/payload under the original authorized context. Business 409/403 and transport-unknown need distinct states. Server cached response alone does not make local application idempotent: record applied request IDs transactionally.

### P1 — Context and durability fences are missing

Android captures database/order/shift/token before awaits but does not recheck server URL, salon, authenticated user/session generation or shift before POST and before local application. It only checks that SOME active shift exists; no shift ID or original-tender allocation is added. A logout/salon switch can leave stale continuation running. `database.flush()` rejection is swallowed while reporting success.

Capture immutable server+salon+user/auth-generation+local/backend order IDs+active shift binding. Recheck before submission; after server mutation never apply it to a new tenant/session, but retain a recoverable record in the original scope. Pass verified refund shift and tender allocation in PLN. Treat flush failure as `mutationDetected/requiresRefresh` (no success/payout); original request ID must remain durable. Windows main handler at lines6929,7021,7070,7128,7140 has stronger scope/flush handling and is useful reference, not proof of complete Android parity.

### P1 — Partial-refund audit overwritten

Android `shim/db/order-repo.ts:195–207` replaces `refund_lines`; transport passes only requested current lines while storing a cumulative amount. A second partial refund loses earlier line history and replay markers. Persist normalized authoritative delta lines cumulatively, deduplicated by request+canonical item ID, in the same transaction as cumulative status/amount and local reconciliation state. Preserve backend IDs and units. Do not invent a returned line from a request when the server omits it.

### P2 — Detail availability and refund permission are separate

`shim/stubs.ts:321` currently returns `refund-detail-unavailable`. Shared history `loadAuthoritativeRefundDetail` (OrderHistoryModal.tsx:2166) opens the refund path after detail succeeds. Simply replacing this stub can expose all issues above. Read-only detail can be built now, but mutation needs an explicit fail-closed capability/permission gate independent of read availability.

Validate raw detail.id equals requested backend ID; salonId equals captured salon; item IDs are unique, belong to that order, and carry valid canonical quantities/prices/refund history. Preserve local order.id only in the returned UI projection and backend_id separately. Fail on cross-order/cross-salon/malformed/stale context, including after fallback fetch. Cash/invoiced fallback is only a compatibility retry after a missing result, never a fallback after auth/validation failure.

Refund receipt printing remains explicitly unsupported on Android. Keep `receiptPrinted:false` and `ANDROID_REFUND_RECEIPT_UNSUPPORTED`; never substitute a sale reprint or report a drawer payout. Native receipt/payment hardware verification is a separate gate.

## Minimal implementation order / acceptance gate

1. Keep Android refund mutation disabled independently of detail. Implement only validated read-only detail and ownership/permission checks.
2. Extend shared refund selection/request types to retain exact server item identity; preserve Billiard's separate stable-key contract. Build one shared pure money/identity payload boundary used by Windows and Android.
3. Add Android durable attempt/reconciliation state, immutable payload, context fences and same-order serialization; verified shift/tender binding. This needs a scoped schema design, not incidental edits to the current history task.
4. Validate authoritative POST response; apply delta audit once, cumulative amount/status atomically, and reconcile stock. Handle unknown/partial server mutation and flush failure without success, new ID, payout or print.
5. Enable OWNER/MANAGER refund UI only when these gates and regression tests pass; retain truthful unsupported hardware status.

Required tests before enablement:

- 2000 grosze →20 PLN across amount, line price/amount and tender split; integer/weight quantities and gross/net prices; FULL remaining after prior PARTIAL.
- Duplicate product rows with distinct prices/notes; select either independently; reversed server item order; unknown/cross-order/local IDs rejected before POST.
- Wrong response orderId/salon detail; malformed items; negative/nonfinite/over-refund totals; `{success:false}`; missing canonical lines; tracked and nontracked restock.
- STAFF cannot execute; 401/403/404/501/409 distinguishable; no local mutation on rejected request.
- Logout, same-salon account switch, server URL/salon/shift change at each awaited boundary; stale results never write into the new scope.
- Same-ID replay twice, two partial refunds, timeout-after-commit, restart while pending, changed payload with same ID, concurrent attempts; audit and stock/outbox applied once only.
- Flush failure before POST means no POST; failure after server commit retains unknown/reconciliation state and no false success. Unsupported refund print never calls sale reprint.

Existing `tests/android-refund.test.ts:185–232` explicitly asserts verbatim DTO with a mocked invalid non-UUID request ID and empty refundedLines. Those fixtures encode the unsafe behavior and are not evidence of backend compatibility. Replace/add authority tests; do not preserve that expectation. This audit executed no payment calls and no runtime tests; findings are source-backed and the test list is a future acceptance gate, not a claimed pass.
