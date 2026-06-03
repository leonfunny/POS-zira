# Hide Non-Fiscal Orders — Design

**Date:** 2026-06-03
**Status:** Implemented (local branch), pending push/deploy
**Author:** Claude (vibe-coded for KaiPizz / chesaigon POS1)

## Problem

Orders that were paid but never had a fiscal receipt printed (the cashier did not
press the fiscal-print button, or the fiscal print failed/was blocked) do **not**
get synced to faktura / accounting. They clutter the Order History and inflate the
"official" revenue figures, making the app totals diverge from what the accountant
sees.

The owner wants to optionally **hide** these non-fiscal orders from history and from
the revenue figures, while keeping cash-drawer reconciliation correct.

## Definition of "has fiscal"

An order is considered **fiscalized** when it has at least one row in the
`fiscal_attempts` table with `status = 'SUCCESS_CONFIRMED'`.

Every other state — no attempt at all, `SENT` (in flight), `BLOCKED`, `FAILED`,
`UNKNOWN_NEEDS_RECONCILIATION` — counts as **not fiscalized**.

Reusable SQL fragment (against the `orders` table):

```sql
EXISTS (
  SELECT 1 FROM fiscal_attempts fa
  WHERE fa.order_id = orders.id
    AND fa.status = 'SUCCESS_CONFIRMED'
) AS has_fiscal
```

## Setting

- New config flag `showNonFiscalOrders: boolean`, **default `true`** (preserves
  current behaviour — everything is shown out of the box).
- Stored in the existing config store (electron-store), same mechanism as
  `hiddenTabs`. Edited via a toggle in `Settings.tsx`.
- Semantics: **ON = show** non-fiscal orders, **OFF = hide** them.

## Surfaces affected when the toggle is OFF

| # | Surface | Behaviour when OFF | Notes |
|---|---------|--------------------|-------|
| 1 | **History list** — `OrderHistoryModal` (renderer filter after local+server merge/dedupe) | `getByDateRange` returns a `has_fiscal` column on every local row; the renderer hides rows with `has_fiscal === 0` after the merge | Filtering **after** dedupe (not at SQL) avoids a bug where a hidden local non-fiscal order reappears via its synced server copy. Server-only rows (`has_fiscal` undefined) stay **visible** — cannot be proven non-fiscal locally. Pagination counts may include hidden rows (cosmetic; acceptable for a single-terminal local-first POS) |
| 2 | **Revenue / order count** — `shift-controller.closeShift` (`totalSales`, `totalOrders`) and `orderRepo.getDailyStats` | Computed over **fiscal-only** orders | "Official" sales figure that matches faktura |
| 3 | **Cash-drawer reconciliation** — `cashTotal`, `cardTotal`, `blikTotal`, `transferTotal`, `closingCash`, `difference` | **Unchanged — counts ALL orders** | The drawer physically holds the cash from non-fiscal sales. `difference = closingCash - (openingCash + cashTotal)` must reconcile to the physical count |

### Intentional consequence on the Shift Report

When OFF, `totalSales` (fiscal-only) will **not** equal the sum of the payment-method
totals (full). A small caption — e.g. `(tylko sfiskalizowane / chỉ đơn đã fiscal)` —
is rendered next to `totalSales` so this is not mistaken for a bug.

## Data flow

```
Settings toggle ──onConfigChange({ showNonFiscalOrders })──▶ config store
                                                                  │
        renderer reads config.showNonFiscalOrders (useConfig)     │
                                                                  ▼
OrderHistoryModal ── getHistory returns has_fiscal ──▶ renderer hides has_fiscal===0 after merge
ShiftReport close ── shift.close({ ..., fiscalOnly: !show }) ──▶ shift-controller (totalSales fiscal-aware, cash full)
getDailyStats ── getDailyStats(date, fiscalOnly: !show) ──▶ order-repo (revenue fiscal-aware)
```

The renderer is the single source of truth for the flag value. For the history
**list** it filters locally on the `has_fiscal` column; for the **stats** paths it
passes `fiscalOnly = !showNonFiscalOrders` down the IPC call. The main process never
reads the flag itself, keeping the data layer pure and easily unit-testable.

## Files to change (additive; no DB schema change)

1. `src/shared/types.ts` — add `showNonFiscalOrders?: boolean` to the app config type (near `hiddenTabs`).
2. `src/main/config/store.ts` — schema entry `showNonFiscalOrders: { type: 'boolean', default: true }`.
3. `src/main/database/repos/order-repo.ts` — add a shared `HAS_FISCAL_EXPR` SQL fragment.
   - `getByDateRange`: add `has_fiscal` column to the rows query (no `fiscalOnly` filter — list filtering happens in the renderer after dedupe).
   - `getByShift`: add `has_fiscal` column (consumed by the shift controller).
   - `getDailyStats(date, fiscalOnly = false)`: when `fiscalOnly`, add the `EXISTS(... SUCCESS_CONFIRMED ...)` predicate.
   - `OrderRow` type: add `has_fiscal?: number` (0/1).
4. `src/main/modules/pos.module.ts` — `pos:orders:getDailyStats` reads `fiscalOnly` and forwards; `pos:shift:close` reads `fiscalOnly` and forwards to `closeShift`.
5. `src/main/pos/shift-controller.ts` — `closeShift(shiftId, closingCash, fiscalOnly = false)`; compute `totalSales`/`totalOrders` over `orders.filter(o => o.has_fiscal === 1)` when set, leaving the cash/method totals and `difference` over all orders.
6. `src/preload/preload-pos.ts` — thread the optional `fiscalOnly` arg through `getDailyStats` and `shift.close`.
7. `src/renderer/components/pos/OrderHistoryModal.tsx` — read `config.showNonFiscalOrders` via `useConfig()`; after the local+server merge, when the flag is off drop rows with `has_fiscal === 0` (server-only rows with `has_fiscal` undefined stay visible). Add the flag to the `loadOrders` dependency list so toggling re-renders the list.
8. `src/renderer/components/Settings.tsx` — toggle in the existing settings tab that hosts `hiddenTabs`/module-visibility; calls `onConfigChange({ showNonFiscalOrders })`.
9. `src/renderer/i18n/translations.ts` — label + help text for the setting, and the Shift Report "fiscal-only" caption.

## Testing (vitest, following existing repo/controller test patterns)

- `order-repo`:
  - `has_fiscal` is `1` only when a `SUCCESS_CONFIRMED` attempt exists (not for `SENT`/`FAILED`/`BLOCKED`/none).
  - `getByDateRange(..., fiscalOnly=true)` returns only fiscalized orders **and** the `total` count matches the filtered set.
  - `getDailyStats(date, fiscalOnly=true)` excludes non-fiscal from `total_sales`/`order_count`.
- `shift-controller`:
  - With `fiscalOnly`, `totalSales`/`totalOrders` drop the non-fiscal order, **but** `cashTotal` and `difference` are identical to the all-orders computation (drawer reconciliation protected).

## Out of scope (YAGNI)

- No DB schema change, no migration.
- No per-order "fiscalize now from history while hidden" shortcut beyond the existing
  fiscal reprint flow.
- The fiscal Z-report printed by the ELZAB itself is untouched (it already counts
  only fiscal sales at the hardware level).
- Server-side history filtering — the flag is a local-terminal display preference.
