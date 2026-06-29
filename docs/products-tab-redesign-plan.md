# POS Products Tab Redesign — Implementation Plan (v2, gatekeeper-corrected)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Dotykačka-style drill-down Products tab (category grid → stock-coloured tiles → single-form edit) with POS-semantic search/scan and backend-backed manual create.

**Architecture:** Renderer = new view-router shell over reused data/edit logic (Approach 1). Backend = new `POST /warehouse/product-admin/products` (idempotent via `Idempotency-Key` header + durable request table, atomic create+stock) + capability flip. Capability-gated, offline-first sync preserved.

**Tech Stack:** Electron 33 renderer (React 18 + TS 5.7 strict + Tailwind + lucide), vitest. Backend NestJS 10 + TypeORM + class-validator, jest.

## Ownership (MANDATORY)
- **PART A = BACKEND-BOT OWNED.** The POS-zira app worker does NOT edit `/var/www/www/enail/backend` and does NOT deploy Contabo. Part A below is the **contract handed to backend-bot**.
- **PART B = POS-zira app worker.** Ships capability-gated; create UI stays dark until the **live** backend returns `canCreateProduct=true`.
- B and A can proceed in parallel because B is gated and cannot break live POS.

## Global Constraints
- Money = integer grosze in transport. Capability-gated (fail-closed). Mutations return canonical shapes, mirrored locally then refreshed via `onProductsSynced/onCatalogUpdated/onStockUpdated`. OCC via `expectedUpdatedAt`. Remove = soft deactivate. Colours red≤0/amber≤5/green>5. Canonical name only. TS strict. **Renderer verify = `npm run typecheck:renderer` AND `npm run build:renderer`.** `pos.wolka@chesaigon.pl` is live — coordinate.

---

# PART A — Backend contract (BACKEND-BOT OWNED — do not implement from app worktree)

> Handed to backend-bot. Listed as tasks so backend-bot can execute with the same discipline.

### Task A1: `product_admin_create_requests` table + entity + migration
**Files:** new entity under `backend/src/modules/product-admin/entities/`, migration in `backend/src/migrations/`.
- [ ] Entity `ProductAdminCreateRequest`: `id uuid pk`, `salonId`, `idempotencyKey varchar(100)`, `status enum('PENDING','COMPLETED','FAILED')`, `variantId uuid null`, `responseJson jsonb null`, `lastError text null`, `createdAt`, `updatedAt`. **Unique `(salon_id, idempotency_key)`.**
- [ ] Migration: create table + unique index. `NODE_ENV=development npm run migration:generate -- -n AddProductAdminCreateRequests`, review, `migration:run`.
- [ ] Commit.

### Task A2: `CreateProductAdminProductDto`
**Files:** `backend/src/modules/product-admin/dto/product-admin.dto.ts`
- [ ] Append DTO. `idempotencyKey` **optional fallback** (not required). `priceGrossGrosze` `@Min(1)`. `sellBy?: 'PIECE'|'WEIGHT'` explicit.
```ts
export class CreateProductAdminProductDto {
  @ApiProperty() @IsString() @MaxLength(255) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) barcode?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) sku?: string | null;
  @ApiProperty({ description: "Gross price in grosze (positive)" }) @IsInt() @Min(1) priceGrossGrosze: number;
  @ApiProperty() @IsNumber() @Min(0) vatRate: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(16) saleUnit?: string | null;
  @ApiPropertyOptional({ enum: ["PIECE","WEIGHT"] }) @IsOptional() @IsIn(["PIECE","WEIGHT"]) sellBy?: "PIECE"|"WEIGHT";
  @ApiPropertyOptional({ description: "Default 0" }) @IsOptional() @IsNumber() @Min(0) initialStockQty?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string | null;
  @ApiPropertyOptional({ description: "Fallback only; canonical is Idempotency-Key header" })
  @IsOptional() @IsString() @MaxLength(100) idempotencyKey?: string;
}
```
- [ ] Build (tsc) clean. Commit.

### Task A3: `ProductAdminService.createProduct(salonId, dto, userId, resolvedKey)` — idempotent + atomic
**Files:** `backend/src/modules/product-admin/services/product-admin.service.ts`
- [ ] Signature takes `resolvedKey: string` (controller passes `header ?? body`). Algorithm:
  1. If no `resolvedKey` → 400 (idempotency key required).
  2. Upsert/find `product_admin_create_requests` by `(salonId, resolvedKey)`. If `COMPLETED` → return `response_json`. If `PENDING` with `variantId` → resume stock (idempotent) then complete. If absent → insert `PENDING`.
  3. If `initialStockQty>0`: `await resolveDefaultWarehouse(salonId)` first (fail before create if none).
  4. In **one `dataSource.transaction`**: create `Product`(salonId,name,categoryId,taxRate=vatRate, +any NOT NULL cols — inspect entity), create `ProductVariant`(salonId,templateId,name,sku,barcode,retailPrice=grosze/100,saleUnit,sellBy,imageUrl,isActive=true), set request.variantId. If stock service can join the tx, apply RECEIVE here too.
  5. If stock can't join the tx: after commit, apply `adjustStock` RECEIVE keyed by resolvedKey; on failure mark request `PENDING`+lastError and **throw** (no success). On success mark `COMPLETED`, store `response_json = { product, variant, serverTime }`.
  6. Return `{ product, variant, serverTime }`.
- [ ] Concurrency: rely on the unique `(salon_id, idempotency_key)` — a racing second insert hits the constraint; catch → re-read the existing row and return/await its result. Never double-insert variant.
- [ ] Build clean. Commit.

### Task A4: Controller route + capability flip
**Files:** `backend/src/modules/product-admin/controllers/product-admin.controller.ts`, service `getCapabilities`.
```ts
@Post("products")
@Roles(UserRole.OWNER, UserRole.MANAGER)
async createProduct(
  @Body() dto: CreateProductAdminProductDto,
  @Headers("idempotency-key") headerKey: string | undefined,
  @CurrentUser() user: CurrentUserPayload,
) {
  const resolvedKey = (headerKey || dto.idempotencyKey || "").trim();
  return this.service.createProduct(user.salonId, dto, user.userId, resolvedKey);
}
```
- [ ] `getCapabilities`: `canCreateProduct: canAdminProducts`.
- [ ] Build clean. Commit.

### Task A5: Backend specs
**Files:** `backend/src/modules/product-admin/__tests__/product-admin.service.spec.ts` (+ controller spec if present)
- [ ] Tests: header idempotency accepted; body fallback works; duplicate/concurrent → same variant, no 2nd insert; initial stock atomic/replay-safe; **stock failure does not return created variant as success**; no-warehouse + initialStockQty>0 fails before partial create; `getCapabilities().canCreateProduct===true`.
- [ ] `npx jest src/modules/product-admin` green. Commit.

### Task A6: Deploy (backend-bot, gated)
- [ ] Land on the branch Contabo serves (NOT `feat/pickup-queue-backend`). Deploy via `deploy-contabo` (Netcup build → Contabo → health poll, ~80s slow-boot gate).
- [ ] Verify live `GET /warehouse/product-admin/capabilities` → `canCreateProduct=true` for an owner token on the chesaigon salon.

---

# PART B — Renderer (POS-zira app worker, `C:\POS-zira`)

> Work on a feature branch (see C0). Verify each task with `npm run typecheck:renderer` then `npm run build:renderer`. Unit tests `npx vitest run <file>`.

### Task B0: Contract alignment — `sellBy` passthrough
**Files:** `src/shared/types.ts` (`ProductAdminCreateProductInput`), `src/main/network/api-client.ts`, test `tests/api-client-create-sellby.test.ts`.
**Interfaces:** Produces `ProductAdminCreateProductInput.sellBy?: 'PIECE'|'WEIGHT'`; create body retains `sellBy`.
- [ ] **Step 1: Failing test** — assert the create body sent by `createProductVariant` includes `sellBy:'WEIGHT'` (mock `productAdminRequest`/fetch, inspect body).
- [ ] **Step 2: Run** → FAIL (sellBy currently stripped).
- [ ] **Step 3: Add `sellBy?: 'PIECE' | 'WEIGHT';`** to `ProductAdminCreateProductInput` (types.ts ~2959).
- [ ] **Step 4:** In `createProductVariant` (api-client.ts ~1513) stop stripping sellBy: replace `withoutUnsupportedProductAdminSellBy(payload)` with a destructure that keeps `sellBy` (only strip the client-only `idempotencyKey`):
```ts
const { idempotencyKey, ...body } = payload;
return this.productAdminRequest(token, 'POST', '/products', body, idempotencyKey);
```
(Leave `updateProductVariant`'s strip as-is unless backend update also accepts sellBy — out of scope here.)
- [ ] **Step 5: Run** → PASS. `npm run typecheck:renderer` + `npm run build:main` clean. Commit.

### Task B1: Stock-colour helper (pure)
**Files:** Create `src/renderer/components/products/product-stock-color.ts`; Test `tests/product-stock-color.test.ts`.
**Produces:** `stockColor(qty):'red'|'amber'|'green'`, `stockTileClasses(qty):string`.
- [ ] Failing test (0→red, -3→red, 1→amber, 5→amber, 6→green) → run FAIL.
- [ ] Implement:
```ts
export type StockColor = "red" | "amber" | "green";
export const LOW_STOCK_THRESHOLD = 5;
export function stockColor(qty: number): StockColor {
  const n = Number(qty) || 0;
  if (n <= 0) return "red";
  if (n <= LOW_STOCK_THRESHOLD) return "amber";
  return "green";
}
export function stockTileClasses(qty: number): string {
  switch (stockColor(qty)) {
    case "red":   return "bg-rose-500 text-white border-rose-600";
    case "amber": return "bg-amber-400 text-amber-950 border-amber-500";
    case "green": return "bg-emerald-500 text-white border-emerald-600";
  }
}
```
- [ ] Run → PASS. typecheck+build clean. Commit.

### Task B2: Scan resolver — reuse POS semantics + dup detection
**Files:** Create `src/renderer/components/products/scan-match.ts`; Test `tests/scan-match.test.ts`.
**Produces:** `barcodeKey(s:string):string` (normalize: trim; leading-zero strip when len≥4); `findDuplicateBarcodeSet(code, products): ProductListItem[]` (exact OR leading-zero-normalized barcode equality, plus SKU exact); `resolveScan(code, products, getByBarcode): Promise<{kind:'one';product}|{kind:'many';products}|{kind:'none';code}>` where `getByBarcode=(c)=>Promise<ProductListItem|null>`.
- [ ] **Step 1: Failing tests** — exact 1 → 'one'; two rows same barcode → 'many' even if getByBarcode returns one; leading-zero variant ('0123' vs '123') counted as dup; unknown → 'none'; SKU-only hit (no barcode) routes via getByBarcode → 'one'.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — `resolveScan`: compute `dupSet = findDuplicateBarcodeSet(code, products)`; if `dupSet.length>1` → `{kind:'many',products:dupSet}`; else `const hit = await getByBarcode(code)` → `hit ? {kind:'one',product:hit} : {kind:'none',code}`. `barcodeKey` strips leading zeros only when result length≥4 (mirror repo stage 2). Keep it pure (getByBarcode injected).
- [ ] **Step 4: Run** → PASS. Commit.

### Task B3: `ProductTile`
**Files:** Create `src/renderer/components/products/ProductTile.tsx`.
- [ ] Implement (uses `stockTileClasses`, `resolveName`, money fmt). Whole `<button onClick={()=>onSelect(product)}>`; shows name, `(retail_price/100).toFixed(2)+' zł'`, stock number; badges draft/inactive; price≤0 warning ring. min-h ~96px.
- [ ] typecheck+build clean. Commit.

### Task B4: `ProductTileGrid`
**Files:** Create `src/renderer/components/products/ProductTileGrid.tsx`.
- [ ] Header: `‹ Back`, category name, count, `＋ Thêm SP` (`onAddProduct`), search icon (`onOpenSearch`). Responsive grid; 300-cap with "narrow your search" hint. Renders `ProductTile`.
- [ ] typecheck+build clean. Commit.

### Task B5: `CategoryGrid`
**Files:** Create `src/renderer/components/products/CategoryGrid.tsx`.
- [ ] Toolbar (Search, ＋Add, Manage categories). Cards per category: `resolveName` + product count; **sort by `category.sort_order ?? displayOrder` then `resolveName`**. Add "Tất cả" (all) and "Chưa phân loại" (`category_id==null`) cards. Cards are buttons → `onOpenCategory(id|'ALL'|null)`. Neutral styling.
- [ ] typecheck+build clean. Commit.

### Task B6: `ProductSearchOverlay`
**Files:** Create `src/renderer/components/products/ProductSearchOverlay.tsx`.
**Consumes:** `useProducts` filtered list, `resolveScan` (B2), `window.electronAPI.pos.products.getByBarcode`.
- [ ] Fixed overlay; input "Nhập tên, EAN hoặc PLU"; live code-left/name-right list → tap `onOpenProduct`. On Enter/scanner event: `await resolveScan(input, allProducts, (c)=>window.electronAPI.pos.products.getByBarcode(c))`:
  - `one` → `onOpenProduct`. `many` → list + rose "Trùng mã EAN" banner. `none` → CTA "Tạo SP mới với mã {code}" → `onCreateWithBarcode(code, currentCategoryId)`.
  - Subscribe to the renderer scanner bridge only while `open` (grep `SearchBar.tsx`/POSLayout scanner wiring for the event name). Respect `TouchKeyboard` inset.
- [ ] typecheck+build clean. Commit.

### Task B7: `ProductEditView` — full parity with `ProductDetailDrawer`
**Files:** Create `src/renderer/components/products/ProductEditView.tsx`.
**Consumes:** `ProductEditForm`, `DeactivateProductDialog`, `StockAdjustmentDialog`, `ProductStatusBadge`, `window.electronAPI.printLabel`.
- [ ] Full-screen view that ports EVERY `ProductDetailDrawer` capability (gatekeeper gate): header `‹Back` + name + status badge; actions — **Edit** (`ProductEditForm`, `canUpdateProduct && !_isDraft`), **Print label** (`electronAPI.printLabel(barcode, displayName, {priceText, sku})`, needs barcode), **Import draft** (`onImportDraft`, when `_isDraft && barcode`), **Adjust stock** (`StockAdjustmentDialog`, `canAdjustStock && !_isDraft`), **Ngừng bán** (`DeactivateProductDialog`, `canDeactivateProduct && !_isDraft && is_active!==0 && !productInCart`) with the **in-cart guard banner**, and `onStaleProductHidden` wiring. Props mirror the drawer's (`productInCart`, `onProductChanged`, `onProductDeactivated`, `onStaleProductHidden`, capability flags).
- [ ] typecheck+build clean. Commit.

### Task B8: Rewrite `ProductModule` as view-router
**Files:** Modify `src/renderer/components/products/ProductModule.tsx`.
- [ ] View state `{name:'categories'} | {name:'products',categoryId} | {name:'edit',productId}` + `searchOpen`, `createOpen`, `createCategoryId`, `createBarcode`. Keep capability load + gating (hide ＋Add unless `canCreateProduct`). Wire CategoryGrid→ProductTileGrid→ProductEditView + ProductSearchOverlay + ProductCreateDialog (initialCategoryId/initialBarcode) + CategoryManagerDialog. Keep header count chips. Compute `productInCart` from `usePosStore` (as today). Edit view receives the same deactivate/stale/import handlers ProductModule already defines.
- [ ] typecheck+build clean. Commit.

### Task B9: `ProductCreateDialog` — default category/barcode, stable key, stock 0
**Files:** Modify `src/renderer/components/products/ProductCreateDialog.tsx`. (IPC path is KNOWN: `pos.module.ts` → `apiClient.createProductVariant()`; no discovery.)
- [ ] Props `initialCategoryId?: string|null`, `initialBarcode?: string`. In the open-effect seed `setCategoryId(initialCategoryId ?? '')`, `setBarcode(initialBarcode ?? '')`, **`setStockQty('0')`** (was '1'), and **generate one idempotency key into state on open** (`makeIdempotencyKey()` in the open-effect), reused by submit — not a fresh key per click.
- [ ] In `handleSubmit`, pass the dialog-open key (not a new one) and include `sellBy`. Read success as `result.data.variant` (response `{ product, variant, serverTime }`).
- [ ] typecheck+build clean. Commit.

### Task B10: Retire `ProductTable`/`ProductToolbar` (KEEP `ProductDetailDrawer`), update static test
**Files:** Delete `ProductTable.tsx`, `ProductToolbar.tsx` after confirming no external importers. Modify `tests/product-module-static.test.ts`. **Do NOT delete `ProductDetailDrawer.tsx`** until B7 parity is verified on-device (§ gate); leave it in place this round.
- [ ] Confirm no importers (`findstr /s /n "ProductTable\|ProductToolbar" C:\POS-zira\src`).
- [ ] Update static test to assert new shell composition (CategoryGrid/ProductTileGrid/ProductEditView/ProductSearchOverlay). `npx vitest run tests/product-module-static.test.ts` → PASS.
- [ ] Delete the two files; `npm run typecheck:renderer` + `npm run build:renderer` clean. Commit.

---

# PART C — Workspace, build, smoke

### Task C0: Feature branch / workspace (app worker)
- [ ] Do NOT edit the main checkout directly. Create branch `feat/products-tab-redesign` (ideally a git worktree) in `C:\POS-zira`; confirm with Paul before first edit.

### Task C1: Full renderer verify
- [ ] `npm run typecheck:renderer` clean; `npm run build:renderer` clean; `npx vitest run` (products tests green, no new failures).

### Task C2: Device smoke (manual, off business hours, coordinate)
- [ ] Drill-down + colours; search by name/SKU; scan known EAN → edit; scan dup (synthetic) → "Trùng mã EAN" list; scan unknown → create prefilled; create from inside category (category preselected, stock 0) → after backend live, appears + syncs to another POS; edit price/VAT/category/kg-pcs (OCC) + stock recount; print label; import draft; deactivate (in-cart guard).

---

## Self-Review (vs corrected spec)
- Ownership split → Part A header + B/C split. ✓
- Idempotency header canonical + `product_admin_create_requests` + fallback rule → A1/A3/A4. ✓
- Atomic create+stock + replay-no-silent-success → A3 + A5 tests. ✓
- sellBy explicit + un-strip + type → A2 + B0. ✓
- DTO optional key + `@Min(1)` + `@Headers` + service resolved key → A2/A3/A4. ✓
- Backend tests list → A5. ✓
- B0 added; stable per-open key; stock default 0; known IPC; success `{product,variant,serverTime}` → B0/B9. ✓
- UI gates: keep ProductDetailDrawer (B10), getByBarcode scan semantics (B2/B6), category sort (B5), typecheck:renderer (Global + every B + C1). ✓
- Type consistency: `stockColor`, `resolveScan` kinds, `ProductAdminCreateProductInput.sellBy`, `createProductVariant` body, `{product,variant,serverTime}` used consistently. ✓
