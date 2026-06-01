import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/main/database/database', () => ({
  database: {
    all: vi.fn(() => []),
  },
}));

import { database } from '../src/main/database/database';
import { productRepo, type ProductVariantRow } from '../src/main/database/repos/product-repo';

function product(overrides: Partial<ProductVariantRow>): ProductVariantRow {
  return {
    id: 'product',
    template_id: null,
    name: 'Product',
    sku: null,
    barcode: null,
    retail_price: 100,
    category_id: null,
    image_url: null,
    in_stock: 10,
    vat_rate: 23,
    is_active: 1,
    updated_at: null,
    available_qty: 10,
    price_gross: 100,
    price_net: 81,
    vat_amount: 19,
    is_on_sale: 0,
    thumbnail_url: null,
    sale_unit: 'szt',
    sell_by: 'PIECE',
    ...overrides,
  };
}

describe('POS product category contamination guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(database.all).mockReturnValue([]);
  });

  it('only returns categories that still have active sellable products', () => {
    productRepo.getCategories();

    const sql = vi.mocked(database.all).mock.calls[0][0] as string;
    expect(sql).toMatch(/FROM categories c/);
    expect(sql).toMatch(/WHERE EXISTS/);
    expect(sql).toMatch(/p\.category_id = c\.id/);
    expect(sql).toMatch(/p\.is_active = 1/);
    expect(sql).toMatch(/p\.id NOT IN/);
    expect(sql).not.toMatch(/SELECT \* FROM categories ORDER BY/);
  });

  it('does not seed demo catalog when the app is paired or authenticated', () => {
    const source = readFileSync(
      resolve(__dirname, '../src/main/core/orchestrator.ts'),
      'utf8',
    );
    expect(source).toMatch(/getSecureAuthToken/);
    expect(source).toMatch(/const isPaired = !!getConfigValue\('isPaired'\)/);
    expect(source).toMatch(/const hasAuthToken = !!getSecureAuthToken\(\)/);
    expect(source).toMatch(/if \(!isPaired && !hasAuthToken\) \{\s*seedIfEmpty\(\);/);
  });

  it('ranks accentless Vietnamese POS search by closest product name first', () => {
    vi.mocked(database.all).mockReturnValue([
      product({ id: 'bao', name: 'Bánh bao Thịt trứng truyền thống', sku: 'banh-bao-thit' }),
      product({ id: 'belly', name: 'Thịt ba chỉ', sku: 'boczek', sale_unit: 'kg', sell_by: 'WEIGHT' }),
      product({ id: 'pork', name: 'Thịt heo xay', sku: 'mieso-mielone' }),
    ]);

    expect(productRepo.search('thit ba chi').map((row) => row.id)).toEqual(['belly']);
  });

  it('matches Vietnamese d/đ without accents for product names', () => {
    vi.mocked(database.all).mockReturnValue([
      product({ id: 'tofu', name: 'Đậu hũ non', sku: 'tofu-soft' }),
      product({ id: 'peanut', name: 'Đậu phộng rang', sku: 'orzeszki' }),
    ]);

    expect(productRepo.search('dau hu').map((row) => row.id)).toEqual(['tofu']);
  });

  it('keeps the closest Vietnamese product first when accents or letters are mistyped', () => {
    vi.mocked(database.all).mockReturnValue([
      product({ id: 'tomato', name: 'C\u00e0 chua', sku: 'tomato' }),
      product({ id: 'sour-soup', name: 'Canh chua', sku: 'soup' }),
      product({ id: 'fish', name: 'C\u00e1 thu', sku: 'fish' }),
    ]);

    expect(productRepo.search('c\u00e1  chua').map((row) => row.id)[0]).toBe('tomato');
    expect(productRepo.search('ca hua').map((row) => row.id)[0]).toBe('tomato');
    expect(productRepo.search('c chua').map((row) => row.id)[0]).toBe('tomato');
  });

  it('does not flood POS search results for one-letter typo input', () => {
    vi.mocked(database.all).mockReturnValue([
      product({ id: 'tomato', name: 'C\u00e0 chua', sku: 'tomato' }),
      product({ id: 'fish', name: 'C\u00e1 thu', sku: 'fish' }),
    ]);

    expect(productRepo.search('c')).toEqual([]);
  });
});
