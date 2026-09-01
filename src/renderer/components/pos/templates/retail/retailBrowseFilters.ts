import type { Category, Product } from '../../../../hooks/usePosDb';
import { classifyProductSale } from '../../../../../shared/product-sale-classifier';

export type RetailUnitFilter = 'all' | 'piece' | 'kg';

export interface RetailCategoryUnitCounts {
  piece: number;
  kg: number;
  total: number;
}

export const RETAIL_UNIT_FILTERS: Array<{
  id: RetailUnitFilter;
  labelKey: string;
  fallback: string;
}> = [
  { id: 'all', labelKey: 'pos.unitFilter.all', fallback: 'All' },
  { id: 'piece', labelKey: 'pos.unitFilter.piece', fallback: 'Piece' },
  { id: 'kg', labelKey: 'pos.unitFilter.kg', fallback: 'Kg' },
];

/**
 * The retail home screen is the category gallery -- unless the device runs in
 * "simple grid" (fair / market-stall) mode, where the whole catalogue is the
 * home screen and categories never appear.
 */
export function shouldShowCategoryGallery(input: {
  simpleGrid: boolean;
  gridSearchQuery: string;
  activeCategoryId: string | null;
}): boolean {
  if (input.simpleGrid) return false;
  return !input.gridSearchQuery && input.activeCategoryId === null;
}

export function getRetailProductUnit(product: Product): Exclude<RetailUnitFilter, 'all'> {
  return classifyProductSale(product).isWeighted ? 'kg' : 'piece';
}

export function productMatchesRetailUnitFilter(product: Product, filter: RetailUnitFilter): boolean {
  if (filter === 'all') return true;
  return getRetailProductUnit(product) === filter;
}

export function filterRetailBrowseProducts(
  products: Product[],
  activeCategoryId: string | null,
  activeUnitFilter: RetailUnitFilter,
): Product[] {
  return products.filter((product) => {
    if (activeCategoryId && product.category_id !== activeCategoryId) return false;
    return productMatchesRetailUnitFilter(product, activeUnitFilter);
  });
}

export function countRetailProductsByCategory(products: Product[]): Map<string, RetailCategoryUnitCounts> {
  const map = new Map<string, RetailCategoryUnitCounts>();
  for (const product of products) {
    if (!product.category_id) continue;
    const counts = map.get(product.category_id) ?? { piece: 0, kg: 0, total: 0 };
    counts[getRetailProductUnit(product)] += 1;
    counts.total += 1;
    map.set(product.category_id, counts);
  }
  return map;
}

export function countForRetailUnitFilter(
  counts: RetailCategoryUnitCounts | undefined,
  filter: RetailUnitFilter,
): number {
  if (!counts) return 0;
  if (filter === 'piece') return counts.piece;
  if (filter === 'kg') return counts.kg;
  return counts.total;
}

export function getVisibleRetailCategories(
  categories: Category[],
  countsByCategory: Map<string, RetailCategoryUnitCounts>,
  activeUnitFilter: RetailUnitFilter,
): Category[] {
  return categories.filter((category) => (
    countForRetailUnitFilter(countsByCategory.get(category.id), activeUnitFilter) > 0
  ));
}

// ---------------------------------------------------------------------------
// Category priority ranking (POS-configurable)
//
// The shop owner ranks categories in POS Settings; the order is persisted as
// `sort_order` on each category (synced down from the backend `display_order`).
// Lower `sort_order` = higher priority = shown first and bigger on the retail
// browse screen. Grocery tills scan ~90% of items, so the value is surfacing
// the few "must-tap" (no-barcode) fresh categories at the top.
// ---------------------------------------------------------------------------

/**
 * New mirrors store category media in `image_url`. Keep the URL-in-icon
 * fallback for one upgrade window so an old local DB can still render images
 * before migration/catalog refresh has repaired the row.
 */
export function categoryImageUrl(
  cat: { image_url?: string | null; icon?: string | null },
): string | null {
  const imageUrl = (cat.image_url || '').trim();
  if (imageUrl) return imageUrl;
  const legacyIcon = (cat.icon || '').trim();
  if (!legacyIcon) return null;
  return /^https?:\/\//i.test(legacyIcon)
    || legacyIcon.startsWith('//')
    || legacyIcon.startsWith('/')
    ? legacyIcon
    : null;
}

export type CategoryTier = 'big' | 'medium' | 'small';

/** Default rank → size bands: positions [0,big) big, [big,medium) medium, rest small. */
export const CATEGORY_TIER_BANDS: { big: number; medium: number } = { big: 3, medium: 8 };

/**
 * Sort categories by priority: ascending `sort_order`, tie-broken by name so
 * the order is stable when several categories share a rank (e.g. all 0 before
 * the owner ranks anything). Returns a new array; input is not mutated.
 */
export function sortCategoriesByRank<T extends { name: string; sort_order?: number | null }>(
  categories: T[],
): T[] {
  return [...categories].sort((a, b) => {
    const oa = a.sort_order ?? 0;
    const ob = b.sort_order ?? 0;
    if (oa !== ob) return oa - ob;
    return (a.name || '').localeCompare(b.name || '');
  });
}

/** Map a 0-based rank position to its render tier using the given bands. */
export function categoryTierForRank(
  position: number,
  bands: { big: number; medium: number } = CATEGORY_TIER_BANDS,
): CategoryTier {
  if (position < bands.big) return 'big';
  if (position < bands.medium) return 'medium';
  return 'small';
}

export interface CategoryTapCounts {
  /** Products with no barcode → cashier must tap them. */
  noBarcode: number;
  total: number;
}

/** Count "must-tap" (no-barcode) products per category id. */
export function countNoBarcodeByCategory(
  products: Array<{ category_id?: string | null; barcode?: string | null }>,
): Map<string, CategoryTapCounts> {
  const map = new Map<string, CategoryTapCounts>();
  for (const product of products) {
    if (!product.category_id) continue;
    const counts = map.get(product.category_id) ?? { noBarcode: 0, total: 0 };
    counts.total += 1;
    if (!product.barcode || product.barcode.trim() === '') counts.noBarcode += 1;
    map.set(product.category_id, counts);
  }
  return map;
}

/**
 * Auto-suggested priority order ("Gợi ý tự xếp"): categories whose products are
 * mostly missing a barcode (fresh produce, meat, herbs) float to the top, since
 * those are the ones a cashier actually taps. Ranks by no-barcode *ratio* desc,
 * tie-broken by absolute no-barcode count desc, then name. Returns category ids
 * in suggested priority order (assign sequential sort_order from this).
 */
export function suggestCategoryOrder<T extends { id: string; name: string }>(
  categories: T[],
  products: Array<{ category_id?: string | null; barcode?: string | null }>,
): string[] {
  const counts = countNoBarcodeByCategory(products);
  const ratioOf = (id: string): number => {
    const c = counts.get(id);
    return c && c.total > 0 ? c.noBarcode / c.total : 0;
  };
  return [...categories]
    .sort((a, b) => {
      const ra = ratioOf(a.id);
      const rb = ratioOf(b.id);
      if (rb !== ra) return rb - ra;
      const na = counts.get(a.id)?.noBarcode ?? 0;
      const nb = counts.get(b.id)?.noBarcode ?? 0;
      if (nb !== na) return nb - na;
      return (a.name || '').localeCompare(b.name || '');
    })
    .map((c) => c.id);
}
