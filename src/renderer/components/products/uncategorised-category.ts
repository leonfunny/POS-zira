import { parseTranslations } from '../../../shared/catalog-names';
import type { Category } from '../../hooks/usePosDb';

const DEFAULT_UNCATEGORISED_NAME = 'chua phan loai';

function normalizeCategoryName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase();
}

/**
 * The backend creates this fallback category for imports it cannot classify.
 * The POS mirror does not currently expose the category slug, so match the
 * canonical backend name (or one of its translations) without diacritics.
 */
export function findUncategorisedCategory(categories: readonly Category[]): Category | null {
  return categories.find((category) => {
    const names = [category.name, ...Object.values(parseTranslations(category.name_translations))];
    return names.some((name) => normalizeCategoryName(name) === DEFAULT_UNCATEGORISED_NAME);
  }) ?? null;
}

export function isInMergedUncategorisedCategory(
  productCategoryId: string | null,
  uncategorisedCategoryId: string | null,
): boolean {
  return productCategoryId == null
    || (uncategorisedCategoryId !== null && productCategoryId === uncategorisedCategoryId);
}

export function countMergedUncategorisedProducts(
  products: readonly { category_id: string | null }[],
  uncategorisedCategoryId: string | null,
): number {
  return products.filter((product) => (
    isInMergedUncategorisedCategory(product.category_id, uncategorisedCategoryId)
  )).length;
}
