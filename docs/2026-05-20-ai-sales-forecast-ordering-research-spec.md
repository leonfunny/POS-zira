# AI sales forecast and daily ordering module research

Date: 2026-05-20

Scope: research and specification for a Zira POS module that reports sold items, predicts near-future sales, and recommends daily ordering quantities. This document does not implement code.

## Short conclusion

The module should not be a chatbot that guesses quantities. It should be a deterministic demand-planning engine with optional AI wording on top. The forecast must be calculated from `orders`, `order_items`, and `product_variants`, then converted into order suggestions using stock on hand, lead time, safety stock, pack size, and manual owner overrides.

The first useful slice can be read-only inside the desktop app: show sales reports, forecast next 1/3/7/14 days, and produce a "Today should order" list. The action that actually creates supplier orders, warehouse documents, incoming receipts, or stock changes must wait for backend warehouse/purchase-order contracts. A local SQLite-only workaround would be wrong because this app already treats backend catalog and stock as the source of truth.

## Current app findings

The app already has the core data needed for a first forecast:

- `src/main/database/repos/order-repo.ts` stores `orders` and `order_items`, including `variant_id`, `name`, `sku`, `quantity`, `price`, `total`, `status`, `created_at`, and refund fields.
- `src/main/database/repos/product-repo.ts` reads `product_variants` and `categories`, including `in_stock`, `available_qty`, `retail_price`, `vat_rate`, `sale_unit`, and `name_translations`.
- `src/main/modules/pos.module.ts` exposes product/category/order IPC and decrements local stock when local POS orders are created.
- `src/main/sync/product-sync.ts` mirrors `/api/v1/warehouse/public/products` into `product_variants`.
- `src/main/sync/entity-applicators.ts` can already apply inbound `stock` sync entries by setting or delta-updating stock.
- `src/renderer/components/OrdersTab.tsx` already shows order history but only as a list, not as a planning report.

There are also two important gaps:

- `src/renderer/App.tsx` imports `./components/products/ProductModule`, but the current products worktree only shows partial product components and no `ProductModule.tsx`. The Products tab may be incomplete or broken until that entry component exists.
- `src/renderer/components/billiard/DailyReport.tsx` and `StockManager.tsx` call `window.electronAPI.dailyReport` / `window.electronAPI.stock`, and `src/shared/electron.d.ts` declares them, but `src/preload/preload.ts` does not expose those APIs and no main IPC handler was found. Do not copy that incomplete pattern for this module.

## External research baseline

Oracle describes reorder point planning as ordering when available quantity falls below safety stock plus forecast demand during replenishment lead time. The practical formula is:

```text
reorder_point = safety_stock + forecast_demand_during_lead_time
```

Odoo's reordering rules use minimum/maximum quantities, forecasted stock, manual vs automatic triggers, and order multiples. For a POS owner-facing module, the safer default is a manual replenishment dashboard: show what needs ordering and let the owner approve it.

For validation, scikit-learn's time-series cross validation guidance is important: normal random train/test splits are inappropriate because they can train on future data. Forecast evaluation must use expanding or rolling time windows.

For sparse retail SKUs, Nixtla's StatsForecast documentation highlights intermittent-demand models such as Croston, ADIDA, IMAPA, and TSB. This matters because many shop products sell only a few times per week; a naive daily average will over-order slow movers.

Prophet is useful later for products/categories with enough history and clear seasonality. It expects a historical dataframe with date column `ds` and numeric target `y`, and returns `yhat` plus uncertainty intervals. It is not the best first dependency for this Electron app because it adds a Python/R modeling stack and packaging cost.

Sources:

- Oracle reorder point planning: https://docs.oracle.com/cd/A60725_05/html/comnls/us/inv/roplan.htm
- Odoo reordering rules: https://www.odoo.com/documentation/master/applications/inventory_and_mrp/inventory/warehouses_storage/replenishment/reordering_rules.html
- scikit-learn TimeSeriesSplit: https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html
- Nixtla intermittent demand: https://nixtlaverse.nixtla.io/statsforecast/docs/tutorials/intermittentdata.html
- Prophet quick start: https://facebook.github.io/prophet/docs/quick_start.html

## What "AI" should mean here

Use "AI" as a forecast/recommendation system, not as a large language model deciding quantities. The model output should be numeric, reproducible, backtestable, and explainable. A language model may later summarize the computed results, for example: "Rice paper is high risk because current stock covers 1.2 days and the next delivery is 2 days away." It must not invent demand.

Good AI output per product:

```json
{
  "variantId": "uuid",
  "name": "Coca Cola 500ml",
  "stockOnHand": 8,
  "forecastDemand": 23,
  "horizonDays": 3,
  "leadTimeDays": 1,
  "safetyStock": 5,
  "suggestedOrderQty": 24,
  "confidence": "medium",
  "reason": "High recent weekday sales, stock below lead-time demand plus safety buffer"
}
```

## Data model needed for accurate daily ordering

The current local app can estimate demand but does not know enough to create reliable supplier orders. These fields are needed:

- Per variant replenishment policy: enabled, supplier, lead time days, review period days, safety stock method, min order quantity, pack size, max stock, active/inactive.
- Incoming stock: pending purchase orders or posted-but-not-received documents.
- Stock movement history: receipts, damages, losses, recounts, refunds/restocks.
- Supplier metadata: supplier name, ordering unit, pack multiple, cutoff time, default delivery days.
- Promotion/calendar signals: holiday, weekend, campaign, temporary display, local event.

Some of this overlaps with `docs/2026-05-20-zira-magazyn-module-scr.md`. That SCR already states the correct rule: stock-changing operations and official warehouse documents must be backend-owned. This forecast module should reuse that future warehouse contract instead of inventing its own local order state.

## Sales aggregation rules

Create a main-process repository, for example `src/main/database/repos/sales-forecast-repo.ts`, with SQL queries that aggregate sales at the variant-day level.

Recommended base query shape:

```sql
SELECT
  date(o.created_at) AS sale_date,
  oi.variant_id,
  oi.name,
  oi.sku,
  SUM(oi.quantity) AS gross_units,
  SUM(oi.total) AS gross_revenue
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE date(o.created_at) >= date(?)
  AND date(o.created_at) <= date(?)
  AND o.status NOT IN ('CANCELLED')
  AND oi.variant_id IS NOT NULL
GROUP BY date(o.created_at), oi.variant_id;
```

Refund handling should be explicit:

- `gross_units` answers "what customers wanted".
- `net_units` subtracts fully voided/cancelled sales and optionally subtracts refunded lines.
- Ordering recommendations should default to gross demand, but show refund rate as a warning. A high refund rate means demand exists but product quality or catalog data may be wrong.

Stockout days should be flagged when a product had zero stock. A day with zero sales and zero stock is censored demand, not proof that nobody wanted it. The MVP can mark confidence lower when stockout days are detected.

## MVP forecast model

Do not start with a neural model. For daily shop ordering, a robust transparent baseline will beat an opaque model with weak data.

Use a per-variant ensemble:

1. Recent velocity: weighted average of last 7, 14, and 28 days.
2. Day-of-week demand: average of the last 4 to 8 same weekdays.
3. Intermittent fallback: if non-zero sales days are rare, use a Croston-like split of demand size and interval, or a simpler local approximation until a Python forecasting sidecar is justified.
4. Category/new-product fallback: if a product has less than 14 days of history, borrow the category median adjusted by its first observed velocity.

Combine them conservatively:

```text
forecast_day = 0.45 * recent_velocity
             + 0.35 * same_weekday_average
             + 0.20 * category_or_intermittent_fallback
```

Then clamp:

- never below 0,
- cap extreme spikes unless there is repeated evidence,
- round final order quantities up only at the ordering step, not inside the forecast.

Confidence:

- `high`: 60+ days of history, enough non-zero sale days, backtest WAPE acceptable.
- `medium`: 28+ days of history or stable category fallback.
- `low`: new item, sparse data, recent stockouts, price change, or high refund rate.

## Replenishment calculation

For daily ordering, calculate over `leadTimeDays + reviewPeriodDays`. If the shop orders every day and delivery is next day, the horizon is usually 2 days. If supplier delivers in 3 days, the horizon grows.

Recommended formula:

```text
horizon_days = lead_time_days + review_period_days
demand_horizon = sum(forecast for next horizon_days)
safety_stock = max(min_safety_units, safety_stock_days * avg_daily_demand)
target_stock = demand_horizon + safety_stock
available_stock = stock_on_hand + incoming_qty - reserved_qty
raw_order_qty = max(0, target_stock - available_stock)
suggested_order_qty = round_up_to_pack_size(raw_order_qty, pack_size)
```

Per-product defaults:

- `review_period_days`: 1
- `lead_time_days`: 1 until supplier data exists
- `safety_stock_days`: 1 for normal items, 2 for high-volume/high-risk items
- `pack_size`: 1 unless barcode/product metadata says case size
- `max_stock`: optional guard to avoid over-ordering

Manual override must be first-class. The owner should be able to type a different quantity and the system should remember the override reason for learning later.

## User-facing module design

Add a new sidebar tab only after deciding the product surface naming. Good names:

- `Dat hang`
- `Du bao & dat hang`
- `Bao cao ban hang`

The first screen should be the work queue, not a dashboard hero.

Primary sections:

1. Today to order
   - Product, category, current stock, 7-day sales, forecast next horizon, suggested order, confidence, reason, override field.
   - Filters: needs order, out-of-stock risk, low confidence, high seller, slow mover, category, supplier.

2. Product detail
   - Last 30/90 day sales chart.
   - Forecast next 7/14 days.
   - Stock coverage in days.
   - Refund/void warning.
   - Policy editor: lead time, safety days, pack size, max stock, disabled from auto-order.

3. Reports
   - Top sellers by units/revenue.
   - Slow movers/dead stock.
   - Stockout risk.
   - Forecast accuracy from last run.
   - Category demand trend.

4. Order draft
   - The approved quantities grouped by supplier.
   - In MVP, allow print/export only.
   - After backend purchase/warehouse contract exists, create a backend purchase/order draft.

## Proposed architecture

Main process:

- `src/main/database/repos/sales-forecast-repo.ts`
- `src/main/forecast/forecast-engine.ts`
- `src/main/forecast/replenishment.ts`
- `src/main/modules/forecast.module.ts`

Renderer:

- `src/renderer/components/forecast/ForecastOrderingTab.tsx`
- `src/renderer/components/forecast/OrderingTable.tsx`
- `src/renderer/components/forecast/ProductForecastDrawer.tsx`
- `src/renderer/components/forecast/ReplenishmentPolicyEditor.tsx`
- `src/renderer/hooks/useForecastOrdering.ts`

Shared/preload:

- Add `forecast` feature key and tab only if this is a full module.
- Add typed IPC channels:
  - `forecast:get-report`
  - `forecast:get-recommendations`
  - `forecast:get-product-detail`
  - `forecast:save-policy`
  - `forecast:recompute`
  - `forecast:export-order-list`

Local tables:

```sql
CREATE TABLE replenishment_policies (
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

CREATE TABLE forecast_runs (
  id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  model_version TEXT NOT NULL,
  metrics_json TEXT
);

CREATE TABLE forecast_recommendations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  forecast_units REAL NOT NULL,
  stock_on_hand INTEGER NOT NULL,
  safety_stock REAL NOT NULL,
  suggested_qty INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  reason TEXT,
  override_qty INTEGER,
  override_reason TEXT,
  FOREIGN KEY (run_id) REFERENCES forecast_runs(id)
);
```

These tables are local planning/cache tables only. They must not become the authoritative warehouse or purchase-order store.

## Backend needs before "real ordering"

If the product owner wants "click to create order to supplier", request backend endpoints first. Minimum:

- `GET /api/v1/warehouse/suppliers`
- `GET /api/v1/warehouse/stock-movements?variantId=&from=&to=`
- `GET /api/v1/warehouse/pending-receipts`
- `GET/PUT /api/v1/warehouse/replenishment-policies`
- `POST /api/v1/warehouse/purchase-order-drafts`
- `PATCH /api/v1/warehouse/purchase-order-drafts/:id`
- `POST /api/v1/warehouse/purchase-order-drafts/:id/submit`

The backend should return canonical draft IDs, supplier grouping, item pack sizes, incoming quantities, and stock movement IDs. It should emit sync entries or make product sync reflect updated incoming/stock state.

Until this exists, the desktop may create only a local printable/exportable recommendation list, clearly labeled as a suggestion.

## Implementation phases

### Phase 1: Local read-only planning report

- Add forecast repo SQL aggregation over local `orders`, `order_items`, `product_variants`, and categories.
- Add a pure `forecast-engine.ts` with no external ML dependencies.
- Add a pure `replenishment.ts` formula module.
- Add IPC/preload bridge.
- Add a tab or integrate under Products/Magazyn as "Du bao".
- UI shows read-only recommendations and lets user export/print a list.

### Phase 2: Policy and override persistence

- Add `replenishment_policies`.
- Let owner set lead time, safety days, pack size, min/max, and enable/disable per product.
- Store recommendation runs and overrides.
- Show low-confidence and stockout warnings.

### Phase 3: Accuracy/backtesting

- Add walk-forward backtest: train on past days, predict the next 7 days, compare against actuals.
- Track WAPE/MAE by variant and category.
- Show "accuracy last 14 days" and do not over-trust low-accuracy products.

### Phase 4: Backend-backed ordering

- After backend purchase/supplier endpoints exist, convert approved suggestions into purchase-order drafts.
- Keep idempotency keys and audit identity.
- Refresh product sync after submission/receipt.

### Phase 5: Advanced forecasting

- Consider a Python sidecar using StatsForecast only if local simple models underperform and there is enough data.
- Use Croston/ADIDA/IMAPA/TSB for sparse SKUs.
- Use Prophet/category-level seasonality only for products/categories with enough continuous history.
- Add holiday/promotion regressors only after those events are captured in app/backend data.

## Tests and verification

Core unit tests:

- Aggregation excludes cancelled orders.
- Refund handling produces gross and net units separately.
- Forecast never reads future dates during backtest.
- Sparse product does not get over-ordered from one spike.
- Pack-size rounding works.
- Safety stock and lead time affect suggestions.
- Current stock greater than target yields suggested quantity 0.
- Manual override persists without changing product stock.

Suggested commands after implementation:

```powershell
npm run typecheck:renderer
npm test -- tests/sales-forecast-repo.test.ts tests/forecast-engine.test.ts tests/replenishment.test.ts
npm run build
```

## Success criteria

MVP is successful when:

1. Owner sees top sold products and low-stock risk from the last 7/30/90 days.
2. Owner sees a daily "should order" list with suggested quantities and reasons.
3. Suggestions use current stock and pack-size rounding.
4. Forecast confidence is visible, and low-data products are not presented as certain.
5. No stock, product, or official warehouse document is mutated by the forecast module.
6. The app can export/print the daily order suggestion list.
7. Tests prove aggregation, forecast, and replenishment math independently.

## Recommended first coding slice

Build Phase 1 and Phase 2 locally, but keep it read-only for stock/order operations:

- local sales aggregation,
- pure forecast/replenishment engine,
- report/recommendation UI,
- local replenishment policies,
- print/export suggestion list.

Do not build "Create supplier order" until the backend purchase/warehouse contract exists. That would otherwise create a second, inconsistent inventory workflow beside the existing backend-owned catalog and the proposed Magazyn module.
