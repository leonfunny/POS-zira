# Kitchen Self-Order — Cashier Pickup Queue (backend-coordinated) Design

Status: reviewed design draft, not yet implemented
Date: 2026-06-22
Related: `KITCHEN_SELF_ORDER_DESIGN_CONTRACT.md`, `KITCHEN_SELF_ORDER_MVP_PLAN.md`, `KITCHEN_LAN_FIRST_DOUBLE_PRINT_FIX.md`
Repos touched: `enail` backend (NestJS) **and** `POS-zira` desktop app (Electron)

> **Scope guard — this is a forward-looking feature for OTHER salons.**
> It must **NOT** be built into or released onto the chè sài gòn (chesaigon) POS
> machines. No backend production deploy is in scope. Development and this spec
> live on `winpc` (`C:\POS-zira`, branch `main`); the owner tests it and builds
> for chesaigon later, only when it is proven correct.

---

## 1. Problem

In the `PAY_AT_COUNTER` kitchen self-order flow, a customer orders at a
self-order kiosk, the kitchen ticket + a customer pickup slip (with a `KSO1:` QR
and a daily pickup number like `K-001`) print, and the customer pays at a cashier
POS. Today the **only** way the cashier loads that order into the cart is by
**scanning the QR** (`decodeKitchenSelfOrderQr` → `loadKitchenSelfOrderQr` in
`POSLayout.tsx`). If a future explicit policy makes `ORDER_ONLY` counter-handled,
it can opt into the same queue, but `ORDER_ONLY` alone is not treated as payment
due at the cashier.

That single path is fragile:

- many counter scanners are 1D laser units that cannot read a 2D QR at all;
- the slip can be torn, smudged, or lost;
- if the scan silently fails to decode, nothing is added to the cart and the
  cashier has no other handle on the order.

There is currently **no cashier-visible list** of waiting self-orders.

## 2. Goal

Give every cashier POS a small **"Kitchen orders (N)"** affordance that lists the
self-orders waiting to be paid. Tapping an order loads it into the cart through
the same cart-building path as a QR scan. The QR scan stays as the offline
fallback only when the backend has no matching queue row or is unreachable. If
the backend knows the row is already claimed, settled, or cancelled, the scan is
blocked instead of fallback-loading the payload.

### Non-goals
- No change to the kiosk ordering UX, modifier rules, or the printing pipeline.
- No KIOSK_TERMINAL payment integration.
- LAN-direct transport for the queue (the kitchen-ticket LAN-first path is
  unchanged; the queue rides the backend — see §4).
- Multi-currency / non-grosze pricing changes.

## 3. Key decisions (locked)

1. **Transport = backend Socket.IO coordinated queue.** The backend is the single
   source of truth for the pending list and for which station claimed which order.
   Rationale: the requirement is a *shared queue with claim semantics across
   multiple cashier tabs* — a coordination problem a central authority handles
   cleanly. The existing `print-agent` gateway already keeps every salon machine
   in a `salon:${salonId}` Socket.IO room and exposes `emitToSalon(...)`.
2. **Reuse the QR payload shape.** The backend stores the decoded
   `KitchenSelfOrderQrPayload` (`src/shared/kitchen-self-order.ts`) or a DTO with
   the same fields. The cashier cart is still built by the existing QR recall
   logic after it is refactored into a safe prepare/commit result — no second
   pricing / stock / modifier implementation.
3. **Claim on open after local preflight.** When a station opens an order (by
   list tap **or** QR scan), the app first verifies the cart is empty and the
   payload can be prepared. It then claims/locks the row to that station. If
   final cart commit fails after claim, the app immediately releases the row.
   Settle on successful POS sale; release only on explicit cashier cancel/clear
   before payment.
4. **QR scan and list tap are two doors to the same action** (see §7). A scan
   never creates a new/duplicate queue entry. A scan of a known `SETTLED` or
   `CANCELLED` row is rejected.
5. **QR scan remains the offline fallback.** If the queue row genuinely does not
   exist (kiosk push failed) or the backend is unreachable, the QR still loads
   the cart from its own self-contained payload. If the backend is reachable and
   returns `CLAIMED`, `SETTLED`, `CANCELLED`, or an ambiguous match, do not load.
6. **Online dependency is acceptable** for the list because the QR covers the
   offline case.
7. **`sourceOrderId` is the scan match key.** Match QR scans by QR `orderId`
   (`sourceOrderId`) first. `orderNumber` is a human handle and a last-ditch
   fallback only when the backend can prove it maps to exactly one row for the
   salon and business date.

## 4. Architecture & end-to-end flow

```
KIOSK (self-order machine)
  kitchen-self-order:submit  (src/main/modules/pos.module.ts)
    1. kitchenSelfOrderRepo.create(...)                [unchanged]
    2. print kitchen ticket + customer slip (QR)       [unchanged — offline path]
    3. buildKitchenSelfOrderQrPayload(...)              [unchanged]
    4. POST /api/v1/print-agent/pickup-orders (apiKey) [NEW, best-effort, non-blocking]
          → backend stores pickup_order(status=PENDING)
          → gateway.emitToSalon(salonId, 'pickup-order:new', dto)

BACKEND (enail)
  pickup_orders table  +  PickupOrderService  +  endpoints  +  gateway emits

CASHIER POS (counter machine, already in salon:${salonId} room)
  on mount / reconnect: GET /api/v1/print-agent/pickup-orders/open → seed local list
  socket 'pickup-order:new|claimed|released|settled|cancelled'
    → main-process listener → POS preload IPC → renderer list state
  small badge "Kitchen orders (N)" → panel of order cards (K-001 … + item preview + total)

  OPEN AN ORDER  (list tap OR QR scan → same handler):
    1. prepare cart from payload without mutating cart
    2. POST /:id/claim or /claim-by-ref
       ok    → commit prepared cart + remember pickupOrderId in checkoutDraft
       409   → toast "being handled at another station"; do not load
       410   → toast "already paid/cancelled"; do not load
       404/network → QR fallback only for scan path, never for list tap
    3. if cart commit fails after claim → POST /:id/release best-effort
  TAKE PAYMENT → save POS sale with pickupOrderId → POST /:id/settle
    → emit 'pickup-order:settled' (vanishes everywhere)
  CASHIER CANCEL / CLEAR BEFORE PAYMENT → POST /:id/release
    → back to PENDING → emit 'pickup-order:released'
```

The kiosk push is **best-effort and must never block or fail the print/QR path**.
A failed push is logged only; the order still prints and the QR still works.

## 5. Backend design (`enail`)

Template to mirror: `src/modules/print-agent/controllers/self-checkout-help.controller.ts`
(kiosk `@Public` + apiKey create; staff JWT actions) and
`src/modules/print-agent/gateways/print-agent.gateway.ts` (`emitToSalon`).

### 5.1 Entity `pickup_orders` (+ TypeORM migration)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | backend identity, used by claim/settle/release |
| `salonId` | uuid, indexed | tenant isolation (ALWAYS filter by this) |
| `terminalId` | varchar null | kiosk source label / machine |
| `sourceOrderId` | varchar null | kiosk-local `kitchen_self_orders.id` from the QR payload (`orderId`) — for scan→row matching |
| `orderNumber` | varchar | e.g. `K-001` (human handle, resets daily) |
| `sequence` | int | from the kiosk order number |
| `businessDate` | date, indexed | for daily scoping / expiry |
| `payloadJson` | jsonb/text | the full `KitchenSelfOrderQrPayload` |
| `totalGrosze` | int | for list display |
| `status` | enum `PENDING\|CLAIMED\|SETTLED\|CANCELLED` | |
| `claimedByMachineId` | varchar null | |
| `claimedByUserId` | uuid null | |
| `claimedAt` | timestamptz null | for claim TTL |
| `settledPosOrderId` | varchar/uuid null | local POS sale id or backend sale id, supplied by settle |
| `settledPosOrderNumber` | varchar null | POS sale number for reconciliation |
| `settledAt` | timestamptz null | |
| `cancelledAt` | timestamptz null | |
| `cancelledByUserId` | uuid null | |
| `cancelReason` | varchar/text null | required for manual cancel |
| `createdAt` | timestamptz | |

Indexes: `(salonId, status, businessDate)`, `(salonId, sourceOrderId)`,
`(salonId, businessDate, orderNumber)`. Add a unique partial index on
`(salonId, sourceOrderId)` where `sourceOrderId IS NOT NULL`. Do **not** make
`orderNumber` unique unless the backend owns salon-wide numbering; local kiosks
can otherwise both produce `K-001` on the same day.

Idempotency: a repeated kiosk push for the same `(salonId, sourceOrderId)` must
upsert (not duplicate). Treat `(salonId, sourceOrderId)` as the natural key when
`sourceOrderId` exists. A repeated push must **never** roll a row back to
`PENDING`: if the existing row is still `PENDING`, it may refresh payload/display
metadata; if it is `CLAIMED`, `SETTLED`, or `CANCELLED`, preserve status,
claim/settle/cancel fields, and emit no "new pending" event.

Business date must be consistent across kiosk push and backend reads. Prefer the
`businessDate` supplied by the kiosk push; otherwise derive it with the salon's
business timezone. `GET /open` and daily expiry must use the same definition, not
server UTC by accident.

### 5.2 Endpoints (`@Controller('print-agent/pickup-orders')`)

| method + path | auth | purpose |
|---|---|---|
| `POST /` | `@Public` + apiKey (`PrintAgentService.validateApiKey`) | kiosk registers a pending order; idempotent on `(salonId, sourceOrderId)` without resetting non-PENDING status; emits `pickup-order:new` only for newly visible PENDING rows |
| `GET /open` | JWT (OWNER/MANAGER/STAFF) | resync: PENDING + this machine's CLAIMED rows for `salonId`, `businessDate=today`; rows claimed by other machines are hidden from the cashier list |
| `POST /:id/claim` | JWT | atomic claim by id. `PENDING→CLAIMED`; already claimed by same machine is idempotent 200; claimed elsewhere → 409; settled/cancelled → 410; emits `pickup-order:claimed` |
| `POST /claim-by-ref` | JWT | QR scan fallback when the row is not in local state. Body should include `{ sourceOrderId, orderNumber }`; resolve by `sourceOrderId` first, `orderNumber` only if exactly one row matches salon+today. Claim must be atomic after resolution (`UPDATE ... WHERE salonId AND id AND status='PENDING' RETURNING`), not SELECT-then-UPDATE. No row → 404 (QR fallback allowed); claimed elsewhere → 409; settled/cancelled → 410; ambiguous orderNumber → 409 |
| `POST /:id/release` | JWT | backend rule: only the claiming machine can move `CLAIMED→PENDING`; `SETTLED`/`CANCELLED` return 409/no-op. "Before payment started" is a client discipline, not backend state |
| `POST /:id/settle` | JWT | only the claiming machine; body `{ posOrderId, posOrderNumber }`; `CLAIMED→SETTLED`; same `posOrderId` is idempotent 200; different already-settled POS id → 409; emits `pickup-order:settled` |
| `POST /:id/cancel` | JWT | manager/PIN-gated manual dismiss with reason; `→CANCELLED`; emits `pickup-order:cancelled` |

All staff endpoints derive `salonId` from `@CurrentUser()` and reject cross-salon
ids. Throttle the kiosk `POST /` (mirror help-request's `@Throttle`).

The status codes above are part of the client contract. The POS may fallback-load
the QR payload only on `404` from `/claim-by-ref` or on network/unreachable
backend errors. It must block on `409` and `410`.

### 5.3 Socket events (emitted via `PrintAgentGateway.emitToSalon`)

`pickup-order:new`, `pickup-order:claimed`, `pickup-order:released`,
`pickup-order:settled`, `pickup-order:cancelled`. Payload carries at least
`{ id, sourceOrderId, orderNumber, status, claimedByMachineId, totalGrosze,
businessDate, settledPosOrderId }`; `:new` also carries the full `payloadJson`
so a station can load without a round-trip.

## 6. POS app — kiosk side (`POS-zira`)

In `kitchen-self-order:submit` (`src/main/modules/pos.module.ts`, ~L2935), after
the QR payload is built and the order is persisted, fire a best-effort push:

- new helper (e.g. `src/main/kitchen-self-order/pickup-queue-client.ts`) that
  POSTs `{ apiKey, terminalId, sourceOrderId, orderNumber, sequence, totalGrosze,
  businessDate, payload }` to `${serverUrl}/api/v1/print-agent/pickup-orders`
  using the agent apiKey (`getSecureApiKey`) and `ApiClient`;
- wrap in try/catch; on failure log `[PickupQueue] push failed` and continue.
  **Never** change `success`, the slip gate, or `kitchenAlreadyReleased`.
- only push by default when checkout mode is `PAY_AT_COUNTER`. `ORDER_ONLY` does
  **not** mean "cashier must take payment" in the existing kitchen contract; only
  push `ORDER_ONLY` if a future explicit policy says it needs counter handling.
  Do not push for `KIOSK_TERMINAL`.

## 7. POS app — cashier side (`POS-zira`)

### 7.1 Live list
- Add explicit `pickup-order:*` socket handling in the main process and expose it
  through preload to the POS renderer (the existing `job:new` bridge is not a
  general renderer event bridge). Seed with `GET /open` on mount and on
  reconnect. Keep the list in POS renderer state keyed by `id`. When another
  machine claims a row, remove it from the cashier waiting list rather than
  showing a disabled card.
- Render a small **"Kitchen orders (N)"** badge in the POS top bar, mirroring the
  existing Hold/Recall affordance (`QuickActions` `recall`, `handleRecallCart` in
  `templates/retail/RetailTemplate.tsx`). Tapping opens a panel of order cards:
  big `orderNumber`, item preview, total, age.

### 7.2 Unified "open an order" handler (list tap **and** QR scan)
Both paths call one function `openPickupOrder(target)`:

0. Preflight locally before claiming:
   - cart must be empty;
   - payload must contain at least one item;
   - refactor the current QR loader into `prepareKitchenSelfOrderCart(payload)`
     and `commitPreparedKitchenSelfOrder(prepared, pickupOrderId?)`, or return an
     explicit success/failure result from the loader. Do not claim an order just
     to discover the cart cannot be built.
1. Resolve the queue row:
   - **list tap** → the row `id` directly;
   - **QR scan** (`handleBarcodeKeyDown` → `decodeKitchenSelfOrderQr` returns a
     payload with `orderNumber` and `orderId`) → find the matching PENDING row in
     local list state by `sourceOrderId === payload.orderId` first. Use
     `orderNumber` only if it maps to exactly one row. If not found locally, call
     `POST /claim-by-ref { sourceOrderId: payload.orderId, orderNumber }`.
2. `POST /:id/claim` (or `/claim-by-ref`):
   - **200 ok** → commit the prepared cart; dispatch `checkoutDraft/update` with
     `kitchenSelfOrder` **plus `pickupOrderId`** so settle can reference it; remove
     the row from visible waiting list.
   - **409 already claimed / ambiguous** → toast "Order is being handled at
     another station" or "Order number is ambiguous"; do **not** load.
   - **410 settled/cancelled** → toast "Order already paid or cancelled"; do
     **not** load. This blocks duplicate charging from an old slip.
   - **404 not found** → QR scan may fallback-load from payload; list tap cannot
     fallback because the row existed by definition.
   - **network/backend unreachable** → QR scan may fallback-load from payload;
     list tap should show an offline error.
3. If cart commit fails after a successful claim, call `POST /:id/release`
   best-effort and show the load error. Do not leave the row claimed until TTL.
4. A scan never creates a pickup queue row. No queue row creation from cashier
   actions, ever.

This is the core of the owner's requirement: **scanning the QR claims the same
order, locks it to that machine, hides it elsewhere, and never spawns a
duplicate.**

### 7.3 Settle / release
- Extend `checkoutDraft.kitchenSelfOrder` with `pickupOrderId`.
- Stamp `pickupOrderId` on the resulting local POS sale (`orders.pickup_order_id`
  or a narrowly-scoped equivalent metadata column). Existing `kitchen_number` is
  not enough for reconciliation.
- On successful POS sale save, call `POST /:id/settle` with
  `{ posOrderId, posOrderNumber }` before the cart is cleared. The settle call is
  idempotent.
- If settle fails after the local sale is saved, write a durable local retry
  outbox entry keyed by `pickupOrderId` + `posOrderId`; retry on reconnect until
  the backend returns settled. Do not let this path release the pickup order.
- A generic `cart/clear` listener is too blunt because successful payment also
  clears the cart. Release only from explicit cashier cancel/clear-before-payment
  actions that still carry the active `pickupOrderId`.
- Disable Hold/Recall for an active pickup order in P3. If Hold is later allowed,
  the held cart must preserve `pickupOrderId` and remain claimed.

## 8. Lifecycle & edge cases (defaults — tunable)

- **Claim race** → atomic SQL claim; exactly one station wins; loser gets 409.
- **Claim stale threshold** → after **10 minutes**, a `CLAIMED` order with no
  `settledAt` becomes stale/manager-actionable, but it must **not** blindly
  auto-revert to `PENDING`. Auto-release can double-charge if the cashier saved a
  POS sale and the settle call/outbox is delayed.
- **Disconnect behavior** → do not blindly release on socket disconnect. A
  disconnect can happen during or after payment. Prefer explicit release from the
  claiming station before payment, plus manager/PIN reclaim for stale claims.
- **Daily scope / expiry** → `GET /open` only returns `businessDate = today`;
  yesterday's unsettled orders are implicitly expired. Manual `POST /:id/cancel`
  for "customer never showed". A stale claim from a prior business date should be
  visible only in manager/admin cleanup, not in the normal cashier waiting list.
- **QR ↔ list consistency** → guaranteed by §7: both doors claim the same row;
  scanning settles it through the same `pickupOrderId` path.
- **Old QR slip** → if `/claim-by-ref` finds a `SETTLED` or `CANCELLED` row, the
  app blocks the scan. It must not fallback-load merely because no PENDING row is
  available.
- **Ambiguous `orderNumber`** → if `sourceOrderId` is missing and multiple rows
  match the same daily `orderNumber`, block and ask staff to choose from the list
  or enter a more specific reference. Do not guess.
- **Best-effort push failure** → order is absent from the queue but the QR still
  works; acceptable degradation.

## 9. Security & tenancy
- Kiosk create authed by Print Agent apiKey only (no JWT on an unattended kiosk),
  same as `self-checkout-help`.
- Every staff endpoint scopes by `@CurrentUser().salonId`; reject cross-salon ids.
- `payloadJson` is treated as data: the cashier still revalidates price/stock via
  the existing QR cart-building logic (which resolves products from the local
  catalog) — the pushed prices are only a QR-snapshot fallback, exactly as in the
  scan path.
- Throttle the kiosk create endpoint.

## 10. Phasing (each phase independently testable)
- **P1 — backend.** Entity + migration + `PickupOrderService` + controller +
  gateway emits + unit/e2e tests. No client change yet (test with curl/REST).
- **P2 — kiosk push.** Best-effort POST on submit; verify rows appear via P1 API.
- **P3 — cashier integration.** Explicit pickup socket→IPC/preload bridge,
  `GET /open` seed, badge/panel, unified `openPickupOrder` (list tap + QR scan),
  QR prepare/commit refactor, `pickupOrderId` in `checkoutDraft`, local POS sale
  stamp, settlement retry outbox, and explicit release/cancel paths.
- **P4 — polish.** Stale-claim manager/PIN reclaim, manual dismiss reason, daily
  expiry display, list age display.

## 11. Testing
- **Backend:** claim atomicity (two concurrent claims → one 200, one 409);
  idempotent kiosk push on `(salonId, sourceOrderId)`; settle/release/cancel
  transitions; `claim-by-ref` status semantics (`404` fallback vs `409/410`
  block); ambiguous `orderNumber`; `GET /open` daily scoping; cross-salon
  rejection; idempotent settle with same/different `posOrderId`.
- **App (vitest):** pure helpers for list-merge from socket events and for the
  scan→row match (`sourceOrderId` primary, `orderNumber` unique fallback) +
  claim-state reducer. Cover "claim succeeds but cart commit fails → release",
  "settled QR scan blocks", "cart clear after successful payment does not
  release", and "Hold is disabled for pickup orders". Use the repo's
  **baseline-diff** discipline so no *new* failures are introduced (the repo
  carries known pre-existing failures).
- **Manual:** kiosk submit → order appears on cashier; tap loads cart; second
  station no longer sees it; pay → vanishes everywhere; scan the same slip on a
  fresh order → claims + loads + hides elsewhere; scan the same slip after settle
  → blocked, no duplicate. Simulate backend outage during settle and verify the
  local retry outbox later settles the pickup row.

## 12. Rollout constraints (must hold)
- **Do not** build into or release onto chesaigon POS machines.
- **Do not** deploy the backend to production as part of this work.
- Dev + this spec on `winpc` (`C:\POS-zira`); backend code in the `enail` repo.
- QR scan path stays intact as the offline fallback throughout.

## 13. Defaults after review (owner can override)
1. Claim stale threshold: keep **10 min**, but do **not** auto-release. Show stale
   claimed rows as manager-actionable/reclaimable.
2. Stamp `pickupOrderId` on the resulting POS sale. Settle-only is not enough for
   later reconciliation or debugging.
3. Manual dismiss/reclaim is manager/PIN gated and requires a reason. Any logged-in
   cashier can explicitly release only the order that their own station claimed
   before payment started.
