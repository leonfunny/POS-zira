import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductVariantRow } from '../src/main/database/repos/product-repo';

/**
 * Tenant-generation fence regression (2026-08-08 baohan/chesaigon incident):
 * a full catalog sync started under the leaving salon finished AFTER
 * clearSalonData() and repopulated the freshly-cleared DB with the old
 * salon's 2220 products. A sync may only apply its fetched payload when
 * both the tenant generation and the configured salonId are unchanged
 * since the fetch began.
 */
const {
  getPosProductsMock,
  getProductAdminCapabilitiesMock,
  upsertCategoriesMock,
  upsertManyMock,
  deactivateExceptMock,
  deactivateByIdsMock,
  applySyncTombstonesMock,
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
  databaseGetTenantGenerationMock,
  getSecureAuthTokenMock,
  getConfigValueMock,
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
  applySyncTombstonesMock: vi.fn(),
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
  databaseGetTenantGenerationMock: vi.fn(() => 1),
  getSecureAuthTokenMock: vi.fn(() => 'token'),
  getConfigValueMock: vi.fn(),
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
    applySyncTombstones: applySyncTombstonesMock,
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
    getTenantGeneration: databaseGetTenantGenerationMock,
  },
}));

vi.mock('../src/main/config/store', () => ({
  getSecureAuthToken: getSecureAuthTokenMock,
  getConfigValue: getConfigValueMock,
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

function mockEmptyBaseline() {
  databaseAllMock.mockReturnValue([]);
  databaseGetMock.mockImplementation((sql: string) => {
    if (sql.includes('COUNT(*) AS n')) return { n: 0 };
    if (sql.includes('COUNT(*) as count FROM product_variants WHERE is_active = 1')) {
      return { count: 0 };
    }
    if (sql.includes('COUNT(*) as count FROM categories')) return { count: 0 };
    return null;
  });
}

describe('ProductSync tenant-generation fence', () => {
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
    databaseGetTenantGenerationMock.mockReturnValue(1);
    getConfigValueMock.mockImplementation((key: string) =>
      key === 'salonId' ? 'salon-A' : undefined,
    );
    mockEmptyBaseline();
  });

  it('drops the fetched full-sync payload when tenant generation changed mid-fetch', async () => {
    getPosProductsMock.mockImplementation(async () => {
      // clearSalonData ran while the network fetch was in flight
      databaseGetTenantGenerationMock.mockReturnValue(2);
      return {
        products: [product('p1')],
        categories: [],
        categoriesComplete: false,
        nextSince: 'cursor-after',
      };
    });

    await new ProductSync().fullSync();

    expect(upsertManyMock).not.toHaveBeenCalled();
    expect(databaseRunMock).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR REPLACE INTO sync_metadata'),
      expect.anything(),
    );
    expect(markFullSyncMock).not.toHaveBeenCalled();
  });

  it('drops the fetched payload when config salonId changed mid-fetch', async () => {
    getPosProductsMock.mockImplementation(async () => {
      getConfigValueMock.mockImplementation((key: string) =>
        key === 'salonId' ? 'salon-B' : undefined,
      );
      return {
        products: [product('p1')],
        categories: [],
        categoriesComplete: false,
        nextSince: 'cursor-after',
      };
    });

    await new ProductSync().fullSync();

    expect(upsertManyMock).not.toHaveBeenCalled();
    expect(markFullSyncMock).not.toHaveBeenCalled();
  });

  it('applies normally when the tenant stayed stable (control)', async () => {
    getPosProductsMock.mockResolvedValue({
      products: [product('p1')],
      categories: [],
      categoriesComplete: false,
      nextSince: 'cursor-after',
    });

    await new ProductSync().fullSync();

    expect(upsertManyMock).toHaveBeenCalledWith([product('p1')]);
    expect(markFullSyncMock).toHaveBeenCalledWith('products');
  });
});
