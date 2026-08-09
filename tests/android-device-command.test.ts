import { describe, expect, test, vi } from 'vitest';

import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { createDeviceCommandHandler, type DeviceCommandEvent } from '../src/renderer/android-pos/shim/device-command';
import type { AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';

function configStore() {
  const data = new Map<string, string>();
  return new ShimConfigStore({
    storage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    },
    seed: { apiKey: 'must-never-leave-device' } as any,
  });
}

function command(type: DeviceCommandEvent['type'], payload: Record<string, unknown> = {}): DeviceCommandEvent {
  return {
    commandId: crypto.randomUUID(),
    type,
    payload,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function build() {
  const store = configStore();
  const run = vi.fn();
  const flush = vi.fn(async () => {});
  const database = {
    run,
    flush,
    get: vi.fn((sql: string) => ({ count: sql.includes('orders') ? 2 : 3 })),
  } as unknown as AndroidDatabase;
  const syncProducts = vi.fn(async () => ({ success: true, productsCount: 4 }));
  const syncStaff = vi.fn(async () => ({ success: true, count: 2 }));
  const handler = createDeviceCommandHandler({
    configStore: store,
    db: async () => database,
    getPosStore: () => null,
    syncProducts,
    syncStaff,
    updater: null,
    reload: vi.fn(),
  });
  return { store, database, run, flush, syncProducts, syncStaff, handler };
}

describe('Android POS device command handler', () => {
  test('applies only the remote-safe settings surface', async () => {
    const { handler, store } = build();
    await expect(handler(command('SETTINGS_PATCH', {
      settings: { posMode: 'retail', posLanguage: 'vi', allowOversell: false },
    }))).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(store.getRawConfig()).toMatchObject({ posMode: 'retail', posLanguage: 'vi', allowOversell: false });

    await expect(handler(command('SETTINGS_PATCH', {
      settings: { apiKey: 'remote-secret-injection' },
    }))).resolves.toMatchObject({ status: 'FAILED', error: 'setting-not-remote-manageable:apiKey' });
  });

  test.each(['tr', 'zh', 'ru'])('accepts shared cashier language %s from remote settings', async (language) => {
    const { handler, store } = build();
    await expect(handler(command('SETTINGS_PATCH', {
      settings: { posLanguage: language },
    }))).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(store.getRawConfig().posLanguage).toBe(language);
  });

  test.each(['de', 'cs', 'sk'])('rejects legacy untranslated language %s from remote settings', async (language) => {
    const { handler } = build();
    await expect(handler(command('SETTINGS_PATCH', {
      settings: { posLanguage: language },
    }))).resolves.toMatchObject({ status: 'FAILED', error: 'invalid-setting:posLanguage' });
  });

  test('preserves Windows-managed device flags in the remote protocol', async () => {
    const { handler, store } = build();
    const settings = {
      customerDisplayEnabled: true,
      selfCheckoutEnabled: true,
      kitchenSelfOrderEnabled: true,
      tvAdEnabled: true,
      remoteAccessEnabled: true,
    };
    await expect(handler(command('SETTINGS_PATCH', { settings }))).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(store.getRawConfig()).toMatchObject(settings);
  });

  test('full database resync resets only the catalog cursor then invokes named syncs', async () => {
    const { handler, run, flush, syncProducts, syncStaff } = build();
    await expect(handler(command('DATABASE_RESYNC', { scope: 'ALL', full: true }))).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    expect(run).toHaveBeenCalledWith(
      'INSERT OR REPLACE INTO sync_meta (key, value, updated_at) VALUES (?, ?, ?)',
      expect.arrayContaining(['products_sync_cursor', null]),
    );
    expect(flush).toHaveBeenCalled();
    expect(syncProducts).toHaveBeenCalledOnce();
    expect(syncStaff).toHaveBeenCalledOnce();
  });

  test('state response is sanitized and excludes secrets', async () => {
    const { handler } = build();
    const result = await handler(command('DEVICE_STATE'));
    expect(result.status).toBe('COMPLETED');
    expect(JSON.stringify(result.result)).not.toContain('must-never-leave-device');
    expect(result.result).toMatchObject({ database: { products: 3, pendingOrders: 2 } });
  });

  test('update fails closed without the native signer-verifying plugin', async () => {
    const { handler } = build();
    await expect(handler(command('APP_UPDATE', {
      version: '1.0.26',
      apkUrl: 'https://img.zira.pl/downloads/zira-pos.apk',
      sha256: 'a'.repeat(64),
    }))).resolves.toMatchObject({ status: 'FAILED', error: 'native-updater-unavailable' });
  });
});
