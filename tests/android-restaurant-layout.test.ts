import { describe, expect, it } from 'vitest';
import { parseRestaurantLayout, canUseCachedRestaurantLayout } from '../src/renderer/android-pos/shim/restaurant-layout';
import { createRestaurantTableRepo } from '../src/renderer/android-pos/shim/db/restaurant-table-repo';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const table = { id: 'A', salonId: 'salon', tableNumber: 'Terrace 1', capacity: 4, isActive: true,
  zone: { name: 'Terrace', salonId: 'salon' }, status: 'OCCUPIED', currentOrderId: 'windows-order', occupiedSince: '2026-09-08' };

describe('validated restaurant layout only', () => {
  it('allowlists config fields, preserving server order and dropping live server state', () => {
    expect(parseRestaurantLayout([table], 'salon')).toEqual([{ id: 'A', name: 'Terrace 1', capacity: 4, active: true, zone: 'Terrace', sortOrder: 0 }]);
    expect(parseRestaurantLayout({ data: [table] }, 'salon')).toEqual(parseRestaurantLayout([table], 'salon'));
    expect(parseRestaurantLayout([], 'salon')).toEqual([]);
  });
  it.each([null, {}, { success: false, data: [] }, [null], [{ ...table, salonId: 'other' }],
    [{ ...table, capacity: -1 }], [{ ...table, capacity: 1.5 }], [{ ...table, isActive: 'true' }],
    [{ ...table, tableNumber: ' ' }], [{ ...table, zone: 'Terrace' }],
    [{ ...table, zone: { name: 'Other', salonId: 'other' } }], [table, table]])('rejects malformed or cross-tenant snapshots: %j', payload => {
    expect(() => parseRestaurantLayout(payload, 'salon')).toThrow('Invalid restaurant');
  });
  it('allows transient transport failures, never permissions or invalid contracts', () => {
    for (const status of [408, 429, 500, 502, 503]) expect(canUseCachedRestaurantLayout({ status })).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 422]) expect(canUseCachedRestaurantLayout({ status })).toBe(false);
    expect(canUseCachedRestaurantLayout(new TypeError('Failed to fetch'))).toBe(true);
    expect(canUseCachedRestaurantLayout(new Error('Request timeout after 30000ms: https://test.invalid'))).toBe(true);
    expect(canUseCachedRestaurantLayout(new Error('Invalid restaurant layout'))).toBe(false);
  });
  it('persists layout and sync marker together without copying server occupancy or touching another salon', async () => {
    const persistence = new MemoryAndroidPersistence();
    const db = await initAndroidDb({ locateFile: null, persistence });
    const repo = createRestaurantTableRepo(db, 'salon');
    const other = createRestaurantTableRepo(db, 'other');
    other.replaceLayout([{ id: 'A', name: 'Other table', capacity: 2, active: true, zone: null, sortOrder: 0 }], 'other-sync');
    repo.replaceLayout(parseRestaurantLayout([table], 'salon'), 'first-sync');
    expect(repo.list(true)[0]).toMatchObject({ status: 'free', current_order_id: null, covers: 0 });
    repo.setCovers('A', 3); repo.updateStatus('A', 'occupied', 'local-order');
    repo.replaceLayout(parseRestaurantLayout([{ ...table, tableNumber: 'Renamed', capacity: 6 }], 'salon'), 'second-sync');
    await db.flush();
    const loaded = createRestaurantTableRepo(await initAndroidDb({ locateFile: null, persistence }), 'salon');
    expect(loaded.lastSyncedAt()).toBe('second-sync');
    expect(loaded.list(true)[0]).toMatchObject({ name: 'Renamed', capacity: 6, status: 'occupied', current_order_id: 'local-order', covers: 3 });
    expect(other.list(true)[0].name).toBe('Other table');
    repo.replaceLayout([], 'empty-sync');
    expect(repo.list(true)).toEqual([]);
    expect(repo.list(true, 'A')[0].id).toBe('A');
    expect(repo.getById('A')?.is_active).toBe(0);
    await db.flush();
  });
  it('rolls back the whole snapshot and marker when a write fails', async () => {
    const db = await initAndroidDb({ locateFile: null, persistence: new MemoryAndroidPersistence() });
    const repo = createRestaurantTableRepo(db, 'salon');
    repo.replaceLayout(parseRestaurantLayout([table], 'salon'), 'first-sync');
    expect(() => repo.replaceLayout([{ id: 'B', name: null, active: true, zone: null, capacity: 2, sortOrder: 0 } as any], 'broken-sync')).toThrow();
    expect(repo.lastSyncedAt()).toBe('first-sync');
    expect(repo.list(true).map(t => t.id)).toEqual(['A']);
    await db.flush();
  });
});
