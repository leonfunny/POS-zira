/**
 * Packet S4 — TokenStore (Android parity port) tests.
 *
 * Covers the two storage paths the shim's token store exposes:
 *   • NATIVE  — `window.Capacitor.Plugins.SecureKV` is present (a fake of the
 *     SecureKVPlugin Java plugin). Verifies get/set/remove/clear call shapes,
 *     isSecure === true, and that access/refresh tokens round-trip + clear().
 *   • FALLBACK — the native plugin is absent (plain browser / vitest). Verifies
 *     plaintext localStorage persistence under the `zira.dev-insecure.` prefix,
 *     isSecure === false, and the same round-trip + clear() semantics.
 *
 * The fake plugin also asserts the secure-storage boundary is honored: token
 * values only ever travel through the typed plugin methods (never logged).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenStore } from '../src/renderer/android-pos/shim/token-store';

// ─── fakes ──────────────────────────────────────────────────────────────────

/**
 * A fake SecureKV plugin backed by an in-memory Map, so round-trip + clear
 * semantics can be exercised while still asserting exact call shapes via the
 * vi.fn wrappers. Mirrors the SecureKVPlugin.java contract
 * (get→{value}, set/remove/clear→{}).
 */
function makeFakePlugin() {
  const map = new Map<string, string>();
  return {
    map,
    get: vi.fn(async ({ key }: { key: string }): Promise<{ value: string | null }> => ({
      value: map.has(key) ? (map.get(key) as string) : null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }): Promise<void> => {
      map.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }): Promise<void> => {
      map.delete(key);
    }),
    clear: vi.fn(async (): Promise<void> => {
      map.clear();
    }),
  };
}

/** A localStorage-shaped adapter backed by a Map (fallback path tests). */
function makeFakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: vi.fn((k: string) => (map.has(k) ? (map.get(k) as string) : null)),
    setItem: vi.fn((k: string, v: string) => { map.set(k, v); }),
    removeItem: vi.fn((k: string) => { map.delete(k); }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── native path (SecureKV present → Keystore-backed) ──────────────────────

describe('TokenStore — native SecureKV path', () => {
  let plugin: ReturnType<typeof makeFakePlugin>;

  beforeEach(() => {
    plugin = makeFakePlugin();
    // The approved runtime-global access path; no @capacitor/* import.
    vi.stubGlobal('window', {
      Capacitor: { Plugins: { SecureKV: plugin } },
    });
  });

  it('reports isSecure === true', () => {
    expect(new TokenStore().isSecure).toBe(true);
  });

  it('getAccessToken calls SecureKV.get with {key:"access_token"}', async () => {
    plugin.map.set('access_token', 'jwt.access.value');
    const store = new TokenStore();

    const value = await store.getAccessToken();

    expect(plugin.get).toHaveBeenCalledTimes(1);
    expect(plugin.get).toHaveBeenCalledWith({ key: 'access_token' });
    expect(value).toBe('jwt.access.value');
  });

  it('getRefreshToken calls SecureKV.get with {key:"refresh_token"}', async () => {
    plugin.map.set('refresh_token', 'jwt.refresh.value');
    const store = new TokenStore();

    const value = await store.getRefreshToken();

    expect(plugin.get).toHaveBeenCalledWith({ key: 'refresh_token' });
    expect(value).toBe('jwt.refresh.value');
  });

  it('getAccessToken resolves null when no token is stored', async () => {
    const store = new TokenStore();
    expect(await store.getAccessToken()).toBeNull();
  });

  it('setTokens(access, refresh) calls SecureKV.set twice with {key,value}', async () => {
    const store = new TokenStore();
    await store.setTokens('access-1', 'refresh-1');

    expect(plugin.set).toHaveBeenCalledTimes(2);
    expect(plugin.set).toHaveBeenNthCalledWith(1, { key: 'access_token', value: 'access-1' });
    expect(plugin.set).toHaveBeenNthCalledWith(2, { key: 'refresh_token', value: 'refresh-1' });
    expect(plugin.remove).not.toHaveBeenCalled();
  });

  it('setTokens(access, null) removes a stale refresh token via SecureKV.remove', async () => {
    plugin.map.set('refresh_token', 'stale');
    const store = new TokenStore();
    await store.setTokens('access-1', null);

    // access set; refresh removed (login with no refresh must drop the old one).
    expect(plugin.set).toHaveBeenCalledTimes(1);
    expect(plugin.set).toHaveBeenCalledWith({ key: 'access_token', value: 'access-1' });
    expect(plugin.remove).toHaveBeenCalledTimes(1);
    expect(plugin.remove).toHaveBeenCalledWith({ key: 'refresh_token' });
  });

  it('clear() removes only session secrets and preserves device-owned SecureKV values', async () => {
    plugin.map.set('access_token', 'a');
    plugin.map.set('refresh_token', 'r');
    plugin.map.set('printAgentKey', 'pa_test');
    plugin.map.set('kiosk_exit_pin_v1', 'device-owned-pin-digest');
    const store = new TokenStore();

    await store.clear();

    expect(plugin.clear).not.toHaveBeenCalled();
    expect(plugin.remove).toHaveBeenCalledTimes(3);
    expect(plugin.remove).toHaveBeenCalledWith({ key: 'access_token' });
    expect(plugin.remove).toHaveBeenCalledWith({ key: 'refresh_token' });
    expect(plugin.remove).toHaveBeenCalledWith({ key: 'printAgentKey' });
    expect(plugin.map.get('kiosk_exit_pin_v1')).toBe('device-owned-pin-digest');
    expect(await store.getAccessToken()).toBeNull();
    expect(await store.getRefreshToken()).toBeNull();
  });

  it('round-trips access + refresh through the encrypted store', async () => {
    const store = new TokenStore();
    await store.setTokens('access-XYZ', 'refresh-XYZ');

    expect(await store.getAccessToken()).toBe('access-XYZ');
    expect(await store.getRefreshToken()).toBe('refresh-XYZ');
    // Values live in the SecureKV map, not in any fallback surface.
    expect(plugin.map.get('access_token')).toBe('access-XYZ');
    expect(plugin.map.get('refresh_token')).toBe('refresh-XYZ');
  });
});

// ─── fallback path (no SecureKV → plaintext localStorage, dev only) ────────

describe('TokenStore — fallback localStorage path', () => {
  let storage: ReturnType<typeof makeFakeStorage>;

  beforeEach(() => {
    storage = makeFakeStorage();
    // No window.Capacitor stub → nativeSecureKv() returns null → fallback.
  });

  it('reports isSecure === false', () => {
    expect(new TokenStore({ storage }).isSecure).toBe(false);
  });

  it('persists tokens under the zira.dev-insecure. prefix', async () => {
    const store = new TokenStore({ storage });
    await store.setTokens('access-1', 'refresh-1');

    expect(storage.setItem).toHaveBeenCalledWith('zira.dev-insecure.access_token', 'access-1');
    expect(storage.setItem).toHaveBeenCalledWith('zira.dev-insecure.refresh_token', 'refresh-1');
    expect(await store.getAccessToken()).toBe('access-1');
    expect(await store.getRefreshToken()).toBe('refresh-1');
  });

  it('round-trips access + refresh and clear() wipes both', async () => {
    const store = new TokenStore({ storage });
    await store.setTokens('access-ABC', 'refresh-ABC');

    expect(await store.getAccessToken()).toBe('access-ABC');
    expect(await store.getRefreshToken()).toBe('refresh-ABC');

    await store.clear();

    expect(await store.getAccessToken()).toBeNull();
    expect(await store.getRefreshToken()).toBeNull();
    expect(storage.map.has('zira.dev-insecure.access_token')).toBe(false);
    expect(storage.map.has('zira.dev-insecure.refresh_token')).toBe(false);
  });

  it('setTokens(access, null) removes the stale refresh key', async () => {
    const store = new TokenStore({ storage });
    await store.setTokens('access-1', 'refresh-1');
    await store.setTokens('access-2', null);

    expect(await store.getAccessToken()).toBe('access-2');
    expect(await store.getRefreshToken()).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith('zira.dev-insecure.refresh_token');
  });
});

// ─── boundary: native access never reaches @capacitor/* ────────────────────

describe('TokenStore — native access boundary', () => {
  it('resolves the plugin via (window).Capacitor.Plugins.SecureKV', async () => {
    const plugin = makeFakePlugin();
    vi.stubGlobal('window', {
      Capacitor: { Plugins: { SecureKV: plugin } },
    });
    const store = new TokenStore();
    expect(store.isSecure).toBe(true);

    await store.setTokens('a', 'r');
    // The runtime-global path is the only way the store touches native code;
    // there is no static @capacitor/* import (enforced separately by the
    // cross-platform boundary verifier).
    expect(plugin.set).toHaveBeenCalledWith({ key: 'access_token', value: 'a' });
    vi.unstubAllGlobals();
  });
});
