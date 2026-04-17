# Zira AI Print Agent — Session Handoff

> Last updated: 2026-04-17 (session 52) | Read this file at the start of every new session.

---

## Session 52 — Wire server POS endpoints into UI (2026-04-17)

**Status:** Built, both tsc passes, NOT committed yet. Requires live server test.

Server team shipped endpoint spec (41 endpoints). Cross-checked with client; wired high-value gaps.

### New `apiClient` methods (`src/main/network/api-client.ts`)
- `getOrderPdf(token, backendId, kind, invoiceType)` — `GET /b2b/pos/orders/{cash|invoiced}/:id/{receipt,invoice}-pdf`
- `addInvoiceToOrder(token, backendId, {customerNip, invoiceType})` — `PATCH /b2b/pos/orders/:id/add-invoice`
- `generateProforma(token, backendId)` — `POST /b2b/pos/orders/:id/generate-proforma`
- `lookupCustomerByNip(token, nip)` — `GET /b2b/pos/customers/nip/:nip` (GUS fallback)
- `getOrderServerHistory(token, backendId)` — `GET /b2b/pos/orders/:id/history`
- Fixed stale comment `/api/v1/pos/products` → `/api/v1/warehouse/public/products`

### IPC handlers (`src/main/modules/pos.module.ts`)
- `pos:orders:downloadPdf` (save dialog + auto-open)
- `pos:orders:addInvoice` (also updates local `orders.customer_nip`)
- `pos:orders:generateProforma`
- `pos:customers:lookupNip`
- `pos:orders:getServerHistory` (IPC only, no UI yet)

### Preload + types
- `src/preload/preload-pos.ts`: new methods under `pos.orders.*` + `pos.customers.lookupNip`
- `src/shared/electron.d.ts`: type signatures added

### UI (`OrderHistoryModal.tsx`)
- New `ServerActionsPanel` in order detail sidebar (visible when `backend_id`):
  - Download Receipt/Invoice PDF
  - NIP input + GUS lookup + "Attach invoice" (when no invoice yet)
  - Generate Proforma
- Added `customer_nip`, `customer_name` to `OrderRow` interface

### Still NOT wired
- Server audit log viewer UI
- Item editing (`PATCH/POST/DELETE .../items`)
- Notify Telegram, email send (server stub)
- Mark-paid, cancel, delete (overlap with refund flow)
- PIN login via `/public/pos/:slug/login`
- SQL.js `undefined bind` bug in order `POS-20260417-0009` sync

---

## Session 51 — PaymentModal Touch Keypad + POS Bug Fixes

**Status:** Built, typecheck passes. Not yet committed.

### Keypad
- `PaymentModal.tsx`: In-modal numeric keypad (4x4 grid) for touchscreen POS use
  - Digits 0-9, decimal, backspace (SVG), clear, 00, quick actions (Exact/Remaining)
  - Functional state updates for rapid-tap safety; disabled during saving
  - Cash mode + split mode support; physical keyboard still works
- E2E verified with screenshots at 1280x720 and 1600x900

### Payment speed optimization
- **Before:** 10-15s (4 PowerShell spawns + 1.5s hardcoded delay)
- **After:** ~3-5s (1 combined PS spawn, cached presence check, 300ms post-check)
- `thermal-driver.ts`: Combined flush+print+post-check into single PowerShell call; cached printer presence (10s TTL); removed 1500ms hardcoded delay
- `PaymentModal.tsx`: Receipt print + drawer open in parallel; shows "Printing..." status

### Post-payment reset
- `RetailTemplate.tsx`: Search query and category reset to "All" after payment

### Discount fix
- `pos-store.ts`: Cart stores `discountType` + `discountPercent`; `recalcCart` recalculates percentage discounts when items change; added `cart/clearDiscount` action
- `Cart.tsx`: Shows discount percentage, added X button to remove discount

### VAT display
- `Cart.tsx`: "Incl. VAT" now styled as informational (italic, parenthesized, lighter color). Prices are gross (VAT-inclusive) — current calculation is correct for Polish retail.

### aria-hidden fix
- `POSLayout.tsx`: Replaced `aria-hidden="true"` with `aria-label="Barcode scanner"` on hidden scanner input (fixes Chrome console errors on fullscreen toggle)

---

## Session 50 — Path B Sync + Refund + Split Payment + Sync Health

**Status:** ✅ Committed and pushed (`1dd7d6c`). 34 files, +3281/-467 lines.

### Path B Bidirectional Sync (log-based)
- SyncLogService: pull/push/real-time via `/sync/pull`, `/sync/push`, `sync:entry` socket
- Auto-detect server capability on connect → progressive mode upgrade (`path_a` → `path_b_full`)
- Entity applicators for product/stock/order/staff/invoice/checkin/category
- camelCase ↔ snake_case normalization, seq gap detection, crash recovery, log pruning
- SyncConflictBanner: non-blocking cashier UI for rejected sync entries
- Migrations v17-v18: `local_sync_log`, `sync_state`, `sync_conflicts`, `sync_attempts`
- **Tested live**: pull=true, push=true, mode auto-upgraded to path_b_full

### Refund Flow (P0)
- Full + Partial refund via `POST /b2b/pos/orders/:id/refund` (backend commit 3f8c04f3, chờ deploy)
- Inline refund panel in OrderHistoryModal (2-step confirm, reason dropdown)
- Refund receipt: "ZWROT / REFUND" banner + original order number + reason
- Status badges (REFUNDED / PARTIAL_REFUND) on order list
- Migration v19: `refunded_at` column

### Split Payment
- PaymentModal: toggle "Split" → add multiple tenders (method + amount)
- OrderSync sends `tenders[]` to backend (already supported on production)
- Receipt + Z-report show split breakdown
- Migration v20: `payment_tenders` JSON column

### Sync Health Fixes
- Order/shift sync retry cap (5 attempts → shelved as `synced=-1`)
- ProductSync remembers delta unsupported → skips 7s retry waste
- Payment method mapping: `TRANSFER` → `BANK_TRANSFER`
- Path A always runs alongside Path B (catalog + outbox sync)

---

## POS Roadmap

### P0 — Done
- [x] Refund flow (full + partial)
- [x] Quantity type-in
- [x] Split payment

### P1 — Should have
- [x] PaymentModal touch keypad (s51)
- [ ] Custom/open price items (cần backend sync)
- [ ] Z-report warning (thiếu/thừa tiền > 5zl)

### P2 — Nice to have
- [ ] Staff PIN login (cần backend: PIN field cho staff)
- [ ] Keyboard shortcuts (F2=void, F3=discount)
- [ ] Receipt email/PDF export
- [ ] Order-level notes

### Chờ backend deploy
- [ ] Refund endpoint (commit 3f8c04f3)
- [ ] `since` param fix + stock init (commit 36de4926)
- [ ] Barcodes (commit 1228ca47)
- [ ] Staff PIN endpoint — chưa gửi request

---

## Sync Architecture

**Path B live** — auto-detected, 4 progressive modes.
- Pull: `/api/v1/sync/pull?after=N` (15s interval)
- Push: `/api/v1/sync/push` (10s interval)
- Real-time: `sync:entry` socket event
- Path A code intact as fallback

Key files: `sync-log-service.ts`, `sync-log-repo.ts`, `entity-applicators.ts`, `sync.module.ts`

---

## Prior Sessions (compact)

**s49:** Path B sync foundation — migration v17, SyncLogService, entity applicators, conflict banner
**s47:** POS production readiness — UX fixes, order history, Phase 3 sync (Path A), backend enrichment
**s46:** Phase 2 booking_number per-register + clearSalonData leak fix
**s45:** Phase 1 log-based sync (checkin + salon customer, dark launch)
**s44:** Check-in receipt: 1 service/label + QR on last page

---

## Dev Commands
```bash
npm run dev              # tsc --watch + vite dev server
npm run build && DEBUG=1 npm run start   # build + run with DevTools
npm run dist:win         # NSIS installer
```
