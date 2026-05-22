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
});
