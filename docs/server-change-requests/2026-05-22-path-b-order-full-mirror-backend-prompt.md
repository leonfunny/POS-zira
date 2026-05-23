# Backend bot prompt: Path B order full mirror

Date: 2026-05-22
Requester: codex
Client repo: `C:\Users\pc\POS-zira`
Target: eNail backend

## Goal

Finish Path B full mirror for POS orders so the Electron POS tab can stop relying on REST fallback and mirror-on-click for multi-device order history/refund workflows.

The desired end state:

- POS A creates an order.
- Backend persists it and emits a full `sync_log` order entry.
- POS B receives the order through Path B and stores it locally without opening the REST order detail endpoint.
- POS B can refund/cancel/update supported order state using backend-owned mutations.
- POS A receives the reflected order state through Path B.
- Only after this is verified should the Electron client remove transitional REST fallback, `mirrorFromServer`, `_origin='server'`, and view-only gates.

## Current Client State

Important files in `C:\Users\pc\POS-zira`:

- `src/main/sync/entity-applicators.ts`
  - `applyOrder()` already has an INSERT path for missing local rows, but only if payload has `items[]`.
  - If payload has no `items[]`, it logs and skips mirroring.
- `src/main/sync/pos-order-adapter.ts`
  - Converts backend order shape into local `orders` + `order_items`.
- `src/main/database/repos/order-repo.ts`
  - `upsertFromServer()` writes server-originated orders into local SQLite.
- `src/main/modules/pos.module.ts`
  - Still exposes `pos:orders:getServerList` REST fallback.
  - Still exposes `pos:orders:mirrorFromServer` transitional mirror-on-click.
  - Synced destructive actions still guard on `order.backend_id`.
- `src/renderer/components/pos/OrderHistoryModal.tsx`
  - Still uses server list merge and mirror-on-click for `_origin='server'` rows.

Client verification already passes locally:

```powershell
cd C:\Users\pc\POS-zira
npm test -- --run tests/self-checkout-model.test.ts tests/self-checkout-receipt-screen.test.ts tests/product-module-static.test.ts tests/product-sync-guard.test.ts tests/forecast-engine.test.ts tests/replenishment.test.ts tests/order-sync.test.ts tests/sync-log-push-order-accept.test.ts --reporter=dot
npm run build
```

## Backend Investigation Needed

Please SSH into this machine if useful and inspect the client files above. Then inspect backend code and/or production DB for these questions:

1. Does the backend emit `sync_log` rows with `entity_type = 'order'` for:
   - POS order created
   - order refunded / partial refunded
   - order cancelled / voided
   - invoice attached
   - proforma generated
   - payment updated / items updated, if those endpoints are live

2. For each order sync entry, does `payload` contain a full offline-renderable order shape, including:
   - order id
   - order number
   - status and payment status
   - payment method and tenders / split tender data
   - totals in a shape the client adapter can normalize
   - customer fields including NIP if present
   - created/updated timestamps
   - refund amount, refund reason, refunded lines
   - `items[]` with backend order item ids, variant ids, SKU/barcode/name, quantity, unit price, tax/VAT, line totals

3. Are `sync:entry` socket payload keys camelCase (`entityType`, `entityId`) or snake_case? The client normalizes both, but please keep this stable.

4. Are the emitted order payload fields aligned with what `src/main/sync/pos-order-adapter.ts` expects? If not, either adjust backend payload or tell us the exact client adapter change needed.

5. Does backend idempotently handle duplicate client `order/created` pushes by returning an accepted duplicate response with the original backend order id? The client treats `code='DUPLICATE'` for `order/created` as accepted.

6. Does backend publish order status/refund updates for orders created by another POS, by dashboard, or by mutation endpoints, not only echo the creating POS?

## Minimum Server Acceptance Criteria

Please implement or verify:

- A full-payload `entity_type='order'` sync-log row is emitted after order create.
- The payload includes non-empty `items[]`.
- Refund/cancel/invoice/proforma/payment/item mutations emit canonical order update sync entries.
- Socket delivery pushes the entry to other online agents in the same tenant.
- Pull replay returns the same entries after offline periods.
- Duplicate order create retries do not create duplicate backend orders and do return enough info for the client to set `backend_id`.
- Existing non-order sync entities are not regressed.

## Two-Device E2E To Run

Use the Chesaigon salon/test tenant if possible.

1. Start POS A and POS B with separate machine identities.
2. On POS A, create a cash/card order with at least two item lines.
3. On POS B, verify the order appears locally through Path B:
   - Do not click mirror-on-click.
   - Prefer checking local SQLite / logs to prove it came from `sync:entry` or `/sync/pull`.
4. On POS B, refund or cancel the order through the supported backend endpoint.
5. On POS A, verify the update arrives via Path B and local `orders.status`, refund amount, and `order_items` stay consistent.
6. Restart POS B and confirm the order remains local without server list fallback.

## What To Return

Please return:

- Backend commit hash(es) or confirmation no code change was needed.
- Exact sync-log payload sample with sensitive customer fields redacted.
- Whether the payload currently includes `items[]`.
- Two-device E2E result.
- Any client adapter changes needed in `POS-zira`.
- Whether it is safe to remove REST fallback, `mirrorFromServer`, `_origin='server'`, and view-only gates now, or which specific blocker remains.

## Notes

Codex tried the configured read-only Enail DB MCP on 2026-05-22, but PostgreSQL at `100.72.205.122:5433` refused the connection:

```text
connect ECONNREFUSED 100.72.205.122:5433
```

So live DB verification still needs backend bot access or a working DB tunnel.
