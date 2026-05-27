# Weighted Fresh-Food POS — Backend Design (MVP)

**Status:** Approved (conceptual) + corrections applied · **Date:** 2026-05-26 · **Scope:** chesaigon (eNail POS / b2b-pos)
**No production mutation performed.** This is a design document only.

## Locked decisions & corrections (2026-05-26, approved)
1. **`sell_by` is a dedicated enum (`PIECE | WEIGHT`).** Weighted behavior is NEVER inferred from `saleUnit='kg'`.
2. **`price_basis_*` is DEFERRED** (post-MVP). MVP stores canonical `retailPrice` as **price per kg** for WEIGHT; admin/UI must label it explicitly as **zł/kg**.
3. **Stock precision migration `numeric(10,2) → numeric(12,3)` is UP-ONLY**, applied before/when weighted sales begin (no down-migration once >2dp data exists).
4. **Legacy integer columns (`pack_quantity`/`units_per_pack`/`total_units`) are compatibility placeholders ONLY.** Do NOT set `total_units = ceil(saleQuantity)` for weighted lines — it would leak into reports/refunds/stock and misrepresent 0.238 kg as 1. Every weighted-aware path MUST read `sale_quantity` / `sale_unit`.
5. **Money math uses integer grams (or Decimal), never JS float multiplication.** `grams = round(saleQuantity_kg × 1000)`; `lineTotalGross = roundHalfUp(grams × pricePerKgGross / 1000)`.
6. **`sale_quantity` / `sale_unit` are populated for PIECE lines too** (`sale_quantity = packQuantity × unitsPerPack`, `sale_unit = 'szt'`) so reports/refunds have one generic quantity contract.
7. **`sellBy` must be exposed to POS-zira** via the product feed and the sync-log payload.

## Goal

Sell fresh food (vegetables, meat, e.g. "Riềng củ") by **weight** in the POS tab.
Backend/catalog is the source of truth for product, price, VAT and stock. The cashier
(or, later, a Novitus/DIBAL GPOS G325 scale over RS232; for now manual grams / mock scale
in POS-zira) provides a decimal **kg** quantity. Line total = `kg × price-per-kg`.

Worked example: `0.238 kg × 8000 grosze/kg = 1904 grosze` (VAT 5%).

Money is **always integer grosze**. Weight quantity is **decimal kg, 3 decimals** (gram resolution).

---

## 1. Current backend compatibility audit

Verified against the running code (2026-05-26).

### 1.1 Product variant (`product_variants` / `ProductVariant`)
- `sale_unit varchar(16) NULL` (`saleUnit`) — free-form label ("szt", "kg", "g", "L"); admin mapper defaults to "szt". **Already present.**
- `weight_unit varchar(8) NULL` (`weightUnit`) — 'g'/'kg'/'ml'/'l'/'pcs'.
- `retailPrice` (grosze) exposed via getter `sellingPrice` — this is price **per sale unit**.
- ❌ No `sell_by` / `sale_mode` flag, no canonical `pricePerKgGross`, no `priceBasis*` fields.
- **Verdict:** unit metadata exists; a sale-mode flag + canonical per-kg price semantics are missing.

### 1.2 POS order DTO/service
- `CreateB2BPOSOrderItemDto.packQuantity` = `@IsInt() @Min(1)` → **rejects decimals**.
  Other item fields: `customPrice?` (decimal), `customPriceNotes?`, `colorCode?`.
- `B2BPOSService.createPOSOrder()` computes `total_units = packQuantity × unitsPerPack`,
  line totals from integer units; `deductStock()` derives `unitsToDeduct = item.totalUnits || packQty*(unitsPerPack||1)` → **integer**.
- **Verdict:** the order create path is integer-only — the primary blocker.

### 1.3 `b2b_order_items` schema (`B2BOrderItem`)
- `pack_quantity integer DEFAULT 1`, `units_per_pack integer DEFAULT 1`, `total_units integer DEFAULT 1` — **all integer**.
- Prices/tax columns are numeric; `external_metadata jsonb`.
- **Verdict:** no column can hold a decimal sale quantity; no `unit` column.

### 1.4 Stock precision (`stock_quants`, `stock_moves`)
- `stock_quants.quantity` and `reserved_quantity` = `numeric(10,2)`.
- `stock_moves.quantity`, `quantity_before`, `quantity_after` = `numeric(10,2)`.
- `SmartStockService.smartStockOut(quantity: number, …)` and the FEFO loop operate on `number` → decimal-capable in code.
- **Verdict:** columns hold **2 decimals only** (0.01 kg = 10 g; `0.238 → 0.24`). The deduction value fed in is currently the integer `total_units`.

### 1.5 Fiscal receipt DTO/payload (`ReceiptItemDto`, `PrintJobEventDto`)
- `ReceiptItemDto`: `name`, `quantity (@IsNumber)`, `unitPrice` (grosze), `totalPrice` (grosze), `vatRate`, `sku?`.
- ❌ **No `unit` field.** Quantity is decimal-capable; the job payload is `jsonb`.
- The print-job contract (post-2026-05-26 deploy) carries `printerId/printerType/referenceType/referenceId/payload`, plus `waitForCompletion`/`GET /jobs/:id` (Point 3).
- **Verdict:** decimal quantity survives the payload; the **unit (kg)** is not represented.

### 1.6 Refund / order-history implications
- Refund restock = `restoreStock()` → `WarehouseStockMovement` with `referenceType = B2B_POS_ORDER_CANCEL`, distributed over the original sale movements; quantities `numeric(10,2)`.
- Refund quantity per line is read from the order item (integer today).
- **Verdict:** refund/restock and order-history quantity must become decimal-aware once order items hold decimal quantity, otherwise weighted refunds round/mismatch.

---

## 2. Proposed schema / API contract

Design principle: **additive + generic**. A line carries a generic decimal `saleQuantity` +
`saleUnit`; the existing integer `packQuantity` path is preserved for PIECE items.

### 2.1 Product variant (catalog = source of truth)
| Field | Type | Notes |
|---|---|---|
| `sell_by` (`sellBy`) | varchar(8) / enum `PIECE \| WEIGHT` | default `PIECE`. WEIGHT ⇒ `saleUnit` must be a weight unit (kg). |
| `sale_unit` (`saleUnit`) | varchar(16) | reuse existing. `szt` for PIECE, `kg` for WEIGHT. |
| `retailPrice` (grosze) | int | **canonical price per sale unit** (for WEIGHT = price per kg, e.g. `8000`). Reuse existing column. |
| ~~`price_basis_qty` / `price_basis_unit` / `price_basis_gross`~~ | — | **DEFERRED (post-MVP).** Not in MVP scope. |

**MVP catalog contract:** `sell_by` (enum, dedicated) + `sale_unit` ('kg' for WEIGHT) + `retailPrice` = **canonical price per kg** (grosze). Admin/UI MUST label the WEIGHT price field explicitly as **"zł/kg"**. `price_basis_*` ("16 zł / 200 g" input convenience) is deferred to a later iteration.

### 2.2 Order line (`b2b_order_items` + `CreateB2BPOSOrderItemDto`)
| Field | Type | Notes |
|---|---|---|
| `sale_quantity` (`saleQuantity`) | numeric(12,3) | **generic** decimal quantity (kg for WEIGHT, pieces for PIECE). |
| `sale_unit` | varchar(8) | `kg` \| `szt`. |
| (keep) `pack_quantity`/`units_per_pack`/`total_units` | integer | **Compatibility placeholders ONLY.** For WEIGHT lines set them to a neutral `1` (NOT `ceil(saleQuantity)`); they must never be read as the quantity for weighted lines. Every weighted-aware path (pricing, stock, fiscal, reports, refunds) reads `sale_quantity`/`sale_unit`. For PIECE lines they keep their real integer meaning. |

`sale_quantity`/`sale_unit` are **always populated** — PIECE: `sale_quantity = packQuantity × unitsPerPack`, `sale_unit = 'szt'`; WEIGHT: `sale_quantity = kg` (3 dp), `sale_unit = 'kg'`.

DTO: add `saleQuantity?: number` (`@IsNumber({maxDecimalPlaces:3}) @Min(0.001)`) + `saleUnit?: string`.
Make `packQuantity` `@IsOptional()`. **Resolution rule:** the line's mode comes from the **variant's `sell_by`** (not from which field is sent). WEIGHT variant → require `saleQuantity` (kg); PIECE variant → use `packQuantity` (legacy path unchanged) and derive `sale_quantity`.

### 2.3 Fiscal (`ReceiptItemDto`)
Add `unit?: string` (default `szt`). For WEIGHT: `unit='kg'`, `quantity = saleQuantity` (3 dp),
`unitPrice = pricePerKgGross`, `totalPrice = lineTotalGross`.

### 2.4 Backward compatibility
- All new fields are **nullable/optional**; PIECE items keep using `packQuantity` and integer columns.
- Existing orders/movements (2 dp) remain valid after widening to (12,3).

---

## 3. Decimal & rounding rules

- **Quantity:** kg with **3 decimals** (`numeric(12,3)`), gram resolution. POS-zira sends ≤3 dp.
- **Money:** always **integer grosze**. No floats persisted for money.
- **Line total (integer math, NO JS float):** convert kg → integer grams, then:
  `grams = round(saleQuantity_kg × 1000)` (integer); `lineTotalGross = roundHalfUp(grams × pricePerKgGross / 1000)` → integer grosze.
  (e.g. `238 × 8000 = 1_904_000; / 1000 = 1904`.) Use BigInt/integer arithmetic (or a Decimal lib) — never `0.238 * 8000` float.
- **VAT:** extracted from the **rounded gross** using the product `taxRate` (prices are brutto in this POS):
  `vatAmount = round(lineTotalGross − lineTotalGross × 100 / (100 + taxRate))`. Fresh food = 5%.
  This matches the existing POS VAT extraction (`Math.round(total − total*100/(100+rate))`).
- **Basis normalization:** `pricePerKgGross = roundHalfUp(priceBasisGross × 1000 / priceBasisQtyGrams)`.
  Clean case `1600 × 1000 / 200 = 8000`. **Edge:** when it does not divide cleanly, store the rounded
  per-kg value, keep the basis as entered for display, and flag for admin review (small per-kg rounding
  is acceptable; never silently distort the basis). Document the chosen per-kg as canonical.

---

## 4. Stock behavior

- **Precision:** migrate `stock_quants.quantity`, `reserved_quantity` and
  `stock_moves.quantity`/`quantity_before`/`quantity_after` from `numeric(10,2)` → **`numeric(12,3)`**.
- **Deduction:** for WEIGHT lines, `deductStock` deducts `saleQuantity` (kg, decimal) instead of integer `total_units`.
- **FEFO / allow-negative:** unchanged — `smartStockOut` already runs on `number` and supports FEFO across lots
  plus the POS `allowNegative` oversell (negative remainder move). Decimal kg flows through unchanged.
- **Migration risk:** widening scale `2 → 3` and precision `10 → 12` is **safe and lossless** for existing
  rows (no truncation; values gain a trailing zero). Do it as a single `ALTER COLUMN … TYPE numeric(12,3)`
  per column. Lock impact is brief; run off-peak. No data backfill needed.

---

## 5. Fiscal behavior

- `ReceiptItemDto.unit` must be preserved and sent to the agent (job payload already `jsonb`).
- Fiscal payload for a weighted line: `{ name, quantity: 0.238, unit: "kg", unitPrice: 8000, totalPrice: 1904, vatRate: 5 }`.
- **Client formatting risk (POS-zira ELZAB_STX / POSNET driver):** Polish fiscal protocols accept a
  decimal quantity + a unit string per line, but the **driver must format** the quantity to the protocol's
  precision (typically 3 dp for weight) and pass the unit. This is **client-side** (POS-zira hardware driver),
  not backend — backend only needs to carry `quantity` (3 dp) + `unit`. Confirm the ELZAB_STX driver emits
  the weight quantity and unit; otherwise the fiscal line prints qty=1.
- Total integrity: the fiscal `totalPrice` must equal the rounded `lineTotalGross` the backend stored
  (single source of truth) to avoid receipt/backend mismatch.

---

## 6. Minimal implementation plan

**Migrations**
1. `ALTER` stock columns `numeric(10,2) → numeric(12,3)` (`stock_quants.quantity`, `reserved_quantity`; `stock_moves.quantity`, `quantity_before`, `quantity_after`).
2. `ALTER TABLE b2b_order_items ADD COLUMN sale_quantity numeric(12,3) NULL, ADD COLUMN sale_unit varchar(8) NULL`.
3. `ALTER TABLE product_variants ADD COLUMN sell_by varchar(8) NOT NULL DEFAULT 'PIECE'`. (No `price_basis_*` in MVP.)

**DTO changes**
- `CreateB2BPOSOrderItemDto`: add `saleQuantity?` (`@IsNumber({maxDecimalPlaces:3}) @Min(0.001)`), `saleUnit?`; `packQuantity` optional. Line mode resolved from variant `sell_by`.
- `ReceiptItemDto`: add `unit?: string`.

**Service changes**
- `B2BPOSService.createPOSOrder`: branch on variant `sell_by`. WEIGHT → `grams = round(saleQuantity×1000)`, `lineTotalGross = roundHalfUp(grams × pricePerKgGross / 1000)` (integer math), persist `sale_quantity`/`sale_unit='kg'`, set legacy int cols to neutral `1`; `deductStock` uses `saleQuantity`. PIECE → unchanged total, also persist `sale_quantity = packQuantity×unitsPerPack`, `sale_unit='szt'`.
- `deductStock`: deduct decimal `saleQuantity` for WEIGHT lines (smartStockOut already decimal-safe).
- Fiscal payload builder: set `unit` + decimal `quantity` (= `sale_quantity`) for WEIGHT; `totalPrice` = stored `lineTotalGross` (single source of truth).
- `restoreStock`/refund + order-history: read `sale_quantity`/`sale_unit` (never `total_units`) for WEIGHT.
- **Product feed + sync-log to POS-zira: expose `sellBy`** (so the client knows which lines are weighted) — quick-add/product lookup response + the POS sync payload.

**Tests** (required)
- PIECE regression: integer `packQuantity` path unchanged; `sale_quantity` populated (`szt`).
- WEIGHT create: `0.238 kg × 8000 → total 1904`, persisted `sale_quantity=0.238`, `sale_unit='kg'`.
- Stock deduction WEIGHT: quant decremented by `0.238`, `stock_move` qty `0.238` with lotId (3 dp preserved).
- Fiscal payload: WEIGHT line carries `unit='kg'` + decimal quantity.
- Refund WEIGHT line: net qty decimal-correct (reads `sale_quantity`).
- Rounding half-up via integer grams (e.g. a qty/price whose product is `…500/1000` rounds up).

**Rollout / backward compatibility**
- All additive/nullable; PIECE flow untouched. Deploy = surgical dist swap on Contabo (manual, see CONTABO workflow) + migrations run on prod DB. The stock scale migration is **UP-ONLY** (no down-migration once weighted sales write >2dp data).

---

## 7. POS-zira (client) impacts

The cart store already uses `quantity: number` (decimal-capable; `total = quantity × price`). Required client changes:
- **Decimal cart/order quantity:** keep `quantity` as decimal end-to-end (store, local SQL.js order rows). Add `saleUnit` per line.
- **Bypass the integer stepper for WEIGHT lines:** weighted items need a **kg/gram input** (manual now, scale later), not the ±1 stepper.
- **Stop rounding to `packQuantity`:** today the sync payload rounds quantity to a positive integer in **three** places — `src/main/database/repos/order-repo.ts:298`, `src/main/modules/pos.module.ts:1004`, `src/main/sync/order-sync.ts:145` (`packQuantity: Math.max(1, Math.round(quantity))`). For WEIGHT lines these must send `saleQuantity` (decimal) + `saleUnit`, not the rounded `packQuantity`.
- **Order-history / refund parsing:** `src/main/sync/pos-order-adapter.ts:128` reads `quantity: item.packQuantity ?? 1`; refund/payment payloads (`refund-backend-payload.ts`, `payment-controller.ts`) pass `quantity` — update to read/preserve the decimal `saleQuantity` so history and refunds show 0.238 kg, not 1.
- **Fiscal line:** send `unit='kg'` + decimal quantity; ensure the ELZAB_STX driver formats weight + unit.

> Client work is owned by the POS-zira team. Backend changes above are necessary and sufficient on the server side; POS-zira must adopt the `saleQuantity`/`saleUnit` contract.

---

## Resolved decisions (2026-05-26, signed off)
1. ✅ `sell_by` = dedicated enum column (`PIECE | WEIGHT`); never inferred from `saleUnit`.
2. ✅ `price_basis_*` deferred post-MVP; MVP uses canonical `retailPrice` per kg, UI labels "zł/kg".
3. ✅ Stock scale migration is up-only.
