import { describe, it, expect } from 'vitest';
import type { Category, Product } from '../src/renderer/hooks/usePosDb';
import {
  sortCategoriesByRank,
  categoryTierForRank,
  countNoBarcodeByCategory,
  suggestCategoryOrder,
  categoryImageUrl,
  CATEGORY_TIER_BANDS,
} from '../src/renderer/components/pos/templates/retail/retailBrowseFilters';

const cat = (id: string, name: string, sort_order: number): Category =>
  ({ id, name, image_url: null, icon: null, color: null, sort_order, updated_at: null } as Category);

const prod = (id: string, category_id: string | null, barcode: string | null): Product =>
  ({ id, name: id, category_id, barcode } as Product);

describe('sortCategoriesByRank', () => {
  it('orders by ascending sort_order, then name', () => {
    const out = sortCategoriesByRank([
      cat('c', 'Zebra', 5),
      cat('a', 'Apple', 1),
      cat('b', 'Mango', 1),
    ]);
    expect(out.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const input = [cat('x', 'X', 2), cat('y', 'Y', 1)];
    sortCategoriesByRank(input);
    expect(input.map((c) => c.id)).toEqual(['x', 'y']);
  });
});

describe('categoryTierForRank', () => {
  it('maps positions to big/medium/small using default bands (3/8)', () => {
    expect(categoryTierForRank(0)).toBe('big');
    expect(categoryTierForRank(2)).toBe('big');
    expect(categoryTierForRank(3)).toBe('medium');
    expect(categoryTierForRank(7)).toBe('medium');
    expect(categoryTierForRank(8)).toBe('small');
    expect(categoryTierForRank(99)).toBe('small');
  });

  it('respects custom bands', () => {
    expect(categoryTierForRank(1, { big: 1, medium: 2 })).toBe('medium');
    expect(categoryTierForRank(0, CATEGORY_TIER_BANDS)).toBe('big');
  });
});

describe('countNoBarcodeByCategory', () => {
  it('counts no-barcode and total per category, ignoring uncategorized', () => {
    const counts = countNoBarcodeByCategory([
      prod('1', 'veg', null),
      prod('2', 'veg', ''),
      prod('3', 'veg', '590123'),
      prod('4', 'snacks', '590999'),
      prod('5', null, null),
    ]);
    expect(counts.get('veg')).toEqual({ noBarcode: 2, total: 3 });
    expect(counts.get('snacks')).toEqual({ noBarcode: 0, total: 1 });
    expect(counts.has(null as any)).toBe(false);
  });

  it('treats whitespace-only barcode as no barcode', () => {
    const counts = countNoBarcodeByCategory([prod('1', 'veg', '   ')]);
    expect(counts.get('veg')).toEqual({ noBarcode: 1, total: 1 });
  });
});

describe('suggestCategoryOrder', () => {
  it('ranks high no-barcode-ratio categories first', () => {
    const categories = [
      cat('snacks', 'Snacks', 0),
      cat('veg', 'Veg', 0),
      cat('drinks', 'Drinks', 0),
    ];
    const products = [
      // veg: 3/3 no barcode → ratio 1.0
      prod('v1', 'veg', null), prod('v2', 'veg', null), prod('v3', 'veg', null),
      // drinks: 1/2 no barcode → ratio 0.5
      prod('d1', 'drinks', null), prod('d2', 'drinks', '59'),
      // snacks: 0/2 → ratio 0
      prod('s1', 'snacks', '11'), prod('s2', 'snacks', '12'),
    ];
    expect(suggestCategoryOrder(categories, products)).toEqual(['veg', 'drinks', 'snacks']);
  });

  it('tie-breaks equal ratio by absolute no-barcode count', () => {
    const categories = [cat('a', 'A', 0), cat('b', 'B', 0)];
    const products = [
      // both ratio 1.0, but b has more no-barcode items
      prod('a1', 'a', null),
      prod('b1', 'b', null), prod('b2', 'b', null),
    ];
    expect(suggestCategoryOrder(categories, products)).toEqual(['b', 'a']);
  });
});

describe('categoryImageUrl', () => {
  const category = (image_url: string | null, icon: string | null): Category =>
    ({ id: 'c', name: 'C', image_url, icon, color: null, sort_order: 0, updated_at: null } as Category);

  it('prefers the canonical image_url field', () => {
    expect(categoryImageUrl(category(
      'https://img.zira.pl/categories/canonical.jpg',
      'https://img.zira.pl/categories/legacy.jpg',
    ))).toBe('https://img.zira.pl/categories/canonical.jpg');
  });

  it('falls back when a legacy icon holds an image url', () => {
    expect(categoryImageUrl(category(null, 'https://img.zira.pl/quick-add/chesaigon/categories/cat-1.jpg')))
      .toBe('https://img.zira.pl/quick-add/chesaigon/categories/cat-1.jpg');
    expect(categoryImageUrl(category(null, '//img.zira.pl/x.jpg'))).toBe('//img.zira.pl/x.jpg');
    expect(categoryImageUrl(category(null, '/uploads/x.jpg'))).toBe('/uploads/x.jpg');
  });

  it('returns null for emoji / short glyphs / empty', () => {
    expect(categoryImageUrl(category(null, '🥬'))).toBeNull();
    expect(categoryImageUrl(category(null, 'AB'))).toBeNull();
    expect(categoryImageUrl(category(null, ''))).toBeNull();
    expect(categoryImageUrl(category(null, null))).toBeNull();
  });
});
