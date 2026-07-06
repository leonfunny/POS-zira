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

  it('has a separate Products-admin category read path that includes empty categories', () => {
    productRepo.getAllCategories();

    const sql = vi.mocked(database.all).mock.calls[0][0] as string;
    expect(sql).toMatch(/FROM categories/);
    expect(sql).not.toMatch(/WHERE EXISTS/);
    expect(sql).toMatch(/ORDER BY/);
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

  it('ranks exact Vietnamese-accent product names before accentless lookalikes', () => {
    vi.mocked(database.all).mockReturnValue([
      product({ id: 'coffee', name: 'Trung Nguy\u00ean C\u00e0 ph\u00ea' }),
      product({ id: 'egg-cake', name: 'B\u00e1nh tr\u1ee9ng 240g' }),
      product({ id: 'eggs', name: 'Tr\u1ee9ng g\u00e0 th\u01b0\u1eddng' }),
    ]);

    expect(productRepo.search('tr\u1ee9ng').map((row) => row.id)).toEqual([
      'eggs',
      'egg-cake',
      'coffee',
    ]);
  });

  it('does not let ASCII SKU slugs outrank exact Vietnamese-accent name matches', () => {
    vi.mocked(database.all).mockReturnValue([
      product({
        id: 'egg-white',
        name: 'Tr\u1ee9ng g\u00e0 tr\u1eafng 30 qu\u1ea3 38zl',
        sku: 'trung-ga-trang-30-qua-38zl',
      }),
      product({
        id: 'coffee',
        name: 'C\u00e0 ph\u00ea rang xay Trung Nguy\u00ean CHE PHIN 4 500g',
        sku: 'ca-phe-rang-xay-trung-nguyen-che-phin-4-500g',
      }),
      product({
        id: 'egg-regular',
        name: 'Tr\u1ee9ng g\u00e0 th\u01b0\u1eddng',
        sku: 'jaja-kurze',
      }),
    ]);

    expect(productRepo.search('tr\u1ee9ng').map((row) => row.id)).toEqual([
      'egg-regular',
      'egg-white',
      'coffee',
    ]);
  });

  it('ranks literal unaccented Vietnamese names before text-only SKU slugs', () => {
    vi.mocked(database.all).mockReturnValue([
      product({
        id: 'egg-white',
        name: 'Tr\u1ee9ng g\u00e0 tr\u1eafng 30 qu\u1ea3 38zl',
        sku: 'trung-ga-38',
      }),
      product({
        id: 'coffee',
        name: 'C\u00e0 ph\u00ea Trung Nguy\u00ean Creative 4',
        sku: 'kawa-mielona-trung-nguyen-creative-4',
      }),
    ]);

    expect(productRepo.search('trung').map((row) => row.id)).toEqual([
      'coffee',
      'egg-white',
    ]);
  });

  it('keeps accentless multi-word Vietnamese searches useful for eggs', () => {
    vi.mocked(database.all).mockReturnValue([
      product({ id: 'coffee', name: 'C\u00e0 ph\u00ea Trung Nguy\u00ean Creative 4' }),
      product({ id: 'egg-white', name: 'Tr\u1ee9ng g\u00e0 tr\u1eafng 30 qu\u1ea3 38zl' }),
      product({ id: 'egg-regular', name: 'Tr\u1ee9ng g\u00e0 th\u01b0\u1eddng' }),
    ]);

    expect(productRepo.search('trung ga').map((row) => row.id)).toEqual([
      'egg-regular',
      'egg-white',
    ]);
  });

  it('ranks accentless Vietnamese brand phrases before fuzzy food lookalikes', () => {
    vi.mocked(database.all).mockReturnValue([
      product({ id: 'coffee', name: 'C\u00e0 ph\u00ea Trung Nguy\u00ean Creative 4' }),
      product({ id: 'squid', name: 'M\u1ef1c \u1ed1ng tr\u1ee9ng Julia Alex nguy\u00ean con' }),
    ]);

    expect(productRepo.search('trung nguyen').map((row) => row.id)).toEqual([
      'coffee',
      'squid',
    ]);
  });

  it('keeps numeric barcode and SKU searches above name-only matches', () => {
    vi.mocked(database.all).mockReturnValue([
      product({ id: 'name-only', name: '590 sauce', barcode: null, sku: null }),
      product({ id: 'barcode', name: 'Rice paper', barcode: '5901234567890', sku: null }),
      product({ id: 'sku', name: 'Tempura flour', barcode: null, sku: 'EAN-590999' }),
    ]);

    expect(productRepo.search('590').map((row) => row.id)).toEqual([
      'barcode',
      'sku',
      'name-only',
    ]);
  });

  it('searches localized display names as product names', () => {
    vi.mocked(database.all).mockReturnValue([
      product({ id: 'coffee', name: 'Trung Nguy\u00ean C\u00e0 ph\u00ea' }),
      product({
        id: 'eggs',
        name: 'Jaja kurze',
        name_translations: JSON.stringify({ vi: 'Tr\u1ee9ng g\u00e0 th\u01b0\u1eddng' }),
      }),
    ]);

    expect(productRepo.search('tr\u1ee9ng').map((row) => row.id)).toEqual([
      'eggs',
      'coffee',
    ]);
  });

  it('does not flood POS search results for one-letter typo input', () => {
    vi.mocked(database.all).mockReturnValue([
      product({ id: 'tomato', name: 'C\u00e0 chua', sku: 'tomato' }),
      product({ id: 'fish', name: 'C\u00e1 thu', sku: 'fish' }),
    ]);

    expect(productRepo.search('c')).toEqual([]);
  });
});
