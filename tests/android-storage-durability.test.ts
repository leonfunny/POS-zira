/**
 * Task 3 of docs/superpowers/plans/2026-07-25-android-pos-device-readiness-fixes.md.
 *
 * The whole local ledger — catalog, shifts, the billiard handoff journal, and
 * orders that are PAID but not yet synced — is one IndexedDB blob
 * (shim/db/db.ts:52-56), and `allowBackup="false"` means there is no second
 * copy anywhere. Without `navigator.storage.persist()` Android is free to evict
 * it under storage pressure.
 *
 * Two properties matter here and both are tested: the request is made, and it
 * NEVER breaks boot — a cashier must still be able to sell on an engine that
 * refuses or does not implement the API.
 */
import { describe, expect, test, vi } from 'vitest';

import {
  STORAGE_AT_RISK_MESSAGE,
  ensurePersistentStorage,
  getStorageDurability,
  initStorageDurability,
} from '../src/renderer/android-pos/shim/storage-durability';

describe('ensurePersistentStorage', () => {
  test('reports unsupported when the API is absent', async () => {
    await expect(ensurePersistentStorage({})).resolves.toEqual({
      supported: false,
      persisted: false,
    });
  });

  test('does not re-request when storage is already persisted', async () => {
    const persist = vi.fn();
    const result = await ensurePersistentStorage({
      navigator: { storage: { persisted: async () => true, persist } },
    });
    expect(result).toEqual({ supported: true, persisted: true });
    expect(persist).not.toHaveBeenCalled();
  });

  test('requests persistence when not yet granted and reports the grant', async () => {
    const persist = vi.fn(async () => true);
    const result = await ensurePersistentStorage({
      navigator: { storage: { persisted: async () => false, persist } },
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ supported: true, persisted: true });
  });

  test('reports a refused request rather than throwing', async () => {
    const result = await ensurePersistentStorage({
      navigator: { storage: { persisted: async () => false, persist: async () => false } },
    });
    expect(result).toEqual({ supported: true, persisted: false });
  });

  test('never throws when the API rejects — boot must not depend on it', async () => {
    const result = await ensurePersistentStorage({
      navigator: {
        storage: {
          persisted: async () => { throw new Error('SecurityError'); },
          persist: async () => true,
        },
      },
    });
    expect(result).toEqual({ supported: true, persisted: false });
  });

  test('exposes cashier-facing copy for the at-risk banner', () => {
    expect(STORAGE_AT_RISK_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe('initStorageDurability', () => {
  test('requests once and hands every later reader the same answer', async () => {
    const persist = vi.fn(async () => true);
    const scope = { navigator: { storage: { persisted: async () => false, persist } } };
    const first = initStorageDurability(scope);
    const second = getStorageDurability();
    expect(await first).toEqual({ supported: true, persisted: true });
    expect(await second).toEqual({ supported: true, persisted: true });
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
