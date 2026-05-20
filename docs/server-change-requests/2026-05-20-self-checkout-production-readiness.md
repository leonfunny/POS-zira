# Server Change Request: Self-Checkout Production Readiness

Date: 2026-05-20
Client repo: `POS-zira`
Requester: codex

## Summary

The self-checkout customer window now fails closed in production mode because the client repo does not yet have a confirmed unattended-readiness contract for terminal payment, fiscal printing, shift/order readiness, scanner routing, or post-payment failure handling.

Do not implement unattended production self-checkout as a client-only workaround. Assisted/demo payment can continue to exist, but production must be driven by backend/main-process facts and idempotent payment/order contracts.

## Required Runtime Readiness Snapshot

Expose a single readiness snapshot through backend API and/or Electron main IPC:

```json
{
  "ready": false,
  "terminal": { "ready": false, "provider": "elavon", "terminalId": "T123", "reason": "offline" },
  "fiscalPrinter": { "ready": false, "printerId": "P123", "reason": "offline" },
  "orderCreate": { "ready": true },
  "shift": { "open": true, "shiftId": "S123" },
  "scanner": { "ready": true },
  "receiptPrinter": { "ready": true },
  "reasons": ["no_terminal", "no_fiscal_printer"]
}
```

The client will keep production self-checkout unavailable unless this snapshot is present and `ready` is true.

## Payment Attempt Contract

Production payment must use a first-class payment attempt:

`POST /api/v1/self-checkout/payment-attempts`

Request:

```json
{
  "idempotencyKey": "uuid",
  "terminalId": "T123",
  "amountGrosze": 2599,
  "currency": "PLN",
  "method": "CARD_OR_BLIK",
  "cartFingerprint": "sha256"
}
```

Response:

```json
{
  "attemptId": "PA123",
  "status": "pending",
  "terminalInstruction": "Use terminal",
  "expiresAt": "2026-05-20T12:05:00.000Z"
}
```

Status updates must be observable by socket or polling and must include `approved`, `failed`, `canceled`, `timeout`, and `unknown` states. Approved attempts must include a stable provider reference for fiscal/order audit.

## Order Creation Contract

After payment approval, order creation must be idempotent and tied to the payment attempt:

`POST /api/v1/self-checkout/orders`

Request must include `paymentAttemptId`, cart lines, customer NIP when present, kiosk terminal id, kiosk user id, and an idempotency key. Repeating the same request must return the same order result.

## Failure Rules

If payment is approved but order save, sync, fiscal print, or receipt print fails, the kiosk must not auto-reset or show thank-you. The response/status must tell the client to lock the kiosk and call staff with a clear reason.

## Catalog Metadata Needed

Self-checkout should not infer departments from category names forever. Add explicit fields to product/category payloads:

```json
{
  "visibleOnSelfCheckout": true,
  "selfCheckoutDepartment": "grocery",
  "selfCheckoutDisplayOrder": 10,
  "soldOutReason": null,
  "thumbnailUrl": "https://..."
}
```

Allowed departments for V1: `grocery`, `kitchen`.

## Help Request Contract

If customers are allowed to cancel an acknowledged help request, add an explicit cancel endpoint/status transition. Until then, the customer UI must stay locked until staff resolves the request.
