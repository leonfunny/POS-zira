/**
 * TokenStore — Keystore-backed staff-JWT persistence for the Android POS shim.
 *
 * Packet S4 of the Android parity port — see
 * docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md (§5, S4) and the
 * SHIM_CONTRACT_S1.md §2.B note. This is the Android stand-in for the Windows
 * DPAPI safeStorage path that persists the eNail staff JWTs
 * (`access_token` / `refresh_token`) in `%APPDATA%/Zira AI/config.json` as
 * `encryptedAuthToken` / `encryptedRefreshToken`. On Android the tokens live in
 * the native SecureKV plugin (EncryptedSharedPreferences + a Keystore-held
 * AES256_GCM master key) — equivalent-or-better confidentiality.
 *
 * ─── Native access boundary ────────────────────────────────────────────────
 * The cross-platform boundary verifier forbids importing `@capacitor/*` in the
 * shim graph. The SecureKV plugin is therefore reached ONLY through the runtime
 * global `(window as any).Capacitor?.Plugins?.SecureKV` — the plugin is an
 * in-app Capacitor plugin registered in MainActivity, so it exists on the
 * global at runtime with zero static import. This is the approved pattern.
 *
 * ─── Fallback (dev / plain browser) ────────────────────────────────────────
 * When the native plugin is absent, plaintext fallback is available only in a
 * Vite development build or when a test explicitly opts in. Production reads
 * fail closed and writes reject; tokens can never silently enter WebView
 * localStorage because a native plugin was omitted or failed to register.
 *
 * ─── Logging ───────────────────────────────────────────────────────────────
 * This module NEVER logs token values. Errors are surfaced as null results
 * (fail closed) or rejected promises; a token string is never passed to
 * console/log/error reporting.
 *
 * S7 wires this store into the auth flow + the S3 PosApiClient TokenProvider;
 * S4 only ships the storage primitive (no auth-flow wiring here).
 */

// Dedicated logical keys — match the LoginResponse field names the S3
// api-client returns (access_token / refresh_token). These are NOT the Windows
// electron-store field names (encryptedAuthToken), because SecureKV is a
// separate store; the "logical key" parity (S1 §2.B note) is the token
// identity, not the Windows persistence field name.
const ACCESS_TOKEN_KEY = 'access_token';
const REFRESH_TOKEN_KEY = 'refresh_token';

// E-PARITY-1: the salon-wide print-agent API key (Windows `pa_xxx`). The Sunmi
// is a trusted fixed terminal (owner-approved 2026-07-19), so it MAY hold this
// key exactly like the Windows counter does in electron-store via safeStorage
// (setSecureApiKey/getSecureApiKey — auth.module.ts:919, config/store.ts). The
// logical slot name is `printAgentKey` (NOT the `pa_`-prefixed value) so the
// slot identifier itself carries no key material. The KEY VALUE is never logged.
const PRINT_AGENT_KEY = 'printAgentKey';

/** localStorage key prefix for the plaintext dev fallback (never on-device). */
const INSECURE_PREFIX = 'zira.dev-insecure.';

/** Call shape of the native SecureKV Capacitor plugin (SecureKVPlugin.java). */
interface SecureKVPlugin {
  get(opts: { key: string }): Promise<{ value: string | null }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
  clear(): Promise<void>;
}

/** Minimal KV adapter — works in a browser, jsdom, or pure-node tests. */
export interface TokenStoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): TokenStoreStorage {
  const g = globalThis as unknown as { localStorage?: TokenStoreStorage };
  if (g.localStorage) return g.localStorage;
  // Pure-node fallback (unit tests without jsdom).
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

/**
 * Resolve the native SecureKV plugin from the runtime global, or null when it
 * is absent. Reaches `(window).Capacitor.Plugins.SecureKV` first (the WebView
 * surface Capacitor injects) and falls back to a bare `globalThis.Capacitor`.
 * Pure read — safe to call from inside methods; no module-load side effect.
 */
function nativeSecureKv(): SecureKVPlugin | null {
  const g = globalThis as unknown as {
    window?: { Capacitor?: { Plugins?: { SecureKV?: unknown } } };
    Capacitor?: { Plugins?: { SecureKV?: unknown } };
  };
  const capacitor = g.window?.Capacitor ?? g.Capacitor;
  const plugin = capacitor?.Plugins?.SecureKV;
  if (plugin && typeof plugin === 'object') {
    // Treat the present plugin as the SecureKV contract; the cast is the
    // runtime-global boundary the verifier requires (no @capacitor/* import).
    return plugin as SecureKVPlugin;
  }
  return null;
}

export interface TokenStoreOptions {
  /** Inject a localStorage-like adapter (tests). Defaults to globalThis.localStorage. */
  storage?: TokenStoreStorage;
  /** Explicit test/dev escape hatch. Production defaults to false. */
  allowInsecureFallback?: boolean;
}

export class SecureTokenStorageUnavailableError extends Error {
  readonly code = 'SECURE_TOKEN_STORAGE_UNAVAILABLE';

  constructor() {
    super('Secure token storage is unavailable');
    this.name = 'SecureTokenStorageUnavailableError';
  }
}

/**
 * Secure token store for the Android POS shim. Staff access/refresh tokens are
 * persisted via the native SecureKV plugin when present; otherwise in
 * `localStorage` (dev only, flagged `isSecure === false`).
 */
export class TokenStore {
  private readonly storage: TokenStoreStorage;
  private readonly allowInsecureFallback: boolean;

  constructor(options: TokenStoreOptions = {}) {
    this.storage = options.storage ?? defaultStorage();
    this.allowInsecureFallback = options.allowInsecureFallback ?? import.meta.env.DEV;
  }

  /**
   * True when the native Keystore-backed SecureKV plugin is active. False on
   * the plaintext localStorage fallback — callers may surface a dev warning.
   */
  get isSecure(): boolean {
    return nativeSecureKv() !== null;
  }

  /** Current staff access token, or null when none is stored. */
  async getAccessToken(): Promise<string | null> {
    return this.read(ACCESS_TOKEN_KEY);
  }

  /** Current refresh token, or null when none is stored. */
  async getRefreshToken(): Promise<string | null> {
    return this.read(REFRESH_TOKEN_KEY);
  }

  /**
   * Persist the access token (always) and the refresh token (when present).
   * When `refreshToken` is null/undefined, any stale refresh token is removed
   * (a login that returns no refresh token must not keep the previous one).
   */
  async setTokens(accessToken: string, refreshToken?: string | null): Promise<void> {
    await this.write(ACCESS_TOKEN_KEY, accessToken);
    if (refreshToken) {
      await this.write(REFRESH_TOKEN_KEY, refreshToken);
    } else {
      await this.removeKey(REFRESH_TOKEN_KEY);
    }
  }

  /**
   * E-PARITY-1: the stored print-agent API key (`pa_…`), or null when the device
   * has never fetched/connected. Mirrors Windows getSecureApiKey. Never logged.
   */
  async getPrintAgentKey(): Promise<string | null> {
    return this.read(PRINT_AGENT_KEY);
  }

  /** Persist the print-agent API key (mirror Windows setSecureApiKey). */
  async setPrintAgentKey(key: string): Promise<void> {
    await this.write(PRINT_AGENT_KEY, key);
  }

  /** Drop the stored print-agent key (logout / terminal unpair). */
  async clearPrintAgentKey(): Promise<void> {
    await this.removeKey(PRINT_AGENT_KEY);
  }

  /** Wipe both tokens (logout). Clears the whole SecureKV file on-device. */
  async clear(): Promise<void> {
    const plugin = nativeSecureKv();
    if (plugin) {
      try {
        await plugin.clear();
        return;
      } catch {
        // Fall through to a best-effort local wipe.
      }
    }
    this.storage.removeItem(INSECURE_PREFIX + ACCESS_TOKEN_KEY);
    this.storage.removeItem(INSECURE_PREFIX + REFRESH_TOKEN_KEY);
    this.storage.removeItem(INSECURE_PREFIX + PRINT_AGENT_KEY);
  }

  private async read(key: string): Promise<string | null> {
    const plugin = nativeSecureKv();
    if (plugin) {
      try {
        const { value } = await plugin.get({ key });
        return value ?? null;
      } catch {
        // Fail closed — never surface a stored secret via an error path.
        return null;
      }
    }
    if (!this.allowInsecureFallback) return null;
    return this.storage.getItem(INSECURE_PREFIX + key);
  }

  private async write(key: string, value: string): Promise<void> {
    const plugin = nativeSecureKv();
    if (plugin) {
      await plugin.set({ key, value });
      return;
    }
    if (!this.allowInsecureFallback) throw new SecureTokenStorageUnavailableError();
    this.storage.setItem(INSECURE_PREFIX + key, value);
  }

  private async removeKey(key: string): Promise<void> {
    const plugin = nativeSecureKv();
    if (plugin) {
      try {
        await plugin.remove({ key });
        return;
      } catch {
        // Best-effort; a stale refresh token is not a security cliff.
      }
    }
    this.storage.removeItem(INSECURE_PREFIX + key);
  }
}
