import { describe, expect, it } from 'vitest';
import {
  productStatusKind,
  type ProductStatusKind,
} from '../src/renderer/components/products/ProductStatusBadge';
import type { ProductListItem } from '../src/renderer/hooks/useProducts';

const BASE_PRODUCT: ProductListItem = {
  id: 'variant-1',
  template_id: 'template-1',
  name: 'Test product',
  sku: null,
  barcode: null,
  retail_price: 1000,
  category_id: null,
  image_url: null,
  in_stock: 10,
  available_qty: 10,
  vat_rate: 23,
  is_active: 1,
  updated_at: '2026-07-15T00:00:00.000Z',
};

function status(overrides: Partial<ProductListItem>): ProductStatusKind {
  return productStatusKind({ ...BASE_PRODUCT, ...overrides });
}

describe('ProductStatusBadge state priority', () => {
  it('keeps lifecycle and pricing states ahead of stock states', () => {
    expect(status({ _isDraft: true, is_active: 0, retail_price: 0, in_stock: -1 })).toBe('draft');
    expect(status({ is_active: 0, retail_price: 0, in_stock: -1 })).toBe('inactive');
    expect(status({ retail_price: 0, item_type: 'service', in_stock: -1 })).toBe('noPrice');
  });

  it('labels non-stock-tracked items without calling them out of stock', () => {
    expect(status({ item_type: 'service', in_stock: 0, available_qty: 0 })).toBe('service');
    expect(status({ item_type: 'consumable', in_stock: 0, available_qty: 0 })).toBe('notTracked');
    expect(status({ item_type: 'stockable', track_inventory: 0, in_stock: 0 })).toBe('notTracked');
  });

  it('distinguishes negative, zero, low, and healthy tracked stock', () => {
    expect(status({ in_stock: -1, available_qty: 0 })).toBe('oversold');
    expect(status({ in_stock: 2, available_qty: -1 })).toBe('oversold');
    expect(status({ in_stock: 0, available_qty: 0 })).toBe('outOfStock');
    expect(status({ in_stock: 5, available_qty: 5 })).toBe('lowStock');
    expect(status({ in_stock: 6, available_qty: 6 })).toBe('active');
  });
});
