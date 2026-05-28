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
