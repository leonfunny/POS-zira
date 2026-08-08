import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Catalog provenance self-heal (2026-08-08 baohan/chesaigon incident):
 * a machine whose local catalog mirror was populated under another salon
 * must detect the contamination on its own — via the salonId embedded in
 * the stored sync-v2 cursor or the db_salon_id stamp — purge the foreign
 * catalog, and rebuild with a full sync for the current salon. This is
 * the recovery path for field machines we cannot SSH into.
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

import {
  ProductSync,
  decodeCursorSalonId,
  isForeignSalonCursorError,
} from '../src/main/sync/product-sync';

function encodeCursor(salonId: string): string {
  return Buffer.from(
    JSON.stringify({ v: 2, kind: 'sync', salonId, since: '2026-08-08T14:56:05.383743Z' }),
  ).toString('base64url');
}

/**
 * Route database.get by query intent; catalog mirror has rows (poisoned or
 * legit). Stateful: once the purge's DELETE runs, count queries drop to 0 —
 * mirroring the real DB so the full-sync shrink guard sees an empty baseline.
 */
function mockDb(opts: { cursor?: string | null; stamp?: string | null; productCount?: number }) {
  let purged = false;
  databaseAllMock.mockReturnValue([]);
  databaseRunMock.mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.includes('DELETE FROM product_variants')) purged = true;
  });
  databaseGetMock.mockImplementation((sql: string, params?: unknown[]) => {
    const key = Array.isArray(params) ? params[0] : undefined;
    const count = purged ? 0 : (opts.productCount ?? 5);
    if (sql.includes('FROM sync_metadata')) {
      if (key === 'products_sync_cursor_v2' || key === 'products_last_sync') {
        return !purged && opts.cursor ? { value: opts.cursor } : undefined;
      }
      if (key === 'db_salon_id') {
        return !purged && opts.stamp ? { value: opts.stamp } : undefined;
      }
      return undefined;
    }
    if (sql.includes('COUNT(*) AS n')) return { n: count };
    if (sql.includes('COUNT(*) as count FROM product_variants WHERE is_active = 1')) {
      return { count };
    }
    if (sql.includes('COUNT(*) as count FROM categories')) return { count: purged ? 0 : 1 };
    return null;
  });
}

describe('ProductSync catalog provenance guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSecureAuthTokenMock.mockReturnValue('token');
    getProductAdminCapabilitiesMock.mockResolvedValue({
      supportsProductSyncV2: true,
      productSyncVersion: 2,
    });
    databaseTransactionMock.mockImplementation((fn: () => void) => fn());
    getPendingVariantIdsMock.mockReturnValue([]);
    getSyncedAliasesMock.mockReturnValue([]);
    deleteCategoriesExceptMock.mockReturnValue({ removed: 0, categories: [] });
    databaseSaveCoalescedMock.mockResolvedValue({ success: true });
    databaseGetTenantGenerationMock.mockReturnValue(1);
    getConfigValueMock.mockImplementation((key: string) =>
      key === 'salonId' ? 'salon-MINE' : undefined,
    );
    getPosProductsMock.mockResolvedValue({
      products: [],
      categories: [],
      categoriesComplete: false,
      nextSyncCursor: encodeCursor('salon-MINE'),
    });
  });

  it('purges foreign catalog and full-syncs when stored cursor belongs to another salon', async () => {
    mockDb({ cursor: encodeCursor('salon-OTHER'), stamp: null, productCount: 2220 });

    await new ProductSync().deltaSync();

    expect(databaseRunMock).toHaveBeenCalledWith('DELETE FROM product_variants');
    expect(databaseRunMock).toHaveBeenCalledWith('DELETE FROM categories');
    // full sync, not delta: no `since` argument
    expect(getPosProductsMock).toHaveBeenCalledWith('token', undefined, expect.anything());
  });

  it('purges when db_salon_id stamp mismatches current salon (legacy v1-cursor machines)', async () => {
    mockDb({ cursor: '2026-08-01T00:00:00.000Z', stamp: 'salon-OTHER', productCount: 10 });

    await new ProductSync().deltaSync();

    expect(databaseRunMock).toHaveBeenCalledWith('DELETE FROM product_variants');
    expect(getPosProductsMock).toHaveBeenCalledWith('token', undefined, expect.anything());
  });

  it('leaves catalog alone when cursor + stamp match current salon', async () => {
    mockDb({ cursor: encodeCursor('salon-MINE'), stamp: 'salon-MINE', productCount: 10 });

    await new ProductSync().deltaSync();

    expect(databaseRunMock).not.toHaveBeenCalledWith('DELETE FROM product_variants');
  });

  it('decodeCursorSalonId: null on garbage input, salonId on a valid cursor, never throws', () => {
    expect(decodeCursorSalonId(null)).toBeNull();
    expect(decodeCursorSalonId(undefined)).toBeNull();
    expect(decodeCursorSalonId('!!!not-base64url!!!')).toBeNull();
    expect(decodeCursorSalonId(Buffer.from('"just-a-string"').toString('base64url'))).toBeNull();
    expect(decodeCursorSalonId('2026-08-01T00:00:00.000Z')).toBeNull();
    expect(decodeCursorSalonId(encodeCursor('salon-X'))).toBe('salon-X');
  });

  it('isForeignSalonCursorError matches the server 400 and nothing else', () => {
    expect(isForeignSalonCursorError(
      Object.assign(new Error('Product sync cursor belongs to another salon'), { status: 400 }),
    )).toBe(true);
    expect(isForeignSalonCursorError(
      Object.assign(new Error('Product sync cursor belongs to another salon'), { status: 409 }),
    )).toBe(false);
    expect(isForeignSalonCursorError(
      Object.assign(new Error('some other validation problem'), { status: 400 }),
    )).toBe(false);
  });

  it('handles server 400 "belongs to another salon" on delta: purge + full sync', async () => {
    // Cursor looks fine locally but the SERVER rejects it as foreign.
    mockDb({ cursor: encodeCursor('salon-MINE'), stamp: 'salon-MINE', productCount: 10 });
    const foreignErr = Object.assign(
      new Error('Product sync cursor belongs to another salon'),
      { status: 400 },
    );
    getPosProductsMock
      .mockRejectedValueOnce(foreignErr) // delta attempt
      .mockResolvedValue({
        products: [],
        categories: [],
        categoriesComplete: false,
        nextSyncCursor: encodeCursor('salon-MINE'),
      }); // full-sync fallback

    await new ProductSync().deltaSync();

    expect(databaseRunMock).toHaveBeenCalledWith('DELETE FROM product_variants');
    expect(getPosProductsMock).toHaveBeenLastCalledWith('token', undefined, expect.anything());
  });

  it('full sync purges a foreign mirror first so the shrink guard cannot block the repair', async () => {
    // Poisoned machine, forced FULL sync path (socket-connect / post-login):
    // without the pre-purge, the shrink guard rejects "backend 0 products vs
    // local 2220" and the repair never happens on this path.
    mockDb({ cursor: encodeCursor('salon-OTHER'), stamp: 'salon-OTHER', productCount: 2220 });

    const result = await new ProductSync().fullSync();

    expect(databaseRunMock).toHaveBeenCalledWith('DELETE FROM product_variants');
    expect(result).toEqual({ productsCount: 0, categoriesCount: 0 });
    expect(markFullSyncMock).toHaveBeenCalledWith('products');
  });

  it('full sync stamps db_salon_id with the fenced salon id', async () => {
    mockDb({ cursor: null, stamp: null, productCount: 0 });

    await new ProductSync().fullSync();

    expect(databaseRunMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR REPLACE INTO sync_metadata'),
      ['db_salon_id', 'salon-MINE'],
    );
  });
});
