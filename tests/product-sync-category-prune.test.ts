import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CategoryRow, ProductVariantRow } from '../src/main/database/repos/product-repo';

const {
  getPosProductsMock,
  getProductAdminCapabilitiesMock,
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
  databaseSaveCoalescedMock,
  databaseTransactionMock,
  getSecureAuthTokenMock,
  loggerInfoMock,
  loggerWarnMock,
  markFullSyncMock,
} = vi.hoisted(() => ({
  getPosProductsMock: vi.fn(),
  getProductAdminCapabilitiesMock: vi.fn(),
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
  databaseSaveCoalescedMock: vi.fn(),
  databaseTransactionMock: vi.fn((fn: () => void) => fn()),
  getSecureAuthTokenMock: vi.fn(() => 'token'),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  markFullSyncMock: vi.fn(),
}));

vi.mock('../src/main/network/api-client', () => ({
  apiClient: {
    getPosProducts: getPosProductsMock,
    getProductAdminCapabilities: getProductAdminCapabilitiesMock,
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
    saveCoalesced: databaseSaveCoalescedMock,
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
    image_url: null,
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
  databaseGetMock.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM sync_metadata') && params?.[0] === 'products_last_sync') {
      return { value: 'cursor-1' };
    }
    if (sql.includes('FROM sync_metadata') && params?.[0] === 'products_sync_cursor_v2') {
      return { value: 'cursor-v2-1' };
    }
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
    getProductAdminCapabilitiesMock.mockResolvedValue({
      supportsProductSyncV2: false,
      productSyncVersion: 1,
    });
    databaseTransactionMock.mockImplementation((fn: () => void) => fn());
    getPendingVariantIdsMock.mockReturnValue([]);
    getSyncedAliasesMock.mockReturnValue([]);
    deleteCategoriesExceptMock.mockReturnValue({ removed: 0, categories: [] });
    databaseSaveCoalescedMock.mockResolvedValue({ success: true });
    mockGuardBaseline();
  });

  it('prunes backend-missing categories during full sync and logs their names', async () => {
    const categories = [category('cat-1'), category('cat-2')];
    getPosProductsMock.mockResolvedValueOnce({
      products: [product('p-1')],
      categories,
      deletedIds: [],
      nextSince: 'cursor-2',
      categoriesComplete: true,
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

  it('clears all local categories when an authoritative full snapshot is empty', async () => {
    getPosProductsMock.mockResolvedValueOnce({
      products: [product('p-1')],
      categories: [],
      categoriesComplete: true,
      deletedIds: [],
      nextSince: 'cursor-2',
    });

    await expect(new ProductSync().fullSync()).resolves.toMatchObject({ productsCount: 1 });

    expect(upsertCategoriesMock).not.toHaveBeenCalled();
    expect(deleteCategoriesExceptMock).toHaveBeenCalledTimes(1);
    expect([...(deleteCategoriesExceptMock.mock.calls[0]?.[0] as Set<string>)]).toEqual([]);
  });

  it('preserves local categories when the public category snapshot failed', async () => {
    getPosProductsMock.mockResolvedValueOnce({
      products: [product('p-1')],
      categories: [],
      categoriesComplete: false,
      deletedIds: [],
      nextSince: 'cursor-2',
    });

    await expect(new ProductSync().fullSync()).resolves.toMatchObject({ productsCount: 1 });

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

  it('removes backend-deleted categories during an authoritative delta sync', async () => {
    const categories = [category('cat-1')];
    getPosProductsMock.mockResolvedValueOnce({
      products: [product('p-1')],
      categories,
      categoriesComplete: true,
      deletedIds: [],
      nextSince: 'cursor-2',
    });
    deleteCategoriesExceptMock.mockReturnValueOnce({
      removed: 1,
      categories: [{ id: 'ghost', name: 'Ghost' }],
    });

    await expect(new ProductSync().deltaSync()).resolves.toBe(1);

    const keepIds = deleteCategoriesExceptMock.mock.calls[0]?.[0] as Set<string>;
    expect([...keepIds]).toEqual(['cat-1']);
    expect(loggerInfoMock).toHaveBeenCalledWith(expect.stringContaining('Ghost (ghost)'));
  });

  it('runs a queued catalog callback only after an older delta has finished applying', async () => {
    let resolveResponse!: (value: {
      products: ProductVariantRow[];
      categories: CategoryRow[];
      deletedIds: string[];
      nextSince: string;
    }) => void;
    getPosProductsMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    const order: string[] = [];
    upsertManyMock.mockImplementationOnce(() => { order.push('delta-apply'); });
    const sync = new ProductSync();

    const olderDelta = sync.deltaSync();
    await vi.waitFor(() => expect(getPosProductsMock).toHaveBeenCalledTimes(1));
    const mirror = sync.runAfterPendingCatalogSync(() => {
      order.push('mutation-mirror');
      return 'mirrored';
    });

    expect(order).toEqual([]);
    resolveResponse({
      products: [product('p-old')],
      categories: [],
      deletedIds: [],
      nextSince: 'cursor-old',
    });

    await expect(olderDelta).resolves.toBe(1);
    await expect(mirror).resolves.toBe('mirrored');
    expect(order).toEqual(['delta-apply', 'mutation-mirror']);
  });

  it('continues the catalog callback queue after an older delta rejects', async () => {
    getPosProductsMock.mockResolvedValueOnce({
      products: [product('p-1')],
      categories: [],
      deletedIds: [],
      nextSince: 'cursor-2',
    });
    databaseTransactionMock.mockImplementationOnce(() => {
      throw new Error('catalog apply failed');
    });
    const sync = new ProductSync();

    const failedDelta = sync.deltaSync();
    const mirror = sync.runAfterPendingCatalogSync(() => 'mirrored-after-failure');

    await expect(failedDelta).rejects.toThrow('catalog apply failed');
    await expect(mirror).resolves.toBe('mirrored-after-failure');
  });

  it('uses cursor-v2 metadata and advances only to the server final cursor', async () => {
    getProductAdminCapabilitiesMock.mockResolvedValueOnce({
      supportsProductSyncV2: true,
      productSyncVersion: 2,
    });
    getPosProductsMock.mockResolvedValueOnce({
      products: [product('p-v2')],
      categories: [],
      deletedIds: [],
      nextSyncCursor: 'cursor-v2-2',
    });

    await expect(new ProductSync().deltaSync()).resolves.toBe(1);

    expect(getPosProductsMock).toHaveBeenCalledWith(
      'token',
      'cursor-v2-1',
      { cursorV2: true },
    );
    expect(databaseRunMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR REPLACE INTO sync_metadata'),
      ['products_sync_cursor_v2', 'cursor-v2-2'],
    );
  });

  it('resets an unsafe cursor-v2 once and performs one full v2 sync without legacy fallback', async () => {
    getProductAdminCapabilitiesMock.mockResolvedValueOnce({
      supportsProductSyncV2: true,
      productSyncVersion: 2,
    });
    const unsafe = Object.assign(new Error('cursor exceeds safe watermark'), {
      status: 409,
      code: 'PRODUCT_SYNC_CURSOR_UNSAFE',
      resetRequired: true,
      serverBody: {
        error: 'PRODUCT_SYNC_CURSOR_UNSAFE',
        message: 'cursor exceeds safe watermark',
        resetRequired: true,
      },
    });
    getPosProductsMock
      .mockRejectedValueOnce(unsafe)
      .mockResolvedValueOnce({
        products: [product('p-full-v2')],
        categories: [],
        categoriesComplete: true,
        deletedIds: [],
        nextSyncCursor: 'cursor-v2-reset',
      });

    await expect(new ProductSync().deltaSync()).resolves.toBe(1);

    expect(getPosProductsMock).toHaveBeenCalledTimes(2);
    expect(getPosProductsMock.mock.calls).toEqual([
      ['token', 'cursor-v2-1', { cursorV2: true }],
      ['token', undefined, { cursorV2: true }],
    ]);
    expect(databaseRunMock).toHaveBeenCalledWith(
      'DELETE FROM sync_metadata WHERE key = ?',
      ['products_sync_cursor_v2'],
    );
    expect(databaseSaveCoalescedMock).toHaveBeenCalledWith(5000);
  });

  it('bubbles a repeated unsafe response from the one full v2 reset attempt without looping', async () => {
    getProductAdminCapabilitiesMock.mockResolvedValueOnce({
      supportsProductSyncV2: true,
      productSyncVersion: 2,
    });
    const unsafe = Object.assign(new Error('cursor unsafe'), {
      status: 409,
      code: 'PRODUCT_SYNC_CURSOR_UNSAFE',
      details: { resetRequired: true },
    });
    getPosProductsMock.mockRejectedValue(unsafe);

    await expect(new ProductSync().deltaSync()).rejects.toMatchObject({
      code: 'PRODUCT_SYNC_CURSOR_UNSAFE',
    });

    expect(getPosProductsMock).toHaveBeenCalledTimes(2);
    expect(getPosProductsMock.mock.calls[1]).toEqual(['token', undefined, { cursorV2: true }]);
  });

  it('retains the previous legacy cursor on an empty delta without using local time', async () => {
    getPosProductsMock.mockResolvedValueOnce({
      products: [],
      categories: [],
      deletedIds: [],
      nextSince: undefined,
    });

    await expect(new ProductSync().deltaSync()).resolves.toBe(0);

    expect(databaseRunMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR REPLACE INTO sync_metadata'),
      ['products_last_sync', 'cursor-1'],
    );
  });

  it('serializes direct catalog sync calls across ProductSync instances', async () => {
    let resolveFirst!: (value: {
      products: ProductVariantRow[];
      categories: CategoryRow[];
      deletedIds: string[];
      nextSince: string;
    }) => void;
    getPosProductsMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({
        products: [product('p-new')],
        categories: [],
        deletedIds: [],
        nextSince: 'cursor-new',
      });

    const first = new ProductSync().deltaSync();
    await vi.waitFor(() => expect(getPosProductsMock).toHaveBeenCalledTimes(1));
    const second = new ProductSync().deltaSync();
    await Promise.resolve();
    expect(getPosProductsMock).toHaveBeenCalledTimes(1);

    resolveFirst({
      products: [product('p-old')],
      categories: [],
      deletedIds: [],
      nextSince: 'cursor-old',
    });

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(1);
    expect(getPosProductsMock).toHaveBeenCalledTimes(2);
  });
});
