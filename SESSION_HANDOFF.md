# Zira AI Print Agent — Session Handoff

> Last updated: 2026-04-17 (session 50) | Read this file at the start of every new session.

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
