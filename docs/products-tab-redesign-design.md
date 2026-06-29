---
title: POS Products Tab Redesign (Dotykačka-style drill-down)
type: design-spec
created: 2026-06-29
revised: 2026-06-29 (gatekeeper pass — contract holes closed)
author: Claude (brainstormed with Paul) + app-bot gatekeeper corrections
project: zira-ai / POS-zira
status: revised-for-implementation
target_salon: pos.wolka@chesaigon.pl (active salon d2bc0dbd…, serverUrl=https://api.enail.pro → Contabo)
---

# POS Products Tab Redesign — Dotykačka-style drill-down (v2, gatekeeper-corrected)

## 0. Goal & ownership

Rebuild the POS-zira **Products tab** (`src/renderer/components/products/`) into a
category-first, touch-friendly catalog manager inspired by Dotykačka, with global
search/scan-to-jump and **proper backend-backed manual product creation**.

### 0.1 Ownership & boundaries (MANDATORY — gatekeeper)
- **Part A (backend, `/var/www/www/enail/backend`) is BACKEND-BOT OWNED.** This document's
  backend sections are a **contract/request** for backend-bot, not work the POS-zira app
  worker performs.
- The **POS-zira app worker does NOT** edit `/var/www/www/enail/backend` from an app worktree,
  and does NOT deploy Contabo.
- The app stays **capability-gated**: the create UI is enabled only when the **live** backend
  returns `canCreateProduct=true`. Until then the redesign ships with create dark, everything
  else (browse, search/scan, edit, deactivate, stock-adjust per live caps) live.

## 1. Reference (Dotykačka)
5 photos (`C:\Users\pc\Downloads\dotykacka-reference\1..5.jpg`): item list (category rail +
stock-coloured tiles), edit-general (name, alt name, category, show-in-menu), category dropdown,
edit-price (net/VAT/gross + weighed-quantity), search overlay (name/EAN/PLU, code-left/name-right).
We adopt: category-first nav, colour-by-stock tiles, code search, kg/pcs, optional image. We do
NOT adopt: persistent rail (we drill down), recipes/allergens/packaging tabs.

## 2. Pre-work findings

### 2.1 Duplicate-EAN audit
All 4 local salon mirrors on winpc: **0 duplicate barcode groups** (1700/1652/1699/89 products).
`product_variants` has **no UNIQUE index on barcode** → DB does not prevent it → scan must handle
≥2 matches defensively.

### 2.2 Backend contract (read from `backend/src/modules/product-admin/`)
| Capability | State | Endpoint |
|-----------|-------|----------|
| Update variant | ✅ | `PATCH variants/:id` |
| Deactivate (soft) | ✅ | `POST variants/:id/deactivate` |
| Adjust stock | ✅ (admin roles) | `POST variants/:id/stock-adjustments` |
| Categories list/create/update/reorder | ✅ | `…/categories…` |
| **Create product** | ❌ no endpoint, `canCreateProduct=false` | **to be added by backend-bot** |

OCC via `expectedUpdatedAt` → `409 STALE_PRODUCT`. `Idempotency-Key` HTTP **header** is the
canonical idempotency channel — the POS api-client (`productAdminRequest`) already sends it for
create/stock today.

### 2.3 Existing renderer assets
- **Reuse**: `useProducts.ts`, `ProductEditForm.tsx` (exact single-form edit), `ProductCreateDialog.tsx`,
  `CategoryManagerDialog.tsx`, `ProductStatusBadge.tsx`, `StockAdjustmentDialog.tsx`,
  `DeactivateProductDialog.tsx`, `ProductAddFlow.tsx`, `productAdmin.*` IPC.
- **Scan semantics already exist**: `productRepo.getByBarcode()` (main) resolves in 5 stages —
  (1) exact, (2) leading-zero strip (len≥4), (3) substring `INSTR(scanned, stored)`, (4)
  alphanumeric-only containment (len≥8/≥4), (5) SKU exact. Exposed as
  `window.electronAPI.pos.products.getByBarcode(code)`. The new search/scan MUST reuse this, not
  reinvent a naive `barcode===code` filter.
- **Client create wiring already exists**: `pos.module.ts` → `apiClient.createProductVariant()`
  in `api-client.ts`, POSTs `/products` with `Idempotency-Key` header — but it **strips `sellBy`**
  via `withoutUnsupportedProductAdminSellBy()`, and `ProductAdminCreateProductInput` has **no
  `sellBy`** field. Both must be fixed (B0).
- **Retire later** (only after parity, see §6 gates): `ProductTable.tsx`, `ProductToolbar.tsx`.
  **Do NOT delete `ProductDetailDrawer.tsx`** until the new edit view preserves all its features.

## 3. Decisions (approved 2026-06-29, gatekeeper-amended)
1. Approach 1: new drill-down shell, reuse logic.
2. Stock colour: red ≤ 0 · amber ≤ 5 · green > 5.
3. "Remove product" = soft deactivate (never hard delete).
4. Scan no-match → offer "create with this code" (prefill barcode + current category).
5. No translated-name editing (canonical `name` only).
6. CategoryGrid: "All" + "Uncategorised" tiles; **sort categories by `sort_order` then display name**.
7. Manual create = new backend endpoint + flip `canCreateProduct`. **Initial stock default = 0.**

## 4. Architecture — renderer (POS-zira app worker owned)

`ProductModule` = thin view-router: `categories → products(categoryId) → edit(productId)`, with a
floating search/scan overlay.

| Component | Purpose |
|-----------|---------|
| `CategoryGrid.tsx` | Landing: category cards (count) sorted by sort_order→name, + All + Uncategorised; toolbar (Search, ＋Add, Manage categories) |
| `ProductTileGrid.tsx` | Tiles of one category, colour-by-stock, ＋Add (defaults this cat), ‹Back |
| `ProductTile.tsx` | name + price(zł) + stock number; bg colour; badges (no-price/draft/inactive) |
| `ProductSearchOverlay.tsx` | global search (name/EAN/SKU) + scan-to-jump via `getByBarcode` + dup handling + no-match-create |
| `ProductEditView.tsx` | full-screen edit hosting `ProductEditForm` **plus all `ProductDetailDrawer` actions** (print label, import draft, stock adjust, deactivate w/ in-cart guard, stale/not-found hide) |
| `product-stock-color.ts` | pure: stock → colour classes |
| `scan-match.ts` | pure dup-detector layered over `getByBarcode` |

### 4.1 Colour
`stock<=0→red · 1..5→amber · >5→green`; price≤0 → warning ring; `_isDraft` → violet badge;
`is_active===0` → grey "stopped" badge.

### 4.2 Search & scan-to-jump (matches POS semantics)
- Input "Nhập tên, EAN hoặc PLU"; live list (reuse `useProducts` filter) shows code-left/name-right.
- On scan/Enter of a code token: call `window.electronAPI.pos.products.getByBarcode(code)` for the
  authoritative single match (inherits the 5-stage normalization). **Independently** compute the
  duplicate set from `allProducts` (exact OR leading-zero-normalized barcode equality, plus SKU
  exact). Resolution:
  - dupSet>1 → render list + **"Trùng mã EAN"** banner (no blind jump).
  - else getByBarcode hit → open `edit`.
  - else (no match) → CTA "Tạo SP mới với mã {code}" → ProductCreateDialog prefilled.
- Text-result tap → open `edit`.

### 4.3 Create flow
`ProductCreateDialog` (reused): when opened from a category, `categoryId` defaults to it; **initial
stock default 0**; **idempotency key generated once per dialog OPEN** (not per submit click);
image optional. Submits via `productAdmin.createProduct` → `apiClient.createProductVariant()` →
`POST /products` with `Idempotency-Key` header. Gated by `canCreateProduct`.

## 5. Backend contract (BACKEND-BOT OWNED — request spec)

### 5.1 New endpoint `POST /api/v1/warehouse/product-admin/products` (OWNER/MANAGER)
- **Idempotency**: canonical = `Idempotency-Key` **header**; body `idempotencyKey` = fallback only.
  Resolved key = `header ?? body.idempotencyKey`. **Never** key on `(salonId,barcode)` or
  `(salonId,name)`.
- **Durable uniqueness (preferred)**: new table `product_admin_create_requests`
  `(id, salon_id, idempotency_key, status, variant_id, response_json, last_error, created_at, updated_at)`
  with **unique `(salon_id, idempotency_key)`**. status ∈ `PENDING|COMPLETED|FAILED`.
  - Fallback only if stock is atomic in the same DB transaction: `product_variants.idempotency_key`
    + unique `(salon_id, idempotency_key)` for non-null keys.
- **Atomic create + stock**: template + variant + initial stock must not be left half-made.
  - Preferred: template + variant + stock move inside **one DB transaction**.
  - If the stock service cannot share the transaction: persist the request row, insert
    template+variant, record `variant_id` + status `PENDING`; attempt stock (RECEIVE) keyed by the
    same idempotency key; on success → `COMPLETED` + `response_json`; on failure → keep `PENDING`
    + `last_error` and **return an error (NOT success)**. A replay **resumes**: `COMPLETED` →
    return `response_json`; `PENDING` with variant but stock unconfirmed → re-attempt the single
    stock op then complete; **never return the variant as success while stock is unwritten**.
- **Input DTO** `CreateProductAdminProductDto`: `name` (req), `barcode?`, `sku?`,
  `priceGrossGrosze` (**`@Min(1)`** positive by default; backend may allow no-price only if
  explicitly documented), `vatRate` (req), `categoryId?`, `saleUnit?`,
  **`sellBy?: 'PIECE'|'WEIGHT'`** (explicit — do not infer from `saleUnit`),
  `initialStockQty?` (default 0), `imageUrl?`, `idempotencyKey?` (**optional fallback, not required**).
- **Controller** reads `@Headers('idempotency-key')`; **service signature** takes the resolved key.
- **No warehouse + initialStockQty>0** → fail **before** any partial create.
- **Capability**: flip `canCreateProduct` to `canAdminProducts`.
- **Success response shape**: `{ product, variant, serverTime }` (canonical template + variant).
- **Stable error envelope** (`success/data/error.code/error.message`).

### 5.2 Backend tests (backend-bot)
header idempotency accepted · body fallback works · duplicate/concurrent returns same variant w/o
second insert · initial stock atomic/replay-safe · stock failure does NOT silently return created
variant · no-warehouse+initial-stock fails before partial create · capability flips true.

## 6. UI regression gates (MANDATORY before retiring anything)
- **Do not delete `ProductDetailDrawer`** until `ProductEditView` preserves: print label
  (`electronAPI.printLabel`), import draft (`onImportDraft`), stock adjustment
  (`StockAdjustmentDialog`), stale/not-found hide (`onStaleProductHidden`), and the **in-cart
  deactivate guard** (block hide while the product is in an open cart).
- **Scan resolver** must match POS semantics: exact, leading-zero-stripped, SKU fallback, safe
  substring/alphanumeric, duplicate handling at every stage (reuse `getByBarcode` + dup-set).
- **Category grid** sorts by `category.sort_order` then display name.
- Renderer verification must include **`npm run typecheck:renderer`** — `build:renderer` alone is
  insufficient.

## 7. Out of scope (Phase 2)
Category colour/icon, translated-name editing, price levels/discounts/loyalty, recipes, allergens,
packaging, price-label redesign.

## 8. Deployment & safety
- Backend = backend-bot: build on Netcup → deploy Contabo (slow-boot ~80s health gate). App worker
  does not deploy. App reads live capability; create UI dark until `canCreateProduct=true`.
- Renderer = POS-zira build; verify `npm run typecheck:renderer` + `npm run build:renderer`; UI/E2E
  by hand on device. `pos.wolka@chesaigon.pl` is a **live** counter — coordinate timing.

## 9. Test plan
Pure helpers unit-tested (`product-stock-color`, `scan-match`); `tests/product-module-static.test.ts`
updated; B0 static tests for sellBy passthrough; backend specs per §5.2; manual device smoke
(drill-down, colours, search, scan exact/dup/no-match, create default-category, edit, deactivate,
stock recount, sync to another POS).
