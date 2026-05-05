/**
 * Auth refresh helper — single-flight 401 recovery.
 *
 * PRD-driven (PLAN-refresh-token-rotation.md, C2):
 *   - happy path: /auth/refresh returns 200 → access token rotated,
 *     refresh token rotated (server-side rotation), helper returns
 *     ok=true with the new access token.
 *   - no refresh token persisted → return no-refresh-token, no fetch
 *     call, do not clear anything.
 *   - 401 from /auth/refresh → tokens are revoked → call narrow
 *     clearSecureAuthTokens (NOT clearSecureTokens — must not wipe
 *     printer pairing / AI key) → emit auth-expired event.
 *   - network error (offline / DNS / 500) → return network, do NOT
 *     clear tokens; cashier may be on a flaky link, the access token
 *     might still be valid for the next attempt.
 *   - concurrent calls share one fetch → critical because backend
 *     rotates the refresh token on every successful refresh; a race
 *     would invalidate all but one caller's stored refresh token.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { storeData, storeMock } = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  const set = (key: string | object, value?: unknown) => {
    if (typeof key === 'string') data.set(key, value);
    else for (const [k, v] of Object.entries(key)) data.set(k, v);
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
  class Store {
    set = storeMock.set;
    get = storeMock.get;
    has = storeMock.has;
    delete = storeMock.delete;
    clear = storeMock.clear;
    onDidAnyChange = storeMock.onDidAnyChange;
    get store() { return storeMock.store; }
  }
  return { default: Store };
});

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => 'C:\\tmp'), getVersion: vi.fn(() => 'test') },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  setSecureAuthToken,
  setSecureRefreshToken,
  getSecureAuthToken,
  getSecureRefreshToken,
} from '../src/main/config/store';
import {
  refreshAccessToken,
  authEvents,
  AUTH_EXPIRED,
  __resetAuthRefreshForTests,
} from '../src/main/network/auth-refresh';

const fetchMock = vi.fn();

beforeEach(() => {
  storeData.clear();
  storeData.set('serverUrl', 'https://api.test');
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as any;
  __resetAuthRefreshForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('refreshAccessToken — happy path', () => {
  it('exchanges refresh_token for a new access_token and persists rotation', async () => {
    setSecureRefreshToken('old-refresh');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    const result = await refreshAccessToken();

    expect(result).toEqual({ ok: true, accessToken: 'new-access' });
    expect(getSecureAuthToken()).toBe('new-access');
    expect(getSecureRefreshToken()).toBe('new-refresh');
  });

  it('POSTs to /api/v1/auth/refresh with snake_case body field refresh_token', async () => {
    setSecureRefreshToken('rt-1');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: 'a', refresh_token: 'b' }),
        { status: 200 },
      ),
    );

    await refreshAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/v1\/auth\/refresh$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ refresh_token: 'rt-1' });
  });

  it('handles response without refresh_token rotation (preserves stored refresh)', async () => {
    setSecureRefreshToken('rt-stable');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: 'a' }), // no refresh_token in response
        { status: 200 },
      ),
    );

    const result = await refreshAccessToken();

    expect(result.ok).toBe(true);
    // Backend currently always rotates, but defensively: if no refresh_token
    // in the response, leave the stored one alone.
    expect(getSecureRefreshToken()).toBe('rt-stable');
  });
});

describe('refreshAccessToken — no refresh token stored', () => {
  it('returns no-refresh-token without calling fetch', async () => {
    // No setSecureRefreshToken — refresh slot is empty.
    const result = await refreshAccessToken();
    expect(result).toEqual({ ok: false, reason: 'no-refresh-token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT clear other tokens when refresh slot is empty', async () => {
    setSecureAuthToken('access-still-valid');
    storeData.set('encryptedApiKey', 'pa-key');

    await refreshAccessToken();

    expect(getSecureAuthToken()).toBe('access-still-valid');
    expect(storeData.get('encryptedApiKey')).toBe('pa-key');
  });
});

describe('refreshAccessToken — 401 from /auth/refresh', () => {
  it('returns refresh-rejected and emits auth-expired event', async () => {
    setSecureAuthToken('old-access');
    setSecureRefreshToken('revoked-refresh');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));

    const expiredHandler = vi.fn();
    authEvents.on(AUTH_EXPIRED, expiredHandler);

    const result = await refreshAccessToken();

    expect(result).toEqual({ ok: false, reason: 'refresh-rejected' });
    expect(expiredHandler).toHaveBeenCalledTimes(1);

    authEvents.off(AUTH_EXPIRED, expiredHandler);
  });

  it('clears auth + refresh tokens (narrow scope)', async () => {
    setSecureAuthToken('access');
    setSecureRefreshToken('refresh');
    storeData.set('encryptedApiKey', 'pa-key-survives');
    storeData.set('encryptedAiApiKey', 'ai-key-survives');

    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));

    await refreshAccessToken();

    expect(getSecureAuthToken()).toBeNull();
    expect(getSecureRefreshToken()).toBeNull();
    // Crucial — printer pairing key + AI key must survive a session
    // expiry; they are device-bound, not user-session-bound.
    expect(storeData.get('encryptedApiKey')).toBe('pa-key-survives');
    expect(storeData.get('encryptedAiApiKey')).toBe('ai-key-survives');
  });
});

describe('refreshAccessToken — network error', () => {
  it('returns network when fetch throws and does NOT clear tokens', async () => {
    setSecureAuthToken('access-might-still-work');
    setSecureRefreshToken('refresh-still-good');
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await refreshAccessToken();

    expect(result).toEqual({ ok: false, reason: 'network' });
    expect(getSecureAuthToken()).toBe('access-might-still-work');
    expect(getSecureRefreshToken()).toBe('refresh-still-good');
  });

  it('treats 5xx as network error (NOT auth-rejected)', async () => {
    setSecureRefreshToken('rt');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));

    const result = await refreshAccessToken();

    expect(result).toEqual({ ok: false, reason: 'network' });
    // Refresh token must NOT be cleared on 5xx — it might be a temporary
    // backend hiccup, the token is still valid.
    expect(getSecureRefreshToken()).toBe('rt');
  });

  // PRD: backend rate-limits /auth/refresh at 10/min/IP. A 429 means
  // "back off and retry later" — NOT "session is dead". Treating it as
  // refresh-rejected would log the cashier out for a transient burst
  // (e.g. 5 timers concurrently hit 401 and only the first triggers
  // a real refresh — the rest see 429).
  it('treats 429 (throttled) as network error, NOT refresh-rejected', async () => {
    setSecureRefreshToken('rt');
    fetchMock.mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }));

    const result = await refreshAccessToken();

    expect(result).toEqual({ ok: false, reason: 'network' });
    expect(getSecureRefreshToken()).toBe('rt');
  });

  // PRD: only 401 maps to refresh-rejected. 400/403/404/etc. are
  // backend hiccups or routing problems — keep tokens, return network.
  it('treats other 4xx (400, 403, 404) as network error, NOT refresh-rejected', async () => {
    for (const status of [400, 403, 404]) {
      storeData.set('encryptedRefreshToken', '');
      setSecureRefreshToken('rt');
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(new Response('', { status }));

      const expiredHandler = vi.fn();
      authEvents.on(AUTH_EXPIRED, expiredHandler);

      const result = await refreshAccessToken();

      expect(result, `status=${status}`).toEqual({ ok: false, reason: 'network' });
      expect(getSecureRefreshToken(), `status=${status}`).toBe('rt');
      expect(expiredHandler, `status=${status}`).not.toHaveBeenCalled();
      authEvents.off(AUTH_EXPIRED, expiredHandler);
    }
  });

  // PRD: malformed response → network reason. Otherwise a partially-
  // written response could trick the helper into clearing tokens or
  // accepting a corrupt access_token.
  it('treats malformed JSON response as network error', async () => {
    setSecureRefreshToken('rt');
    fetchMock.mockResolvedValueOnce(
      new Response('not json {{{', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const result = await refreshAccessToken();

    expect(result).toEqual({ ok: false, reason: 'network' });
    expect(getSecureRefreshToken()).toBe('rt');
  });

  // PRD: 200 with no access_token field is a backend bug or a partial
  // response. Don't accept the response — treat as network so the
  // caller can retry on the next 401.
  it('treats 200 with missing access_token as network error', async () => {
    setSecureRefreshToken('rt');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ refresh_token: 'rt-2' }), // no access_token
        { status: 200 },
      ),
    );

    const result = await refreshAccessToken();

    expect(result).toEqual({ ok: false, reason: 'network' });
    // Old tokens preserved — backend hasn't given us anything usable.
    expect(getSecureAuthToken()).toBeNull();
    expect(getSecureRefreshToken()).toBe('rt');
  });

  it('does NOT emit auth-expired on network error', async () => {
    setSecureRefreshToken('rt');
    fetchMock.mockRejectedValueOnce(new Error('timeout'));

    const expiredHandler = vi.fn();
    authEvents.on(AUTH_EXPIRED, expiredHandler);

    await refreshAccessToken();

    expect(expiredHandler).not.toHaveBeenCalled();
    authEvents.off(AUTH_EXPIRED, expiredHandler);
  });
});

describe('refreshAccessToken — single-flight (concurrent calls)', () => {
  it('two concurrent calls share one fetch and one refresh-token rotation', async () => {
    setSecureRefreshToken('rt-1');
    let resolveResponse!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((r) => { resolveResponse = r; }),
    );

    const p1 = refreshAccessToken();
    const p2 = refreshAccessToken();

    // Only one fetch fired — single-flight gate held.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse(
      new Response(
        JSON.stringify({ access_token: 'new-a', refresh_token: 'new-r' }),
        { status: 200 },
      ),
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ ok: true, accessToken: 'new-a' });
    expect(r2).toEqual({ ok: true, accessToken: 'new-a' });
    // Still only one fetch — no second refresh leaked through after
    // the first resolved.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('after one refresh resolves, the next call mints a fresh fetch (no stale gate)', async () => {
    setSecureRefreshToken('rt-1');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: 'a1', refresh_token: 'r1' }),
        { status: 200 },
      ),
    );

    await refreshAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: 'a2', refresh_token: 'r2' }),
        { status: 200 },
      ),
    );

    const r2 = await refreshAccessToken();
    expect(r2).toEqual({ ok: true, accessToken: 'a2' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
