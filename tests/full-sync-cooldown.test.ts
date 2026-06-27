import { beforeEach, describe, expect, it, vi } from 'vitest';

const { databaseGetMock, databaseRunMock } = vi.hoisted(() => ({
  databaseGetMock: vi.fn(),
  databaseRunMock: vi.fn(),
}));

vi.mock('../src/main/database/database', () => ({
  database: { get: databaseGetMock, run: databaseRunMock },
}));

import {
  FULL_SYNC_COOLDOWN_MS,
  fullSyncOnCooldown,
  markFullSync,
} from '../src/main/sync/full-sync-cooldown';

describe('full-sync cooldown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseGetMock.mockReturnValue(undefined);
  });

  it('is off when no full sync was ever recorded', () => {
    databaseGetMock.mockReturnValue(undefined);
    expect(fullSyncOnCooldown('products')).toBe(false);
  });

  it('is on within the cooldown window and off once it elapses', () => {
    const now = Date.now();
    databaseGetMock.mockReturnValue({ value: new Date(now - 60_000).toISOString() });
    expect(fullSyncOnCooldown('products')).toBe(true);

    databaseGetMock.mockReturnValue({
      value: new Date(now - FULL_SYNC_COOLDOWN_MS - 60_000).toISOString(),
    });
    expect(fullSyncOnCooldown('products')).toBe(false);
  });

  it('reads the per-stream metadata key', () => {
    fullSyncOnCooldown('draft_products');
    expect(databaseGetMock).toHaveBeenCalledWith(expect.stringContaining('sync_metadata'), [
      'draft_products_last_full_sync',
    ]);
  });

  it('treats an unparseable timestamp as not-on-cooldown', () => {
    databaseGetMock.mockReturnValue({ value: 'not-a-date' });
    expect(fullSyncOnCooldown('products')).toBe(false);
  });

  it('honours a custom cooldown window', () => {
    databaseGetMock.mockReturnValue({ value: new Date(Date.now() - 5_000).toISOString() });
    expect(fullSyncOnCooldown('products', 1_000)).toBe(false);
    expect(fullSyncOnCooldown('products', 10_000)).toBe(true);
  });

  it('markFullSync upserts the per-stream timestamp', () => {
    markFullSync('products');
    expect(databaseRunMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR REPLACE INTO sync_metadata'),
      expect.arrayContaining(['products_last_full_sync']),
    );
  });
});
