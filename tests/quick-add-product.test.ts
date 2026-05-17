import { describe, expect, it } from 'vitest';
import { toQuickAddVariantRow } from '../src/main/pos/quick-add-product';

describe('toQuickAddVariantRow', () => {
  it('turns a quick-add mutation response into an immediately sellable local row', () => {
    expect(toQuickAddVariantRow(
      {
        id: 'product-1',
        name: 'Klej szkolny',
        ean: '5901234567890',
        imageUrl: 'https://example.test/front.jpg',
        weightUnit: 'g',
      },
      {
        id: 'variant-1',
        sku: 'SKU-1',
        totalStockQty: 7,
        availableQty: 7,
        taxRate: 8,
      },
      { retailPriceGrosze: 1299, quantity: 7 },
    )).toMatchObject({
      id: 'variant-1',
      template_id: 'product-1',
      name: 'Klej szkolny',
      sku: 'SKU-1',
      barcode: '5901234567890',
      retail_price: 1299,
      image_url: 'https://example.test/front.jpg',
      in_stock: 7,
      available_qty: 7,
      vat_rate: 8,
      price_gross: 1299,
      sale_unit: 'g',
    });
  });

  it('returns null when the backend did not return a variant id', () => {
    expect(toQuickAddVariantRow({ id: 'product-1' }, null, {
      retailPriceGrosze: 999,
      quantity: 1,
    })).toBeNull();
  });
});
