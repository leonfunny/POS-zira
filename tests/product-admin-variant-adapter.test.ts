import { describe, expect, test } from 'vitest';

import {
  productAdminVariantToCartLine,
  productAdminVariantToProduct,
} from '../src/renderer/components/products/product-admin-variant-adapter';

const variant = {
  id: 'variant-1', templateId: 'template-1', name: 'Native EAN item', sku: 'SKU-1', barcode: '5901234567890',
  priceGrossGrosze: 1299, retailPrice: 12.99, vatRate: 23, totalStockQty: 7, availableQty: 6,
  isActive: true, saleUnit: 'szt', sellBy: 'PIECE' as const, updatedAt: '2026-08-09T00:00:00.000Z',
};

describe('product-admin variant adapter', () => {
  test('keeps backend EAN, grosze, quantity and VAT exact in the local product row', () => {
    expect(productAdminVariantToProduct(variant)).toMatchObject({
      id: 'variant-1', barcode: '5901234567890', retail_price: 1299,
      in_stock: 7, available_qty: 6, vat_rate: 23, sell_by: 'PIECE', sale_unit: 'szt',
    });
  });

  test('adds the exact native-created item as one POS cart line', () => {
    const outcome = productAdminVariantToCartLine(variant, 'line-1');
    expect(outcome.kind).toBe('cart-line');
    if (outcome.kind !== 'cart-line') throw new Error('expected a piece cart line');
    expect(outcome.line).toEqual({
      id: 'line-1', variantId: 'variant-1', name: 'Native EAN item', sku: 'SKU-1',
      price: 1299, quantity: 1, total: 1299, saleUnit: 'szt', sellBy: 'PIECE',
      imageUrl: undefined, vatRate: 23, name_translations: null,
    });
  });

  test('refuses to auto-add a weighted variant as one kilogram', () => {
    const outcome = productAdminVariantToCartLine({ ...variant, saleUnit: 'kg', sellBy: 'WEIGHT' }, 'line-weight');
    expect(outcome).toMatchObject({
      kind: 'manual-weight',
      product: { id: 'variant-1' },
      saleClass: { requiresScale: true },
    });
  });
});
