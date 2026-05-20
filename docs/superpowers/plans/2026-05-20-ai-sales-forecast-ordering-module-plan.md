# AI Sales Forecast And Daily Ordering Module Implementation Plan

> This plan is based on `docs/2026-05-20-ai-sales-forecast-ordering-research-spec.md`. It is a staged implementation plan, not completed work. Use the checklist as the source of truth when coding.

**Goal:** Add a `Du bao & dat hang` / `Forecast & Ordering` module that reports what sold, forecasts near-future demand, and recommends daily order quantities for shop operators.

**Key constraint:** The module may calculate reports, forecasts, recommendations, policies, overrides, and printable/exportable suggestion lists locally. It must not create authoritative supplier orders, warehouse receipts, incoming stock, stock movements, or product stock changes until backend warehouse/purchase-order contracts exist.

**Architecture:** Keep the forecast math deterministic and testable in the main process. The renderer should only display results, collect policy overrides, and ask main IPC to recompute. Use local SQLite as a read model and planning cache, not as the source of truth for inventory operations.

**Tech Stack:** Electron main process, React renderer, TypeScript, Tailwind CSS, sql.js local mirror, existing POS product/order data, Vitest, Vite. No external ML runtime in the MVP.

---

## Scope Guard

This plan implements:

- A forecast/order-planning tab or subtab for shop operators.
- Sales aggregation by product/variant/category over local `orders`, `order_items`, `product_variants`, and `categories`.
- Deterministic forecast and replenishment calculations.
- Local replenishment policies: lead time, review period, safety stock, pack size, min/max stock, supplier label, enabled flag.
- Recommendation runs stored locally for review and later accuracy checks.
- Manual quantity overrides and override reasons.
- Printable/exportable daily order suggestion list.
- Backtesting and accuracy metrics in a later local-only phase.
- Clear backend gate for real supplier order creation.

Do not implement:

- LLM-only quantity generation.
- Direct updates to `product_variants.in_stock` from this module.
- Local-only purchase orders that look official.
- Warehouse PZ/WZ/RW/PW/MM document posting.
- Supplier-order submission until backend endpoints exist.
- New stock movement authority inside this repo.
- Prophet/StatsForecast/Python sidecar in the MVP.
- A marketing-style dashboard screen. The first screen must be the working "today to order" queue.

## Existing Contracts To Preserve

- Backend catalog and stock are the source of truth.
- `product_variants` is a local mirror/read model for POS sales surfaces.
- Money stays in integer grosze. Decimal PLN is UI-only.
- `name_translations` remains display-only; canonical product `name` stays the business/fiscal/order name.
- Product sync and `pos:products-synced` remain the catalog refresh mechanism.
- Orders, refunds, receipts, fiscal payloads, and invoice surfaces must keep resolving old variant ids.
- Stock-changing workflows belong to backend-owned warehouse/Product Admin contracts, not forecast code.
- Renderer IPC declarations must match actual preload/main wrapper shapes.

## Phase 0: Contract And UX Gate

**Files:**
- Read: `docs/2026-05-20-ai-sales-forecast-ordering-research-spec.md`
- Read: `docs/2026-05-20-zira-magazyn-module-scr.md`
- Optional create later: `docs/server-change-requests/2026-05-20-forecast-ordering-backend.md`

- [ ] **Step 1: Choose module placement**

Decide whether this ships as:

- a standalone sidebar tab: `forecast` / `Du bao & dat hang`;
- a subtab under future Products module;
- a subtab under future Magazyn/Warehouse module.

Recommendation for MVP: standalone `forecast` tab, because it is an operator planning workflow, not product editing and not official warehouse posting.

- [ ] **Step 2: Confirm backend ordering boundary**

For MVP, real ordering is out of scope. The desktop may export/print a suggestion list only. If the product owner wants "Create supplier order", draft a server change request first for:

- suppliers;
- incoming/pending receipts;
- purchase-order drafts;
- replenishment policies if shared across devices;
- submitted supplier orders;
- sync visibility after receipt/posting.

- [ ] **Step 3: Confirm local data sufficiency**

Before coding, verify local data has enough history to make the UI useful:

- `orders.created_at` spans more than a few days;
- `order_items.variant_id` is usually present;
- `product_variants.in_stock` / `available_qty` is populated;
- cancelled/refunded rows are understandable enough for gross/net reporting.

If the real shop has very little history, the UI must default to low-confidence recommendations and category/recent-velocity fallbacks.

## Phase 1: Shared Types, Feature Gate, And Tab Shell

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/electron.d.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/i18n/translations.ts`
- Create: `src/renderer/components/forecast/ForecastOrderingTab.tsx`

- [ ] **Step 1: Add feature and tab types**

Add:

- `forecast` to `FeatureKey`;
- `forecast` to `Tab`;
- default entitlement value as enabled in shared `DEFAULT_ENTITLEMENTS`;
- renderer `DEFAULT_ENTITLEMENTS`;
- `TAB_TO_FEATURE` in `App.tsx`;
- `visibleTabs` all-tab list.

Keep this separate from `products` and `billiard`.

- [ ] **Step 2: Add sidebar entry**

Add a Sales or Operations group item using `BarChart3`, `TrendingUp`, or `ClipboardList` from `lucide-react`.

Suggested labels:

- EN: `Forecast`
- VI: `Dự báo`
- PL: `Prognoza`

- [ ] **Step 3: Create renderer shell**

Create `ForecastOrderingTab.tsx` with an operational layout:

- header with date range, recompute, export/print actions;
- summary strip;
- main recommendation table;
- right-side product detail drawer placeholder.

Do not use a landing page or explanatory hero.

- [ ] **Step 4: Add translations**

Add EN, VI, and PL keys at minimum:

- `sidebar.forecast`
- `forecast.title`
- `forecast.subtitle`
- `forecast.recompute`
- `forecast.export`
- `forecast.print`
- `forecast.todayToOrder`
- `forecast.report`
- `forecast.loading`
- `forecast.empty`
- `forecast.error`
- `forecast.col.product`
- `forecast.col.stock`
- `forecast.col.sales7`
- `forecast.col.forecast`
- `forecast.col.suggested`
- `forecast.col.confidence`
- `forecast.col.reason`

Use a `tOr` helper with explicit `translated !== key` behavior if needed.

## Phase 2: Pure Forecast And Replenishment Core

**Files:**
- Create: `src/main/forecast/forecast-types.ts`
- Create: `src/main/forecast/forecast-engine.ts`
- Create: `src/main/forecast/replenishment.ts`
- Create: `src/main/forecast/date-utils.ts`
- Create: `tests/forecast-engine.test.ts`
- Create: `tests/replenishment.test.ts`

- [ ] **Step 1: Define domain types**

Define types for:

- `DailyVariantSales`
- `VariantDemandSeries`
- `ForecastRequest`
- `ForecastResult`
- `ReplenishmentPolicy`
- `ReplenishmentInput`
- `ReplenishmentRecommendation`
- `ForecastConfidence`
- `ForecastWarning`

Keep these in main-process code unless renderer needs a public DTO.

- [ ] **Step 2: Implement date utilities**

Implement deterministic helpers:

- local ISO date creation;
- inclusive date range;
- day-of-week grouping;
- last N days filtering;
- no `toLocaleString()` in model logic.

Tests should pin date output independent of machine locale.

- [ ] **Step 3: Implement baseline forecast**

Use a conservative no-dependency model:

- recent weighted velocity: last 7/14/28 days;
- same-weekday average from recent matching weekdays;
- sparse/intermittent fallback;
- category fallback supplied by caller if product history is too thin;
- clamp negative values to zero;
- cap one-day spikes unless repeated.

Do not round forecast units to integer inside the forecast engine. Rounding belongs in replenishment/order quantity logic.

- [ ] **Step 4: Implement confidence classification**

Return confidence:

- `high`: enough history and non-zero sales days;
- `medium`: usable but short/noisy history;
- `low`: sparse, stockout, new product, high refund rate, or no category fallback.

Expose warnings such as:

- `LOW_HISTORY`
- `SPARSE_DEMAND`
- `RECENT_STOCKOUT`
- `HIGH_REFUND_RATE`
- `PRICE_CHANGED_RECENTLY`

- [ ] **Step 5: Implement replenishment formula**

Use:

```text
horizon_days = lead_time_days + review_period_days
demand_horizon = sum(forecast for next horizon_days)
safety_stock = max(min_safety_units, safety_stock_days * avg_daily_demand)
target_stock = demand_horizon + safety_stock
available_stock = stock_on_hand + incoming_qty - reserved_qty
raw_order_qty = max(0, target_stock - available_stock)
suggested_order_qty = round_up_to_pack_size(raw_order_qty, pack_size)
```

Rules:

- `pack_size <= 1` means no pack rounding.
- `min_order_qty` applies after raw order qty is positive.
- `max_stock` caps the target if present.
- missing stock means confidence low, not zero order silently.

- [ ] **Step 6: Unit-test math**

Cover:

- no future data read;
- sparse SKU does not over-order from one spike;
- pack rounding;
- max-stock cap;
- safety stock and lead time effect;
- stock above target produces zero suggestion;
- low history produces low confidence.

## Phase 3: Sales Aggregation Repository

**Files:**
- Create: `src/main/database/repos/sales-forecast-repo.ts`
- Create: `tests/sales-forecast-repo.test.ts`

- [ ] **Step 1: Add daily sales aggregation**

Aggregate `orders` + `order_items` by date and `variant_id`.

Return:

- sale date;
- variant id;
- canonical name;
- sku;
- gross units;
- gross revenue;
- order count;
- cancelled count if useful.

Cancelled orders should be excluded from demand by default.

- [ ] **Step 2: Add product snapshot query**

Join or separately fetch:

- variant id;
- name;
- sku;
- barcode;
- category id/name;
- current stock: prefer `available_qty`, fallback `in_stock`;
- retail price;
- active status;
- sale unit.

Do not include template-parent duplicate rows if active sellable variants exist. Reuse the same leaf-variant rule as `productRepo`.

- [ ] **Step 3: Add refund-aware fields**

Expose gross and net demand separately:

- gross units = what customers bought;
- net units = after cancelled/refunded adjustment when reliably computable;
- refund rate = warning signal.

If refund lines cannot be safely mapped per variant, leave net adjustment conservative and mark the recommendation warning rather than guessing.

- [ ] **Step 4: Add stockout detection**

For MVP, detect stockout risk from current stock and no/low stock snapshots where available. Later, use stock movement history from backend.

Flag days with zero stock as censored demand if historical stock snapshots become available.

- [ ] **Step 5: Unit-test aggregation**

Use in-memory DB test setup consistent with existing repo tests. Cover:

- grouping by local date;
- cancelled orders excluded;
- completed orders included;
- product with null `variant_id` excluded from variant forecast;
- revenue stays in grosze.

## Phase 4: Local Planning Tables And Repositories

**Files:**
- Modify: `src/main/database/migrations.ts`
- Modify if needed: `src/main/database/database.ts`
- Create: `src/main/database/repos/replenishment-policy-repo.ts`
- Create: `src/main/database/repos/forecast-run-repo.ts`
- Create: `tests/replenishment-policy-repo.test.ts`
- Create: `tests/forecast-run-repo.test.ts`

- [ ] **Step 1: Add migration**

Add local planning/cache tables:

```sql
CREATE TABLE IF NOT EXISTS replenishment_policies (
  variant_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  supplier_id TEXT,
  supplier_name TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 1,
  review_period_days INTEGER NOT NULL DEFAULT 1,
  safety_stock_days REAL NOT NULL DEFAULT 1,
  min_safety_units INTEGER NOT NULL DEFAULT 0,
  min_order_qty INTEGER NOT NULL DEFAULT 0,
  pack_size INTEGER NOT NULL DEFAULT 1,
  max_stock INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS forecast_runs (
  id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  model_version TEXT NOT NULL,
  metrics_json TEXT
);

CREATE TABLE IF NOT EXISTS forecast_recommendations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  forecast_units REAL NOT NULL,
  stock_on_hand INTEGER NOT NULL,
  safety_stock REAL NOT NULL,
  suggested_qty INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  reason TEXT,
  warnings_json TEXT,
  override_qty INTEGER,
  override_reason TEXT,
  FOREIGN KEY (run_id) REFERENCES forecast_runs(id)
);
```

These tables are not authoritative inventory data.

- [ ] **Step 2: Implement policy repo**

Support:

- get by variant id;
- upsert policy;
- list all policies;
- merge default policy with product data;
- validate numeric fields.

Default:

- enabled = true;
- lead time = 1;
- review period = 1;
- safety stock days = 1;
- pack size = 1;
- min order = 0.

- [ ] **Step 3: Implement forecast run repo**

Support:

- create run with recommendations;
- list recent runs;
- get run detail;
- update override quantity/reason for a recommendation;
- delete old runs if retention is needed later.

- [ ] **Step 4: Preserve tenant isolation**

If `database.clearSalonData()` should wipe local forecast planning tables on salon switch, add these tables to the clear list:

- `forecast_recommendations`;
- `forecast_runs`;
- `replenishment_policies`.

Use judgment: if policies should survive per salon, they still must not leak between salons.

## Phase 5: Forecast Service And IPC

**Files:**
- Create: `src/main/forecast/forecast-service.ts`
- Create or modify: `src/main/modules/forecast.module.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/core/tokens.ts` only if service token is needed.
- Modify: `src/shared/types.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/preload/preload-pos.ts` only if standalone POS window needs it.
- Modify: `src/shared/electron.d.ts`
- Create: `tests/forecast-ipc-contracts.test.ts`

- [ ] **Step 1: Implement service orchestration**

`ForecastService` should:

- load sales history from `salesForecastRepo`;
- load product snapshots;
- load replenishment policies;
- compute forecast results;
- convert them into replenishment recommendations;
- persist a run when requested;
- return a DTO ready for renderer display.

- [ ] **Step 2: Add IPC channels**

Add explicit channels:

- `forecast:get-report`
- `forecast:get-recommendations`
- `forecast:get-product-detail`
- `forecast:save-policy`
- `forecast:save-override`
- `forecast:recompute`
- `forecast:export-order-list`

Return wrapper shape consistently:

```ts
{ success: boolean; data?: T; error?: string }
```

Keep declarations in `electron.d.ts` consistent with preload.

- [ ] **Step 3: Register module**

Register `ForecastModule` in the orchestrator/module list where other modules are registered.

The module should be lightweight:

- no timers in MVP unless explicitly needed;
- no backend calls in MVP except existing product/order data already mirrored locally;
- no startup recompute unless cheap and useful.

- [ ] **Step 4: Add manual recompute**

`forecast:recompute` accepts:

- date range;
- horizon days;
- category filter optional;
- only-needs-order optional.

It returns the new run and stores it if requested.

- [ ] **Step 5: Add export-order-list**

MVP export can return structured text/CSV content or write a user-selected file later. Do not create backend orders.

Suggested CSV columns:

- product name;
- SKU;
- barcode;
- category;
- stock;
- forecast demand;
- suggested quantity;
- override quantity;
- supplier;
- confidence;
- reason.

## Phase 6: Renderer Data Hook

**Files:**
- Create: `src/renderer/hooks/useForecastOrdering.ts`
- Modify: `src/renderer/utils/logger.ts` only if needed.
- Create: `tests/forecast-renderer-hook-source.test.ts` if using source/static tests.

- [ ] **Step 1: Add hook state**

Track:

- date range;
- horizon;
- filters;
- selected recommendation;
- loading/error;
- current run;
- recompute status;
- save-policy status;
- save-override status.

- [ ] **Step 2: Load recommendations**

Call `window.electronAPI.forecast.getRecommendations()` or `recompute()` on first load.

Reload without resetting filters after:

- policy save;
- override save;
- product sync event if subscribed;
- manual recompute.

- [ ] **Step 3: Subscribe to product changes**

Use existing `window.electronAPI.pos.sync.onProductsSynced` if the forecast tab is open. Recompute or mark stale. Prefer marking stale plus showing a refresh action if recompute is expensive.

- [ ] **Step 4: Avoid raw translation keys**

Use helper pattern:

```ts
function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}
```

## Phase 7: Today-To-Order UI

**Files:**
- Create: `src/renderer/components/forecast/ForecastToolbar.tsx`
- Create: `src/renderer/components/forecast/ForecastSummaryStrip.tsx`
- Create: `src/renderer/components/forecast/OrderingRecommendationTable.tsx`
- Create: `src/renderer/components/forecast/ConfidenceBadge.tsx`
- Create: `src/renderer/components/forecast/ForecastReasonCell.tsx`
- Modify: `src/renderer/components/forecast/ForecastOrderingTab.tsx`

- [ ] **Step 1: Build toolbar**

Controls:

- date range: today, 7 days, 30 days, 90 days, custom;
- horizon: 1, 3, 7, 14 days;
- category filter;
- status filter: needs order, high risk, low confidence, all;
- recompute button;
- export/print button.

Use compact operational controls, not cards inside cards.

- [ ] **Step 2: Build summary strip**

Show:

- total items needing order;
- estimated units to order;
- out-of-stock risk count;
- low confidence count;
- forecast run timestamp.

- [ ] **Step 3: Build recommendation table**

Rows show:

- product name and SKU/barcode;
- category;
- current stock;
- 7-day units sold;
- forecast horizon demand;
- safety stock;
- suggested quantity;
- editable override quantity;
- confidence badge;
- reason/warnings.

Important buttons and inputs should be touch-friendly.

- [ ] **Step 4: Add row actions**

Actions:

- open product forecast drawer;
- disable from auto-order;
- save override;
- reset override.

Do not add "order now" in MVP.

- [ ] **Step 5: Empty/error states**

Plain language states:

- no order needed;
- not enough sales history yet;
- product data missing;
- forecast failed.

Avoid visible raw keys.

## Phase 8: Product Forecast Drawer

**Files:**
- Create: `src/renderer/components/forecast/ProductForecastDrawer.tsx`
- Create: `src/renderer/components/forecast/ProductSalesSparkline.tsx`
- Create: `src/renderer/components/forecast/ReplenishmentPolicyEditor.tsx`
- Modify: `src/renderer/components/forecast/ForecastOrderingTab.tsx`

- [ ] **Step 1: Add read-only product history**

Drawer shows:

- product name, SKU, barcode;
- current stock;
- stock coverage days;
- last 30/90 day units;
- forecast next 7/14 days;
- warnings;
- last run confidence.

Use a simple chart or compact bars. Do not introduce a large charting dependency unless already present.

- [ ] **Step 2: Add policy editor**

Fields:

- enabled;
- supplier name;
- lead time days;
- review period days;
- safety stock days;
- min safety units;
- min order quantity;
- pack size;
- max stock.

Validate:

- non-negative numeric fields;
- lead/review at least 0 or 1 depending field;
- pack size at least 1;
- max stock empty or positive.

- [ ] **Step 3: Save policy through IPC**

After save:

- call `forecast:save-policy`;
- recompute selected product or mark run stale;
- keep drawer open;
- show inline success/failure.

- [ ] **Step 4: Dirty guard**

If user closes drawer with unsaved policy changes, show a confirm. Do not silently discard.

## Phase 9: Reports View

**Files:**
- Create: `src/renderer/components/forecast/SalesReportPanel.tsx`
- Create: `src/renderer/components/forecast/SlowMoverPanel.tsx`
- Create: `src/renderer/components/forecast/StockRiskPanel.tsx`
- Modify: `src/renderer/components/forecast/ForecastOrderingTab.tsx`

- [ ] **Step 1: Add tabs or segmented view**

Views:

- `Today to order`;
- `Sales report`;
- `Risk`;
- `Accuracy` later.

- [ ] **Step 2: Top sellers report**

Show:

- top by units;
- top by revenue;
- category totals;
- payment/status filter only if needed.

- [ ] **Step 3: Slow movers/dead stock**

Show products with:

- stock > 0;
- no sales in N days;
- low velocity;
- high stock coverage days.

Do not auto-suggest discounting in MVP unless explicitly requested later.

- [ ] **Step 4: Stock risk**

Show:

- stock below lead-time demand;
- stockout risk;
- no price/no stock data;
- low confidence due to sparse history.

## Phase 10: Print And Export Suggestion List

**Files:**
- Create: `src/main/forecast/forecast-export.ts`
- Modify: `src/main/modules/forecast.module.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/shared/electron.d.ts`
- Modify: `src/renderer/components/forecast/ForecastToolbar.tsx`
- Add tests as needed.

- [ ] **Step 1: Add CSV export content**

Generate deterministic CSV string with UTF-8 text.

Columns:

- Product;
- SKU;
- Barcode;
- Category;
- Stock;
- Forecast;
- Suggested Qty;
- Override Qty;
- Final Qty;
- Supplier;
- Confidence;
- Reason.

- [ ] **Step 2: Add print/export UI action**

MVP can:

- copy/export structured content through Electron dialog later;
- or show a printable modal/list.

If writing a file, use a save dialog and avoid hard-coded Downloads paths.

- [ ] **Step 3: Do not print official warehouse docs**

The output is explicitly "order suggestion", not PZ/WZ/PW/RW/MM and not a purchase order. Label it clearly.

## Phase 11: Backtesting And Accuracy

**Files:**
- Create: `src/main/forecast/backtest.ts`
- Create: `tests/forecast-backtest.test.ts`
- Modify: `src/main/forecast/forecast-service.ts`
- Modify: `src/renderer/components/forecast/AccuracyPanel.tsx`

- [ ] **Step 1: Add walk-forward backtest**

Use expanding or rolling windows:

- train only on days before prediction window;
- predict next 1/3/7 days;
- compare to actual sales.

Never use random train/test splits for time series.

- [ ] **Step 2: Add metrics**

Compute:

- MAE;
- WAPE;
- bias;
- stockout-adjusted warning count if available.

Group metrics by:

- variant;
- category;
- overall.

- [ ] **Step 3: Surface accuracy**

Show:

- accuracy last 14/30 days;
- products with poor forecast;
- products where manual policy override may be needed.

Do not hide the recommendation because accuracy is low; show confidence and reason.

## Phase 12: Backend-Backed Ordering Gate

**Files:**
- Create later: `docs/server-change-requests/2026-05-20-forecast-ordering-backend.md`
- Modify later: `src/main/network/api-client.ts`
- Modify later: `src/main/modules/forecast.module.ts`
- Modify later: `src/preload/preload.ts`
- Modify later: `src/shared/electron.d.ts`
- Modify later: renderer order draft UI files.

- [ ] **Step 1: Draft server change request**

Only when owner wants real order submission, request:

- `GET /api/v1/warehouse/suppliers`
- `GET /api/v1/warehouse/pending-receipts`
- `GET /api/v1/warehouse/stock-movements`
- `GET/PUT /api/v1/warehouse/replenishment-policies`
- `POST /api/v1/warehouse/purchase-order-drafts`
- `PATCH /api/v1/warehouse/purchase-order-drafts/:id`
- `POST /api/v1/warehouse/purchase-order-drafts/:id/submit`

Define idempotency, audit identity, supplier grouping, pack sizes, incoming quantities, and sync events.

- [ ] **Step 2: Add runtime capabilities**

If backend supports a capability endpoint, hide/disable backend ordering actions until capability confirms support.

- [ ] **Step 3: Implement draft creation**

After backend exists:

- collect approved final quantities;
- group by supplier;
- call backend draft endpoint with idempotency key;
- show backend draft number/id;
- do not mutate local stock.

- [ ] **Step 4: Refresh after backend mutations**

After submit/receipt:

- run product sync or wait for stock sync entries;
- mark forecast run stale;
- do not fabricate incoming/stock state locally unless backend returned canonical data.

## Phase 13: Optional Advanced AI

**Files:**
- Add only after MVP proves need.

- [ ] **Step 1: Decide whether local baseline is insufficient**

Use backtest metrics to justify more complexity. Do not add ML dependencies by default.

- [ ] **Step 2: Consider Python sidecar**

If needed, use a sidecar similar to existing `python/security` only after packaging cost is accepted.

Candidate models:

- Croston/ADIDA/IMAPA/TSB for intermittent SKU demand;
- AutoARIMA/ETS for category-level stable series;
- Prophet only for enough history plus seasonality/holiday effects.

- [ ] **Step 3: Keep LLM as explanation layer**

If using OpenAI/OpenRouter later, only summarize computed facts:

- no hidden quantity generation;
- structured output;
- no backend mutation from AI text;
- cite exact metrics used.

## Tests And Verification

**Required commands during implementation:**

```powershell
npm run typecheck:renderer
npm test -- tests/forecast-engine.test.ts tests/replenishment.test.ts
npm test -- tests/sales-forecast-repo.test.ts tests/replenishment-policy-repo.test.ts tests/forecast-run-repo.test.ts
npm run build
```

**Additional focused tests to run if touched:**

```powershell
npm test -- tests/ipc-contracts.test.ts
npm test -- tests/retail-sync-respects-filter.test.ts
```

**Manual check:**

- Forecast tab appears in sidebar and opens.
- Recompute works with local order/product data.
- Recommendation table shows products, stock, forecast, suggested qty, confidence, and reason.
- Saving policy changes recomputes or marks results stale.
- Override quantity saves and does not mutate product stock.
- Export/print output is labeled as suggestion, not official order.
- Product sync while tab is open does not reset active filters unexpectedly.
- Low-data products show low confidence.

## Success Criteria

MVP is complete when:

1. Owner can open Forecast/Ordering from the main app.
2. Owner sees top sold products and low-stock risk from local POS history.
3. Owner sees a daily order suggestion list with quantity, confidence, and explanation.
4. Suggestions use current stock, lead time, safety stock, and pack-size rounding.
5. Owner can override quantities and store the reason.
6. Owner can print/export the suggestion list.
7. No product stock, supplier order, warehouse document, or backend state is mutated by MVP recommendations.
8. Forecast/replenishment math is covered by focused unit tests.
9. Renderer typecheck and build pass.

## Suggested Implementation Order

1. Phase 0 contract/UX gate.
2. Phase 2 pure forecast and replenishment core.
3. Phase 3 sales aggregation repo.
4. Phase 4 local planning tables and repos.
5. Phase 5 forecast service and IPC.
6. Phase 1 tab shell if the app does not already have a chosen place for it.
7. Phase 6 renderer hook.
8. Phase 7 today-to-order UI.
9. Phase 8 product forecast drawer.
10. Phase 10 export/print suggestion list.
11. Phase 9 reports view.
12. Phase 11 backtesting.
13. Phase 12 backend-backed ordering after backend contract exists.
14. Phase 13 advanced AI only if metrics justify it.

## First Coding Slice Recommendation

The first safe coding slice should be local-only and deterministic:

- Add pure `forecast-engine.ts` and `replenishment.ts`.
- Add sales aggregation repo.
- Add local `replenishment_policies` table/repo.
- Add IPC for recompute and policy save.
- Add minimal Forecast tab with recommendation table.
- Add unit tests for math and aggregation.

Do not implement backend supplier order creation in the first slice. That would be a brittle client workaround and would conflict with the backend-owned warehouse direction already documented for Magazyn.
