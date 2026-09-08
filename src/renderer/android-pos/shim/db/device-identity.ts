import type { AndroidDatabase } from './db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Register identity is device-local, not salon-local. The caller must await
 * its durable flush barrier before using this ID, including an existing row. */
export function getOrCreateAndroidDeviceId(db: AndroidDatabase): string {
  const existing = db.get<{ id: unknown }>('SELECT id FROM pos_device_identity WHERE singleton = 1');
  if (existing) {
    if (typeof existing.id !== 'string' || !UUID.test(existing.id)) {
      throw new Error('ANDROID_DEVICE_ID_INVALID: Restore the original device identity before continuing.');
    }
    return existing.id;
  }
  const id = globalThis.crypto?.randomUUID?.();
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('ANDROID_DEVICE_ID_UNAVAILABLE');
  // No await between lookup and insert: all callers sharing this connection
  // observe the same singleton, even before the first caller flushes it.
  db.run('INSERT INTO pos_device_identity(singleton,id) VALUES (1,?)', [id]);
  return id;
}
