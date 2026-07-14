import { describe, expect, it } from 'vitest';
import {
  calculateLineTotalGrosze,
  formatSaleQuantity,
  isValidManualWeightQuantity,
  isValidSaleQuantity,
  normalizeSellBy,
  resolveSaleQuantity,
} from '../src/shared/pos-sale';
import { buildBackendOrderItem } from '../src/main/pos/order-line-contract';
import { adaptServerOrderItem } from '../src/main/sync/pos-order-adapter';

describe('weighted fresh-food POS contract', () => {
  it('rounds weighted line totals with integer gram math', () => {
    expect(calculateLineTotalGrosze(8000, 0.238, 'WEIGHT')).toBe(1904);
    expect(calculateLineTotalGrosze(3333, 0.5, 'WEIGHT')).toBe(1667);
  });

  it('normalizes the dedicated sell_by flag only', () => {
    expect(normalizeSellBy('WEIGHT')).toBe('WEIGHT');
    expect(normalizeSellBy('kg')).toBe('PIECE');
  });

  it('builds weighted backend payloads without rounding to packQuantity', () => {
    const payload = buildBackendOrderItem({
      id: 'line-1',
      variant_id: 'variant-ginger',
      sku: 'GINGER',
      price: 8000,
      quantity: 0.238,
      sale_quantity: 0.238,
      sale_unit: 'kg',
      sell_by: 'WEIGHT',
    });

    expect(payload).toMatchObject({
      productId: 'variant-ginger',
      variantId: 'variant-ginger',
      variantSku: 'GINGER',
      customPrice: 80,
      saleQuantity: 0.238,
      saleUnit: 'kg',
    });
    expect(payload).not.toHaveProperty('packQuantity');
  });

  it('keeps piece payloads on the legacy packQuantity contract', () => {
    expect(buildBackendOrderItem({
      id: 'line-1',
      variant_id: 'variant-can',
      price: 500,
      quantity: 2,
      sell_by: 'PIECE',
    })).toMatchObject({
      productId: 'variant-can',
      variantId: 'variant-can',
      packQuantity: 2,
      customPrice: 5,
    });
  });

  it('adapts weighted server lines through saleQuantity and saleUnit', () => {
    const item = adaptServerOrderItem({
      id: 'item-1',
      variantId: 'variant-ginger',
      productName: 'Rieng cu',
      variantSku: 'GINGER',
      unitPrice: '80.00',
      saleQuantity: '0.238',
      saleUnit: 'kg',
      sellBy: 'WEIGHT',
      taxRate: 5,
    }, 'order-1');

    expect(item).toMatchObject({
      quantity: 0.238,
      sale_quantity: 0.238,
      sale_unit: 'kg',
      sell_by: 'WEIGHT',
      total: 1904,
    });
  });

  it('formats weighted quantities without dropping gram precision', () => {
    expect(resolveSaleQuantity({ sale_quantity: 0.238, sell_by: 'WEIGHT' })).toBe(0.238);
    expect(formatSaleQuantity(0.238, 'WEIGHT')).toBe('0.238');
    expect(formatSaleQuantity(1, 'WEIGHT')).toBe('1');
  });

  it('rejects fractional pieces and non-number runtime quantities', () => {
    expect(isValidSaleQuantity(2, 'PIECE')).toBe(true);
    expect(isValidSaleQuantity(2.1, 'PIECE')).toBe(false);
    expect(isValidSaleQuantity(2.1, 'WEIGHT')).toBe(true);
    expect(isValidSaleQuantity('2' as unknown, 'PIECE')).toBe(false);
    expect(isValidSaleQuantity(null, 'PIECE')).toBe(false);
  });

  it('accepts only positive manual weights up to 999 kg with gram precision', () => {
    expect(isValidManualWeightQuantity(0.001)).toBe(true);
    expect(isValidManualWeightQuantity(1.125)).toBe(true);
    expect(isValidManualWeightQuantity(1.1255)).toBe(false);
    expect(isValidManualWeightQuantity(0)).toBe(false);
    expect(isValidManualWeightQuantity(999.001)).toBe(false);
  });
});
