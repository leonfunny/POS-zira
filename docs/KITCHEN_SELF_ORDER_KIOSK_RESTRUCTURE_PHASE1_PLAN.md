# Kitchen Self-Order & Self-Checkout Restructure — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `kitchen_print` the single source of truth for "what is food", cut the duplicate self-checkout `menu_kitchen` food path, and reorganize kiosk settings — logic/flow only, no visual redesign.

**Architecture:** Two independent kiosks. `kitchenSelfOrder` (food → kitchen ticket → counter-pay) gains an explicit `menuSource: 'all' | 'selected'` gate that replaces the ambiguous show-all fallback. `selfCheckout` collapses to grocery scan-first; its `menu_kitchen` profile, `DepartmentTabs`, and `getCategoryDepartment()` name-keyword classifier are removed. The `customer` display stops classifying food by name keywords and reads `kitchen_print`. Legacy persisted config (`selfCheckoutProfile='menu_kitchen'`, missing `menuSource`) is coerced/derived at runtime, never schema-narrowed.

**Tech Stack:** Electron + React + TypeScript, vitest. Repo: `C:\POS-zira` (winpc), branch `main`.

**Source spec:** `docs/KITCHEN_SELF_ORDER_KIOSK_RESTRUCTURE_DESIGN.md` (read it before starting).

## Global Constraints

- **Do NOT build into or release onto chesaigon. chesaigon = POS tab only.** (verbatim from spec §10)
- Develop + test on `winpc` against the test salon `owner+salon-test-kuchnia@test.local`.
- **No backend production deploy.** Backend `enail` needs **no schema change** — `categories.kitchen_print` + product-admin `updateCategory` already exist.
- **No visual/UX redesign in this phase** — that is Phase 2, a separate spec.
- **Do NOT narrow persisted config schemas** in a way that can crash machines holding old config. Keep accepting legacy values; coerce/derive at runtime.
- **Baseline-diff test discipline:** the suite carries known pre-existing failures. A task is green if it introduces **no new** failures vs the pre-change baseline — capture the baseline before Task 1 as a local scratch log, not a committed repo artifact.
- When deleting a component/helper, **grep its exact consumers first**; never delete blind.
- Test runner: `npx vitest run <file>` (single file) / `npx vitest run` (full). Type check: `npm run typecheck:renderer` and `npx tsc -p tsconfig.main.json --noEmit`.
- **Task order matters:** the self-checkout UI branch (Task 4) is removed before its catalog helpers are deleted (Task 5); deleting helpers while a consumer remains breaks the renderer typecheck.
- One concept, one commit. Each implementation task ends with a commit. Task 0 and Task 8 are verification gates; do not commit raw test-output artifacts.

---

## Task 0: Capture the test baseline (no code change)

**Files:** none (records a local scratch baseline only).

- [ ] **Step 1: Run the full suite and record pre-existing failures**

Run: `cd C:\POS-zira; npx vitest run 2>&1 | Tee-Object "$env:TEMP\pos-zira-phase1-baseline.txt"`
Expected: some known failures. Note the failing file::test names — these are the allowed baseline. Every later task compares against this list.

- [ ] **Step 2: Keep the baseline out of git**

Do not `git add` the raw baseline log. It is machine-local evidence for the implementation session; summarize the allowed failures in the final handoff/PR description instead.

---

## Task 1: Explicit `menuSource` gate in the kitchen menu service

Replace the ambiguous show-all fallback with an explicit `all | selected` resolver that derives safely from existing `kitchen_print` flags when config is absent/legacy.

**Files:**
- Modify: `src/shared/kitchen-self-order.ts` (define the shared resolver)
- Modify: `src/main/kitchen-self-order/menu-service.ts` (import and use the shared resolver)
- Modify: `src/main/config/store.ts` (add `kitchenSelfOrderMenuSource` to the schema — **no default**)
- Modify: `src/shared/types.ts` (add `kitchenSelfOrderMenuSource?: 'all' | 'selected'` to `AgentConfig`)
- Test (new): `tests/kitchen-self-order-menu-source.test.ts`

**Interfaces:**
- Produces in `src/shared/kitchen-self-order.ts`: `export function resolveKitchenSelfOrderMenuSource(config: { kitchenSelfOrderMenuSource?: string | null }, categories: Array<{ kitchen_print?: number | null }>): 'all' | 'selected'`
- Produces (unchanged signature): `buildKitchenSelfOrderMenu({ config, categories, products })` — its `config` now also reads `kitchenSelfOrderMenuSource`.

- [ ] **Step 1: Write the failing test**

Create `tests/kitchen-self-order-menu-source.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildKitchenSelfOrderMenu } from '../src/main/kitchen-self-order/menu-service';
import { resolveKitchenSelfOrderMenuSource } from '../src/shared/kitchen-self-order';

const flagged = [
  { id: 'drinks', name: 'Trà sữa', kitchen_print: 1 },
  { id: 'shelf', name: 'Đồ hộp', kitchen_print: 0 },
];
const products = [
  { id: 'p-tea', name: 'Trà sữa trân châu', category_id: 'drinks', retail_price: 1500, is_active: 1 },
  { id: 'p-can', name: 'Cá hộp', category_id: 'shelf', retail_price: 900, is_active: 1 },
];

describe('kitchen self-order menu source', () => {
  it('honors explicit all vs selected', () => {
    expect(resolveKitchenSelfOrderMenuSource({ kitchenSelfOrderMenuSource: 'all' }, flagged)).toBe('all');
    expect(resolveKitchenSelfOrderMenuSource({ kitchenSelfOrderMenuSource: 'selected' }, flagged)).toBe('selected');
  });

  it('derives from kitchen_print flags when config is missing/legacy', () => {
    expect(resolveKitchenSelfOrderMenuSource({}, flagged)).toBe('selected');
    expect(resolveKitchenSelfOrderMenuSource({ kitchenSelfOrderMenuSource: null }, flagged)).toBe('selected');
    expect(resolveKitchenSelfOrderMenuSource({ kitchenSelfOrderMenuSource: 'bogus' }, flagged)).toBe('selected');
    expect(resolveKitchenSelfOrderMenuSource({}, [{ id: 'a', name: 'A', kitchen_print: 0 }])).toBe('all');
    expect(resolveKitchenSelfOrderMenuSource({}, [])).toBe('all');
  });

  it('all shows every category; selected shows only flagged; selected-with-none is empty (never show-all)', () => {
    const all = buildKitchenSelfOrderMenu({ config: { kitchenSelfOrderMenuSource: 'all' }, categories: flagged, products });
    expect(all.categories.map((c) => c.id).sort()).toEqual(['drinks', 'shelf']);

    const selected = buildKitchenSelfOrderMenu({ config: { kitchenSelfOrderMenuSource: 'selected' }, categories: flagged, products });
    expect(selected.categories.map((c) => c.id)).toEqual(['drinks']);
    expect(selected.products.map((p) => p.id)).toEqual(['p-tea']);

    const noneFlagged = [{ id: 'x', name: 'X', kitchen_print: 0 }];
    const emptySelected = buildKitchenSelfOrderMenu({ config: { kitchenSelfOrderMenuSource: 'selected' }, categories: noneFlagged, products: [] });
    expect(emptySelected.categories).toEqual([]);
    expect(emptySelected.products).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/kitchen-self-order-menu-source.test.ts`
Expected: FAIL — `resolveKitchenSelfOrderMenuSource` is not exported from the shared module yet; `selected`-with-none currently returns all (old fallback).

- [ ] **Step 3: Implement the shared resolver and rewire `getKitchenCatalog`**

In `src/main/kitchen-self-order/menu-service.ts`:

Add `kitchenSelfOrderMenuSource` to the `KitchenSelfOrderMenuConfig` interface:
```ts
interface KitchenSelfOrderMenuConfig {
  // ...existing fields...
  kitchenSelfOrderMenuSource?: string | null;
}
```

In `src/shared/kitchen-self-order.ts`, add the exported resolver:
```ts
export function resolveKitchenSelfOrderMenuSource(
  config: { kitchenSelfOrderMenuSource?: string | null },
  categories: Array<{ kitchen_print?: number | null }>,
): 'all' | 'selected' {
  const explicit = config.kitchenSelfOrderMenuSource;
  if (explicit === 'all' || explicit === 'selected') return explicit;
  // Missing/legacy: preserve today's intent without leaking groceries.
  return categories.some((category) => category.kitchen_print === 1) ? 'selected' : 'all';
}
```

Import that resolver in `src/main/kitchen-self-order/menu-service.ts`, then replace the body of `getKitchenCatalog(...)` (currently keyed on `kitchenCategoryIds.size === 0 -> return all`) so it is driven by the resolver. It must now receive `config`:
```ts
function getKitchenCatalog(
  config: KitchenSelfOrderMenuConfig,
  categories: CategoryRow[],
  products: ProductVariantRow[],
): { categories: CategoryRow[]; products: ProductVariantRow[] } {
  if (resolveKitchenSelfOrderMenuSource(config, categories) === 'all') {
    return { categories, products };
  }
  const kitchenCategoryIds = new Set(
    categories.filter((category) => category.kitchen_print === 1).map((category) => category.id),
  );
  // 'selected' with no flags -> empty sets, NOT the whole catalog.
  return {
    categories: categories.filter((category) => kitchenCategoryIds.has(category.id)),
    products: products.filter((product) => !!product.category_id && kitchenCategoryIds.has(product.category_id)),
  };
}
```

In `buildKitchenSelfOrderMenu(...)`, update the call: `const catalog = getKitchenCatalog(config, categories, products);`

In `src/main/config/store.ts`, add to the config schema **without a default** (absent ⇒ resolver derives):
```ts
kitchenSelfOrderMenuSource: { type: 'string', enum: ['all', 'selected'] },
```

In `src/shared/types.ts`, add to `AgentConfig`:
```ts
kitchenSelfOrderMenuSource?: 'all' | 'selected';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/kitchen-self-order-menu-source.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/kitchen-self-order-menu-source.test.ts src/shared/kitchen-self-order.ts src/main/kitchen-self-order/menu-service.ts src/main/config/store.ts src/shared/types.ts
git commit -m "feat(kitchen-self-order): explicit menuSource all|selected, derive from kitchen_print, drop show-all fallback"
```

---

## Task 2: Coerce legacy `menu_kitchen` self-checkout profile to `retail_scan`

`menu_kitchen` is removed as a runtime profile, but old persisted config must NOT crash — coerce at read, keep the schema enum permissive.

**Files:**
- Modify: `src/renderer/windows/self-checkout/self-checkout-model.ts`
- Modify: `tests/self-checkout-model.test.ts` (flip the assertion at the existing profile test)
- Verify only (do NOT narrow): `src/main/config/store.ts` `selfCheckoutProfile` enum keeps `'menu_kitchen'`.

**Interfaces:**
- Produces for now: `resolveSelfCheckoutProfile(value: unknown): SelfCheckoutProfile`, but the implementation always returns `'retail_scan'`.
- Keep `export type SelfCheckoutProfile = 'retail_scan' | 'menu_kitchen'` until Task 4 removes every live `profile === 'menu_kitchen'` UI branch. Narrowing the type before Task 4 can make the intermediate renderer typecheck fail on comparisons that still exist.

- [ ] **Step 1: Update the existing test to assert coercion (this is the failing test)**

In `tests/self-checkout-model.test.ts`, replace the `it('defaults unknown kiosk profiles to retail scan mode', ...)` body (currently lines ~24-29) with:
```ts
  it('coerces every profile — including legacy menu_kitchen — to retail scan', () => {
    expect(resolveSelfCheckoutProfile(undefined)).toBe('retail_scan');
    expect(resolveSelfCheckoutProfile('retail_scan')).toBe('retail_scan');
    expect(resolveSelfCheckoutProfile('menu_kitchen')).toBe('retail_scan');
    expect(resolveSelfCheckoutProfile('grocery_kitchen_mix')).toBe('retail_scan');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/self-checkout-model.test.ts -t "coerces every profile"`
Expected: FAIL — current `resolveSelfCheckoutProfile('menu_kitchen')` returns `'menu_kitchen'`.

- [ ] **Step 3: Implement the coercion**

In `src/renderer/windows/self-checkout/self-checkout-model.ts`:
- Do **not** narrow `SelfCheckoutProfile` in this task; leave the legacy union in place until Task 4.
- Replace the resolver:
```ts
export function resolveSelfCheckoutProfile(_value: unknown): SelfCheckoutProfile {
  // menu_kitchen is retired; any persisted value (incl. legacy 'menu_kitchen') is grocery scan.
  return 'retail_scan';
}
```

- [ ] **Step 4: Verify the persisted schema is NOT narrowed**

Open `src/main/config/store.ts`. Confirm `selfCheckoutProfile` enum still includes `'menu_kitchen'` (so old machines' config validates on load). Leave it. Add a one-line comment above it: `// keep 'menu_kitchen' for legacy config acceptance; coerced to retail_scan at runtime (resolveSelfCheckoutProfile)`.

- [ ] **Step 5: Run targeted tests and confirm only expected pending failures remain**

Run: `npx vitest run tests/self-checkout-model.test.ts`
Expected: the profile test passes; note any `menu_kitchen`-asserting tests later in this file (the L265-291 chrome test) still fail — those are fixed in **Task 4 (the UI-removal task)**, not here. Confirm no failure beyond that known one. Do not run or require renderer typecheck for this commit unless the remaining UI branches have already been removed.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/windows/self-checkout/self-checkout-model.ts tests/self-checkout-model.test.ts src/main/config/store.ts
git commit -m "feat(self-checkout): coerce legacy menu_kitchen profile to retail_scan (no schema narrowing)"
```

---

## Task 3: Customer display classifies food by `kitchen_print`, not name keywords

**Files:**
- Modify: `src/main/pos/pos-store.ts` (`resolveCustomerDisplayCatalogSection`; remove keyword tables if unused)
- Modify: `tests/pos-store.test.ts` (replace the name-keyword section tests)

**Interfaces:**
- Produces (unchanged signature): `resolveCustomerDisplayCatalogSection(category: unknown): 'food' | 'retail'` — now `kitchen_print === 1 ? 'food' : 'retail'`.
- Unchanged: `isCustomerDisplayCatalogSectionEnabled(section, config)`.

- [ ] **Step 1: Replace the failing test cases**

In `tests/pos-store.test.ts`, replace the section-classification assertions (currently ~lines 393-396, the `{ name: 'Napoje' }` block) with:
```ts
    expect(resolveCustomerDisplayCatalogSection({ kitchen_print: 1 })).toBe('food');
    expect(resolveCustomerDisplayCatalogSection({ kitchen_print: 0 })).toBe('retail');
    expect(resolveCustomerDisplayCatalogSection({ kitchen_print: 1, name: 'Grocery' })).toBe('food');
    expect(resolveCustomerDisplayCatalogSection({ name: 'Napoje' })).toBe('retail');
    expect(resolveCustomerDisplayCatalogSection({})).toBe('retail');
```
Leave the `isCustomerDisplayCatalogSectionEnabled` assertions (~lines 400-403) unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pos-store.test.ts -t "section"` (or the enclosing `it` name)
Expected: FAIL — current classifier returns `'food'` for `{ name: 'Napoje' }` and `'retail'` for `{ kitchen_print: 1 }`.

- [ ] **Step 3: Implement the kitchen_print classifier**

In `src/main/pos/pos-store.ts`, replace the body of `resolveCustomerDisplayCatalogSection`:
```ts
export function resolveCustomerDisplayCatalogSection(category: unknown): CustomerDisplayCatalogSection {
  const raw = category as Record<string, unknown> | null | undefined;
  // Single source of truth: a category is "food" iff it is a kitchen category.
  return Number(raw?.kitchen_print) === 1 ? 'food' : 'retail';
}
```

- [ ] **Step 4: Remove the now-dead keyword tables (grep first)**

Run: `cd C:\POS-zira; Select-String -Path src/main/pos/pos-store.ts -Pattern 'FOOD_MENU_KEYWORDS','RETAIL_CATALOG_KEYWORDS','matchesAnyKeyword','normalizeCatalogText'`
- Delete `FOOD_MENU_KEYWORDS`, `RETAIL_CATALOG_KEYWORDS`, and `matchesAnyKeyword` **only if** no other reference remains after Step 3.
- `normalizeCatalogText`: grep the whole repo — `Select-String -Path src/**/*.ts -Pattern 'normalizeCatalogText'`. Keep it if anything else uses it; remove from pos-store only if it is local and now unused.

- [ ] **Step 5: Run tests + typecheck to verify**

Run: `npx vitest run tests/pos-store.test.ts`
Run: `npx tsc -p tsconfig.main.json --noEmit`
Expected: PASS; no unused-symbol/type errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/pos/pos-store.ts tests/pos-store.test.ts
git commit -m "feat(customer-display): classify food sections by kitchen_print, remove name-keyword classifier"
```

---

## Task 4: Remove the `menu_kitchen` food branch from the self-checkout UI (grocery scan-first only)

Self-checkout no longer shows a food/kitchen menu or department tabs. The guard is a rewrite of the existing chrome test from "branch exists" to "branch is gone". **Do this before Task 5** (Task 5 deletes the catalog helpers these screens consume).

**Files:**
- Modify: `src/renderer/windows/self-checkout/self-checkout-model.ts` (narrow `SelfCheckoutProfile` only after every UI branch is removed)
- Modify: `src/renderer/windows/self-checkout/SelfCheckoutApp.tsx` (remove `profile === 'menu_kitchen' ? 'kitchen' : ...` defaulting at ~L486 and ~L682; `initialDepartment` always grocery / removed)
- Modify: `src/renderer/windows/self-checkout/screens/ScanScreen.tsx` (remove the `menuProfile ? <KioskMenuPanel/> : <RetailScanOnlyPanel/>` branch — always RetailScanOnly; remove `showDepartmentTabs`)
- Modify: `src/renderer/windows/self-checkout/screens/WelcomeScreen.tsx` (remove `profile === 'menu_kitchen'` copy branch)
- Modify: `tests/self-checkout-model.test.ts` (rewrite the `keeps kiosk chrome, profile split...` test, ~L265-291)

- [ ] **Step 1: Rewrite the chrome test to assert the food branch is GONE (failing test)**

In `tests/self-checkout-model.test.ts`, replace the `it('keeps kiosk chrome, profile split, and loading labels...')` test body with:
```ts
    const welcomeSource = readSource('src/renderer/windows/self-checkout/screens/WelcomeScreen.tsx');
    const scanSource = readSource('src/renderer/windows/self-checkout/screens/ScanScreen.tsx');
    const searchSource = readSource('src/renderer/windows/self-checkout/components/SearchDialog.tsx');

    // menu_kitchen food path is removed: grocery self-checkout is scan-first only.
    expect(welcomeSource).not.toContain("profile === 'menu_kitchen'");
    expect(scanSource).not.toContain("profile === 'menu_kitchen'");
    expect(scanSource).not.toContain('<KioskMenuPanel');
    expect(scanSource).not.toContain('showDepartmentTabs');
    expect(scanSource).toContain('<RetailScanOnlyPanel');
    // Scan-first chrome + search keyboard stay.
    expect(searchSource).toContain('TouchKeyboard');
    expect(searchSource).toContain('inputMode="none"');
    expect(welcomeSource).toContain('{t.kioskName}');
    expect(scanSource).toContain('{t.kioskName}');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/self-checkout-model.test.ts -t "kiosk chrome"`
Expected: FAIL — sources still contain `menu_kitchen` / `<KioskMenuPanel`.

- [ ] **Step 3: Remove the menu branch in the three files (read each file first)**

Read each target file, then:
- `SelfCheckoutApp.tsx`: replace `profile === 'menu_kitchen' ? 'kitchen' : department` (and the L486 variant) with `'grocery'`; drop the now-unused `initialDepartment`/`profile`-as-department wiring. Keep `profile`/`paymentProfile` state only where payment still needs it.
- `ScanScreen.tsx`: delete the `menuProfile` conditional and the `<KioskMenuPanel ... />` JSX + its import; always render `<RetailScanOnlyPanel ... />`. Remove the `showDepartmentTabs` prop.
- `WelcomeScreen.tsx`: delete the `profile === 'menu_kitchen'` copy branch; keep the single scan-first welcome copy.
- `self-checkout-model.ts`: after the grep proves no live UI comparison remains, narrow `export type SelfCheckoutProfile = 'retail_scan';`.

- [ ] **Step 4: Run test + typecheck to verify it passes**

Run: `npx vitest run tests/self-checkout-model.test.ts`
Run: `npm run typecheck:renderer`
Expected: PASS (the `menu_kitchen`-asserting failure noted in Task 2 Step 5 is now also resolved).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/windows/self-checkout/self-checkout-model.ts src/renderer/windows/self-checkout/SelfCheckoutApp.tsx src/renderer/windows/self-checkout/screens/ScanScreen.tsx src/renderer/windows/self-checkout/screens/WelcomeScreen.tsx tests/self-checkout-model.test.ts
git commit -m "feat(self-checkout): grocery scan-first only — remove menu_kitchen UI branch + department tabs"
```

---

## Task 5: Delete `getCategoryDepartment` + department filtering from the self-checkout catalog model

> **Order:** run AFTER Task 4. Once the UI no longer consumes these helpers, deleting them is a clean, typecheck-verified removal.

**Files:**
- Modify/Delete-from: `src/renderer/windows/self-checkout/catalog-model.ts`
- Modify: `tests/self-checkout-catalog-model.test.ts`

**Interfaces:**
- Removes: `getCategoryDepartment`, `buildVisibleCategories`/`buildVisibleProducts` (department filtering). Keep `getProductAvailability`, `getProductPriceGrosze`, `getProductStock`, and `normalizeCatalogText` **only if still consumed** (see Step 1).

- [ ] **Step 1: Grep consumers + prove zero live references (record results)**

Run:
```
Select-String -Path src/**/*.ts,src/**/*.tsx -Pattern 'getCategoryDepartment','buildVisibleCategories','buildVisibleProducts'
Select-String -Path src/**/*.ts,src/**/*.tsx -Pattern 'normalizeCatalogText' | Where-Object { $_.Path -notmatch 'pos-store' }
```
Expected after Task 4: the only references to `getCategoryDepartment`/`buildVisibleCategories`/`buildVisibleProducts` are inside `catalog-model.ts` itself + `self-checkout-catalog-model.test.ts`. If any live consumer remains (e.g. a screen not handled in Task 4), STOP and report — do not delete.

- [ ] **Step 2: Add a static "symbol is gone" guard test (failing)**

In `tests/self-checkout-catalog-model.test.ts`:
- Add at the top: `import { readFileSync } from 'node:fs';`
- Add this test:
```ts
  it('no longer ships the department keyword classifier', () => {
    const src = readFileSync(
      new URL('../src/renderer/windows/self-checkout/catalog-model.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toContain('getCategoryDepartment');
    expect(src).not.toContain("'kitchen'");
  });
```
- Delete the now-obsolete behavior tests: `it('classifies kitchen/menu categories without UI code knowing the regex', ...)` (~L33-37) and `it('builds visible categories and products by department', ...)` (~L39-44). If `normalizeCatalogText` is being removed (Step 4), also delete `it('normalizes accented catalog text...', ...)` (~L29-31). Remove the corresponding names from the import block. Keep the price/stock/availability tests.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/self-checkout-catalog-model.test.ts -t "department keyword classifier"`
Expected: FAIL — `catalog-model.ts` still contains `getCategoryDepartment`.

- [ ] **Step 4: Delete the dead exports from `catalog-model.ts`**

Remove `getCategoryDepartment`, the department-filtering bodies of `buildVisibleCategories`/`buildVisibleProducts` (and the functions themselves if Step 1 proved them unused), and — if Step 1 proved unused — `normalizeCatalogText` + the keyword list + the `CatalogDepartment` type. Keep `getProductAvailability`, `getProductPriceGrosze`, `getProductStock`.

- [ ] **Step 5: Run test + typecheck to verify it passes**

Run: `npx vitest run tests/self-checkout-catalog-model.test.ts`
Run: `npm run typecheck:renderer`
Expected: PASS; no dangling imports anywhere (the typecheck is what proves no live consumer was missed).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/windows/self-checkout/catalog-model.ts tests/self-checkout-catalog-model.test.ts
git commit -m "refactor(self-checkout): delete getCategoryDepartment keyword classifier + department filtering"
```

---

## Task 6: Delete the now-unused self-checkout menu components (grep-gated)

**Files (delete ONLY if Step 1 proves zero live consumers):**
- `src/renderer/windows/self-checkout/components/KioskMenuPanel.tsx`
- `src/renderer/windows/self-checkout/components/KioskCategoryGallery.tsx`
- `src/renderer/windows/self-checkout/components/DepartmentTabs.tsx`
- `src/renderer/windows/self-checkout/components/CategoryChips.tsx`
- `src/renderer/windows/self-checkout/components/ProductTile.tsx`
- Test: a static guard in `tests/self-checkout-model.test.ts`

- [ ] **Step 1: Grep exact consumers for EACH component (mandatory — no blind delete)**

Run for each name:
```
Select-String -Path src/**/*.ts,src/**/*.tsx -Pattern 'KioskMenuPanel','KioskCategoryGallery','DepartmentTabs','CategoryChips','ProductTile'
```
Decision rule per component: a file is deletable only if its sole remaining references are its own definition + its own test. **`ProductTile` and `CategoryChips` may still be imported by `SearchDialog.tsx` (search results) — if so, KEEP them** and record why in the commit message. List the kept vs deleted set explicitly.

- [ ] **Step 2: Write the static guard test**

Add to `tests/self-checkout-model.test.ts`:
```ts
  it('drops the dead self-checkout food-menu components after the menu_kitchen removal', () => {
    const scan = readSource('src/renderer/windows/self-checkout/screens/ScanScreen.tsx');
    // ScanScreen must not import the removed menu/department components.
    expect(scan).not.toContain("from './components/KioskMenuPanel'");
    expect(scan).not.toContain("from '../components/KioskMenuPanel'");
    expect(scan).not.toContain('DepartmentTabs');
  });
```

- [ ] **Step 3: Run the guard test**

Run: `npx vitest run tests/self-checkout-model.test.ts -t "dead self-checkout"`
Expected: PASS confirms Task 4 already removed the imports — proceed to delete the files. If it FAILS, ScanScreen still imports them; finish Task 4 first.

- [ ] **Step 4: Delete the proven-unused component files + their tests**

Delete each file confirmed unused in Step 1, plus any test file that imports only deleted symbols. Do NOT delete `ProductTile`/`CategoryChips` if kept in Step 1.

- [ ] **Step 5: Run full typecheck + suite to verify no dangling imports**

Run: `npm run typecheck:renderer`
Run: `npx vitest run`
Expected: PASS for the renderer typecheck; vitest shows no NEW failures vs the Task 0 baseline.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(self-checkout): delete dead food-menu components (kept ones still used by SearchDialog noted)"
```

---

## Task 7: Settings split — Kitchen Self-Order module owns the food-category selector + menuSource

`SelfCheckoutTab` stays as the shell/route, but grocery and kitchen panels become separate components, the per-category food selector (`KitchenPrintSettings`) moves out of `Settings.tsx` into the kitchen panel, and a `menuSource` selector is added.

**Files:**
- Create: `src/renderer/components/pos/GrocerySelfCheckoutPanel.tsx` (grocery kiosk config extracted)
- Create: `src/renderer/components/pos/KitchenSelfOrderPanel.tsx` (kitchen kiosk config + `<KitchenPrintSettings/>` + menuSource selector)
- Modify: `src/renderer/components/SelfCheckoutTab.tsx` (compose the two panels; drop `menu_kitchen` profile option; persist `selfCheckoutProfile: 'retail_scan'`)
- Modify: `src/renderer/components/Settings.tsx` (unmount `<KitchenPrintSettings/>` at L5837)
- Modify: `tests/kitchen-self-order.test.ts` (update the static "operator launch settings" assertions to the new component files; add a menuSource assertion)

**Interfaces:**
- `KitchenSelfOrderPanel` renders `<KitchenPrintSettings/>` and exposes `kitchenSelfOrderMenuSource` ('all' | 'selected').
- Initial `menuSource` must be resolved with the shared `resolveKitchenSelfOrderMenuSource(config, categories)` helper: explicit config wins; missing/legacy config derives from current `kitchen_print` flags.
- Do **not** initialize or persist a hardcoded `'all'` default on mount or on unrelated field changes. Persist `kitchenSelfOrderMenuSource` only when the operator explicitly changes it, or when launching/saving kitchen settings using the visible resolved value.
- `KitchenPrintSettings` is imported from its existing path `./pos/KitchenPrintSettings` (component itself unchanged).

- [ ] **Step 1: Update the static settings test (failing)**

In `tests/kitchen-self-order.test.ts`, rewrite the `it('operator launch settings are separate from store self-checkout settings', ...)` test to read the new panel files and assert the contract lives there:
```ts
    const kitchenPanel = readSource('src/renderer/components/pos/KitchenSelfOrderPanel.tsx');
    const groceryPanel = readSource('src/renderer/components/pos/GrocerySelfCheckoutPanel.tsx');

    expect(kitchenPanel).toContain("window.open('kitchenSelfOrder')");
    expect(kitchenPanel).toContain('kitchenSelfOrderLanguage');
    expect(kitchenPanel).toContain('kitchenSelfOrderDefaultFulfillment');
    expect(kitchenPanel).toContain('kitchenSelfOrderSlipPrinterType');
    expect(kitchenPanel).toContain('kitchenSelfOrderMenuSource');
    expect(kitchenPanel).toContain('resolveKitchenSelfOrderMenuSource');
    expect(kitchenPanel).toContain('KitchenPrintSettings');
    expect(groceryPanel).toContain("window.open('selfCheckout')");
    // The food-category selector no longer lives in the monolithic Settings.tsx.
    const settings = readSource('src/renderer/components/Settings.tsx');
    expect(settings).not.toContain('<KitchenPrintSettings');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/kitchen-self-order.test.ts -t "operator launch settings"`
Expected: FAIL — new panel files don't exist; `Settings.tsx` still mounts `<KitchenPrintSettings/>`.

- [ ] **Step 3: Extract the two panels (read `SelfCheckoutTab.tsx` first)**

- Create `GrocerySelfCheckoutPanel.tsx`: move the grocery kiosk state + `openKiosk` (`window.open('selfCheckout')`, persists `selfCheckoutProfile: 'retail_scan'`, mode/monitor/idle/language). Remove any `menu_kitchen` option from the profile control (the profile is fixed to `retail_scan`).
- Create `KitchenSelfOrderPanel.tsx`: move the kitchen kiosk state + `openKitchenSelfOrder` (`window.open('kitchenSelfOrder')`, language/monitor/fulfillment/slip/voice); render `<KitchenPrintSettings lang={...} />`; add a `menuSource` radio/select that persists `kitchenSelfOrderMenuSource: 'all' | 'selected'` (label: "all = every category (restaurant)" / "selected = only kitchen_print categories (hybrid)").
- In `KitchenSelfOrderPanel.tsx`, load categories via the existing renderer bridge (`window.electronAPI.pos.categories.getAll()` or the current local equivalent) and initialize the selector with `resolveKitchenSelfOrderMenuSource(currentConfig, categories)`. This mirrors Task 1 and prevents a missing config from silently becoming explicit `'all'` on hybrid machines.
- If `KitchenPrintSettings` refreshes category flags after the operator edits them, either reload categories in `KitchenSelfOrderPanel` after the edit path or keep the selector stable until the operator chooses a new source. Do not let a stale/empty category array drive an automatic switch to `'all'`.
- `SelfCheckoutTab.tsx`: render `<GrocerySelfCheckoutPanel/>` and `<KitchenSelfOrderPanel/>`; keep i18n shell. No shared mutable state between the two panels.

- [ ] **Step 4: Unmount `KitchenPrintSettings` from `Settings.tsx`**

Remove the `<KitchenPrintSettings lang={...} />` render at `Settings.tsx:5837` and its import. Leave the rest of `Settings.tsx` untouched.

- [ ] **Step 5: Run test + typecheck + i18n test to verify**

Run: `npx vitest run tests/kitchen-self-order.test.ts tests/self-checkout-tab-i18n.test.ts`
Run: `npm run typecheck:renderer`
Expected: PASS. If `self-checkout-tab-i18n.test.ts` asserts strings that moved into the panels, update those reads to the new files in the same commit.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(settings): split self-checkout vs kitchen-self-order panels; move food-category selector + menuSource into Kitchen module"
```

---

## Task 8: Full-suite + typecheck verification against baseline

**Files:** none (verification + handoff).

- [ ] **Step 1: Run the full vitest suite**

Run: `npx vitest run 2>&1 | Tee-Object "$env:TEMP\pos-zira-phase1-after.txt"`
Expected: every failure also present in `$env:TEMP\pos-zira-phase1-baseline.txt` (Task 0). **No new failures.** Diff/summarize the two files; investigate any new red before proceeding.

- [ ] **Step 2: Run both typechecks**

Run: `npm run typecheck:renderer`
Run: `npx tsc -p tsconfig.main.json --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Manual smoke checklist on the test salon (record results, do not auto-pass)**

On `owner+salon-test-kuchnia@test.local`:
- Pure restaurant: `kitchenSelfOrderMenuSource = all` → kitchen kiosk shows every category; order → kitchen ticket prints → pay at counter.
- Hybrid: flag a subset via "In đơn bếp" + `menuSource = selected` → only flagged categories show; non-food categories absent.
- `selected` with no flags → empty/setup state (NOT whole catalog).
- Grocery self-checkout: scan + quantity + code/name search only; no food/department tabs.
- Legacy config: a profile saved as `menu_kitchen` opens self-checkout in grocery mode without crashing.

- [ ] **Step 4: Record verification in the handoff/PR, not as a committed raw log**

Do not commit `$env:TEMP\pos-zira-phase1-after.txt`. Summarize the exact commands, pass/fail result, and any unchanged baseline failures in the final handoff/PR description.

---

## Self-Review (spec coverage map)

- Spec §4.2 cut menu_kitchen → Tasks 2 (profile), 4 (UI), 5 (catalog helpers), 6 (components).
- Spec §4.3 kitchen_print source of truth → Tasks 1 (kitchen kiosk), 3 (customer display).
- Spec §4.4 explicit menuSource + derive + selected-empty → Task 1.
- Spec §4.5 settings split (surgical, separate components) → Task 7.
- Spec §4.7 customer display uses kitchen_print, no inherit of `all` → Task 3 (classifier is kitchen_print-only; no menuSource coupling).
- Spec §4.8 grocery scan-first; delete gallery if unused (grep-first) → Tasks 4 (UI), 6 (components, grep-gated).
- Spec §4.9 legacy menu_kitchen coerce, no schema narrowing → Task 2.
- Spec §9 testing (menu-source migration, legacy profile, customer display, getCategoryDepartment removal) → Tasks 1, 2, 3, 5 + Task 8 baseline-diff.
- Component/helper-deletion grep-first guard → Tasks 5 Step 1, 6 Step 1.
- Phase 2 (visual redesign) intentionally NOT in this plan.
