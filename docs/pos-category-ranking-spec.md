# POS Category Priority Ranking — Design Spec

**Date:** 2026-05-30
**Store driving it:** chè sài gòn (grocery) · POS-zira *retail* template
**Source of truth:** GitHub `leonfunny/POS-zira` (branch `main`) — build origin now cloned on Contabo `/var/www/www/POS-zira-src`
**Mockups:** `pos_mockup.png` (POS screen), `pos_settings_mockup.png` (settings)

---

## 1. Problem & insight (from real data)

chè sài gòn has **1,029 products / 28 flat categories**. POS-zira currently shows all 28 categories with equal weight.

Barcode coverage (variant-level `product_variants.barcode`):
- **~920 products HAVE a barcode** → cashier **scans**, never taps.
- **~108 products have NO barcode** → cashier **must tap**. They cluster almost entirely in **fresh** categories:

| Category | no-barcode / total |
|---|---|
| Trái cây tươi | 24 / 26 |
| Rau củ tươi | 24 / 25 |
| Thịt lợn | 13 / 13 |
| Rau thơm tươi | 12 / 12 |
| Thịt gà | 11 / 11 |
| Thịt bò | 4 / 4 |
| Hải sản tươi (+ Túi ghẹ) | new |
| scattered (đồ uống, giò chả, gạo…) | ~10 |

The 22 packaged categories (Đồ ăn vặt 159, Đồ uống 137, Mì/Bún/Phở 110…) are ~100% barcoded → never tapped.

**Insight:** 90% of the till flow is scanning. Tapping only ever happens on the ~108 fresh items. So the POS browse should make the **high-tap (fresh) categories big and first**, and demote the scanned categories — but *which* categories are "priority" differs per shop, so it must be **configurable**, not hardcoded.

> Note: the two `menus` rows (Main Menu / Footer) are **storefront website navigation**, unrelated to POS. POS browses by **category**.

---

## 2. Feature

A **per-shop, configurable category priority ranking** that controls, on the POS retail screen, both the **order** and the **size** of category groups. Owner ranks categories in POS Settings (drag / ▲▼) with a one-click **auto-suggest** that seeds fresh-first.

---

## 3. Data model — no schema change

Reuse existing **`categories.display_order`** as the priority score. **Lower number = higher priority = top.** One ordering per shop, already synced down to POS local catalogue via the existing category sync. (`categories` also already has `image_url`, `icon`, `is_active`.)

---

## 4. Rank → order **and** size tier

Derived from rank position (constants, tunable):

| Rank position | Render |
|---|---|
| 1–3 | **Big** image cards — highlighted "Hàng tươi" band, top |
| 4–8 | **Medium** image cards |
| 9+ | **Small chips**, collapsed under a `Tất cả ▾` toggle |

A category whose products are fully barcoded naturally lands low → becomes a chip. No explicit "hide" flag needed in v1.

---

## 5. Auto-suggest ("Gợi ý tự xếp")

Sort categories by **no-barcode ratio** (`no_barcode_count / total`) desc, tie-break by `no_barcode_count` desc, then write the resulting sequence into `display_order`. "No barcode" = `product.barcode` empty in the POS local catalogue. Result: fresh categories float to the top out of the box; owner then fine-tunes with ▲▼.

---

## 6. Settings UI — new section in `Settings.tsx`: "Sắp xếp danh mục POS"

Vertical reorderable list. Each row:
`≡ (drag)` · color bar · **Category name** · badge `(X cần bấm / Y tổng)` · tier label `nút TO/vừa/nhỏ` · `▲ ▼`
Header button: **`Gợi ý tự xếp ▶`**. Footer: **`Lưu`**.

Save → for each changed category call existing IPC `pos:product-admin:categories:update(categoryId, { display_order })`.

---

## 7. POS render — `RetailTemplate.tsx` + `retailBrowseFilters.ts`

When **no search and no active category** (default landing):
- Sort categories by `display_order`.
- Render priority **bands** with size tiers (§4); show each category's items as image cards (product images already populated for fresh items).
- Packaged/low-rank categories shown as small chips; `Tất cả ▾` expands the full 28.
- Scan box, search, and unit filter (All/Cái/Kg) behavior unchanged. Scanning a barcoded item adds to cart without touching this screen.

`ProductCard.tsx` / `ProductGrid.tsx`: add a `size` prop (`big | medium | small`).

---

## 8. Files to change

**POS-zira** (`/var/www/www/POS-zira-src`):
- `src/renderer/components/pos/templates/retail/retailBrowseFilters.ts` — add: sort by `display_order`; rank→tier helper; per-category no-barcode counts.
- `src/renderer/components/pos/templates/retail/RetailTemplate.tsx` — priority-band landing.
- `src/renderer/components/Settings.tsx` — ranking section + auto-suggest + save.
- `src/renderer/components/pos/ProductCard.tsx`, `ProductGrid.tsx` — size variants.
- (preload already exposes `product-admin:categories:update` + `categories.getAll`.)

**Backend eNail** (`/var/www/www/enail-production/backend`, on Contabo):
- Verify `categories` update persists `display_order`, and category sync to POS returns `display_order`; product sync includes variant `barcode` (used for no-barcode detection).

---

## 9. Deploy flow

1. Code + commit on Contabo clone → push GitHub `leonfunny/POS-zira` (feature branch → PR/merge to `main`).
2. POS1 (chesaigon) `git pull` → run `scripts/build-and-upload.sh` (Windows electron-builder NSIS) → uploads release to R2 `https://img.zira.pl/downloads/`.
3. chesaigon POS1/POS2 **auto-update** from R2 on next launch.
4. **Never** hand-edit POS1 dist (auto-update overwrites it).

---

## 10. Defaults & out of scope (v1)

- Tier bands default **3 / 8**; auto-suggest seeds fresh-first.
- **Out of scope v1:** web dashboard ranking UI; manual per-category tier override; weighted-by-kg sale flow (separate MVP).
