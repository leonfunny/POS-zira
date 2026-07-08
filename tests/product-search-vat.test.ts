import { describe, expect, it } from 'vitest';
import { getSearchSubmitResult } from '../src/renderer/components/products/product-search-submit';
import { resolveProductVatRates } from '../src/renderer/components/products/product-vat-rates';

describe('product search submit', () => {
  it('selects the first text result before resolving the query as a code', () => {
    const first = { id: 'cleaner', name: 'Cleaner 500ml' };
    expect(getSearchSubmitResult([first, { id: 'other' }])).toBe(first);
  });

  it('falls back to code resolution when there is no text result', () => {
    expect(getSearchSubmitResult([])).toBeNull();
  });
});

describe('product VAT rates', () => {
  it('uses active non-negative configured rates in display order', () => {
    expect(resolveProductVatRates([
      { rate: 5, is_active: 1, display_order: 3 },
      { rate: -1, is_active: 1, display_order: 4 },
      { rate: 23, is_active: 1, display_order: 1 },
      { rate: 8, is_active: 0, display_order: 2 },
    ])).toEqual([23, 5]);
  });

  it('falls back to Polish product rates and preserves the current legacy value', () => {
    expect(resolveProductVatRates([], 7)).toEqual([23, 8, 5, 0, 7]);
    expect(resolveProductVatRates([], 0)).toEqual([23, 8, 5, 0]);
  });
});
