import { describe, expect, it } from 'vitest';
import {
  mergeProductsWithDrafts,
  type ProductListItem,
} from '../src/renderer/hooks/useProducts';

const BASE_PRODUCT: ProductListItem = {
  id: 'variant-1',
  template_id: 'template-1',
  name: 'Catalog product',
  sku: null,
  barcode: null,
  retail_price: 1000,
  category_id: null,
  image_url: null,
  in_stock: 1,
  available_qty: 1,
  vat_rate: 23,
  is_active: 1,
  updated_at: '2026-07-17T00:00:00.000Z',
};

const BASE_DRAFT = {
  id: 'draft-1',
  name: 'Draft product',
  sku: null,
  barcode: null,
  retail_price: 1000,
  category_id: null,
  image_url: null,
  in_stock: 0,
  vat_rate: 23,
  status: 'DRAFT',
  updated_at: '2026-07-17T00:00:00.000Z',
};

function mergedIds(products: ProductListItem[], drafts = [BASE_DRAFT]): string[] {
  return mergeProductsWithDrafts(products, drafts).map((product) => product.id);
}

describe('Products draft deduplication', () => {
  it('hides a draft whose barcode matches an active product', () => {
    const product = { ...BASE_PRODUCT, barcode: '8936150380032' };
    const draft = { ...BASE_DRAFT, barcode: '8936150380032' };

    expect(mergedIds([product], [draft])).toEqual(['variant-1']);
  });

  it('hides a draft whose SKU matches an active product', () => {
    const product = { ...BASE_PRODUCT, sku: 'EAN-8936150380032' };
    const draft = { ...BASE_DRAFT, sku: 'EAN-8936150380032' };

    expect(mergedIds([product], [draft])).toEqual(['variant-1']);
  });

  it('keeps a draft whose barcode only matches an inactive product', () => {
    const product = { ...BASE_PRODUCT, is_active: 0, barcode: '8936150380032' };
    const draft = { ...BASE_DRAFT, barcode: '8936150380032' };

    expect(mergedIds([product], [draft])).toEqual(['variant-1', 'draft:draft-1']);
  });

  it('keeps a draft whose SKU only matches an inactive product', () => {
    const product = { ...BASE_PRODUCT, is_active: 0, sku: 'EAN-8936150380032' };
    const draft = { ...BASE_DRAFT, sku: 'EAN-8936150380032' };

    expect(mergedIds([product], [draft])).toEqual(['variant-1', 'draft:draft-1']);
  });

  it('keeps draft visibility stable when devices have different inactive history', () => {
    const activeCatalog = [{ ...BASE_PRODUCT, id: 'active-1', barcode: '1111111111111' }];
    const staleInactive = { ...BASE_PRODUCT, id: 'inactive-1', is_active: 0, barcode: '8936150380032' };
    const draft = { ...BASE_DRAFT, barcode: '8936150380032' };

    const cleanDevice = mergedIds(activeCatalog, [draft]).filter((id) => id.startsWith('draft:'));
    const staleDevice = mergedIds([...activeCatalog, staleInactive], [draft])
      .filter((id) => id.startsWith('draft:'));

    expect(staleDevice).toEqual(cleanDevice);
    expect(staleDevice).toEqual(['draft:draft-1']);
  });
});
