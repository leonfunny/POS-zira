import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CategoryRow, ProductVariantRow } from '../src/main/database/repos/product-repo';

const {
  getPosProductsMock,
  upsertCategoriesMock,
  upsertManyMock,
  deactivateExceptMock,
  deactivateByIdsMock,
  deleteCategoriesExceptMock,
  getByIdMock,
  getPendingVariantIdsMock,
  getSyncedAliasesMock,
  hasUnsyncedOrdersForVariantMock,
  databaseAllMock,
  databaseGetMock,
  databaseRunMock,
  databaseMarkDirtyMock,
  databaseTransactionMock,
  getSecureAuthTokenMock,
  loggerInfoMock,
  loggerWarnMock,
  markFullSyncMock,
} = vi.hoisted(() => ({
  getPosProductsMock: vi.fn(),
  upsertCategoriesMock: vi.fn(),
  upsertManyMock: vi.fn(),
  deactivateExceptMock: vi.fn(),
  deactivateByIdsMock: vi.fn(),
  deleteCategoriesExceptMock: vi.fn(),
  getByIdMock: vi.fn(),
  getPendingVariantIdsMock: vi.fn(() => []),
  getSyncedAliasesMock: vi.fn(() => []),
  hasUnsyncedOrdersForVariantMock: vi.fn(() => false),
  databaseAllMock: vi.fn(),
  databaseGetMock: vi.fn(),
  databaseRunMock: vi.fn(),
  databaseMarkDirtyMock: vi.fn(),
  databaseTransactionMock: vi.fn((fn: () => void) => fn()),
  getSecureAuthTokenMock: vi.fn(() => 'token'),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  markFullSyncMock: vi.fn(),
}));

vi.mock('../src/main/network/api-client', () => ({
  apiClient: {
    getPosProducts: getPosProductsMock,
  },
}));

vi.mock('../src/main/database/repos/product-repo', () => ({
  productRepo: {
    upsertCategories: upsertCategoriesMock,
    upsertMany: upsertManyMock,
    deactivateExcept: deactivateExceptMock,
    deactivateByIds: deactivateByIdsMock,
    deleteCategoriesExcept: deleteCategoriesExceptMock,
    getById: getByIdMock,
  },
}));

vi.mock('../src/main/database/repos/local-variant-imports-repo', () => ({
  localVariantImportsRepo: {
    getPendingVariantIds: getPendingVariantIdsMock,
    getSyncedAliases: getSyncedAliasesMock,
  },
}));

vi.mock('../src/main/database/repos/order-repo', () => ({
  orderRepo: {
    hasUnsyncedOrdersForVariant: hasUnsyncedOrdersForVariantMock,
  },
}));

vi.mock('../src/main/database/database', () => ({
  database: {
    all: databaseAllMock,
    get: databaseGetMock,
    run: databaseRunMock,
    markDirty: databaseMarkDirtyMock,
    transaction: databaseTransactionMock,
  },
}));

vi.mock('../src/main/config/store', () => ({
  getSecureAuthToken: getSecureAuthTokenMock,
}));

vi.mock('../src/main/logger', () => ({
  default: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/main/sync/full-sync-cooldown', () => ({
  markFullSync: markFullSyncMock,
}));

import { ProductSync } from '../src/main/sync/product-sync';

function product(id: string, categoryId = 'cat-1'): ProductVariantRow {
  return {
    id,
    template_id: null,
    name: `Product ${id}`,
    sku: `sku-${id}`,
    barcode: `ean-${id}`,
    retail_price: 1000,
    category_id: categoryId,
    image_url: null,
    in_stock: 1,
    vat_rate: 23,
    is_active: 1,
    updated_at: '2026-07-02T00:00:00.000Z',
    available_qty: 1,
    price_gross: 1000,
    price_net: 813,
    vat_amount: 187,
    is_on_sale: 0,
    thumbnail_url: null,
    sale_unit: 'szt.',
    sell_by: 'PIECE',
  };
}

function category(id: string): CategoryRow {
  return {
    id,
    name: `Category ${id}`,
    icon: null,
    color: null,
    sort_order: 0,
    updated_at: '2026-07-02T00:00:00.000Z',
  };
}

function mockGuardBaseline() {
  databaseAllMock.mockReturnValue([{
    id: 'existing-product',
    sku: 'existing-sku',
    barcode: 'existing-ean',
    retail_price: 1000,
    price_gross: 1000,
    is_active: 1,
  }]);
  databaseGetMock.mockImplementation((sql: string) => {
    if (sql.includes("key = 'products_last_sync'")) return { value: 'cursor-1' };
    if (sql.includes('COUNT(*) AS n')) return { n: 1 };
    if (sql.includes('COUNT(*) as count FROM product_variants WHERE is_active = 1')) {
      return { count: 1 };
    }
    if (sql.includes('COUNT(*) as count FROM categories')) return { count: 2 };
    return null;
  });
}

describe('ProductSync category pruning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSecureAuthTokenMock.mockReturnValue('token');
    databaseTransactionMock.mockImplementation((fn: () => void) => fn());
    getPendingVariantIdsMock.mockReturnValue([]);
    getSyncedAliasesMock.mockReturnValue([]);
    deleteCategoriesExceptMock.mockReturnValue({ removed: 0, categories: [] });
    mockGuardBaseline();
  });

  it('prunes backend-missing categories during full sync and logs their names', async () => {
    const categories = [category('cat-1'), category('cat-2')];
    getPosProductsMock.mockResolvedValueOnce({
      products: [product('p-1')],
      categories,
      deletedIds: [],
      nextSince: 'cursor-2',
    });
    deleteCategoriesExceptMock.mockReturnValueOnce({
      removed: 2,
      categories: [
        { id: 'ghost-1', name: 'Ghost One' },
        { id: 'ghost-2', name: 'Ghost Two' },
      ],
    });

    const result = await new ProductSync().fullSync();

    expect(result.categoriesCount).toBe(categories.length);
    expect(upsertCategoriesMock).toHaveBeenCalledWith(categories);
    expect(deleteCategoriesExceptMock).toHaveBeenCalledTimes(1);
    const keepIds = deleteCategoriesExceptMock.mock.calls[0]?.[0] as Set<string>;
    expect([...keepIds].sort()).toEqual(['cat-1', 'cat-2']);
    expect(upsertCategoriesMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteCategoriesExceptMock.mock.invocationCallOrder[0],
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.stringContaining('Ghost One (ghost-1), Ghost Two (ghost-2)'),
    );
    expect(markFullSyncMock).toHaveBeenCalledWith('products');
  });

  it('does not prune when the full-sync category payload is empty', async () => {
    getPosProductsMock.mockResolvedValueOnce({
      products: [product('p-1')],
      categories: [],
      deletedIds: [],
      nextSince: 'cursor-2',
    });

    const result = await new ProductSync().fullSync();

    expect(result.categoriesCount).toBe(0);
    expect(upsertCategoriesMock).not.toHaveBeenCalled();
    expect(deleteCategoriesExceptMock).not.toHaveBeenCalled();
  });

  it('does not prune categories during delta sync', async () => {
    const categories = [category('cat-1')];
    getPosProductsMock.mockResolvedValueOnce({
      products: [product('p-1')],
      categories,
      deletedIds: [],
      nextSince: 'cursor-2',
    });

    const result = await new ProductSync().deltaSync();

    expect(result).toBe(1);
    expect(upsertCategoriesMock).toHaveBeenCalledWith(categories);
    expect(deleteCategoriesExceptMock).not.toHaveBeenCalled();
  });
});
