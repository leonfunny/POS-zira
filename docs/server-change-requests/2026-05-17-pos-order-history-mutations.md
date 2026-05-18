# SCR: POS order history edit, payment change, and void mutations

Date: 2026-05-17
Requester: codex
Target repo: eNail backend

## Problem

The Electron POS order history currently can safely mutate only local unsynced orders. Synced orders are canonical on the backend and are pulled back into order history, so any client-only delete, edit, or payment-method change would be overwritten by server history and would create mismatches in sales reports, stock, receipts, refunds, and cash/card totals.

The current POS backend client surface in this repository supports order fetch/list/PDF, invoice/proforma, refund, and cancel-style operations, but it does not expose a contract for editing synced order lines, changing a synced order payment method or tenders, or deleting/voiding a synced order from the POS history workflow.

## Required Server Behavior

The backend must own all mutations for synced POS orders and return the canonical updated order after each mutation. Mutations must be atomic, auditable, idempotent, and protected by optimistic concurrency.

Synced orders must not be hard-deleted for normal POS history cleanup. The backend should support a void/cancel mutation that preserves the order record, reverses report and stock effects where allowed, and records who changed it and why. Hard delete may exist only for backend-approved draft or legally disposable states.

All write requests must require a stable `mutationId`, `expectedVersion`, `reason`, actor context, and POS terminal context. Duplicate mutation IDs must return the already committed result instead of applying the mutation twice. If `expectedVersion` is stale, the backend must reject the write and return the latest canonical order.

## API Contract

Add payment update:

```http
PATCH /api/v1/b2b/pos/orders/:id/payment
```

```json
{
  "mutationId": "uuid",
  "expectedVersion": 4,
  "reason": "Customer paid cash instead of card",
  "paymentMethod": "CASH",
  "paidAmount": 120.00,
  "changeAmount": 0.00,
  "tenders": [
    {
      "method": "CASH",
      "amount": 120.00
    }
  ],
  "terminalId": "pos-device-id",
  "clientTimestamp": "2026-05-17T16:20:00.000Z"
}
```

Add order item/total update:

```http
PATCH /api/v1/b2b/pos/orders/:id
```

```json
{
  "mutationId": "uuid",
  "expectedVersion": 4,
  "reason": "Wrong item quantity entered",
  "items": [
    {
      "orderItemId": "backend-order-item-id",
      "variantId": "variant-id",
      "sku": "SKU-123",
      "quantity": 2,
      "unitPrice": 15.00,
      "discount": 0,
      "taxRate": 23
    }
  ],
  "paymentMethod": "CASH",
  "paidAmount": 30.00,
  "changeAmount": 0.00,
  "terminalId": "pos-device-id",
  "clientTimestamp": "2026-05-17T16:20:00.000Z"
}
```

Add order void:

```http
PATCH /api/v1/b2b/pos/orders/:id/void
```

```json
{
  "mutationId": "uuid",
  "expectedVersion": 4,
  "reason": "Duplicate test order",
  "restock": true,
  "terminalId": "pos-device-id",
  "clientTimestamp": "2026-05-17T16:20:00.000Z"
}
```

Each endpoint must return:

```json
{
  "success": true,
  "order": {
    "id": "backend-order-id",
    "orderNumber": "POS260517-0008",
    "status": "VOIDED",
    "version": 5,
    "paymentMethod": "CASH",
    "items": []
  },
  "mutation": {
    "id": "uuid",
    "type": "ORDER_VOIDED",
    "createdAt": "2026-05-17T16:20:01.000Z"
  },
  "stockMovements": [],
  "shiftImpact": {
    "cashDelta": -120.00,
    "cardDelta": 0.00,
    "salesDelta": -120.00
  },
  "printRequired": false,
  "fiscalBlocked": false
}
```

## State Rules

Unsynced local orders may be edited or deleted by the Electron app before they are uploaded. Once an order has a backend ID or is marked synced, the Electron app must call the backend mutation endpoints instead of changing local SQLite as the source of truth.

Fiscal or legally finalized orders must be protected. If a fiscal receipt was printed, item/total edits should be rejected unless the backend has a compliant correction flow. Payment-method changes after fiscalization should also be explicitly allowed or rejected by server policy, not guessed by the desktop client.

Refunded, partially refunded, cancelled, or voided orders must be read-only except for allowed follow-up actions such as reprint, refund document generation, or backend-approved correction flows.

## Persistence and Audit

Add or expose an order version field for optimistic concurrency. Store immutable mutation history with mutation ID, order ID, mutation type, before/after values, reason, actor, terminal ID, timestamps, and source application.

When items change, the backend must reverse prior stock and sales effects as needed, apply new effects, and return the created stock movements. When payment changes, backend reports must move totals between cash/card/split buckets and return the shift/report impact.

## Sync Requirements

Backend sync/log streams must emit canonical mutation events so Electron clients converge after online updates:

- `order.payment_updated`
- `order.items_updated`
- `order.voided`
- `order.deleted` only if hard delete is explicitly supported

Each sync payload must contain the canonical order, version, updated totals, status, payment fields, item lines, and enough mutation metadata for local audit display.

## Electron Follow-Up After Backend Is Ready

After these endpoints exist, the Electron app can add order-history actions for edit, payment change, and void/delete. For synced orders the UI should call the backend, then update local SQLite from the canonical response. For unsynced orders the UI can update local SQLite directly and adjust the pending sync payload.

The UI must show reason-required confirmation for destructive or financial changes, block unsupported states, surface stale-version conflicts with a refresh action, and keep reprint/history actions available for read-only orders.

## Acceptance Criteria

- Changing a synced order from card to cash updates backend order payment fields, local history after sync, and cash/card report totals.
- Editing a synced order line changes totals, persists an audit entry, applies stock delta correctly, and returns the canonical updated order.
- Voiding a synced order removes it from active sales totals without hard-deleting the historical record.
- Duplicate requests with the same `mutationId` do not apply twice.
- Stale `expectedVersion` requests are rejected with the latest canonical order.
- Fiscal, refunded, cancelled, and voided orders are blocked or routed to a compliant correction flow according to server policy.
- Electron local history remains consistent after app restart and after a fresh server pull.
- Backend contract tests cover payment update, item update, void, duplicate mutation retry, stale version conflict, stock delta, and report delta.
