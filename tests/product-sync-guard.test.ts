import { describe, expect, it } from 'vitest';
import {
  evaluateProductSyncGuard,
  ProductSyncGuardError,
  type ProductSyncGuardBaseline,
} from '../src/main/sync/product-sync-guard';
import type { ProductVariantRow, CategoryRow } from '../src/main/database/repos/product-repo';

function localProduct(id: string, price: number): ProductSyncGuardBaseline['products'][number] {
  return {
    id,
    sku: `sku-${id}`,
    barcode: `ean-${id}`,
    retail_price: price,
    price_gross: price,
    is_active: 1,
  };
}

function incomingProduct(id: string, price: number): ProductVariantRow {
  return {
    id,
    template_id: null,
    name: `Product ${id}`,
    sku: `sku-${id}`,
    barcode: `ean-${id}`,
    retail_price: price,
    category_id: 'cat-1',
    image_url: null,
    in_stock: 1,
    vat_rate: 23,
    is_active: 1,
    updated_at: '2026-05-20T00:00:00.000Z',
    available_qty: 1,
    price_gross: price,
    price_net: price,
    vat_amount: 0,
    is_on_sale: 0,
    thumbnail_url: null,
    sale_unit: null,
  };
}

function category(id = 'cat-1'): CategoryRow {
  return {
    id,
    name: `Category ${id}`,
    icon: null,
    color: null,
    sort_order: 0,
    updated_at: '2026-05-20T00:00:00.000Z',
  };
}

function baseline(count: number, price = 1000, categoryCount = 1): ProductSyncGuardBaseline {
  return {
    products: Array.from({ length: count }, (_, i) => localProduct(String(i + 1), price)),
    activeProductCount: count,
    categoryCount,
  };
}

describe('ProductSync guard', () => {
  it('allows large batches of new zero-priced products during import', () => {
    const existing = baseline(100);
    const result = evaluateProductSyncGuard({
      mode: 'full',
      baseline: existing,
      products: [
        ...existing.products.map((row) => incomingProduct(row.id, row.retail_price)),
        ...Array.from({ length: 250 }, (_, i) => incomingProduct(`new-${i}`, 0)),
      ],
      categories: [category()],
    });

    expect(result.allowed).toBe(true);
    expect(result.stats.newZeroPriceCount).toBe(250);
    expect(result.stats.existingPriceLossCount).toBe(0);
  });

  it('rejects a sync that would zero many existing priced products', () => {
    const existing = baseline(100);
    const result = evaluateProductSyncGuard({
      mode: 'delta',
      baseline: existing,
      products: existing.products.map((row, i) => incomingProduct(row.id, i < 30 ? 0 : row.retail_price)),
      categories: [],
    });

    expect(result.allowed).toBe(false);
    expect(result.rejection?.code).toBe('existing-price-loss');
    expect(() => {
      throw new ProductSyncGuardError(result.rejection!, result.stats);
    }).toThrow(/existing priced product/);
  });

  it('allows a small number of explicit existing price removals', () => {
    const existing = baseline(100);
    const result = evaluateProductSyncGuard({
      mode: 'delta',
      baseline: existing,
      products: existing.products.slice(0, 5).map((row) => incomingProduct(row.id, 0)),
      categories: [],
    });

    expect(result.allowed).toBe(true);
    expect(result.stats.existingPriceLossCount).toBe(5);
  });

  it('rejects an empty full sync when local products already exist', () => {
    const result = evaluateProductSyncGuard({
      mode: 'full',
      baseline: baseline(12),
      products: [],
      categories: [],
    });

    expect(result.allowed).toBe(false);
    expect(result.rejection?.code).toBe('empty-full-sync');
  });

  it('rejects category collapse in a non-empty full sync', () => {
    const existing = baseline(30, 1000, 5);
    const result = evaluateProductSyncGuard({
      mode: 'full',
      baseline: existing,
      products: existing.products.map((row) => incomingProduct(row.id, row.retail_price)),
      categories: [],
    });

    expect(result.allowed).toBe(false);
    expect(result.rejection?.code).toBe('category-collapse');
  });
});
