# Kitchen Self-Order & Self-Checkout Kiosk Restructure — Design

Status: reviewed design draft, revised for build-readiness, not yet implemented
Date: 2026-06-23
Related: `KITCHEN_SELF_ORDER_DESIGN_CONTRACT.md`, `KITCHEN_SELF_ORDER_MVP_PLAN.md`, `KITCHEN_SELF_ORDER_PICKUP_QUEUE_DESIGN.md`
Repos touched: **POS-zira** desktop app (Electron) — renderer + main config. Backend `enail`: no schema change (the food flag already exists).

> **Scope guard — forward-looking feature for FUTURE salons.**
> Do **NOT** build into or release onto the chè sài gòn (chesaigon) machines —
> chesaigon runs the **POS tab only**. Develop + test on `winpc`
> (`C:\POS-zira`, branch `main`) against the test salon
> `owner+salon-test-kuchnia@test.local`. **No backend production deploy.**

---

## 1. Problem

The desktop app grew **three overlapping "customer food menu" concepts**, built at
different times by different people, with no shared source of truth. There are four
customer-facing windows (`pos`, `customer`, `selfCheckout`, `kitchenSelfOrder`); three
of them touch "food":

| Window | Role | Food payment | "What is food" decided by |
|---|---|---|---|
| `kitchenSelfOrder` | Order food at kiosk | **Pay at counter** | `categories.kitchen_print` flag ✅ explicit |
| `selfCheckout` (profile `menu_kitchen`) | Self-pay kiosk, Grocery/Kitchen tabs | **Self-pay** | guessed from category **name** keywords ⚠️ |
| `customer` (2nd screen) | Passive customer display | — | separate toggle + `pos-store.ts` food keyword classifier ⚠️ |

Symptoms of the mess:

- **Two parallel food-menu UIs.** `selfCheckout`'s `menu_kitchen` department vs the
  dedicated `kitchenSelfOrder` window both render a food menu; the latter is richer
  (modifiers + notes).
- **"What is food" decided three different ways** → the two kiosks disagree about which
  categories are food.
- **Fragile classifier.** `getCategoryDepartment()` (self-checkout `catalog-model.ts`)
  matches ~45 PL/EN/VI keywords against the category name to guess grocery-vs-kitchen.
  It both misses and misfires: `"Cơm"` (normalized `com`) → grocery (wrong); a retail
  `"Trà hộp"` → matches `tra` → kitchen (wrong).
- **Ambiguous fallback.** `getKitchenCatalog()` shows the **entire catalog** when no
  category is flagged `kitchen_print` — indistinguishable between "restaurant wants
  everything" and "hybrid forgot to configure → groceries leak onto the food menu".
- **Scattered settings.** `SelfCheckoutTab` configures **both** kiosks (two "open"
  buttons); the food-category selector (`KitchenPrintSettings`, the "In đơn bếp" panel)
  lives separately in the big `Settings.tsx` (L5837).

## 2. Goals

- **One source of truth** for the hybrid food-vs-retail split:
  `categories.kitchen_print`. Pure restaurants are an explicit **all-food**
  override, not a silent fallback.
- **Two clean, non-overlapping customer kiosks**, each enabled per salon.
- **Settings reorganized** so each kiosk + its food definition is controlled in one place.
- **Fix the ambiguous show-all fallback.**
- Work for **both** pure-restaurant and grocery+kitchen **hybrid** salons.
- **Logic/flow correct FIRST**; visual redesign is a deliberately later phase.

### Non-goals (this phase)
- Visual/UX redesign of the kitchen kiosk (Phase 2, separate spec).
- Real unattended self-pay / payment-terminal integration.
- Any change to chesaigon or any production deploy.

## 3. Store-type model (the mental model this design serves)

| Store type | Grocery Self-Checkout (scan → self-pay) | Kitchen Self-Order (menu → ticket → counter-pay) | Food-category toggle |
|---|---|---|---|
| **Pure grocery** (tạp hóa) | ✅ enabled | ❌ off | — (no food) |
| **Pure restaurant** (thuần đồ ăn) | ❌ off | ✅ enabled | **not needed** — owner explicitly chooses `menuSource = all` |
| **Hybrid** (Żabka / chè sài gòn) | ✅ enabled (dry goods) | ✅ enabled (food) | **mark which categories are food**; the rest fall to grocery |

**Key realization:** the food-category toggle is a **HYBRID tool**. A pure restaurant
needs no toggling (everything is food); a pure grocery has no food menu. The toggle
exists only to separate food from packaged goods in a hybrid store. This dissolves the
"if it's a pure food store, why toggle categories?" contradiction.

## 4. Locked decisions

1. **Two independent kiosks, enabled per salon.**
   - **Grocery Self-Checkout** (existing `selfCheckout`, profile `retail_scan`): scan
     barcode + quantity + code search → **self-pay**. Packaged goods only. **Never prints
     a kitchen ticket.**
   - **Kitchen Self-Order** (existing `kitchenSelfOrder` window): browse food menu →
     **kitchen ticket** → **pay at counter**. The **only** food-ordering surface and the
     **only** surface that prints kitchen tickets.

2. **Cut `menu_kitchen`.** Remove the self-checkout `menu_kitchen` profile, the
   grocery/kitchen `DepartmentTabs`, and the `getCategoryDepartment()` keyword classifier.
   Self-checkout becomes **grocery-only**. Reason: self-checkout = self-pay, but food must
   be counter-pay → the "browse-food-then-self-pay" path contradicts the agreed payment
   model and duplicates the kitchen kiosk.

3. **Single source of truth for the hybrid food-vs-retail split =
   `categories.kitchen_print`.** Delete the name-keyword guessing. In `selected`
   mode the flag drives kitchen-menu visibility, and the same flag already drives
   POS-sale kitchen-ticket printing. In explicit `all` mode, the salon is declaring
   "every category is food" for the Kitchen Self-Order menu; this is a store-level
   override for pure restaurants, not a classifier.

4. **Explicit kitchen menu source, replacing the ambiguous fallback.** The Kitchen
   Self-Order kiosk gets a config `kitchenSelfOrderMenuSource: 'all' | 'selected'`:
   - `all` → show **every** category (pure restaurant; zero per-category config).
   - `selected` → show **only `kitchen_print`-flagged** categories (hybrid). If none are
     flagged, show an **empty / setup state — NOT the whole catalog**.
   - **Compatibility rule for missing/legacy config:** do **not** blindly default to
     `all`. If `kitchenSelfOrderMenuSource` is missing/invalid, preserve today's
     behavior by deriving from the cached catalog: if any category has
     `kitchen_print === 1`, resolve to `selected`; otherwise resolve to `all`.
     Once the owner saves the Kitchen Self-Order settings, persist an explicit
     `all` or `selected`.
   - New UI should present both choices clearly. Recommend `selected` for hybrids
     and `all` only for pure restaurants. This avoids leaking groceries just because
     a new config key was absent.

5. **Settings reorganized into two modules** (replacing the combined `SelfCheckoutTab`):
   - **"Self-Checkout (grocery)"** — grocery kiosk config (mode, monitor, idle, language).
   - **"Kitchen Self-Order"** — kitchen kiosk config **+ the food-category selector**
     (`KitchenPrintSettings`, moved here from `Settings.tsx`) **+** the `menuSource`
     choice + slip printer + fulfillment + language + voice. Everything about the food
     kiosk in one place = "dễ kiểm soát".
   Keep this surgical: `SelfCheckoutTab` may remain the existing sidebar route/shell,
   but the implementation must split the grocery and kitchen panels into separate
   components so future edits cannot re-mix the two kiosk contracts.

6. **One flag for now (YAGNI).** In hybrid/`selected` mode, `kitchen_print` keeps doing
   double duty (show-on-menu
   **and** print-ticket). If a future case needs "show on menu but no kitchen ticket"
   (e.g. pre-made bottled drinks), split into `showOnKitchenMenu` ⟂ `printsKitchenTicket`
   then. Not now.

7. **Customer display food menu is aligned in Phase 1, not left open.** If the passive
   customer display keeps a food menu, its food section must use `kitchen_print`.
   Remove the `pos-store.ts` food-name keyword classifier for customer display. The
   existing `customerDisplayFoodMenuEnabled` setting may stay as a visibility toggle,
   but it must no longer define what counts as food. Customer display does **not**
   inherit the Kitchen Self-Order `all` override in this phase; if a pure restaurant
   wants the passive display food section too, categories still need `kitchen_print`
   flags or a future explicit customer-display source setting.

8. **Grocery self-checkout remains scan-first.** Do not keep the category-gallery browse
   in grocery self-checkout for this phase. Self-checkout keeps barcode scan, quantity,
   and code/name search. Delete the self-checkout category gallery/menu components if
   they become unused after `menu_kitchen` is removed.

9. **Legacy `selfCheckoutProfile = 'menu_kitchen'` must be migrated safely.** Runtime
   resolution must coerce any legacy profile value to `retail_scan`, and opening/saving
   self-checkout must persist `retail_scan`. Do **not** narrow the persisted config schema
   in a way that can crash machines with old config before a migration/coercion test
   proves it is safe.

## 5. Architecture & data flow

**Kitchen Self-Order (food, unchanged except the catalog gate):**
```
kitchen-self-order:getMenu (pos.module.ts)
  buildKitchenSelfOrderMenu({ config, categories: getCategories(), products: getAll() })
    resolveKitchenSelfOrderMenuSource(config, categories):
      explicit 'all'      -> all categories + products
      explicit 'selected' -> only categories with kitchen_print === 1 (EMPTY if none; no show-all)
      missing/legacy      -> selected if any kitchen_print flag exists, otherwise all
  -> KitchenSelfOrderMenu -> KitchenSelfOrderApp (menu -> review -> terminal/done)
  -> submit -> kitchen ticket + customer slip + pickup-queue push (existing)
  -> customer pays at the cashier POS
```

**Grocery Self-Checkout (unchanged except food removed):**
```
welcome -> shopping (grocery: scan + quantity + code search) -> payment overlay
        -> receipt -> thankyou        (self-pay; no kitchen ticket, no food menu)
```

**Customer display catalog (passive display, aligned if retained):**
```
customer display idle/touch
  -> pos-store.loadServiceCategories()
     section = category.kitchen_print === 1 ? 'food' : 'retail'
     customerDisplayFoodMenuEnabled only controls visibility of the food section
     customerDisplayRetailCatalogEnabled controls visibility of the retail section
```

## 6. Affected code (high level — exact edits go in the implementation plan)

App (`POS-zira`):
- `src/main/kitchen-self-order/menu-service.ts` — `getKitchenCatalog()` reads
  `menuSource`; **remove the show-all-when-none fallback for explicit `selected`**
  and add a resolver for explicit `all`, explicit `selected`, and missing/legacy config.
- `src/main/config/store.ts` — add `kitchenSelfOrderMenuSource` (`'all' | 'selected'`,
  but do not treat absent config as explicit `all`); `selfCheckoutProfile` runtime
  collapses to grocery-only while legacy persisted `menu_kitchen` is coerced safely.
- `src/shared/types.ts` / `src/shared/electron.d.ts` — add the menu-source config type
  and keep any legacy persisted self-checkout profile typing deliberate. Do not let
  TypeScript cleanup remove the runtime migration path.
- `src/renderer/windows/self-checkout/SelfCheckoutApp.tsx` — remove the `menu_kitchen`
  branch and the `profile === 'menu_kitchen' ? 'kitchen' : ...` department defaulting
  (L486 / L682).
- `src/renderer/windows/self-checkout/self-checkout-model.ts` — drop `menu_kitchen` from
  the runtime `SelfCheckoutProfile`; `resolveSelfCheckoutProfile('menu_kitchen')` must
  return `retail_scan` for legacy config.
- `src/renderer/windows/self-checkout/catalog-model.ts` — delete `getCategoryDepartment()`
  keyword classifier + department filtering.
- `src/renderer/windows/self-checkout/screens/WelcomeScreen.tsx` and
  `src/renderer/windows/self-checkout/screens/ScanScreen.tsx` — remove profile-based
  food/menu copy and the menu-panel branch; grocery self-checkout stays scan/search only.
- `src/renderer/windows/self-checkout/components/` — remove `DepartmentTabs` and delete
  `KioskMenuPanel`, `KioskCategoryGallery`, `ProductTile`, and `CategoryChips` if they
  become unused after the menu branch is removed. Before deleting each component, grep
  all consumers by exact symbol/path; do not delete shared pieces that are still used by
  search or other grocery self-checkout UI.
- `src/renderer/components/SelfCheckoutTab.tsx` — split into the two settings modules;
  remove the `menu_kitchen` profile option; opening self-checkout persists
  `selfCheckoutProfile: 'retail_scan'`.
- `src/renderer/components/pos/KitchenPrintSettings.tsx` — relocate into the Kitchen
  Self-Order settings module (unmount from `Settings.tsx` L5837).
- `src/renderer/components/Settings.tsx` — unmount `KitchenPrintSettings`; keep
  `customerDisplayFoodMenuEnabled` only as a visibility toggle, not a classifier.
- `src/main/pos/pos-store.ts` — remove the customer-display food keyword classifier and
  classify customer-display sections from `category.kitchen_print === 1`.

Backend (`enail`): **no schema change** — `categories.kitchen_print` + product-admin
`updateCategory` already exist and the POS product feed already carries the flag
(`category.kitchen_print`, consumed by `menu-service.ts`). Confirm only.

## 7. The customer-display food menu (3rd concept) — locked decision

`customerDisplayFoodMenuEnabled` on the `customer` (2nd-screen) window is a third food
surface. In Phase 1 it is **not** removed, because that would be an unrelated product
decision for customer-display users. Instead:

- Keep `customerDisplayFoodMenuEnabled` only as "show/hide the food section".
- Keep `customerDisplayRetailCatalogEnabled` only as "show/hide the retail section".
- Remove the customer-display category-name keyword classifier in `pos-store.ts`.
- Treat `category.kitchen_print === 1` as food; all other categories are retail.

This closes the source-of-truth gap without deleting an existing passive-display feature.

## 8. Phasing

- **Phase 1 — logic & flow (this work):** source-of-truth consolidation onto
  `kitchen_print`, cut `menu_kitchen`, `menuSource` config, settings reorg, and prove the
  Kitchen Self-Order flow end-to-end on the test salon (order → kitchen ticket →
  counter pay). Also migrate customer-display food classification away from keywords.
  **No visual redesign.**
- **Phase 2 — UX/UI redesign (later, separate spec):** redo the `KitchenSelfOrderApp`
  display. Deferred on purpose: a pretty screen over a wrong flow is worthless.

## 9. Testing

- **Unit:** `getKitchenCatalog` / menu-source resolver for explicit `all`, explicit
  `selected`, `selected` with none flagged → **empty**, and missing/legacy config:
  flagged categories → `selected`, no flagged categories → `all`.
- **Unit/static:** legacy `resolveSelfCheckoutProfile('menu_kitchen')` coerces to
  `retail_scan`; self-checkout opening persists `retail_scan`; config schema does not
  crash on old persisted `menu_kitchen`.
- **Unit/static:** delete `getCategoryDepartment` tests with the function; add customer
  display section tests proving `kitchen_print === 1` maps to food and category names no
  longer decide food/retail.
- **App (vitest):** self-checkout no longer offers a kitchen department; grocery
  scan/search intact; kitchen-self-order menu reflects `menuSource` + `kitchen_print`.
  Use the repo's **baseline-diff** discipline — no *new* failures vs known pre-existing ones.
- **Manual on `owner+salon-test-kuchnia@test.local`:** pure-restaurant (`all` → every
  category); hybrid (`selected` → only flagged, groceries absent); pure-grocery (kitchen
  kiosk off). Submit → kitchen ticket prints → pay at counter; second food kiosk / scan
  do not cross-contaminate.

## 10. Rollout constraints (must hold)

- **Do NOT** build into or release onto chesaigon. chesaigon = POS tab only.
- Develop + test on `winpc` against `owner+salon-test-kuchnia@test.local`.
- **No** backend production deploy.

## 11. Closed choices for the implementation agent

1. **Customer-display food menu (§7):** align to `kitchen_print`; do not remove it in
   this phase. Customer display does not inherit `menuSource = all`; pure restaurants
   must flag categories for the passive display food section unless a later spec adds a
   separate customer-display source override.
2. **Grocery self-checkout browse:** pure scan + quantity + code/name search only. Do
   not keep category-gallery browse in grocery self-checkout. Delete old browse
   components only after exact consumer grep proves they are unused.
3. **Default / migration for `menuSource`:** explicit owner choice is `all` or
   `selected`; missing/legacy config derives from existing flags (`any flagged` →
   selected, `none flagged` → all). Do not blindly default missing config to `all`.
4. **Legacy `menu_kitchen`:** never expose it in UI; coerce old config to `retail_scan`
   and persist `retail_scan` on the next self-checkout settings save/open.
