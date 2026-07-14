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

  it('treats kg sale-unit products as weighted when backend omits sell_by', () => {
    expect(classifyProductSale({ sale_unit: 'kg' })).toMatchObject({
      kind: 'WEIGHTED',
      sellBy: 'WEIGHT',
      saleUnit: 'kg',
      isWeighted: true,
      requiresScale: true,
      quantityInputMode: 'decimal',
      priceSuffix: '/kg',
    });
  });

  it('keeps legacy kg products weighted when sell_by is stale PIECE', () => {
    expect(classifyProductSale({ sell_by: 'PIECE', sale_unit: 'kg' })).toMatchObject({
      kind: 'WEIGHTED',
      sellBy: 'WEIGHT',
      quantityInputMode: 'decimal',
    });
  });

  it('supports camelCase backend/admin shapes too', () => {
    const product = { sellBy: 'WEIGHT', saleUnit: 'kg' };

    expect(isWeightedProduct(product)).toBe(true);
    expect(isNormalProduct(product)).toBe(false);
  });
});
