# Kitchen Category Admin Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Kitchen Self-Order/category Settings lag by batching category order persistence, removing per-category catalog syncs, and making kitchen visibility explicitly local-only until backend supports it.

**Architecture:** Category ordering remains backend-owned through `categories.display_order` / local `categories.sort_order`, but the app sends order changes through one renderer-to-main IPC call and emits catalog refresh events once. `kitchen_print` is not a backend field today, so the app must stop sending `kitchenPrint` to product-admin PATCH and persist that flag only in the local SQLite mirror with honest UI copy. Backend batch/concurrency support is out of scope for this app-only pass.

**Tech Stack:** Electron IPC, React 18 renderer, TypeScript, local SQLite repo layer, Vitest static/contract tests.

---

## Contract Review

Backend answer is enough for an app-side improvement plan.

The important facts:

- `PATCH /api/v1/warehouse/product-admin/categories/:categoryId` supports `sortOrder`, mapping to backend `categories.display_order`.
- `kitchenPrint` is not supported by current backend DTO/entity/database.
- Global validation rejects unknown fields, so sending `kitchenPrint` to the current category PATCH should 400.
- Category update has no optimistic concurrency and can race.
- Category-only updates do not reliably surface through POS product delta sync, because product delta filters product/template timestamps, not category timestamps.
- There is no safe POS batch endpoint today.

Therefore:

- Reorder can be improved app-side by batching existing single-category PATCH calls and running sync/notify once.
- Kitchen visibility cannot honestly be treated as shared backend state. It is local machine state until backend adds a real category field/sync surface.
- The current app code that sends `{ name, kitchenPrint }` and `{ name, sortOrder }` is weak: `name` risks stale rename overwrites, and `kitchenPrint` violates backend contract.

## File Structure

- Modify `src/shared/types.ts`
  - Add narrow IPC payload/response types for category order batch and local kitchen visibility.
  - Add IPC channel constants.
  - Loosen or split category update typing so PATCH-only payloads do not require stale `name`.

- Modify `src/shared/electron.d.ts`
  - Expose new renderer APIs under `window.electronAPI.pos.productAdmin.updateCategoryOrder(...)` and `window.electronAPI.pos.kitchenCategories.setPrintEnabled(...)`.

- Modify `src/preload/preload.ts`
  - Wire new IPC channels for the main app window.

- Modify `src/preload/preload-pos.ts`
  - Wire the same IPC channels for POS-specific windows if they can render Settings/POS components.

- Modify `src/main/database/repos/product-repo.ts`
  - Add transaction-friendly helpers for multiple `sort_order` updates and local `kitchen_print` updates.

- Modify `src/main/modules/pos.module.ts`
  - Add a batch order handler that validates product-admin capability once, PATCHes changed category `sortOrder` values without stale `name`, mirrors local SQLite once, and emits renderer notifications once.
  - Add a local-only kitchen visibility handler that updates local SQLite without backend calls.
  - Keep existing single `updateCategory` handler for Product Admin category edits, but stop relying on it for kitchen print and ranking controls.

- Modify `src/renderer/components/pos/CategoryRankingSettings.tsx`
  - Replace per-category `productAdmin.updateCategory` loop with one `productAdmin.updateCategoryOrder` call.
  - Keep existing debounce and manual save UX.

- Modify `src/renderer/components/pos/KitchenPrintSettings.tsx`
  - Replace `productAdmin.updateCategory(... kitchenPrint ...)` with local-only `kitchenCategories.setPrintEnabled`.
  - Replace reorder persistence loop with `productAdmin.updateCategoryOrder`.
  - Add concise owner-facing copy that this kitchen visibility is local to this POS until backend support exists.

- Modify `tests/category-ranking-settings-static.test.ts`
  - Guard that ranking uses batch IPC and does not send stale `name`.

- Modify `tests/kitchen-ticket.test.ts`
  - Update stale static assertions that currently claim backend-synced `kitchenPrint`.
  - Guard that kitchen visibility uses local-only IPC and category order uses batch persistence.

---

### Task 1: Lock The Current Contract In Tests

**Files:**
- Modify: `tests/category-ranking-settings-static.test.ts`
- Modify: `tests/kitchen-ticket.test.ts`

- [ ] **Step 1: Update CategoryRankingSettings static test expectations**

In `tests/category-ranking-settings-static.test.ts`, add a test that fails against the current per-category loop:

```ts
it('persists ranking through one batch IPC call without stale category names', () => {
  expect(source).toContain('updateCategoryOrder');
  expect(source).not.toContain('productAdmin.updateCategory(cat.id');
  expect(source).not.toContain('name: cat.name');
});
```

- [ ] **Step 2: Update kitchen category static tests**

In `tests/kitchen-ticket.test.ts`, replace the stale "keeps the kitchen flag synced" assertions with local-only contract assertions:

```ts
it('keeps kitchen visibility local-only and persists order through the product-admin order batch', () => {
  const posModuleSource = readSource('src/main/modules/pos.module.ts');
  const repoSource = readSource('src/main/database/repos/product-repo.ts');
  const kitchenSettingsSource = readSource('src/renderer/components/pos/KitchenPrintSettings.tsx');

  expect(posModuleSource).toContain('POS_KITCHEN_CATEGORY_SET_PRINT_ENABLED');
  expect(posModuleSource).toContain('POS_PRODUCT_ADMIN_CATEGORIES_UPDATE_ORDER');
  expect(repoSource).toContain('setCategoryKitchenPrint(categoryId: string, enabled: boolean)');
  expect(repoSource).toContain('setCategorySortOrders');
  expect(kitchenSettingsSource).toContain('kitchenCategories.setPrintEnabled');
  expect(kitchenSettingsSource).toContain('productAdmin.updateCategoryOrder');
  expect(kitchenSettingsSource).not.toContain('kitchenPrint: next');
});
```

- [ ] **Step 3: Run targeted tests and confirm failure**

Run:

```powershell
npm test -- --run tests/category-ranking-settings-static.test.ts tests/kitchen-ticket.test.ts
```

Expected: FAIL because `updateCategoryOrder`, `POS_KITCHEN_CATEGORY_SET_PRINT_ENABLED`, and `kitchenCategories.setPrintEnabled` do not exist yet.

---

### Task 2: Add Shared IPC Types And Preload Surface

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/electron.d.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/preload/preload-pos.ts`

- [ ] **Step 1: Add shared payload/response types**

In `src/shared/types.ts`, add near existing `ProductAdminCategoryMutationInput`:

```ts
export interface ProductAdminCategoryOrderUpdate {
  id: string;
  sortOrder: number;
}

export interface ProductAdminCategoryOrderUpdateResponse {
  categories: ProductAdminCategory[];
  updated: number;
  serverTime?: string;
}

export interface KitchenCategoryPrintUpdateResponse {
  categoryId: string;
  kitchenPrint: boolean;
}
```

Then change category mutation typing so PATCH callers do not need stale names:

```ts
export interface ProductAdminCategoryMutationInput {
  name?: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number | null;
  isActive?: boolean | null;
  expectedUpdatedAt?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
}
```

Create-category code must still provide a name at runtime; this plan does not add speculative backend validation.

- [ ] **Step 2: Add IPC channel constants**

In `src/shared/types.ts`, extend `IPC_CHANNELS`:

```ts
POS_PRODUCT_ADMIN_CATEGORIES_UPDATE_ORDER: 'pos:product-admin:categories:update-order',
POS_KITCHEN_CATEGORY_SET_PRINT_ENABLED: 'pos:kitchen-category:set-print-enabled',
```

- [ ] **Step 3: Update Electron API declaration**

In `src/shared/electron.d.ts`, update `pos.productAdmin`:

```ts
updateCategoryOrder: (
  updates: import('./types').ProductAdminCategoryOrderUpdate[],
) => Promise<import('./types').ProductAdminIpcResult<import('./types').ProductAdminCategoryOrderUpdateResponse>>;
```

Add a sibling under `pos`:

```ts
kitchenCategories: {
  setPrintEnabled: (
    categoryId: string,
    enabled: boolean,
  ) => Promise<{ ok: boolean; data?: import('./types').KitchenCategoryPrintUpdateResponse; error?: string }>;
};
```

- [ ] **Step 4: Wire main preload**

In `src/preload/preload.ts`, import the new types if needed and add:

```ts
updateCategoryOrder: (updates: ProductAdminCategoryOrderUpdate[]) =>
  ipcRenderer.invoke(IPC_CHANNELS.POS_PRODUCT_ADMIN_CATEGORIES_UPDATE_ORDER, updates),
```

Under `pos`, add:

```ts
kitchenCategories: {
  setPrintEnabled: (categoryId: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.POS_KITCHEN_CATEGORY_SET_PRINT_ENABLED, categoryId, enabled),
},
```

- [ ] **Step 5: Wire POS preload**

In `src/preload/preload-pos.ts`, add the same APIs using literal channel strings:

```ts
updateCategoryOrder: (updates: any[]) =>
  ipcRenderer.invoke('pos:product-admin:categories:update-order', updates),
```

And:

```ts
kitchenCategories: {
  setPrintEnabled: (categoryId: string, enabled: boolean) =>
    ipcRenderer.invoke('pos:kitchen-category:set-print-enabled', categoryId, enabled),
},
```

- [ ] **Step 6: Run type/static tests**

Run:

```powershell
npm test -- --run tests/category-ranking-settings-static.test.ts tests/kitchen-ticket.test.ts
```

Expected: still FAIL because main handlers and renderer calls are not implemented yet.

---

### Task 3: Add Local Repo Helpers

**Files:**
- Modify: `src/main/database/repos/product-repo.ts`

- [ ] **Step 1: Add batch sort-order helper**

In `productRepo`, add next to `setCategorySortOrder`:

```ts
setCategorySortOrders(updates: Array<{ id: string; sortOrder: number }>): void {
  if (updates.length === 0) return;
  database.transaction(() => {
    for (const update of updates) {
      database.run(
        'UPDATE categories SET sort_order = ? WHERE id = ?',
        [update.sortOrder, update.id],
      );
    }
  });
},
```

- [ ] **Step 2: Keep single kitchen print helper**

Leave the existing helper in place:

```ts
setCategoryKitchenPrint(categoryId: string, enabled: boolean): void {
  database.run(
    'UPDATE categories SET kitchen_print = ? WHERE id = ?',
    [enabled ? 1 : 0, categoryId],
  );
},
```

- [ ] **Step 3: Run targeted tests**

Run:

```powershell
npm test -- --run tests/kitchen-ticket.test.ts
```

Expected: still FAIL until main handlers and renderer calls are wired.

---

### Task 4: Add Main Process Batch And Local-Only Handlers

**Files:**
- Modify: `src/main/modules/pos.module.ts`

- [ ] **Step 1: Add a validation helper inside POS IPC registration scope**

Near product-admin handlers in `src/main/modules/pos.module.ts`, add:

```ts
const normalizeCategoryOrderUpdates = (
  input: unknown,
): ProductAdminCategoryOrderUpdate[] => {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const updates: ProductAdminCategoryOrderUpdate[] = [];
  for (const raw of input) {
    const id = String((raw as any)?.id || '').trim();
    const sortOrder = Math.floor(Number((raw as any)?.sortOrder));
    if (!id || !Number.isFinite(sortOrder) || sortOrder < 0 || seen.has(id)) continue;
    seen.add(id);
    updates.push({ id, sortOrder });
  }
  return updates;
};
```

- [ ] **Step 2: Add batch order IPC handler**

Add after the single category update handler:

```ts
ipcMain.handle(
  IPC_CHANNELS.POS_PRODUCT_ADMIN_CATEGORIES_UPDATE_ORDER,
  async (_e, input: ProductAdminCategoryOrderUpdate[]) => {
    const updates = normalizeCategoryOrderUpdates(input);
    if (updates.length === 0) {
      return {
        ok: true,
        data: { categories: [], updated: 0 },
      } as ProductAdminIpcResult<ProductAdminCategoryOrderUpdateResponse>;
    }

    const token = getSecureAuthToken();
    if (!token) {
      return { ok: false, error: 'no-auth', code: 'UNAUTHORIZED_PRODUCT_ADMIN' }
        as ProductAdminIpcResult<ProductAdminCategoryOrderUpdateResponse>;
    }

    try {
      const capabilities = await apiClient.getProductAdminCapabilities(token);
      if (capabilities.canUpdateCategory !== true) {
        return { ok: false, error: 'unsupported-capability', code: 'UNSUPPORTED_CAPABILITY' }
          as ProductAdminIpcResult<ProductAdminCategoryOrderUpdateResponse>;
      }

      const categories: ProductAdminCategory[] = [];
      for (const update of updates) {
        const response = await apiClient.updateProductAdminCategory(token, update.id, {
          sortOrder: update.sortOrder,
        });
        if (response?.category) categories.push(response.category);
      }

      productRepo.setCategorySortOrders(updates);
      database.markDirty();
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_PRODUCTS_SYNCED);
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_CATALOG_UPDATED, {
        source: 'product_admin_category_order_local_mirror',
      });

      return {
        ok: true,
        data: {
          categories,
          updated: updates.length,
          serverTime: categories[categories.length - 1]?.updatedAt,
        },
      } as ProductAdminIpcResult<ProductAdminCategoryOrderUpdateResponse>;
    } catch (err: any) {
      logger.warn(`[PosModule] product-admin update category order failed: ${err?.message ?? err}`);
      return toProductAdminError<ProductAdminCategoryOrderUpdateResponse>(
        err,
        'update category order failed',
      );
    }
  },
);
```

This deliberately does not call `refreshProductsAfterProductAdminMutation` per category.

- [ ] **Step 3: Add local-only kitchen print IPC handler**

Add:

```ts
ipcMain.handle(
  IPC_CHANNELS.POS_KITCHEN_CATEGORY_SET_PRINT_ENABLED,
  async (_e, categoryId: string, enabled: boolean) => {
    const id = String(categoryId || '').trim();
    if (!id) return { ok: false, error: 'missing-category-id' };
    try {
      productRepo.setCategoryKitchenPrint(id, enabled === true);
      database.markDirty();
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_PRODUCTS_SYNCED);
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_CATALOG_UPDATED, {
        source: 'kitchen_category_local_mirror',
      });
      return {
        ok: true,
        data: { categoryId: id, kitchenPrint: enabled === true },
      };
    } catch (err: any) {
      logger.warn(`[PosModule] local kitchen category update failed: ${err?.message ?? err}`);
      return { ok: false, error: err?.message ?? 'local-kitchen-category-update-failed' };
    }
  },
);
```

- [ ] **Step 4: Remove stale-name payload from sort-only paths**

Do not change Product Manager's full category edit behavior yet. Only ranking/kitchen settings should stop sending `name` for sort-only changes.

- [ ] **Step 5: Run targeted tests**

Run:

```powershell
npm test -- --run tests/category-ranking-settings-static.test.ts tests/kitchen-ticket.test.ts
```

Expected: tests still FAIL until renderer components call the new APIs.

---

### Task 5: Convert POS Category Ranking To One Batch Save

**Files:**
- Modify: `src/renderer/components/pos/CategoryRankingSettings.tsx`

- [ ] **Step 1: Replace the persistence loop**

Replace the `for` loop inside `persistOrder` with:

```ts
const updates = targetOrder
  .map((cat, i) => ({ id: cat.id, sortOrder: i, previousSortOrder: cat.sort_order ?? 0 }))
  .filter((update) => update.previousSortOrder !== update.sortOrder)
  .map(({ id, sortOrder }) => ({ id, sortOrder }));

if (updates.length > 0) {
  const res: any = await window.electronAPI.pos.productAdmin.updateCategoryOrder(updates);
  if (res && res.ok === false) {
    const code = res.code || res.error;
    throw new Error(
      code === 'UNSUPPORTED_CAPABILITY'
        ? 'Tai khoan nay khong co quyen sua danh muc'
        : code === 'no-auth' || code === 'UNAUTHORIZED_PRODUCT_ADMIN'
        ? 'Chua dang nhap'
        : `Luu that bai: ${code}`,
    );
  }
}
written = updates.length;
```

Keep the existing post-success:

```ts
setOrdered((prev) => prev.map((c, i) => ({ ...c, sort_order: i })));
setDirty(false);
setSavedNote(written === 0 ? 'Khong co thay doi' : `Da luu ${written} danh muc`);
```

Use the existing mojibake strings if the file currently uses them; do not broaden this plan into an i18n cleanup.

- [ ] **Step 2: Run static test**

Run:

```powershell
npm test -- --run tests/category-ranking-settings-static.test.ts
```

Expected: PASS for category ranking static tests.

---

### Task 6: Convert Kitchen Print Settings To Local Toggle And Batch Order

**Files:**
- Modify: `src/renderer/components/pos/KitchenPrintSettings.tsx`

- [ ] **Step 1: Replace order persistence loop**

Inside `persistOrder`, replace the per-category `updateCategory` calls with:

```ts
const updates = nextCategories
  .map((category, index) => ({
    id: category.id,
    sortOrder: index,
    previousSortOrder: category.sort_order ?? 0,
  }))
  .filter((update) => update.previousSortOrder !== update.sortOrder)
  .map(({ id, sortOrder }) => ({ id, sortOrder }));

if (updates.length > 0) {
  const result = await window.electronAPI.pos.productAdmin.updateCategoryOrder(updates);
  if (!result || (result as any).error || (result as any).ok === false) {
    throw new Error((result as any)?.error || 'Update failed');
  }
}
```

Keep:

```ts
setCategories(nextCategories.map((category, index) => ({
  ...category,
  sort_order: index,
})));
```

- [ ] **Step 2: Replace backend kitchenPrint toggle**

Inside `toggle`, replace the `productAdmin.updateCategory` call with:

```ts
const result = await window.electronAPI.pos.kitchenCategories.setPrintEnabled(category.id, next);
if (!result || (result as any).error || (result as any).ok === false) {
  throw new Error((result as any)?.error || 'Update failed');
}
```

- [ ] **Step 3: Add honest local-only copy**

Near the Settings description, add a short operator-only line:

```tsx
<p className="mb-3 text-[11px] font-semibold text-amber-700">
  Kitchen visibility is saved on this POS only until backend category support is added.
</p>
```

Do not show this in the customer kiosk window.

- [ ] **Step 4: Run targeted tests**

Run:

```powershell
npm test -- --run tests/kitchen-ticket.test.ts tests/category-ranking-settings-static.test.ts
```

Expected: PASS.

---

### Task 7: Verify Kitchen Menu Refresh Behavior

**Files:**
- Modify: `tests/kitchen-self-order.test.ts` if existing static coverage is stale
- Modify: `tests/kitchen-self-order-contract.test.ts` if contract wording claims backend-owned `kitchenPrint`

- [ ] **Step 1: Search for stale contract claims**

Run:

```powershell
rg -n "kitchenPrint|kitchen_print|updateCategoryOrder|deltaSync|display_order|sortOrder" tests src docs -S
```

Expected: stale claims that `kitchenPrint` is backend-synced are limited to docs/tests already touched or consciously deferred.

- [ ] **Step 2: Adjust test wording only when it asserts false backend ownership**

If a test says backend owns `kitchenPrint`, replace with local mirror wording:

```ts
expect(source).toContain('POS_KITCHEN_CATEGORY_SET_PRINT_ENABLED');
expect(source).not.toContain('kitchenPrint: next');
```

- [ ] **Step 3: Run kitchen-related tests**

Run:

```powershell
npm test -- --run tests/kitchen-self-order-contract.test.ts tests/kitchen-self-order.test.ts tests/kitchen-ticket.test.ts tests/category-ranking-settings-static.test.ts
```

Expected: PASS.

---

### Task 8: Build And Manual Smoke Checklist

**Files:**
- No code changes unless verification exposes a defect.

- [ ] **Step 1: Run build**

Run:

```powershell
npm run build
```

Expected: PASS. Existing Browserslist or chunk-size warnings are acceptable if unchanged.

- [ ] **Step 2: Manual Settings smoke**

Run the app as usual, then:

1. Open Settings / Kitchen Self-Order panel.
2. Toggle one hidden category on.
3. Confirm it moves to visible immediately.
4. Confirm no backend validation error appears.
5. Move a visible category up/down.
6. Confirm the UI shows one save operation, not a long spinner per category.
7. Open Kitchen Self-Order window.
8. Confirm category-first screen reflects the new local visibility and order.

- [ ] **Step 3: Manual multi-terminal caveat**

On a second POS without backend `kitchenPrint` support:

1. Confirm the kitchen visibility toggle does not propagate.
2. Confirm POS category order does propagate after backend PATCH + regular catalog refresh.

Expected: this split is documented in the final note because it is a real backend-contract limitation.

---

## Success Criteria

- Reordering categories uses one renderer-to-main IPC call per save/drop, not one IPC call per changed category from the renderer.
- Main process checks product-admin capabilities once per batch.
- Main process does not run `deltaSync()` after each category PATCH.
- Renderer no longer sends stale `name` for sort-only changes.
- Renderer no longer sends unsupported `kitchenPrint` to product-admin category PATCH.
- Kitchen visibility toggle updates local SQLite and refreshes kiosk menu once.
- Targeted kitchen/category tests pass.
- `npm run build` passes.

## Known Limitations After This Plan

- Category reorder is still not atomic on the backend because backend has no safe batch endpoint.
- `kitchen_print` remains local-only and will not sync across machines.
- There is still no category concurrency protection; last writer wins for order.
- A proper backend fix should add official `categories.kitchen_print`, category sync/delta, and an atomic batch endpoint.

## Self-Review

- Spec coverage: The plan addresses the observed lag, backend contract mismatch, local mirror behavior, and verification.
- Placeholder scan: No implementation step relies on "TBD" or unspecified error handling.
- Type consistency: New shared types, preload APIs, main handlers, and renderer calls use the same `updateCategoryOrder` and `setPrintEnabled` names.

