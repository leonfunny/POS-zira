# Product Admin Stock Adjustment Optional Note Plan

Date: 2026-07-07
Target: POS-zira Products tab on WinPC (`C:\POS-zira`)

## Context

The Products tab stock adjustment dialog currently treats the text reason field as required for every mode except `recount`. This blocks normal stock receiving even though the backend contract already supports a missing note for `receive` and `recount`.

Product decision: the text field should be a note, not the primary reason. The selected adjustment mode is the structured reason. The note is optional; leaving it blank must still allow the adjustment.

## Current Contract

POS route:

- Renderer calls `window.electronAPI.pos.productAdmin.adjustStock(...)`.
- Main process handles `pos:product-admin:adjust-stock`.
- API client sends `POST /product-admin/variants/:variantId/stock-adjustments`.

Backend behavior today:

- `receive` without note: accepted, backend returns `Stock received via product-admin facade`.
- `recount` without note: accepted, backend returns `Manual recount from POS`.
- `damage`, `loss`, `return` without note: rejected by backend today.
- Any mode with a non-empty note such as `hi`: backend uses that exact trimmed note as the audit reason and returns it in `adjustment.reason`.

Create-product initial stock is separate: when a new product is created with initial stock, backend uses `Initial stock on product create`.

## Target Behavior

All stock adjustment modes should allow an empty note:

| Mode | Meaning | Quantity Input | Note |
| --- | --- | --- | --- |
| `receive` | Add received stock | Delta quantity | Optional |
| `recount` | Set actual counted stock | Absolute quantity | Optional |
| `damage` | Remove damaged/expired/broken stock | Delta quantity | Optional |
| `loss` | Remove missing/lost stock | Delta quantity | Optional |
| `return` | Add customer return back to sellable stock | Delta quantity | Optional |

If the note is empty, backend should fill a stable default audit reason based on the mode. If the note is present, backend should store and return the trimmed note.

Suggested defaults:

- `receive`: `Stock received via product-admin facade`
- `recount`: `Manual recount from POS`
- `damage`: `Damaged stock adjustment from POS`
- `loss`: `Lost stock adjustment from POS`
- `return`: `Customer return restocked from POS`

## Implementation Plan

1. POS app: rename the text field from "Reason" to "Note" in the stock adjustment dialog.
2. POS app: remove client-side required-note validation for all stock adjustment modes.
3. POS app: submit `reason: undefined` when the note is blank; submit the trimmed note when present.
4. POS app: expose the backend-supported `return` mode only if the user-facing label is clear, e.g. "Customer return / Khach tra lai".
5. Backend: update `resolveStockAdjustmentAuditReason()` so `damage`, `loss`, and `return` no longer throw when note is empty; instead use the defaults above.
6. Backend DTO/API docs: update the note description from "Required for damage/loss/return" to "Optional for all modes; backend fills a mode-based default when omitted."
7. Tests: replace the test that expects missing `damage/loss/return` notes to fail with tests confirming default audit reasons for those modes.
8. Verify on WinPC against production backend:
   - Receive stock with blank note succeeds.
   - Recount with blank note succeeds.
   - Damage with blank note succeeds and returns the default damage reason.
   - Loss with blank note succeeds and returns the default loss reason.
   - Return with blank note succeeds if the mode is exposed in UI.
   - Any mode with note `hi` returns `adjustment.reason = "hi"`.

## Safety Notes

- Do not change stock math in this task.
- Do not bypass optimistic concurrency (`expectedUpdatedAt`).
- Keep backend as the source of truth for the audit reason returned to the POS app.
- Stock adjustments should remain online-only for now.
