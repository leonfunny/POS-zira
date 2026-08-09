import { describe, expect, it } from 'vitest';
import type { Category } from '../src/renderer/hooks/usePosDb';
import {
  countMergedUncategorisedProducts,
  findUncategorisedCategory,
  isInMergedUncategorisedCategory,
} from '../src/renderer/components/products/uncategorised-category';

function category(overrides: Partial<Category>): Category {
  return {
    id: 'category-id',
    name: 'Category',
    image_url: null,
    icon: null,
    color: null,
    sort_order: 0,
    updated_at: null,
    ...overrides,
  };
}

describe('merged uncategorised category', () => {
  it('recognises the backend fallback name with or without Vietnamese diacritics', () => {
    const accented = category({ id: 'accented', name: 'Chưa phân loại' });
    const translated = category({
      id: 'translated',
      name: 'Bez kategorii',
      name_translations: JSON.stringify({ vi: 'Chua phan loai' }),
    });

    expect(findUncategorisedCategory([accented])).toEqual(accented);
    expect(findUncategorisedCategory([translated])).toEqual(translated);
    expect(findUncategorisedCategory([category({ name: 'Napoje' })])).toBeNull();
  });

  it('counts and opens null products together with products assigned to the real fallback category', () => {
    const products = [
      { category_id: null },
      { category_id: 'fallback-id' },
      { category_id: 'drinks-id' },
    ];

    expect(countMergedUncategorisedProducts(products, 'fallback-id')).toBe(2);
    expect(isInMergedUncategorisedCategory(null, 'fallback-id')).toBe(true);
    expect(isInMergedUncategorisedCategory('fallback-id', 'fallback-id')).toBe(true);
    expect(isInMergedUncategorisedCategory('drinks-id', 'fallback-id')).toBe(false);
  });

  it('keeps the synthetic null-only bucket when the backend fallback is absent', () => {
    const products = [{ category_id: null }, { category_id: 'drinks-id' }];

    expect(countMergedUncategorisedProducts(products, null)).toBe(1);
  });
});
