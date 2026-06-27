import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDraftProductsMock,
  getSecureAuthTokenMock,
  clearAllMock,
  upsertManyMock,
  softDeleteByIdsMock,
  databaseGetMock,
  databaseRunMock,
  databaseSaveMock,
  databaseTransactionMock,
  loggerWarnMock,
} = vi.hoisted(() => ({
  getDraftProductsMock: vi.fn(),
  getSecureAuthTokenMock: vi.fn(() => 'token' as string | null),
  clearAllMock: vi.fn(),
  upsertManyMock: vi.fn(),
  softDeleteByIdsMock: vi.fn(),
  databaseGetMock: vi.fn(),
  databaseRunMock: vi.fn(),
  databaseSaveMock: vi.fn(),
  databaseTransactionMock: vi.fn((fn: () => void) => fn()),
  loggerWarnMock: vi.fn(),
}));

vi.mock('../src/main/network/api-client', () => ({
  apiClient: {
    getDraftProducts: getDraftProductsMock,
  },
}));

vi.mock('../src/main/database/repos/draft-product-repo', () => ({
  draftProductRepo: {
    clearAll: clearAllMock,
    upsertMany: upsertManyMock,
    softDeleteByIds: softDeleteByIdsMock,
  },
}));

vi.mock('../src/main/database/database', () => ({
  database: {
    get: databaseGetMock,
    run: databaseRunMock,
    save: databaseSaveMock,
    // Production code now uses markDirty() instead of save() on the hot
    // mutation path; the 5s auto-save loop handles flush. Tests that assert
    // "persisted" semantics should treat both the same.
    markDirty: databaseSaveMock,
    transaction: databaseTransactionMock,
  },
}));

vi.mock('../src/main/config/store', () => ({
  getSecureAuthToken: getSecureAuthTokenMock,
}));

vi.mock('../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: loggerWarnMock,
    debug: vi.fn(),
  },
}));

import { DraftProductSync } from '../src/main/sync/draft-product-sync';

describe('DraftProductSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSecureAuthTokenMock.mockReturnValue('token');
    databaseTransactionMock.mockImplementation((fn: () => void) => fn());
  });

  it('fullSync skips malformed drafts instead of aborting the whole mirror refresh', async () => {
    getDraftProductsMock.mockResolvedValueOnce({
      drafts: [
        { id: 'ok-1', name: 'Tea', retailPrice: 1200 },
        { id: 'bad-1', name: null, retailPrice: 999 },
      ],
      deletedIds: [],
      nextSince: 'cursor-1',
    });

    const sync = new DraftProductSync();
    const result = await sync.fullSync();

    expect(result).toEqual({ count: 1 });
    expect(clearAllMock).toHaveBeenCalledTimes(1);
    expect(upsertManyMock).toHaveBeenCalledTimes(1);
    expect(upsertManyMock.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        id: 'ok-1',
        name: 'Tea',
        retail_price: 1200,
      }),
    ]);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      '[DraftProductSync] Skipped 1 draft(s) with missing id/name',
    );
  });

  it('deltaSync applies valid drafts and deleted ids when the batch also contains malformed drafts', async () => {
    databaseGetMock.mockReturnValueOnce({ value: 'cursor-old' });
    getDraftProductsMock.mockResolvedValueOnce({
      drafts: [
        { id: 'ok-2', name: 'Coffee', purchasePrice: 2500 },
        { id: 'bad-2', name: '' },
      ],
      deletedIds: ['gone-1'],
      nextSince: 'cursor-2',
    });

    const sync = new DraftProductSync();
    const result = await sync.deltaSync();

    expect(result).toBe(1);
    expect(upsertManyMock).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'ok-2',
        name: 'Coffee',
        retail_price: 2500,
      }),
    ]);
    expect(softDeleteByIdsMock).toHaveBeenCalledWith(['gone-1']);
    expect(databaseSaveMock).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed socket updates without throwing', () => {
    const sync = new DraftProductSync();

    expect(() => sync.applyUpdate({ id: 'bad-live', name: '   ' })).not.toThrow();
    expect(upsertManyMock).not.toHaveBeenCalled();
    expect(databaseSaveMock).not.toHaveBeenCalled();
  });

  it('skips the full draft sweep when the mirror is non-empty and a full sync ran within the cooldown', async () => {
    databaseGetMock.mockImplementation((sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes("key = 'draft_products_last_sync'")) return undefined; // cursor missing
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { n: 100 }; // mirror has data
      if (params?.[0] === 'draft_products_last_full_sync') return { value: new Date().toISOString() }; // full sync just now
      return undefined;
    });

    const sync = new DraftProductSync();
    const result = await sync.deltaSync();

    expect(result).toBe(100);
    expect(getDraftProductsMock).not.toHaveBeenCalled(); // no network sweep on a flapping reconnect
    expect(clearAllMock).not.toHaveBeenCalled(); // mirror untouched
  });

  it('still full-syncs when the cursor is missing and the mirror is empty (cooldown never strands an empty catalogue)', async () => {
    databaseGetMock.mockImplementation((sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes("key = 'draft_products_last_sync'")) return undefined;
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { n: 0 }; // mirror EMPTY
      if (params?.[0] === 'draft_products_last_full_sync') return { value: new Date().toISOString() }; // recent full
      return undefined;
    });
    getDraftProductsMock.mockResolvedValueOnce({
      drafts: [{ id: 'd1', name: 'X' }],
      deletedIds: [],
      nextSince: 'c',
    });

    const sync = new DraftProductSync();
    const result = await sync.deltaSync();

    expect(result).toBe(1);
    expect(getDraftProductsMock).toHaveBeenCalledTimes(1); // full sweep still runs
    expect(clearAllMock).toHaveBeenCalledTimes(1);
  });
});
