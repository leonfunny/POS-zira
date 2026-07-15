import { describe, expect, it } from 'vitest';
import { formatStockQuantity, productStockDisplay } from '../src/renderer/components/products/product-stock-display';

describe('product stock display contract', () => {
  it('keeps available-to-sell separate from physical stock', () => {
    expect(productStockDisplay({ in_stock: -1, available_qty: 0 })).toEqual({
      physical: -1,
      available: 0,
      differs: true,
    });
  });

  it('falls back in either direction for legacy rows', () => {
    expect(productStockDisplay({ in_stock: 4 })).toEqual({ physical: 4, available: 4, differs: false });
    expect(productStockDisplay({ available_qty: 3 })).toEqual({ physical: 3, available: 3, differs: false });
  });

  it('formats integer and weighted quantities without noisy zeroes', () => {
    expect(formatStockQuantity(12)).toBe('12');
    expect(formatStockQuantity(1.25)).toBe('1.25');
    expect(formatStockQuantity(Number.NaN)).toBe('0');
  });
});
