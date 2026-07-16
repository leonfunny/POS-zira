import { describe, expect, it } from 'vitest';
import type { ProductAdminCategory } from '../src/shared/types';
import {
  buildAdminCategoryOrderUpdates,
  isDefinitiveCategoryCreateFailure,
  isValidCategoryColor,
  isValidCategoryIcon,
  moveCategoryAndNormalize,
  nextCategorySortOrder,
  shouldKeepCategoryCreateAttemptLocked,
} from '../src/renderer/components/products/category-admin-state';

function category(id: string, sortOrder: number | null, updatedAt = `rev-${id}`): ProductAdminCategory {
  return {
    id,
    name: id.toUpperCase(),
    sortOrder,
    isActive: true,
    updatedAt,
  };
}

describe('category admin state', () => {
  it('accepts only an empty color or a six-digit hex color', () => {
    expect(isValidCategoryColor('')).toBe(true);
    expect(isValidCategoryColor('  #A1b2C3  ')).toBe(true);
    expect(isValidCategoryColor('#abc')).toBe(false);
    expect(isValidCategoryColor('red')).toBe(false);
  });

  it('accepts at most two icon code points', () => {
    expect(isValidCategoryIcon('')).toBe(true);
    expect(isValidCategoryIcon('🥤')).toBe(true);
    expect(isValidCategoryIcon('DR')).toBe(true);
    expect(isValidCategoryIcon('ABC')).toBe(false);
  });

  it('distinguishes definitive create rejection from an uncertain mutation outcome', () => {
    expect(isDefinitiveCategoryCreateFailure({ status: 422, code: 'INVALID_CATEGORY' })).toBe(true);
    expect(isDefinitiveCategoryCreateFailure({ status: 409, code: 'IDEMPOTENCY_CONFLICT' })).toBe(true);
    expect(isDefinitiveCategoryCreateFailure({ status: 408, code: 'TIMEOUT' })).toBe(false);
    expect(isDefinitiveCategoryCreateFailure({ status: 503 })).toBe(false);
    expect(isDefinitiveCategoryCreateFailure({ code: 'NETWORK_ERROR' })).toBe(false);
  });

  it('never unlocks an attempt after an earlier outcome was ambiguous', () => {
    expect(shouldKeepCategoryCreateAttemptLocked(false, { status: 422 })).toBe(false);
    expect(shouldKeepCategoryCreateAttemptLocked(false, { status: 503 })).toBe(true);
    expect(shouldKeepCategoryCreateAttemptLocked(true, { status: 422 })).toBe(true);
  });

  it('places a new category after the highest existing order', () => {
    expect(nextCategorySortOrder([])).toBe(0);
    expect(nextCategorySortOrder([
      category('a', null),
      category('b', 2),
      category('c', 8),
    ])).toBe(9);
    expect(nextCategorySortOrder([
      category('a', null),
      category('b', null),
      category('c', null),
    ])).toBe(3);
  });

  it('moves a category and normalizes every order to a unique contiguous rank', () => {
    const initial = [category('a', 0), category('b', 0), category('c', 9)];

    const moved = moveCategoryAndNormalize(initial, 'c', -1);

    expect(moved.map((row) => [row.id, row.sortOrder])).toEqual([
      ['a', 0],
      ['c', 1],
      ['b', 2],
    ]);
    expect(buildAdminCategoryOrderUpdates(moved)).toEqual([
      { id: 'a', sortOrder: 0, expectedUpdatedAt: 'rev-a' },
      { id: 'c', sortOrder: 1, expectedUpdatedAt: 'rev-c' },
      { id: 'b', sortOrder: 2, expectedUpdatedAt: 'rev-b' },
    ]);
  });

  it('does not move a category beyond either boundary', () => {
    const initial = [category('a', 0), category('b', 1)];

    expect(moveCategoryAndNormalize(initial, 'a', -1)).toBe(initial);
    expect(moveCategoryAndNormalize(initial, 'b', 1)).toBe(initial);
  });
});
