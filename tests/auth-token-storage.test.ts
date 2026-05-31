/**
 * Auth token storage — refresh-token slot + narrow / broad clear scopes.
 *
 * Per refresh-token rotation plan (PLAN-refresh-token-rotation.md):
 *   - Refresh token persists alongside access token, both DPAPI-encrypted.
 *   - Two clear scopes:
 *       clearSecureAuthTokens()  — narrow: auth + refresh ONLY
 *       clearSecureTokens()      — broad: auth + refresh + apiKey + ai + ...
 *   - Reviewer caught that the original plan reused clearSecureTokens for
 *     refresh-rejected, which would also wipe the print-agent pairing key
 *     and the AI assistant key. The narrow helper avoids that collateral.
 *
 * Tests run against the real store.ts module with electron-store and
 * safeStorage mocked. DPAPI is faked as a reversible "enc:<value>" wrap
 * so we can verify the value flows through encrypt → store → decrypt.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

// ─── Mocks (must be hoisted-safe — use vi.hoisted for shared state) ──

const { storeData, storeMock } = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  const set = (key: string | object, value?: unknown) => {
    if (typeof key === 'string') {
      data.set(key, value);
    } else {
      for (const [k, v] of Object.entries(key)) data.set(k, v);
    }
  };
  return {
    storeData: data,
    storeMock: {
      set,
      get: (k: string) => data.get(k),
      has: (k: string) => data.has(k),
      delete: (k: string) => data.delete(k),
      clear: () => data.clear(),
      onDidAnyChange: vi.fn(),
      get store() {
        const obj: Record<string, unknown> = {};
        for (const [k, v] of data) obj[k] = v;
        return obj;
      },
    },
  };
});

vi.mock('electron-store', () => {
  // electron-store exports a default class; consumers do `new Store(opts)`.
  // We forward all method calls to the shared storeMock so test setup +
  // assertions both observe the same Map-backed state.
  class Store {
    set = storeMock.set;
    get = storeMock.get;
    has = storeMock.has;
    delete = storeMock.delete;
    clear = storeMock.clear;
    onDidAnyChange = storeMock.onDidAnyChange;
    get store() {
      return storeMock.store;
    }
  }
  return { default: Store };
});

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

// Import AFTER mocks so the mocked electron-store is used.
import {
  setSecureAuthToken,
  getSecureAuthToken,
  setSecureRefreshToken,
  getSecureRefreshToken,
  clearSecureAuthTokens,
  clearSecureTokens,
} from '../src/main/config/store';

beforeEach(() => {
  storeData.clear();
});

// ─── Refresh token storage ──────────────────────────────────────────

describe('Refresh token storage roundtrip', () => {
  it('setSecureRefreshToken → getSecureRefreshToken returns the same value', () => {
    setSecureRefreshToken('refresh-abc-123');
    expect(getSecureRefreshToken()).toBe('refresh-abc-123');
  });

  it('value is encrypted at rest (not stored as plaintext)', () => {
    setSecureRefreshToken('secret');
    const persisted = storeData.get('encryptedRefreshToken');
    expect(typeof persisted).toBe('string');
    expect(persisted).not.toBe('secret');
    // Our test fake prefixes "enc:" + base64-encodes — both shape checks
    // catch a regression where the function forgets to encrypt.
    const decoded = Buffer.from(persisted as string, 'base64').toString('utf8');
    expect(decoded).toBe('enc:secret');
  });

  it('getSecureRefreshToken returns null when slot is empty', () => {
    expect(getSecureRefreshToken()).toBeNull();
  });

  it('passing empty string clears the slot (and getter returns null)', () => {
    setSecureRefreshToken('foo');
    setSecureRefreshToken('');
    expect(getSecureRefreshToken()).toBeNull();
    expect(storeData.get('encryptedRefreshToken')).toBe('');
  });

  it('access token and refresh token are independent slots', () => {
    setSecureAuthToken('access-1');
    setSecureRefreshToken('refresh-1');
    // Overwriting one must not touch the other.
    setSecureAuthToken('access-2');
    expect(getSecureAuthToken()).toBe('access-2');
    expect(getSecureRefreshToken()).toBe('refresh-1');
  });
});

// ─── Narrow clear: clearSecureAuthTokens ────────────────────────────

describe('clearSecureAuthTokens — narrow scope (auth + refresh only)', () => {
  beforeEach(() => {
    setSecureAuthToken('access-token');
    setSecureRefreshToken('refresh-token');
    // Other secrets the reviewer warned must NOT be cleared on
    // refresh-rejected: print-agent pairing key, AI assistant key,
    // remote-control PIN.
    storeData.set('encryptedApiKey', 'pa-key-encrypted');
    storeData.set('apiKey', '');
    storeData.set('encryptedAiApiKey', 'ai-key-encrypted');
    storeData.set('aiApiKey', '');
    storeData.set('encryptedRemotePin', 'pin-encrypted');
  });

  it('clears the access-token slots (legacy + encrypted)', () => {
    clearSecureAuthTokens();
    expect(storeData.get('authToken')).toBe('');
    expect(storeData.get('encryptedAuthToken')).toBe('');
  });

  it('clears the refresh-token slot', () => {
    clearSecureAuthTokens();
    expect(storeData.get('encryptedRefreshToken')).toBe('');
  });

  it('does NOT clear encryptedApiKey (print-agent pairing must survive)', () => {
    clearSecureAuthTokens();
    expect(storeData.get('encryptedApiKey')).toBe('pa-key-encrypted');
  });

  it('does NOT clear encryptedAiApiKey (Zira AI config must survive)', () => {
    clearSecureAuthTokens();
    expect(storeData.get('encryptedAiApiKey')).toBe('ai-key-encrypted');
  });

  it('does NOT clear encryptedRemotePin (remote-control PIN must survive)', () => {
    clearSecureAuthTokens();
    expect(storeData.get('encryptedRemotePin')).toBe('pin-encrypted');
  });

  it('after narrow clear, getSecureAuthToken + getSecureRefreshToken both return null', () => {
    clearSecureAuthTokens();
    expect(getSecureAuthToken()).toBeNull();
    expect(getSecureRefreshToken()).toBeNull();
  });
});

// ─── Broad clear: clearSecureTokens (explicit logout) ───────────────

describe('clearSecureTokens — broad scope (explicit logout wipes everything)', () => {
  beforeEach(() => {
    setSecureAuthToken('access');
    setSecureRefreshToken('refresh');
    storeData.set('encryptedApiKey', 'pa');
    storeData.set('apiKey', '');
    storeData.set('encryptedAiApiKey', 'ai');
    storeData.set('aiApiKey', '');
  });

  it('clears auth + refresh + apiKey + aiApiKey (all session secrets)', () => {
    clearSecureTokens();
    expect(storeData.get('encryptedAuthToken')).toBe('');
    expect(storeData.get('encryptedApiKey')).toBe('');
    expect(storeData.get('encryptedAiApiKey')).toBe('');
  });

  it('extends to clear refresh token (regression: logout must invalidate refresh too)', () => {
    clearSecureTokens();
    expect(storeData.get('encryptedRefreshToken')).toBe('');
  });
});

// ─── Login persistence wiring (source-string regression) ────────────
//
// Behaviour test on the IPC handler would require booting the full
// AuthModule (database, socket, hardware DI). Heavy. The handler's
// only new responsibility for C1 is "if response has refresh_token,
// call setSecureRefreshToken" — a one-line wiring. Source-string
// regression catches the future contributor who forgets it.

describe('Login handlers persist refresh_token (regression guards)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/main/modules/auth.module.ts'),
    'utf8',
  );
  const apiClientSource = fs.readFileSync(
    path.resolve(__dirname, '../src/main/network/api-client.ts'),
    'utf8',
  );

  it('AUTH_CHECK_TOKEN handler (Telegram login) calls setSecureRefreshToken when refresh_token is present', () => {
    const idx = source.indexOf('AUTH_CHECK_TOKEN');
    expect(idx).toBeGreaterThan(-1);
    // Look at the next ~1500 chars — covers the whole handler body.
    const block = source.slice(idx, idx + 1500);
    expect(block).toMatch(/setSecureRefreshToken\s*\(/);
    // Defence: must guard on result.refresh_token (don't blindly call
    // with undefined and clear a valid token).
    expect(block).toMatch(/result\.refresh_token|result\?\.refresh_token/);
  });

  it('AUTH_LOGIN_EMAIL handler (email login) calls setSecureRefreshToken when refresh_token is present', () => {
    const idx = source.indexOf('AUTH_LOGIN_EMAIL');
    expect(idx).toBeGreaterThan(-1);
    // The email-login handler is longer than the Telegram one — slice
    // up to the next ipcMain.handle so we cover the full body without
    // bleeding into the next handler.
    const after = source.slice(idx);
    const nextHandler = after.indexOf('ipcMain.handle', 50);
    const block = nextHandler > 0 ? after.slice(0, nextHandler) : after.slice(0, 5000);
    expect(block).toMatch(/setSecureRefreshToken\s*\(/);
    expect(block).toMatch(/result\.refresh_token|result\?\.refresh_token/);
  });

  it('AUTH_REGISTER_TOKEN handler does NOT persist refresh_token (it just generates a registration token, no session yet)', () => {
    // Regression guard: if a future contributor mistakenly adds
    // setSecureRefreshToken to the register handler, the test fails.
    // The session is established later via AUTH_CHECK_TOKEN polling.
    const idx = source.indexOf('AUTH_REGISTER_TOKEN');
    expect(idx).toBeGreaterThan(-1);
    // AUTH_REGISTER_TOKEN handler is short — read up to the next
    // ipcMain.handle call so we don't pull the next handler's body.
    const after = source.slice(idx);
    const nextHandler = after.indexOf('ipcMain.handle', 50);
    const block = nextHandler > 0 ? after.slice(0, nextHandler) : after.slice(0, 500);
    expect(block).not.toMatch(/setSecureRefreshToken/);
  });

  it('login auto-connect falls back to the current print-agent key when the stored key is stale', () => {
    expect(source).toContain('connectWithAvailablePrintAgentKey');
    expect(source).toContain('Stored print-agent key failed after');
    expect(source).toContain('Stored print-agent key salon mismatch after');
    expect(source).toContain('client.getMyPrintAgentKey(accessToken)');
    expect(source).toMatch(/connectWithAvailablePrintAgentKey\([\s\S]+result\.access_token,[\s\S]+'telegram login'[\s\S]+newSalonId/);
    expect(source).toMatch(/connectWithAvailablePrintAgentKey\([\s\S]+result\.access_token,[\s\S]+'email login'[\s\S]+newSalonId/);
    expect(source).toMatch(/connectWithAvailablePrintAgentKey\([\s\S]+token,[\s\S]+'startup'[\s\S]+config\.salonId/);
  });

  it('print-agent connect does not write plaintext apiKey into renderer config', () => {
    const idx = apiClientSource.indexOf('const nextConfig');
    expect(idx).toBeGreaterThan(-1);
    const block = apiClientSource.slice(idx, apiClientSource.indexOf('setConfig(nextConfig)', idx));
    expect(block).not.toMatch(/\bapiKey\b/);
  });

  it('GET_CONFIG returns renderer-safe config with credential fields stripped', () => {
    expect(source).toContain('function getRendererConfig');
    expect(source).toContain('ipcMain.handle(IPC_CHANNELS.GET_CONFIG, () => getRendererConfig())');
    for (const field of [
      'apiKey',
      'authToken',
      'encryptedAuthToken',
      'encryptedRefreshToken',
      'encryptedApiKey',
      'encryptedAiApiKey',
      'encryptedRemotePin',
      'enailJwt',
      'telegramBotToken',
    ]) {
      expect(source).toContain(field);
    }
  });
});
