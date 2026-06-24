# Kitchen Self-Order — Reference QR (cashier pickup recall)

Status: APPROVED (design) · 2026-06-24 · app-only (POS-zira), backend unchanged
Related: `KITCHEN_SELF_ORDER_PICKUP_QUEUE_DESIGN.md`

## Problem

The customer slip QR currently carries the **full order payload** (items + notes,
`KSO1:` codec). Two consequences observed in production testing:

1. **Large orders → unscannable QR.** Many items make the 2D QR dense; the cashier
   scanner cannot read it.
2. **Scanned order lingers in the queue.** On scan, the cart loads but the matching
   pickup-queue row is not always claimed/settled, so after payment the order stays
   in the cashier "Đơn bếp (N)" list. Root cause: the scan path has a silent
   fallback (`loadKitchenSelfOrderQr` with no `pickupOrderId`) when `claim-by-ref`
   returns 404 / the backend is unreachable — it loads the cart **without claiming**,
   so the row never settles.

## Decision

Make the printed customer QR a **small reference** (`KSOREF:`) that points at the
backend pickup-order row, instead of self-containing the items. The cashier scan
**always** resolves through `claim-by-ref`, loads the cart **from the backend's
stored payload**, and settles on payment — structurally eliminating the "lingering
order" bug and making the QR tiny regardless of item count.

Scanner hardware = **2D / camera** (reads QR). Reference = `sourceOrderId` (the
kiosk-local `kitchen_self_orders.id`, a UUID → exact 100% match) plus `orderNumber`
as a human/secondary key.

Trade-off accepted by owner: this **drops the pure-offline item-load** from the QR.
The pickup queue already requires the backend (the list, claim, settle all do), so
if the backend is down the whole feature is down and staff ring up from the paper
slip manually (pre-feature baseline). The only new gap — a kiosk push that failed at
submit so no row exists — is closed by adding a **durable retry/outbox** to the push.

## The two customer print formats both become reference

Verified print map (`pos.module.ts`, `printing/kitchen-ticket.ts`,
`hardware/zebra/zpl-formatter.ts`):

| Print | Builder | QR field | Audience | Change |
|---|---|---|---|---|
| Kitchen ticket | `buildKitchenTicketLines` | `null` | cooks | none (no QR) |
| Customer slip "zamówienie" (thermal) | `buildKitchenPaymentSlipLines` | `qrPayload` | customer | → ref QR |
| Customer pickup slip (thermal) | `buildPickupSlipLines` | `qrPayload` | customer | → ref QR |
| Customer label (Zebra) | `zpl-formatter` | `labelQrPayload` | customer | → ref QR |
| Backend push | `pushPickupOrderBestEffort` | `qr: <full>` | backend | keep FULL payload |

Both customer formats (`qrPayload` thermal + `labelQrPayload` Zebra label) print the
reference. The full `KSO1:` payload is built only to push to the backend so the
server still has the items to rebuild the cart on claim.

## Flow

```
Kiosk submit
  → print customer slip/label: KSOREF:<uuidToken>.<orderNumber>   (~35 chars)
  → push FULL payload to backend  (with durable retry/outbox)
Cashier scans QR
  → detect KSOREF: prefix → decodeKitchenSelfOrderRefQr → { sourceOrderId, orderNumber }
  → claimByRef({ sourceOrderId, orderNumber })          // atomic, backend
  → load cart from claim response payload (res.data.payload.qr)   // NOT from the QR
  → stamp checkoutDraft.kitchenSelfOrder.pickupOrderId
  → pay → settle → row leaves the queue          ✅
```

## Changes (POS-zira app only)

1. **`src/shared/kitchen-self-order.ts`**
   - `KITCHEN_SELF_ORDER_REF_QR_PREFIX = 'KSOREF:'`
   - `buildKitchenSelfOrderRefQr(sourceOrderId, orderNumber): string`
     → `KSOREF:<token>.<orderNumber>`, `token = encodeKitchenSelfOrderUuidToken(sourceOrderId)`
       (fallback to URL-encoded raw id when not a UUID).
   - `decodeKitchenSelfOrderRefQr(code): { sourceOrderId: string|null, orderNumber: string|null } | null`
   - Keep legacy `decodeKitchenSelfOrderQr` (`KSO1:`) for slips printed before rollout.

2. **`src/main/modules/pos.module.ts`** (submit + 3 reprint sites)
   - Build the full payload only for the push; build `refQr` once and use it for the
     printed `qrPayload` and `ticket.labelQrPayload`.
   - `pushPickupOrderBestEffort({ …, qr: fullPayload })` unchanged in shape.

3. **`src/renderer/components/pos/POSLayout.tsx`** (scan entry: `handleBarcodeKeyDown`
   / `handleScannedKioskOrder`)
   - If the scanned code starts with `KSOREF:` → parse ref → `claimByRef` → on `ok`
     load the cart from the **claim response payload**, stamp `pickupOrderId`, set
     `activePickup`, remove from list. On `404` show a clear toast ("Đơn chưa lên hệ
     thống — chọn từ danh sách hoặc tính tay"); on `409/410` block (as today).
   - Legacy `KSO1:` scans still decode, but route through `claim-by-ref`
     (`sourceOrderId`/`orderNumber` from the decoded payload) and load from the
     backend payload — **remove the silent no-claim fallback**.
   - List-tap path (`openPickupOrder`) is unchanged (already claim-first, loads from
     claim payload).

4. **`src/main/kitchen-self-order/pickup-queue-client.ts`** (+ submit call site)
   - Upgrade the push from fire-and-forget to a **durable retry/outbox**:
     persist failed pushes in the config-store (`pendingPickupPushes`), drain on
     socket `connected`, mirroring `pendingPickupSettles` in `pickup-settle.ts`.
   - Safe because backend `pushFromKiosk` is idempotent on `(salonId, sourceOrderId)`.

## Backend (enail): no change

Already built and deployed (Contabo, dormant):
- `claimByRef` resolves `sourceOrderId` first (exact → atomic `claimById`), else
  `orderNumber` scoped to today with an ambiguity guard; returns the full payload.
- `pushFromKiosk` idempotent on `(salonId, sourceOrderId)`; never regresses a
  claimed/settled row.
- `settle` idempotent on `posOrderId`.

## Edge cases

- **404 (row never registered):** rare after retry/outbox. Clear error toast; no
  item fallback (ref carries no items). Cashier taps from the list or rings manually.
- **Backend down:** list + scan both stop; manual ring-up from the paper slip.
- **409 claimed elsewhere / 410 already paid:** block, to avoid double-charge.
- **Legacy slips printed before rollout (`KSO1:`):** still scannable; routed through
  `claim-by-ref` via the embedded `orderId`/`orderNumber`.

## Scope / constraints

- App-side only; **no backend deploy**. Forward feature for future salons.
- **Do NOT touch chesaigon.** Test on a test salon (kitchen-self-order,
  `PAY_AT_COUNTER`).
- Dev on winpc `C:\POS-zira`, branch `main`. Tests = vitest, baseline-diff discipline.

## Test focus

- Codec round-trip: `buildKitchenSelfOrderRefQr` ↔ `decodeKitchenSelfOrderRefQr`
  (UUID token + raw fallback + bad input → null).
- Scan handler: `KSOREF:` → claimByRef ok → cart from backend payload + settles;
  404/409/410 branches; legacy `KSO1:` still resolves via claim-by-ref.
- Push outbox: failed push persists + drains on connect; idempotent re-push.
- E2E (test salon, 2 machines): submit → small QR prints → scan → claim → pay →
  leaves queue; large order (many items) scans fine.
