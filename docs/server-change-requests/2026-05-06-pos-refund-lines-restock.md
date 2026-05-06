# SCR: POS refund lines, restock, and backend PDF

Date: 2026-05-06
Requester: codex
Target repo: eNail backend

## Problem

Print Agent sends POS partial refunds as line payloads keyed by `variantId` / `sku`:

```json
{
  "type": "PARTIAL",
  "amount": 35.98,
  "reason": "Damaged item",
  "lines": [
    {
      "variantId": "uuid",
      "sku": "SKU-1799",
      "name": "Refunded item",
      "quantity": 2,
      "unitPrice": 17.99,
      "refundAmount": 35.98,
      "restock": true
    }
  ]
}
```

For order `POS-20260506-0004`, the backend accepted the call but returned `refundedLines=[]` and `stockMovementIds=[]`; the backend refund PDF then printed `-0.00`. The client previously wrote local refund state from its request lines, which hid the server failure.

Second incident: for `POS-20260506-0001`, the first partial refund returned `status=PARTIAL_REFUND`, `refundAmount=28.00`, `refundedLines=[]`, and `stockMovementIds=[]`. The client correctly must not fake success from that incomplete response, but because the server mutation was already applied, retrying the refund produced a backend total refund of `51.66` on an order whose total was `42.00`. That is an over-refund and must be rejected server-side, not merely patched in the desktop client.

## Required Server Behavior

`POST /api/v1/b2b/pos/orders/:id/refund` must accept POS `lines[]` with `variantId` and/or `sku`, resolve each line to the canonical backend order item, validate quantity and amount, and persist real `refundedLines`.

If `restock=true`, the server must apply stock restoration and return created stock movement IDs. If the backend contract instead remains `items[{ orderItemId, quantity }]`, the order create/sync response must expose canonical backend order item IDs so the client can store and send them. Do not require the client to send local `order_items.id` as `orderItemId`; those IDs are not backend item IDs.

Refund processing must be atomic and idempotent. If a refund mutation is committed, the response must include the persisted refund lines and stock movement IDs. A duplicate request, double click, retry after timeout, or repeated local call must not push cumulative `refundAmount` above the order total. Add an idempotency key/refund request ID if the existing endpoint cannot distinguish a retry from a new refund.

## Response Contract

A successful partial refund of `2 x 17.99` with `restock=true` must return delta fields for the current refund call, plus the cumulative refunded total:

```json
{
  "success": true,
  "status": "PARTIAL_REFUND",
  "refundAmount": 35.98,
  "totalRefundedAmount": 35.98,
  "refundedLines": [
    {
      "variantId": "uuid",
      "sku": "SKU-1799",
      "name": "Refunded item",
      "quantity": 2,
      "unitPrice": 17.99,
      "refundAmount": 35.98,
      "taxRate": 23
    }
  ],
  "stockMovementIds": ["uuid"]
}
```

`POST /refund` returns `refundAmount` and `refundedLines` for the current call. `GET /orders/:id` and `sync_log status_changed` payloads return cumulative `refundAmount` and cumulative `refundedLines`.

## Acceptance Criteria

- Partial refund `2 x 17.99` persists `refundAmount=35.98`.
- Response has `refundedLines.length > 0`.
- Response includes `totalRefundedAmount`.
- Response has `stockMovementIds.length > 0` when any line has `restock=true`.
- Backend receipt PDF for the refund shows the refunded item line and `-35.98`, not `-0.00`.
- Stock quantity increases/restores according to `restock=true`.
- Backend rejects or idempotently ignores any refund that would make cumulative `refundAmount` exceed the order total.
- Backend regression covers `POS-20260506-0001` shape: total `42.00`, prior refunded `28.00`, repeated full refund attempt must not result in cumulative `51.66`.
- Add backend contract tests for the line-resolution path and PDF rendering path.
