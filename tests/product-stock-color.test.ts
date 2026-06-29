import { describe, expect, it } from 'vitest';

import { stockColor, stockTileClasses } from '../src/renderer/components/products/product-stock-color';

describe('product stock color', () => {
  it.each([
    [0, 'red'],
    [-3, 'red'],
    [1, 'amber'],
    [5, 'amber'],
    [6, 'green'],
  ] as const)('maps stock %s to %s', (quantity, expected) => {
    expect(stockColor(quantity)).toBe(expected);
  });

  it('returns usable tile classes for every stock band', () => {
    expect(stockTileClasses(0)).toContain('bg-rose-500');
    expect(stockTileClasses(5)).toContain('bg-amber-400');
    expect(stockTileClasses(6)).toContain('bg-emerald-500');
  });
});
