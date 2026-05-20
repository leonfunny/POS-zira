import type {
  CatalogCategory,
  CatalogDepartment,
  SearchProduct,
} from './types';

export function getProductPriceGrosze(product: SearchProduct): number {
  const value = product.retail_price ?? product.price ?? product.price_gross;
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
}

export function getProductStock(product: SearchProduct): number | undefined {
  const value = product.in_stock ?? product.available_qty;
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

export type ProductAvailabilityReason = 'no_price' | 'out_of_stock' | null;

export interface ProductAvailability {
  canAdd: boolean;
  reason: ProductAvailabilityReason;
  priceGrosze: number;
  stock?: number;
}

export function getProductAvailability(product: SearchProduct): ProductAvailability {
  const priceGrosze = getProductPriceGrosze(product);
  const stock = getProductStock(product);
  if (priceGrosze <= 0) {
    return { canAdd: false, reason: 'no_price', priceGrosze, stock };
  }
  if (typeof stock === 'number' && stock <= 0) {
    return { canAdd: false, reason: 'out_of_stock', priceGrosze, stock };
  }
  return { canAdd: true, reason: null, priceGrosze, stock };
}

export function normalizeCatalogText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function getCategorySearchText(category: CatalogCategory | undefined): string {
  if (!category) return '';
  return normalizeCatalogText(`${category.id || ''} ${category.name || ''} ${category.name_translations || ''}`);
}

export function getCategoryDepartment(category: CatalogCategory | undefined): CatalogDepartment {
  const text = getCategorySearchText(category);
  const kitchenKeywords = [
    'kitchen',
    'kuchnia',
    'restaurant',
    'restauracja',
    'menu',
    'food',
    'foods',
    'meal',
    'meals',
    'dish',
    'dishes',
    'drink',
    'drinks',
    'beverage',
    'bar',
    'cafe',
    'coffee',
    'tea',
    'dessert',
    'combo',
    'dania',
    'zupy',
    'zupa',
    'makaron',
    'ryz',
    'rice',
    'pho',
    'burger',
    'pizza',
    'napoje',
    'napoj',
    'kawa',
    'herbata',
    'ciasto',
    'deser',
    'bep',
    'nha bep',
    'do an',
    'mon an',
    'nuoc',
    'tra',
    'ca phe',
  ];
  return kitchenKeywords.some((keyword) => text.includes(keyword)) ? 'kitchen' : 'grocery';
}

function buildCategoryMap(categories: CatalogCategory[]): Map<string, CatalogCategory> {
  const map = new Map<string, CatalogCategory>();
  for (const category of categories) map.set(category.id, category);
  return map;
}

export function buildVisibleCategories(
  categories: CatalogCategory[],
  products: SearchProduct[],
  activeDepartment: CatalogDepartment,
): CatalogCategory[] {
  const categoryById = buildCategoryMap(categories);
  const ids = new Set(
    products
      .filter((product) => {
        const category = product.category_id ? categoryById.get(product.category_id) : undefined;
        return getCategoryDepartment(category) === activeDepartment;
      })
      .map((product) => product.category_id)
      .filter((id): id is string => !!id),
  );
  return categories.filter((category) => ids.has(category.id));
}

export function buildVisibleProducts(
  categories: CatalogCategory[],
  products: SearchProduct[],
  activeDepartment: CatalogDepartment,
  activeCategoryId: string | null,
  limit = 48,
): SearchProduct[] {
  const categoryById = buildCategoryMap(categories);
  return products
    .filter((product) => {
      const category = product.category_id ? categoryById.get(product.category_id) : undefined;
      if (getCategoryDepartment(category) !== activeDepartment) return false;
      if (activeCategoryId && product.category_id !== activeCategoryId) return false;
      return true;
    })
    .slice(0, limit);
}
