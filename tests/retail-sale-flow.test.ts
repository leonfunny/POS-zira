import { describe, expect, it, vi } from 'vitest';
import { resolveRetailCartItem } from '../src/renderer/components/pos/retail-sale-flow';
import type { Product } from '../src/renderer/hooks/usePosDb';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'variant-1',
    template_id: null,
    name: 'Test product',
    sku: 'TEST',
    barcode: '123',
    retail_price: 8000,
    category_id: 'cat-1',
    image_url: null,
    in_stock: 10,
    vat_rate: 5,
    is_active: 1,
    updated_at: null,
    ...overrides,
  };
}

describe('retail sale flow', () => {
  it('adds normal products as one piece without reading the scale', async () => {
    const readWeight = vi.fn();

    const result = await resolveRetailCartItem(product(), {
      readWeight,
      generateId: () => 'line-normal',
    });

    expect(result.ok).toBe(true);
    expect(readWeight).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.item).toMatchObject({
        id: 'line-normal',
        quantity: 1,
        total: 8000,
        saleUnit: 'szt',
        sellBy: 'PIECE',
      });
    }
  });

  it('reads the scale and prices weighted products by kg', async () => {
    const readWeight = vi.fn().mockResolvedValue({
      success: true,
      protocol: 'DIBAL_GDPOS',
      port: 'COM5',
      weightKg: 0.238,
      stable: true,
      status: 'S',
      rawAscii: '',
      rawHex: '',
    });

    const result = await resolveRetailCartItem(product({ sell_by: 'WEIGHT', sale_unit: 'kg' }), {
      scaleEnabled: true,
      scalePort: 'COM5',
      readWeight,
      generateId: () => 'line-weight',
    });

    expect(readWeight).toHaveBeenCalledWith({ port: 'COM5' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item).toMatchObject({
        id: 'line-weight',
        quantity: 0.238,
        total: 1904,
        saleUnit: 'kg',
        sellBy: 'WEIGHT',
      });
    }
  });
});
