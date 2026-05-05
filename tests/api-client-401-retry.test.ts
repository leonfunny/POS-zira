/**
 * api-client.fetchWithTimeout — 401 auto-retry via refreshAccessToken.
 *
 * PRD-driven from PLAN-refresh-token-rotation.md C2:
 *   - 200 → pass through unchanged.
 *   - 401 + Bearer header + non-auth-endpoint → call refreshAccessToken,
 *     rebuild Authorization header with NEW token, retry once. Return
 *     retry's response.
 *   - 401 + auth endpoint (login/refresh/logout) → no retry, would loop.
 *   - 401 + no Bearer header → no retry, request wasn't auth'd.
 *   - 401 + refresh fails (refresh-rejected) → return original 401, do
 *     NOT retry; refresh helper has already cleared tokens + emitted
 *     auth-expired.
 *   - 401 + refresh fails (network) → return original 401; transient
 *     network blip, caller's existing error path runs.
 *
 * Reviewer's critical concern (claim 6): on retry, the Authorization
 * header MUST be the new access token, not the original. Test asserts
 * the second fetch call's Authorization is the NEW value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const refreshAccessTokenMock = vi.hoisted(() => vi.fn());

// Hoist a shared error class so api-client's static import + the test's
// dynamic import both see the same constructor identity (instanceof
// must work across both).
const { AuthRefreshNetworkErrorMock } = vi.hoisted(() => {
  class AuthRefreshNetworkError extends Error {
    constructor(message: string = 'token refresh transiently failed') {
      super(message);
      this.name = 'AuthRefreshNetworkError';
    }
  }
  return { AuthRefreshNetworkErrorMock: AuthRefreshNetworkError };
});

vi.mock('../src/main/network/auth-refresh', () => ({
  refreshAccessToken: refreshAccessTokenMock,
  authEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  AUTH_EXPIRED: 'auth-expired',
  AuthRefreshNetworkError: AuthRefreshNetworkErrorMock,
}));

import { fetchWithTimeoutForTests } from '../src/main/network/api-client';

const fetchMock = vi.fn();

beforeEach(() => {
  refreshAccessTokenMock.mockReset();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as any;
});

afterEach(() => { vi.restoreAllMocks(); });

describe('fetchWithTimeout — happy path', () => {
  it('200 response passes through, no refresh call', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const r = await fetchWithTimeoutForTests('https://api.test/v1/products', {
      headers: { Authorization: 'Bearer access-1' },
    });

    expect(r.status).toBe(200);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchWithTimeout — 401 retry with refresh', () => {
  it('on 401 with Bearer header on non-auth endpoint: refresh + retry with NEW token', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('retry-ok', { status: 200 }));

    refreshAccessTokenMock.mockResolvedValueOnce({
      ok: true,
      accessToken: 'new-access',
    });

    const r = await fetchWithTimeoutForTests('https://api.test/v1/products', {
      headers: { Authorization: 'Bearer old-access' },
    });

    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);

    // Critical: retry MUST overwrite the Authorization header with the
    // new access token. Reviewer's claim 6 — "đừng vô tình dùng token cũ".
    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    const retryHeaders = retryInit.headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer new-access');
  });

  it('preserves the original method, body, and other headers on retry', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    refreshAccessTokenMock.mockResolvedValueOnce({
      ok: true,
      accessToken: 'new-access',
    });

    await fetchWithTimeoutForTests('https://api.test/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer old-access',
        'Content-Type': 'application/json',
        'X-Salon-Slug': 'chesaigon',
      },
      body: JSON.stringify({ id: 'order-1' }),
    });

    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(retryInit.method).toBe('POST');
    expect(retryInit.body).toBe(JSON.stringify({ id: 'order-1' }));
    const headers = retryInit.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Salon-Slug']).toBe('chesaigon');
    expect(headers.Authorization).toBe('Bearer new-access');
  });
});

describe('fetchWithTimeout — 401 NOT retried', () => {
  it('does NOT retry when the request had no Bearer header', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));

    const r = await fetchWithTimeoutForTests('https://api.test/v1/public', {
      headers: { 'X-Salon-Slug': 'chesaigon' }, // no Authorization
    });

    expect(r.status).toBe(401);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on /api/v1/auth/login (would loop)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));

    const r = await fetchWithTimeoutForTests('https://api.test/api/v1/auth/login', {
      method: 'POST',
      headers: { Authorization: 'Bearer x' },
    });

    expect(r.status).toBe(401);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  it('does NOT retry on /api/v1/auth/refresh (would infinite-loop on rejection)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));

    const r = await fetchWithTimeoutForTests('https://api.test/api/v1/auth/refresh', {
      method: 'POST',
      headers: { Authorization: 'Bearer x' },
    });

    expect(r.status).toBe(401);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  it('does NOT retry on /api/v1/auth/check-token', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    await fetchWithTimeoutForTests('https://api.test/api/v1/auth/check-token', {
      headers: { Authorization: 'Bearer x' },
    });
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  it('does NOT retry on /api/v1/auth/register', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    await fetchWithTimeoutForTests('https://api.test/api/v1/auth/register', {
      method: 'POST',
      headers: { Authorization: 'Bearer x' },
    });
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  // PRD: HTTP headers are case-insensitive. `fetch` callers may pass
  // `authorization` lowercase (Node, some libraries normalize). The
  // wrapper must detect both spellings; missing this would silently
  // skip refresh on a perfectly valid 401.
  it('detects lowercase "authorization" header (case-insensitive)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    refreshAccessTokenMock.mockResolvedValueOnce({
      ok: true,
      accessToken: 'fresh',
    });

    await fetchWithTimeoutForTests('https://api.test/v1/products', {
      headers: { authorization: 'Bearer old' }, // lowercase
    });

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWithTimeout — no infinite retry loop', () => {
  // PRD: only ONE retry per request. If the new token also gets 401
  // (e.g. backend revoked the user between refresh and retry), the
  // wrapper must NOT trigger another refresh + retry. Otherwise a
  // hostile backend could induce infinite recursion.
  it('returns the second 401 as-is, only ONE refresh call total', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 })) // initial
      .mockResolvedValueOnce(new Response('', { status: 401 })); // retry also 401
    refreshAccessTokenMock.mockResolvedValueOnce({
      ok: true,
      accessToken: 'new',
    });

    const r = await fetchWithTimeoutForTests('https://api.test/v1/products', {
      headers: { Authorization: 'Bearer old' },
    });

    expect(r.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2); // exactly one retry
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1); // no second refresh
  });
});

describe('fetchWithTimeout — refresh failures', () => {
  it('returns the original 401 when refresh-rejected (helper already emitted auth-expired)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    refreshAccessTokenMock.mockResolvedValueOnce({
      ok: false,
      reason: 'refresh-rejected',
    });

    const r = await fetchWithTimeoutForTests('https://api.test/v1/products', {
      headers: { Authorization: 'Bearer old' },
    });

    expect(r.status).toBe(401);
    // No retry attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('THROWS AuthRefreshNetworkError when refresh hits network error (P1 fix)', async () => {
    // Reviewer P1: surfacing the original 401 makes resolveCurrentUser
    // misclassify a transient backend hiccup as auth-rejected → forced
    // logout. The wrapper must throw a typed error instead so callers
    // can distinguish "really expired" from "temporarily unverifiable".
    const { AuthRefreshNetworkError } = await import(
      '../src/main/network/auth-refresh'
    );
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    refreshAccessTokenMock.mockResolvedValueOnce({
      ok: false,
      reason: 'network',
    });

    await expect(
      fetchWithTimeoutForTests('https://api.test/v1/products', {
        headers: { Authorization: 'Bearer old' },
      }),
    ).rejects.toBeInstanceOf(AuthRefreshNetworkError);

    // Only the original request fired. No retry on transient failure.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AuthRefreshNetworkError message must NOT include "401" substring (regex tripwire)', async () => {
    // resolveCurrentUser uses /\b401\b/ to detect auth-rejected. If
    // the typed error's message helpfully says "(status was 401)",
    // a buggy ordering of checks could re-trigger the auth-rejected
    // path. Defence in depth: make the message regex-safe.
    const { AuthRefreshNetworkError } = await import(
      '../src/main/network/auth-refresh'
    );
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    refreshAccessTokenMock.mockResolvedValueOnce({ ok: false, reason: 'network' });

    let captured: unknown;
    try {
      await fetchWithTimeoutForTests('https://api.test/v1/products', {
        headers: { Authorization: 'Bearer old' },
      });
    } catch (e) {
      captured = e;
    }

    expect(captured).toBeInstanceOf(AuthRefreshNetworkError);
    expect(String((captured as Error).message)).not.toMatch(/\b401\b/);
  });

  it('returns the original 401 when no refresh token is stored (must re-login, not transient)', async () => {
    // no-refresh-token: pre-C1 install, no recovery path. User MUST
    // re-login. Surface 401 so resolveCurrentUser auth-rejects.
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    refreshAccessTokenMock.mockResolvedValueOnce({
      ok: false,
      reason: 'no-refresh-token',
    });

    const r = await fetchWithTimeoutForTests('https://api.test/v1/products', {
      headers: { Authorization: 'Bearer old' },
    });

    expect(r.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchWithTimeout — header case normalisation on retry (P2 fix)', () => {
  // Reviewer P2: headers are case-insensitive but a JS object can hold
  // BOTH 'authorization' and 'Authorization' as distinct keys. If the
  // retry spreads the original options + adds canonical 'Authorization',
  // the lowercase `authorization: Bearer old` still rides along; undici
  // / fetch may use either or coalesce. Result: stale token leaks.
  it('strips lowercase "authorization" before adding canonical "Authorization" with new token', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    refreshAccessTokenMock.mockResolvedValueOnce({
      ok: true,
      accessToken: 'fresh',
    });

    await fetchWithTimeoutForTests('https://api.test/v1/products', {
      headers: { authorization: 'Bearer old' }, // lowercase input
    });

    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    const retryHeaders = retryInit.headers as Record<string, string>;

    // Canonical header carries the new token.
    expect(retryHeaders.Authorization).toBe('Bearer fresh');
    // Lowercase variant of the OLD token must NOT survive.
    expect(retryHeaders.authorization).toBeUndefined();
    // Extra paranoia: scan ALL header keys case-insensitively for any
    // remnant carrying the OLD token.
    for (const [k, v] of Object.entries(retryHeaders)) {
      if (k.toLowerCase() === 'authorization') {
        expect(v).toBe('Bearer fresh');
      }
    }
  });

  it('also strips MixedCase "AUTHORIZATION" / "Authorization" duplicates', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    refreshAccessTokenMock.mockResolvedValueOnce({
      ok: true,
      accessToken: 'fresh',
    });

    await fetchWithTimeoutForTests('https://api.test/v1/products', {
      headers: { AUTHORIZATION: 'Bearer old', 'X-Salon': 'cs' },
    } as any);

    const retryHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer fresh');
    expect(retryHeaders.AUTHORIZATION).toBeUndefined();
    expect(retryHeaders['X-Salon']).toBe('cs'); // unrelated header preserved
  });
});
