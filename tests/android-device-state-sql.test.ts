import { describe, expect, test } from 'vitest';

import { createDeviceCommandHandler, type DeviceCommandEvent } from '../src/renderer/android-pos/shim/device-command';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';

const NODE_LOCATE_FILE = null;

/**
 * DEVICE_STATE ran `... FROM orders WHERE sync_status != 'SYNCED'` against a
 * schema whose column is `synced`. SQLite threw, the handler caught it, and the
 * only command an operator sends first — "tell me what state this till is in" —
 * came back FAILED.
 *
 * The existing suite could not see it: it stubs `database.get` with
 * `(sql) => ({ count: sql.includes('orders') ? 2 : 3 })`, which answers any
 * string, valid SQL or not. So these tests run the real statements against the
 * real schema instead. A mock that cannot be wrong cannot catch a wrong query.
 */

function memoryStore() {
  const data = new Map<string, string>();
  return new ShimConfigStore({
    storage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    },
  });
}

function command(type: DeviceCommandEvent['type']): DeviceCommandEvent {
  return {
    commandId: 'cmd-device-state',
    type,
    payload: {},
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

async function handlerOverRealDb() {
  const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
  const handler = createDeviceCommandHandler({
    configStore: memoryStore(),
    db: async () => database,
    getPosStore: () => null,
    syncProducts: async () => ({ success: true }),
    syncStaff: async () => ({ success: true }),
    updater: null,
    reload: () => undefined,
  });
  return { database, handler };
}

describe('DEVICE_STATE against the real Android schema', () => {
  test('answers COMPLETED instead of failing on a column that does not exist', async () => {
    const { handler } = await handlerOverRealDb();

    const result = await handler(command('DEVICE_STATE'));

    expect(result.error).toBeUndefined();
    expect(result.status).toBe('COMPLETED');
  });

  test('counts only the orders that have not synced', async () => {
    const { database, handler } = await handlerOverRealDb();
    database.run("INSERT INTO orders (id, synced) VALUES ('o-pending', 0)");
    database.run("INSERT INTO orders (id, synced) VALUES ('o-inflight', 2)");
    database.run("INSERT INTO orders (id, synced) VALUES ('o-done', 1)");

    const result = await handler(command('DEVICE_STATE'));

    expect((result.result as any)?.database?.pendingOrders).toBe(2);
  });

  test('a till with nothing outstanding reports zero, not a failure', async () => {
    const { database, handler } = await handlerOverRealDb();
    database.run("INSERT INTO orders (id, synced) VALUES ('o-done', 1)");

    const result = await handler(command('DEVICE_STATE'));

    expect(result.status).toBe('COMPLETED');
    expect((result.result as any)?.database?.pendingOrders).toBe(0);
  });
});
