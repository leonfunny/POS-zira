import type { ProductAdminCategory, ProductAdminCategoryOrderUpdate } from '../../../shared/types';
import type { Category } from '../../hooks/usePosDb';

export function buildCategoryOrderUpdates(ordered: Category[]): ProductAdminCategoryOrderUpdate[] {
  return ordered
    .map((category, index) => ({
      id: category.id,
      sortOrder: index,
      previousSortOrder: category.sort_order ?? 0,
      expectedUpdatedAt: category.updated_at || undefined,
    }))
    .filter((update) => update.previousSortOrder !== update.sortOrder)
    .map(({ id, sortOrder, expectedUpdatedAt }) => ({ id, sortOrder, expectedUpdatedAt }));
}

/**
 * Merge the canonical OCC revisions returned by a successful batch save while
 * preserving any newer drag operation made while that request was in flight.
 * `sort_order` remains the last persisted baseline, so a queued second save
 * compares the current visual order against what the server just committed.
 */
export function mergePersistedCategoryOrder(
  currentOrder: Category[],
  persistedTarget: Category[],
  canonicalCategories: ProductAdminCategory[],
): Category[] {
  const persistedRanks = new Map(persistedTarget.map((category, index) => [category.id, index]));
  const canonicalById = new Map(canonicalCategories.map((category) => [category.id, category]));

  return currentOrder.map((category) => {
    const canonical = canonicalById.get(category.id);
    return {
      ...category,
      name: canonical?.name || category.name,
      color: canonical && Object.prototype.hasOwnProperty.call(canonical, 'color')
        ? canonical.color ?? null
        : category.color,
      icon: canonical && Object.prototype.hasOwnProperty.call(canonical, 'icon')
        ? canonical.icon ?? null
        : category.icon,
      sort_order: persistedRanks.get(category.id) ?? category.sort_order,
      updated_at: canonical?.updatedAt || category.updated_at,
    };
  });
}
