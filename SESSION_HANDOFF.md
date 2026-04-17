# Zira AI Print Agent — Session Handoff

> Last updated: 2026-04-17 (session 50 — sync health + refund flow) | Read this file at the start of every new session.

---

## Session 50 — Sync Health Fixes

**Status:** ✅ Built and tested. Sync health fixes + Refund flow complete.

### What was done

**Fix 1: Order sync max retry (migration v18)**
- Added `sync_attempts` + `sync_error` columns to orders and shifts
- Orders cap at 5 retries → shelved as `synced=-1` after 5 failures
- Logs show `(attempt N/5)` for visibility
- Payment method mapping: `TRANSFER` → `BANK_TRANSFER`, `INVOICE` → `BANK_TRANSFER`
- Guards: skip orders with no items or missing variant_id

**Fix 2: Shift sync max retry**
- Same 5-attempt cap for shift open retries
- Stuck shifts (10+ "already open" errors) will be shelved after 5 attempts

**Fix 3: ProductSync delta skip**
- `deltaUnsupported` flag remembered in-memory per session
- First connect: discovers failure via 3 retries (~7s), then uses full sync
- Subsequent connects: skips straight to full sync (0s waste)

**Fix 4: Path B sync field normalization**
- Server sends camelCase (`entityType`, `sourceTx`, `createdAt`)
- Client normalizes to snake_case before processing
- Handles `sourceTx: null` by generating fallback `server-{seq}`
- Guards against `undefined` binds in sql.js

**Fix 5: Path B + Path A coexistence**
- ProductSync + StaffSync + OrderSync always run (Path B pull only handles changes, not full catalog)
- ChangeFeedSync only runs when NOT in Path B pull mode

**Refund Flow (P0 — block go-live):**
- Full + Partial refund via `POST /b2b/pos/orders/:id/refund` (backend commit 3f8c04f3, chờ deploy)
- Inline refund panel in OrderHistoryModal (2-step confirm, reason dropdown, amount input for partial)
- Refund receipt with "ZWROT / REFUND" banner + original order number + reason
- Status badges on order list (REFUNDED / PARTIAL_REFUND)
- Disabled state for unsynced orders and already-refunded orders
- Auto cash drawer open for cash refunds
- i18n: EN, PL, VI

### Files changed
- `src/main/database/migrations.ts` — v18: sync retry tracking, v19: refunded_at column
- `src/main/sync/order-sync.ts` — retry cap, PM mapping, item guards
- `src/main/sync/product-sync.ts` — delta unsupported flag
- `src/main/pos/shift-controller.ts` — retry cap for shifts
- `src/main/sync/sync-log-service.ts` — camelCase normalization, field guards
- `src/main/modules/sync.module.ts` — Path A always runs alongside Path B
- `src/main/network/api-client.ts` — `refundOrder()` method
- `src/main/modules/pos.module.ts` — `pos:orders:refund` IPC handler
- `src/main/pos/payment-controller.ts` — `printRefundReceipt()`
- `src/main/hardware/thermal/escpos-formatter.ts` — ZWROT/REFUND banner (ESC/POS + plain text)
- `src/shared/types.ts` — isRefund, refundReason, originalOrderNumber on ReceiptData
- `src/preload/preload.ts` — refund IPC bridge
- `src/shared/electron.d.ts` — refund type definition
- `src/renderer/components/pos/OrderHistoryModal.tsx` — Refund UI + status badges
- `src/renderer/i18n/translations.ts` — 17 refund keys × 3 languages (EN, PL, VI)

---

## Session 49 — Path B Sync Log Foundation

**Status:** ✅ Built and compiles. Waiting for backend deployment of `/sync/pull` and `/sync/push` endpoints.

### What was done (this session)

**Reviewed backend sync plan** (`C:\Users\pc\Downloads\backend-bot.md`) against current app architecture:
- Plan is sound — log-based bidirectional sync with monotonic seq cursor
- Identified gaps: missing billiard/checkin entities, pagination for pull, seq gap handling
- Documented all findings in plan file

**Implemented Path B client-side foundation (migration v17):**

New files:
- `src/main/sync/sync-log-service.ts` — Core engine: pull, push, real-time processing, conflict management, mode detection
- `src/main/sync/sync-log-repo.ts` — DB operations for 3 new tables (local_sync_log, sync_state, sync_conflicts)
- `src/main/sync/entity-applicators.ts` — Apply inbound sync entries to local tables (product, stock, order, staff, invoice, checkin, category)
- `src/renderer/components/pos/SyncConflictBanner.tsx` — Non-blocking conflict banner for cashier

Modified files:
- `src/main/database/migrations.ts` — v17: 3 new tables
- `src/main/database/database.ts` — Added new tables to clearSalonData()
- `src/main/network/api-client.ts` — `syncPull()` and `syncPush()` methods (dark-launch safe)
- `src/main/network/socket-client.ts` — `sync:entry` event handler
- `src/main/core/tokens.ts` — `SYNC_LOG_SERVICE` token
- `src/main/modules/sync.module.ts` — Full Path A/B coexistence orchestration with auto-detection
- `src/preload/preload.ts` — Sync conflict IPC bridge
- `src/shared/electron.d.ts` — Type definitions for new sync methods
- `src/renderer/components/pos/POSLayout.tsx` — SyncConflictBanner integration

**Key design decisions:**
- Auto-detect server capability on socket:connected (GET /sync/pull test → auto-upgrade mode)
- 4 progressive modes: path_a → path_b_pull → path_b_push → path_b_full
- Path A code stays intact — fallback if server rolls back
- Echo suppression via agent source matching
- Crash recovery: pushing → pending on startup, idempotent via source_tx UUID
- Log pruning: accepted entries > 7 days auto-deleted

### Blocked on server IT

**Server Change Request — Sync Log Endpoints:**
Backend bot is building these. When deployed, the app auto-detects and upgrades:
1. `GET /api/v1/sync/pull?after=N&types=...&limit=200` — returns `{ entries[], hasMore }`
2. `POST /api/v1/sync/push` — accepts batch entries, returns per-entry accept/reject
3. Socket event `sync:entry` — real-time push of new log entries
4. Server tables: `sync_log`, `sync_cursors`, `sync_conflicts`

No client changes needed when server deploys — auto-detection handles the transition.

### Test results (2026-04-16 16:02)

**Auto-detection: PASS**
```
[SyncLog] Server capability: pull=true, push=true
[SyncLog] Mode upgraded: path_a → path_b_pull → path_b_push → path_b_full
[SyncLog] Started periodic pull (15s interval)
[SyncLog] Started periodic push (10s interval)
```

**Issues found & fixed during testing:**
1. Push detection sent empty `entries[]` → backend rejected with "entries required". Fixed: treat this error as "endpoint exists"
2. Push endpoint required `X-Agent-Id` header. Fixed: added header from `config.agentId` to both pull and push

**Current state:**
- Pull: working (server sync_log empty → 0 entries, correct)
- Push: working (no pending local entries → exits cleanly)
- No sync errors in logs
- Path A fallback code intact and untouched

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
- [x] **Refund flow** — ✅ Full + Partial refund. Inline panel in OrderHistoryModal. Backend endpoint: POST /b2b/pos/orders/:id/refund (chờ deploy).
- [x] **Quantity type-in** — ✅ tap vào số để nhập trực tiếp, Enter/blur lưu, Escape hủy.

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
- [x] Change feed 3 endpoints (orders/staff/invoices) — ✅ backend done (commit 7eb53757), chờ deploy
- [x] Invoice push `POST /print-agent/invoices` — ✅ backend done (commit 2ecdd865), chờ deploy
- [x] Socket events (order:status-changed, staff:updated, invoice:updated) — ✅ backend done (commit 2ecdd865), chờ deploy
- [x] Migrations (staff updated_at, refund columns) — ✅ backend done (commit 2ecdd865), chờ deploy
- [ ] Staff PIN endpoint — chưa gửi request

---

## Log-Based Sync Design (cross-session tracking)

Full architecture in `C:\Users\pc\.claude\plans\snuggly-exploring-wozniak.md`.

**Phase 1** (check-in + salon customer sync): ✅ client shipped, dark launch. Awaiting backend endpoints.
**Phase 2** (booking number collision fix): ✅ shipped.
**Phase 3** (bidirectional log-based sync): ✅ CLIENT COMPLETE. Awaiting backend deploy.
  - Client: 3 per-entity change feed endpoints (orders/staff/invoices), invoice push, staff pull, socket handlers
  - Files: `src/main/sync/change-feed-sync.ts`, `src/main/sync/invoice-sync.ts`, `src/main/sync/staff-sync.ts`
  - Backend commits: `1d8a9602` (saleUnit+deletedIds ✅deployed), `7eb53757` (change feed+staff pull), `2ecdd865` (invoice push+socket events+migrations)
  - **Deploy needed:** Paul runs `fast-build.sh --backend && npm run migration:run && pm2 restart enail-backend`
  - Dark launch safe: all endpoints return null on 404/501, auto-retry on reconnect

User muốn custom items sync qua log-based system (không client-only). Phase 3 deploy sẽ unblock này.

---

## Prior Sessions (compact)

**s47:** POS production readiness sprint — UX fixes, order history, Phase 3 sync infrastructure (Path A)
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
