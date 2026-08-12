import { describe, expect, it, vi } from 'vitest';
import { createHash, randomFillSync } from 'node:crypto';

import {
  KIOSK_EXIT_PIN_KEY,
  KIOSK_EXIT_PIN_LOCKOUT_MS,
  KIOSK_EXIT_PIN_MAX_ATTEMPTS,
  KioskExitPinStore,
} from '../src/renderer/android-pos/shim/kiosk-exit-pin';

function secureKvFake() {
  const values = new Map<string, string>();
  return {
    values,
    get: vi.fn(async ({ key }: { key: string }) => ({ value: values.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => { values.set(key, value); }),
    remove: vi.fn(async ({ key }: { key: string }) => { values.delete(key); }),
    clear: vi.fn(async () => { values.clear(); }),
    sha256: vi.fn(async ({ value }: { value: string }) => ({
      value: createHash('sha256').update(value).digest('base64'),
    })),
  };
}

describe('Android kiosk exit PIN', () => {
  it('fails closed when SecureKV is unavailable or no dedicated PIN is configured', async () => {
    const unavailable = new KioskExitPinStore({ secureKv: null });
    await expect(unavailable.status()).resolves.toMatchObject({ available: false, configured: false });
    await expect(unavailable.configure('2468')).resolves.toMatchObject({ success: false, code: 'SECURE_STORAGE_UNAVAILABLE' });
    await expect(unavailable.verify('2468')).resolves.toMatchObject({ success: false, code: 'SECURE_STORAGE_UNAVAILABLE' });

    const plugin = secureKvFake();
    const unset = new KioskExitPinStore({ secureKv: plugin });
    await expect(unset.status()).resolves.toMatchObject({ available: true, configured: false });
    await expect(unset.verify('2468')).resolves.toMatchObject({ success: false, code: 'UNSET' });
  });

  it('stores only a salted digest, accepts the correct PIN, and resets prior failed attempts', async () => {
    const plugin = secureKvFake();
    const store = new KioskExitPinStore({ secureKv: plugin });
    await expect(store.configure('2468')).resolves.toMatchObject({ success: true, code: 'OK' });

    const persisted = plugin.values.get(KIOSK_EXIT_PIN_KEY) || '';
    expect(persisted).not.toContain('2468');
    expect(JSON.parse(persisted)).toMatchObject({ version: 1, failedAttempts: 0, lockedUntil: null });

    await expect(store.verify('0000')).resolves.toMatchObject({ success: false, code: 'INVALID_PIN', attemptsRemaining: 4 });
    await expect(store.verify('2468')).resolves.toMatchObject({ success: true, code: 'OK', attemptsRemaining: KIOSK_EXIT_PIN_MAX_ATTEMPTS });
    await expect(store.status()).resolves.toMatchObject({ configured: true, attemptsRemaining: KIOSK_EXIT_PIN_MAX_ATTEMPTS });
  });

  it('durably rate-limits attempts, then resets after the lockout expires', async () => {
    const plugin = secureKvFake();
    let now = 1_000_000;
    const store = new KioskExitPinStore({ secureKv: plugin, now: () => now });
    await store.configure('2468');

    for (let attempt = 1; attempt < KIOSK_EXIT_PIN_MAX_ATTEMPTS; attempt += 1) {
      await expect(store.verify('0000')).resolves.toMatchObject({ success: false, code: 'INVALID_PIN' });
    }
    const lock = await store.verify('0000');
    expect(lock).toMatchObject({ success: false, code: 'LOCKED', lockedUntil: now + KIOSK_EXIT_PIN_LOCKOUT_MS });
    await expect(store.verify('2468')).resolves.toMatchObject({ success: false, code: 'LOCKED' });

    now += KIOSK_EXIT_PIN_LOCKOUT_MS + 1;
    await expect(store.verify('2468')).resolves.toMatchObject({ success: true, code: 'OK', attemptsRemaining: KIOSK_EXIT_PIN_MAX_ATTEMPTS });
    await expect(store.status()).resolves.toMatchObject({ lockedUntil: null, attemptsRemaining: KIOSK_EXIT_PIN_MAX_ATTEMPTS });
  });

  it('persists across service instances and a manager change invalidates the old PIN', async () => {
    const plugin = secureKvFake();
    const initial = new KioskExitPinStore({ secureKv: plugin });
    await initial.configure('2468');

    const afterRestart = new KioskExitPinStore({ secureKv: plugin });
    await expect(afterRestart.verify('2468')).resolves.toMatchObject({ success: true, code: 'OK' });
    await expect(afterRestart.configure('1357')).resolves.toMatchObject({ success: true, code: 'OK' });

    const changed = new KioskExitPinStore({ secureKv: plugin });
    await expect(changed.verify('2468')).resolves.toMatchObject({ success: false, code: 'INVALID_PIN' });
    await expect(changed.verify('1357')).resolves.toMatchObject({ success: true, code: 'OK' });
  });

  it('uses the native SHA-256 fallback when WebView 83 live HTTP has no SubtleCrypto', async () => {
    const previousCrypto = globalThis.crypto;
    const getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      if (array) randomFillSync(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
      return array;
    };
    vi.stubGlobal('crypto', { getRandomValues });
    try {
      const plugin = secureKvFake();
      const store = new KioskExitPinStore({ secureKv: plugin });
      await expect(store.configure('2468')).resolves.toMatchObject({ success: true, code: 'OK' });
      await expect(store.verify('2468')).resolves.toMatchObject({ success: true, code: 'OK' });
      expect(plugin.sha256).toHaveBeenCalledTimes(2);
      expect(plugin.values.get(KIOSK_EXIT_PIN_KEY)).not.toContain('2468');
    } finally {
      vi.stubGlobal('crypto', previousCrypto);
    }
  });
});
