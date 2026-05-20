# Product Module Implementation Plan

> This plan is based on `docs/2026-05-20-product-module-research-spec.md`. It is a staged implementation plan, not completed work. Use the checklist as the source of truth when coding.

**Goal:** Add a new "Products" module for small retail operators to find, add, edit, restock, deactivate, and label products without needing to understand POS internals.

**Key constraint:** The backend catalog is the source of truth. The client may read the local SQLite mirror and may reuse the existing offline-first draft import flow, but it must not invent a separate local-only product administration store. Product edits that require backend mutations must wait for backend endpoints or be implemented with a server change request first.

**Architecture:** Add a Products tab in the main app. Start with a safe read/list/search surface backed by existing `product_variants`, `categories`, `draft_products`, `masterCatalog.scanCreate`, and quick-add APIs. Then add backend-backed product mutations through typed `api-client` methods, IPC handlers, preload bridge, and renderer forms. After every successful mutation, refresh the product mirror and emit `pos:products-synced`.

**Tech Stack:** Electron main process, React renderer, TypeScript, Tailwind CSS, sql.js local mirror, existing POS product sync, Vitest, Vite.

---

## Implementation Status

Completed in the desktop client on 2026-05-20:

- Phase 0: backend mutation contract request was created because product-admin mutation endpoints are not confirmed in this repo.
- Phase 0 follow-up: backend contract was expanded with auth/tenant rules, response envelopes, money/concurrency/idempotency requirements, sync/audit requirements, an acceptance checklist, and a companion OpenAPI spec.
- Phase 1: Products tab, entitlement key, sidebar entry, routing, and EN/VI/PL translations.
- Phase 2: product list/search/filter UI backed by the existing local product, category, and draft mirrors.
- Phase 3: read-only detail drawer with the backend-support warning preserved.
- Phase 4: barcode-first open-existing / lookup-draft / import-draft flow using existing APIs.
- Phase 8: one-label print entry from the product drawer, wired through the existing `HardwareModule.printLabel()` path.
- Product-admin capability probe: desktop now checks `/api/v1/warehouse/product-admin/capabilities` through IPC/preload and fails closed when the endpoint or auth is unavailable.
- Product-admin client plumbing: typed API client, IPC, preload, and Electron declarations now exist for create/update/deactivate/stock/category mutations, but renderer mutation UI stays disabled until backend capabilities are true.
- Phase 5 partial: stock adjustment dialog is wired to `pos.productAdmin.adjustStock`, validates quantity/reason, uses an idempotency key, and is enabled only when `canAdjustStock` is true.
- Phase 9 partial: static contract tests plus existing catalog/sync tests and renderer/main typechecks.

Blocked until backend support lands:

- Phase 6 normal product update/deactivate.
- Phase 7 category create/update.

These blocked phases must stay disabled until `/api/v1/warehouse/product-admin/capabilities` reports the needed capability and the mutation endpoints in the server change request are available.

---

## Scope Guard

This plan implements:

- A sidebar tab named `Products`.
- Product list/search/filter UI suitable for non-technical shop operators.
- Barcode-first add/import flow.
- Product detail/edit drawer.
- Stock adjustment flow with explicit reason.
- Product deactivate/hide flow, not hard delete.
- Category picker and simple category create/update once backend supports it.
- Label-print entry point using existing label printer capability where possible.
- Tests and verification for renderer type safety and catalog refresh behavior.

Do not implement:

- A separate local catalog database outside `product_variants` / `draft_products`.
- Direct local SQLite edits as the final source of truth for normal product edits.
- Hard delete for products that may appear in orders, refunds, receipts, invoices, or fiscal payloads.
- A full variant matrix editor in the first slice.
- CSV import/export in the first slice.
- Product translation editing in the first slice.
- Any receipt/fiscal name localization change. `name_translations` remains display-only.

## Existing Contracts To Preserve

- Money is stored and compared in integer grosze. Decimal PLN is only UI input/output.
- Canonical `name` is used for orders, receipts, fiscal payloads, and invoice matching.
- `name_translations` is display-only.
- `ProductSync.deltaSync()` and the 30 second catalog poll remain the product refresh mechanism.
- `pos:products-synced` must preserve the user's current search/filter context.
- Draft import remains offline-first: local sellable variant first, then `local_variant_imports` reconciliation to a server variant.
- Orders containing unresolved local-only variant ids must not be pushed until reconciliation maps them to server ids.

## Phase 0: Backend Contract Gate

**Files:**
- Create: `docs/server-change-requests/2026-05-20-product-module-mutations.md`

- [ ] **Step 1: Confirm mutation endpoints**

Check whether the backend already exposes endpoints for:

- Create product/variant with idempotency key.
- Update product/variant fields: name, barcode, SKU, category, VAT, price gross, sale unit, image, active.
- Duplicate barcode/SKU validation per salon/location.
- Stock adjustment with reason and idempotency key.
- Category create/update.
- Fresh product payload return or guaranteed delta sync visibility.

- [ ] **Step 2: Stop if endpoints are missing**

If these endpoints are missing or uncertain, create `docs/server-change-requests/2026-05-20-product-module-mutations.md` before coding mutation UI. The request must define routes, request/response JSON, idempotency rules, error codes, socket/sync behavior, and how payloads map to `ProductVariantRow`.

- [ ] **Step 3: Allow only safe client work before backend is ready**

Before backend mutation support, client implementation may include:

- Product tab shell.
- Product list/search/filter.
- Read-only detail drawer.
- Existing draft import by barcode.
- Existing quick-add camera flow.
- Existing manual sync.

It must not ship fake edit/save buttons that silently modify only local SQLite.

## Phase 1: Product Tab Shell

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/i18n/translations.ts`
- Create: `src/renderer/components/products/ProductModule.tsx`

- [ ] **Step 1: Add feature and tab types**

Add `products` to `FeatureKey` and `Tab` in `src/shared/types.ts`. Add default entitlement values in both shared defaults and renderer `DEFAULT_ENTITLEMENTS`. Keep products enabled by default for offline/local use unless SuperAdmin entitlement data explicitly disables it later.

- [ ] **Step 2: Add sidebar entry**

Add a Products item in the Sales group in `Sidebar.tsx`, using a clear inventory/product icon from `lucide-react`, such as `Package` or `Boxes`.

- [ ] **Step 3: Route the tab**

Import and render `ProductModule` in `App.tsx`. Add it to `TAB_TO_FEATURE`, `visibleTabs`, and the tab rendering block.

- [ ] **Step 4: Add translation keys**

Add at least EN, VI, and PL keys for:

- `sidebar.products`
- `products.title`
- `products.subtitle`
- `products.searchPlaceholder`
- `products.addProduct`
- `products.scanBarcode`
- `products.sync`
- `products.filters.*`
- `products.empty`
- `products.loading`
- `products.error`

Other languages can use English fallback if the existing translation policy allows it, but do not leave visible raw keys in EN/VI/PL.

- [ ] **Step 5: Build shell**

Create `ProductModule.tsx` as an operational light UI, not a marketing page. The first view should be the working product list, not an intro screen.

## Phase 2: Read/List/Search MVP

**Files:**
- Create: `src/renderer/hooks/useProducts.ts`
- Create: `src/renderer/components/products/ProductToolbar.tsx`
- Create: `src/renderer/components/products/ProductTable.tsx`
- Create: `src/renderer/components/products/ProductStatusBadge.tsx`
- Modify: `src/renderer/components/products/ProductModule.tsx`

- [ ] **Step 1: Add product hook**

Create `useProducts.ts` that loads:

- `window.electronAPI.pos.products.getAll()`
- `window.electronAPI.pos.categories.getAll()`
- `window.electronAPI.pos.draftProducts.getAll()` for draft indicators/search if needed

Subscribe to:

- `pos.sync.onProductsSynced`
- `pos.sync.onCatalogUpdated`
- `pos.sync.onStockUpdated`
- `pos.sync.onDraftProductsSynced`

Reload through the current search/filter state, not by resetting to the full list.

- [ ] **Step 2: Add search behavior**

Search should support name, barcode, SKU, and category in the Products module. This is different from the retail sale screen, where search is intentionally code-only. Use `pos.products.search(query)` for operator browsing and `pos.products.searchByCode(query)` for barcode-first flows.

- [ ] **Step 3: Add filters**

Implement filters:

- All.
- Low stock.
- Out of stock.
- No price.
- Draft/unimported.
- Inactive only after backend/local read support exists.
- Category.

Do not hide critical bad data. Products with price `0` or no barcode should be easy to find.

- [ ] **Step 4: Add table/list UI**

Rows show:

- Product name, image thumbnail or neutral placeholder.
- Price gross formatted from grosze.
- Stock/available quantity.
- Barcode and SKU.
- Category.
- VAT.
- Status: active, out of stock, no price, draft, pending sync.

Rows must be easy to tap. Important controls should have at least 44 x 44 px targets.

- [ ] **Step 5: Add manual refresh**

Wire a visible refresh/sync button to `window.electronAPI.pos.sync.products()`. Show syncing, success, no-auth, and failure states in plain language.

## Phase 3: Product Detail Drawer

**Files:**
- Create: `src/renderer/components/products/ProductDetailDrawer.tsx`
- Create: `src/renderer/components/products/ProductFormFields.tsx`
- Modify: `src/renderer/components/products/ProductModule.tsx`

- [ ] **Step 1: Add read-only detail drawer first**

Clicking a row opens a right-side drawer showing:

- Name.
- Price gross.
- VAT.
- Stock.
- Barcode.
- SKU.
- Category.
- Image.
- Sale unit.
- Updated time.
- Canonical/display translation note if `name_translations` exists.

Before backend mutation support, make fields read-only and show a clear "Editing requires product management backend support" message only where relevant.

- [ ] **Step 2: Add edit mode only after backend endpoints exist**

When backend mutation endpoints are confirmed, enable edit mode for safe fields:

- Name.
- Gross price.
- VAT.
- Barcode.
- SKU.
- Category.
- Sale unit.
- Active/ngung ban.

Do not include direct stock edits in this form. Stock changes go through the stock adjustment dialog.

- [ ] **Step 3: Validate before submit**

Validation rules:

- Name is required.
- Price must be positive to mark as sellable.
- VAT must be one of supported rates.
- Barcode and SKU duplicate errors must be caught and explained in user language.
- Money must be rounded once to grosze at the boundary.

- [ ] **Step 4: Protect unsaved changes**

If the operator closes the drawer with dirty fields, show a simple confirm. Do not silently discard.

## Phase 4: Barcode-First Add Product

**Files:**
- Create: `src/renderer/components/products/ProductAddFlow.tsx`
- Modify: `src/renderer/components/products/ProductModule.tsx`
- Reuse where practical:
  - `src/renderer/components/pos/QuickAddCameraModal.tsx`
  - `src/renderer/components/pos/ScanImportModal.tsx`

- [ ] **Step 1: Start with barcode input**

The add flow starts with a large input and scanner focus:

1. Scan or enter barcode.
2. If existing sellable product exists, open its detail drawer.
3. If matching draft exists, show preview and import action.
4. If online lookup finds a master-catalog draft, show preview and import action.
5. If no match exists and backend create endpoint is unavailable, route to quick-add camera or show the server requirement.

- [ ] **Step 2: Reuse existing offline-first draft import**

For draft import, call `window.electronAPI.pos.masterCatalog.importDraft({ ean })`. This must preserve `local_variant_imports` behavior and must not bypass the reconciler.

- [ ] **Step 3: Reuse existing scan-create where safe**

For online barcode create/restock where the server supports it, call `masterCatalog.scanCreate` with:

- `ean`
- `retailPrice`
- `stockQty`
- `taxRate`
- `idempotencyKey`

After success, run product sync or rely on the main handler's post-create sync, then refresh the visible list.

- [ ] **Step 4: Add manual product create only with backend mutation support**

If the product is truly unknown and the user wants manual create, require backend create endpoint. The create form must collect:

- Name.
- Barcode.
- Gross price.
- Initial stock.
- VAT default.
- Category optional.

SKU should auto-generate or be optional.

## Phase 5: Stock Adjustment

**Files:**
- Create: `src/renderer/components/products/StockAdjustmentDialog.tsx`
- Modify: `src/main/network/api-client.ts`
- Modify: `src/main/modules/pos.module.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/preload/preload-pos.ts`
- Modify: `src/shared/electron.d.ts`

- [ ] **Step 1: Add backend API wrapper**

After backend contract exists, add typed `apiClient.adjustProductStock()` with idempotency key and reason.

Request shape should include:

- `variantId`
- `mode`: receive, recount, damage, loss, return
- `quantity` or `newQuantity`
- `reason`
- `idempotencyKey`

- [ ] **Step 2: Add IPC/preload bridge**

Expose `window.electronAPI.pos.productAdmin.adjustStock(payload)` or a similar clearly named namespace. Keep it separate from read-only `pos.products`.

- [ ] **Step 3: Add dialog**

Dialog modes:

- "Nhap them hang": increment.
- "Kiem lai ton": set actual count.
- "Hong / mat": decrement with reason.
- "Tra hang": adjustment with reason.

Show before/after quantity before submit. For large negative changes, require confirm.

- [ ] **Step 4: Refresh after mutation**

After successful stock mutation:

- Upsert returned product row if response includes it, or run `pos.sync.products()`.
- Emit or rely on `pos:products-synced`.
- Refresh list without resetting filters.

## Phase 6: Product Update And Deactivate

**Files:**
- Modify: `src/main/network/api-client.ts`
- Modify: `src/main/modules/pos.module.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/preload/preload-pos.ts`
- Modify: `src/shared/electron.d.ts`
- Modify: `src/renderer/components/products/ProductDetailDrawer.tsx`

- [ ] **Step 1: Add update API wrapper**

Add `apiClient.updateProductVariant()` or backend-aligned naming. Normalize response through the same boundary rules used by product sync:

- Decimal PLN from server -> grosze.
- camelCase/snake_case accepted.
- translations stored as JSON text only for display.

- [ ] **Step 2: Add deactivate API wrapper**

Deactivate/ngung ban must not hard delete. The UI label should be "Ngung ban" / "Hide from POS", not "Delete".

- [ ] **Step 3: Add IPC/preload bridge**

Expose:

- `productAdmin.update(payload)`
- `productAdmin.deactivate(id)`

Use explicit result shape:

```ts
{ ok: boolean; product?: Product; error?: string; code?: string }
```

- [ ] **Step 4: Wire drawer save**

Save only dirty fields. Disable the save button while saving. Show success/failure inline in the drawer.

- [ ] **Step 5: Duplicate handling**

For duplicate barcode/SKU, show the existing product name if server returns it:

"Ma vach nay da dung cho Coca 500ml. Mo san pham do?"

## Phase 7: Categories

**Files:**
- Create: `src/renderer/components/products/CategoryManagerDialog.tsx`
- Modify: `src/renderer/components/products/ProductFormFields.tsx`
- Modify backend API/IPC files from Phase 6 as needed.

- [ ] **Step 1: Add create category from product form**

If operator cannot find a category, allow creating one inline without leaving the product form.

- [ ] **Step 2: Add simple category manager**

Support:

- Name.
- Color/icon optional.
- Sort order optional.
- Active/hide only if backend supports it.

- [ ] **Step 3: Refresh category list**

After category mutation, refresh categories and product list while preserving the current product filter.

## Phase 8: Label Printing Entry Point

**Files:**
- Modify: `src/renderer/components/products/ProductDetailDrawer.tsx`
- Add/modify main IPC only if existing label print IPC is insufficient.

- [ ] **Step 1: Check existing label print capabilities**

Find the current label print IPC/job path before adding anything new. Do not duplicate printer code.

- [ ] **Step 2: Add "Print label" action**

If barcode exists, allow printing one label from the product drawer. If barcode is missing, disable action with a clear reason.

- [ ] **Step 3: Do not implement batch labels in MVP**

Batch label printing is a later slice.

## Phase 9: Tests And Verification

**Files:**
- Add tests where implementation touches behavior.

- [ ] **Step 1: Add product module hook/model tests**

Cover:

- Current filter preserved on `pos:products-synced`.
- Price parser stores grosze.
- Search merges name and code results without duplicates if a local helper is introduced.
- Draft rows are labeled as draft and not treated as sellable variants.

- [ ] **Step 2: Add renderer smoke/static tests**

Cover:

- Products tab is present in `Tab`, `FeatureKey`, `TAB_TO_FEATURE`, and sidebar menu.
- Reserved local-only mutation warning is not present once backend mutation path is implemented.
- Touch target classes or button dimensions are not obviously tiny for primary actions.

- [ ] **Step 3: Run typecheck**

Run:

```powershell
npm run typecheck:renderer
```

Expected: pass.

- [ ] **Step 4: Run focused tests**

Run product-related tests that were added. Also run existing catalog/sync tests if present:

```powershell
npm test -- tests/retail-sync-respects-filter.test.ts
```

Expected: pass. If that exact file is absent in this worktree, run the closest product/catalog sync tests.

- [ ] **Step 5: Run full build for final slice**

Run:

```powershell
npm run build
```

Expected: pass.

- [ ] **Step 6: Manual check**

Run the app and verify:

- Products tab opens.
- Search by barcode/SKU/name works.
- Category filter works.
- Manual sync does not reset the filter.
- Existing product row opens detail drawer.
- Draft barcode import uses existing offline-first flow.
- Successful product add/edit appears in POS sale grid without restart.
- Deactivated product does not appear in sale grid but old order history still renders.

## Suggested Implementation Order

1. Phase 0 server contract check.
2. Phase 1 tab shell.
3. Phase 2 read/list/search MVP.
4. Phase 3 read-only detail drawer.
5. Phase 4 barcode-first add using existing draft/quick-add flows.
6. Backend mutation implementation if endpoints exist.
7. Phase 5 stock adjustment.
8. Phase 6 update/deactivate.
9. Phase 7 categories.
10. Phase 8 label action.
11. Phase 9 verification.

## First Coding Slice Recommendation

The first safe coding slice should be Phases 1-3 plus the safe parts of Phase 4:

- Add Products tab.
- Add product list/search/filter.
- Add read-only detail drawer.
- Add barcode-first "open existing or import draft" flow.
- Reuse existing quick-add camera button if it can be cleanly reused.

Do not implement normal edit/save until the backend mutation contract is confirmed. That avoids a brittle local workaround and keeps the POS catalog consistent across terminals.
