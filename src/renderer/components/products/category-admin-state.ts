import type {
  ProductAdminCategory,
  ProductAdminCategoryOrderUpdate,
} from '../../../shared/types';

const SIX_DIGIT_HEX_COLOR = /^#[0-9a-f]{6}$/i;

interface CategoryCreateFailure {
  status?: number;
  code?: string;
}

export function isValidCategoryColor(value: string): boolean {
  const color = value.trim();
  return color.length === 0 || SIX_DIGIT_HEX_COLOR.test(color);
}

export function isValidCategoryIcon(value: string): boolean {
  return [...value.trim()].length <= 2;
}

// Keep this conservative and aligned with the durable mutation outbox: only a
// clear client rejection proves that the create request did not commit.
export function isDefinitiveCategoryCreateFailure(failure: CategoryCreateFailure): boolean {
  const status = Number(failure.status);
  const code = String(failure.code || '').toUpperCase();
  if (status === 401 || status === 408 || status === 425 || status === 429
    || status >= 500
    || code === 'UNAUTHORIZED_PRODUCT_ADMIN'
    || code === 'UNSUPPORTED_CAPABILITY'
    || code === 'SALON_CONTEXT_MISMATCH'
    || code.includes('TIMEOUT')
    || code.includes('NETWORK')
    || code.includes('CONNECTION')
    || code.includes('IN_PROGRESS')) return false;
  return Number.isInteger(status) && status >= 400 && status < 500;
}

export function shouldKeepCategoryCreateAttemptLocked(
  wasAlreadyLocked: boolean,
  failure: CategoryCreateFailure,
): boolean {
  // Once a request has had an ambiguous outcome, a later 4xx cannot prove
  // that the original dispatch did not commit. This mirrors the outbox rule.
  return wasAlreadyLocked || !isDefinitiveCategoryCreateFailure(failure);
}

export function nextCategorySortOrder(categories: ProductAdminCategory[]): number {
  const nextAfterHighest = categories.reduce((highest, category) => (
    typeof category.sortOrder === 'number' && Number.isFinite(category.sortOrder)
      ? Math.max(highest, category.sortOrder)
      : highest
  ), -1) + 1;
  return Math.max(nextAfterHighest, categories.length);
}

export function moveCategoryAndNormalize(
  categories: ProductAdminCategory[],
  categoryId: string,
  direction: -1 | 1,
): ProductAdminCategory[] {
  const fromIndex = categories.findIndex((category) => category.id === categoryId);
  const toIndex = fromIndex + direction;
  if (fromIndex < 0 || toIndex < 0 || toIndex >= categories.length) return categories;

  const ordered = [...categories];
  const [moved] = ordered.splice(fromIndex, 1);
  ordered.splice(toIndex, 0, moved);
  return ordered.map((category, index) => ({ ...category, sortOrder: index }));
}

export function buildAdminCategoryOrderUpdates(
  categories: ProductAdminCategory[],
): ProductAdminCategoryOrderUpdate[] {
  return categories.map((category, index) => ({
    id: category.id,
    sortOrder: index,
    expectedUpdatedAt: category.updatedAt || undefined,
  }));
}
