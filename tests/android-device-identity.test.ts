import { afterEach, describe, expect, it, vi } from 'vitest';
import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { getOrCreateAndroidDeviceId } from '../src/renderer/android-pos/shim/db/device-identity';
import { AndroidRestaurantRuntime } from '../src/renderer/android-pos/shim/restaurant-runtime';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { ShimPosStore } from '../src/renderer/android-pos/shim/pos-store';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const id = '11111111-1111-4111-8111-111111111111';
const databases: AndroidDatabase[] = [];
const runtimes: AndroidRestaurantRuntime[] = [];
async function boot(persistence = new MemoryAndroidPersistence()) {
  const db = await initAndroidDb({ locateFile: null, persistence });
  databases.push(db);
  return { db, persistence };
}
function restaurant(db: AndroidDatabase) {
  const values = new Map<string, string>();
  const configStore = new ShimConfigStore({ storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  }, seed: { salonId: 'salon', posMode: 'restaurant', authUser: {
    id: 'staff', salonId: 'salon', role: 'STAFF', email: 'test@example.invalid',
  } as any } });
  const fetchLayout = vi.fn(async () => []);
  const runtime = new AndroidRestaurantRuntime({ configStore, posStore: new ShimPosStore(), db: async () => db, fetchLayout });
  runtimes.push(runtime);
  return { runtime, fetchLayout };
}
afterEach(async () => {
  runtimes.splice(0).forEach(runtime => runtime.dispose());
  for (const db of databases.splice(0)) { try { await db.flush(); } catch {} }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Android persistent device singleton', () => {
  it('creates exactly one UUID and reuses it after the caller flushes and restarts', async () => {
    const { db, persistence } = await boot();
    const created = getOrCreateAndroidDeviceId(db);
    expect(created).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(db.all('SELECT * FROM pos_device_identity')).toEqual([{ singleton: 1, id: created }]);
    await db.flush();
    const restored = await boot(persistence);
    expect(getOrCreateAndroidDeviceId(restored.db)).toBe(created);
  });
  it('returns the same identity to concurrent synchronous callers before persistence', async () => {
    const { db, persistence } = await boot();
    const ids = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => getOrCreateAndroidDeviceId(db))));
    expect(new Set(ids).size).toBe(1);
    expect(db.all('SELECT * FROM pos_device_identity')).toHaveLength(1);
    expect(persistence.image).toBeNull(); // Helper never pretends to own the caller's save barrier.
  });
  it.each(['', 'bad-id', ` ${id}`, `${id} `, '00000000-0000-0000-0000-000000000000'])('rejects invalid existing ID %j without rotating it', async stored => {
    const { db } = await boot();
    db.run('INSERT INTO pos_device_identity(singleton,id) VALUES (1,?)', [stored]);
    const generate = vi.spyOn(globalThis.crypto, 'randomUUID');
    expect(() => getOrCreateAndroidDeviceId(db)).toThrow('ANDROID_DEVICE_ID_INVALID');
    expect(generate).not.toHaveBeenCalled();
    expect(db.get<any>('SELECT id FROM pos_device_identity WHERE singleton = 1')?.id).toBe(stored);
  });
  it('does not replace an existing valid identity when UUID generation is unavailable', async () => {
    const { db } = await boot();
    db.run('INSERT INTO pos_device_identity(singleton,id) VALUES (1,?)', [id]);
    vi.stubGlobal('crypto', undefined);
    expect(getOrCreateAndroidDeviceId(db)).toBe(id);
  });
  it('fails without insecure random fallback when a fresh identity cannot be generated', async () => {
    const { db } = await boot();
    vi.stubGlobal('crypto', undefined);
    expect(() => getOrCreateAndroidDeviceId(db)).toThrow('ANDROID_DEVICE_ID_UNAVAILABLE');
    expect(db.all('SELECT * FROM pos_device_identity')).toHaveLength(0);
  });
  it('preserves the device identity across salon data clearing and restart', async () => {
    const { db, persistence } = await boot();
    const created = getOrCreateAndroidDeviceId(db);
    db.clearSalonData();
    await db.flush();
    expect(getOrCreateAndroidDeviceId((await boot(persistence)).db)).toBe(created);
  });
  it('restaurant initialization waits for an existing but unflushed identity before fetching layout', async () => {
    const { db, persistence } = await boot();
    getOrCreateAndroidDeviceId(db);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const original = persistence.saveImage.bind(persistence);
    const save = vi.spyOn(persistence, 'saveImage').mockImplementationOnce(async image => { await barrier; await original(image); });
    const { runtime, fetchLayout } = restaurant(db);
    let settled = false;
    const pending = runtime.tables.getActive().then(result => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(fetchLayout).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    } finally { release(); }
    expect(await pending).toEqual([]);
    expect(fetchLayout).toHaveBeenCalledTimes(1);
  });
  it('restaurant initialization latches a failed save of an existing identity before any layout use', async () => {
    const { db, persistence } = await boot();
    getOrCreateAndroidDeviceId(db);
    persistence.failSave = true;
    const { runtime, fetchLayout } = restaurant(db);
    await expect(runtime.tables.getActive()).rejects.toThrow('RESTAURANT_STORAGE_RESTART_REQUIRED');
    await expect(runtime.tables.getActive()).rejects.toThrow('Restaurant storage requires restart');
    expect(fetchLayout).not.toHaveBeenCalled();
    expect(persistence.image).toBeNull();
  });
});
