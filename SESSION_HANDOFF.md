# Zira AI Print Agent — Session Handoff

> Last updated: 2026-04-15 (session 47 — POS production readiness sprint) | Read this file at the start of every new session.

---

## Session 47 — POS Production Readiness Sprint

**Status:** ✅ SHIPPED. Build passes. POS tab ready for basic retail sales.

### What was done (this session)

**Infrastructure fixes:**
- `net.fetch` removed — was causing HTTP 405 on POST requests. Now uses plain `globalThis.fetch`
- Logout now fully clears config (`isPaired`, `agentId`, `salonId`) + disconnects socket + clears POS cart
- Offline mode: calls `logout()` + seeds demo products from `seed.ts`
- React `key={sessionKey}` forces full component tree remount on user switch (prevents state leakage)
- Cart persistence scoped per-user (`pos.activeCart.{userId}`), preserved across logout/login cycles
- Product pagination: `limit=100` + auto-paginate through all pages (was only fetching 20/46 products)

**Backend enrichment wired (v14+v15 migrations):**
- New columns: `available_qty`, `price_gross`, `price_net`, `vat_amount`, `is_on_sale`, `thumbnail_url`, `sale_unit`
- API client maps all enriched fields from backend including `saleUnit`, `template.taxRate` (replaces hardcoded 23)
- Category `color` now flows through from backend
- Sync uses server's `nextSince` instead of local time (eliminates clock skew)
- Delta sync handles `deletedIds[]` — deactivates products deleted on backend
- Receipt includes `unit` (szt./kg/paczka) from product catalog

**POS UX improvements:**
- Decimal input fixed (`.` no longer deletes field) — CartItem, ShiftModal, PaymentModal, QuickActions
- PaymentModal scrolls above touch keyboard (`items-start overflow-y-auto mb-[320px]`)
- Discount: fixed + percentage toggle (zł / %)
- Search: diacritics-aware (`banh bao` finds `Bánh Bao`)
- Barcode scan toast feedback (green success / red not found)
- Cart clear 2-step confirm
- Quantity stepper: minus disabled at qty=1
- VAT display in cart totals
- Category pill: fallback brand color `#da7756` when backend has no color
- Products auto-retry 2s after empty initial load (post-login sync timing)
- Sidebar shows "..." while user info loads
- ProductCard: `React.memo` + image error fallback + thumbnail preference + SALE badge

**Order History (new feature):**
- History button in QuickActions bar → modal with paginated order list (20/page)
- Filters: date picker + payment method + staff name
- Detail view: line items, subtotal, discount, VAT, total, change
- Reprint receipt: `*** KOPIA / REPRINT ***` banner + original date + reprint timestamp
- IPC: `pos:orders:getHistory`, `pos:orders:getDetail`, `pos:reprint-receipt`

**Payment reliability:**
- `printReceipt` + `openCashDrawer` now awaited (was fire-and-forget)
- Cart only cleared AFTER order save succeeds (was clearing before)
- PosModule clears cart + session on `user:logged-out` event

**i18n:** 13 new keys × 7 languages (confirmClear, inclVat, blikSales, history.*)

### Files changed (key ones)
- `src/main/network/api-client.ts` — pagination, enriched fields, deletedIds, saleUnit
- `src/main/database/migrations.ts` — v14 (enriched fields), v15 (sale_unit)
- `src/main/database/repos/product-repo.ts` — new fields, getById, deactivateByIds, diacritics search
- `src/main/database/repos/order-repo.ts` — getByDateRange with pagination
- `src/main/sync/product-sync.ts` — retry logic, nextSince, deletedIds handling
- `src/main/pos/pos-store.ts` — percentage discount
- `src/main/pos/payment-controller.ts` — reprintReceipt, saleUnit in receipt
- `src/main/modules/pos.module.ts` — order history IPC, reprint IPC, seedDemo, logout cart clear
- `src/main/modules/auth.module.ts` — full config clear on logout
- `src/main/hardware/thermal/escpos-formatter.ts` — reprint banner, unit display
- `src/shared/types.ts` — ReceiptItem.unit, ReceiptData.isReprint/originalDate
- `src/renderer/components/pos/OrderHistoryModal.tsx` — NEW
- `src/renderer/components/pos/PaymentModal.tsx` — decimal fix, await receipt, keyboard scroll
- `src/renderer/components/pos/Cart.tsx` — VAT display, confirm clear
- `src/renderer/components/pos/CartItem.tsx` — decimal fix, disable minus at 1
- `src/renderer/components/pos/ProductCard.tsx` — memo, image fallback, thumbnail, sale badge, available_qty
- `src/renderer/components/pos/templates/retail/RetailTemplate.tsx` — cart persistence, history modal, product retry
- `src/renderer/components/pos/templates/retail/QuickActions.tsx` — discount %, history button
- `src/renderer/App.tsx` — sessionKey remount, clearRendererState, offline seedDemo

---

## POS Roadmap — Features to Build Next

### P0 — Block go-live (cần cho shop thực tế)
- [ ] **Void/Refund flow** — staff cần xử lý trả hàng. Cần: VoidOrderModal, refund order type, void_reason field. Cần backend sync refund orders.
- [ ] **Quantity type-in** — bán 20 cái phải bấm + 20 lần. Thêm text input cho quantity thay vì chỉ stepper.

### P1 — Should have
- [ ] **Split payment** — 50zl cash + 50zl card. Cần sửa PaymentModal + order schema.
- [ ] **Custom/open price items** — sản phẩm chưa có trong catalog. Cần backend sync (log-based, xem Phase 3 bên dưới).
- [ ] **Z-report cảnh báo** — thiếu/thừa tiền > 5zl → warning trước khi close shift.

### P2 — Nice to have
- [ ] Staff PIN login for shift (cần backend: PIN field cho staff)
- [ ] Display On per business type (retail vs salon vs restaurant)
- [ ] Keyboard shortcuts (F2=void, F3=discount)
- [ ] Receipt email/PDF export
- [ ] Order-level notes

### Đã gửi backend (chờ deploy)
- [x] `saleUnit` on products — ✅ deployed, wired
- [x] `deletedIds[]` in delta sync — ✅ deployed, wired
- [ ] Staff PIN endpoint — chưa gửi request

---

## Log-Based Sync Design (cross-session tracking)

Full architecture in `C:\Users\pc\.claude\plans\snuggly-exploring-wozniak.md`.

**Phase 1** (check-in + salon customer sync): ✅ client shipped, dark launch. Awaiting backend endpoints.
**Phase 2** (booking number collision fix): ✅ shipped.
**Phase 3** (server → client change feed / catch-up sync): NOT STARTED. This is where custom items, product edits from backend, and real-time catalog updates would flow.

User muốn custom items sync qua log-based system (không client-only). Cần Phase 3 để implement.

---

## Prior Sessions (compact)

**s46:** Phase 2 booking_number per-register + clearSalonData leak fix
**s45:** Phase 1 log-based sync (checkin + salon customer, dark launch, awaiting backend)
**s44:** Check-in receipt: 1 service/label + QR on last page
**s43:** Investigations + SESSION_HANDOFF compaction

---

## Dev Commands
```bash
npm run dev              # tsc --watch + vite dev server
npm run build && DEBUG=1 npm run start   # build + run with DevTools
npm run dist:win         # NSIS installer
```
