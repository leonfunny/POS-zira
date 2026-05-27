import { describe, expect, it } from 'vitest';
import {
  classifyProductSale,
  isNormalProduct,
  isWeightedProduct,
} from '../src/shared/product-sale-classifier';

describe('product sale classifier', () => {
  it('classifies dedicated WEIGHT products as weighted scale products', () => {
    expect(classifyProductSale({ sell_by: 'WEIGHT', sale_unit: 'kg' })).toMatchObject({
      kind: 'WEIGHTED',
      sellBy: 'WEIGHT',
      saleUnit: 'kg',
      isWeighted: true,
      requiresScale: true,
      quantityInputMode: 'decimal',
      priceSuffix: '/kg',
    });
  });

  it('keeps products normal unless sell_by is explicitly WEIGHT', () => {
    expect(classifyProductSale({ sale_unit: 'kg' })).toMatchObject({
      kind: 'NORMAL',
      sellBy: 'PIECE',
      saleUnit: 'kg',
      isNormal: true,
      requiresScale: false,
      quantityInputMode: 'integer',
      priceSuffix: '',
    });
  });

  it('supports camelCase backend/admin shapes too', () => {
    const product = { sellBy: 'WEIGHT', saleUnit: 'kg' };

    expect(isWeightedProduct(product)).toBe(true);
    expect(isNormalProduct(product)).toBe(false);
  });
});
