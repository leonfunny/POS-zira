/**
 * Packet S3 — PosApiClient (Android parity port) tests.
 *
 * Covers the parity contract pinned for the Windows api-client
 * (tests/api-client-401-retry.test.ts) plus the endpoint transport shapes the
 * shim relies on:
 *   • exact URL + method + headers + body per endpoint
 *   • 401 → refresh → retry → success (with the NEW token)
 *   • 401 → refresh fail → onExpired (no retry)
 *   • exactly one retry (a second 401 is returned as-is; no second refresh)
 *   • no retry on the login route (no Bearer header)
 *   • error propagation shape parity (Error with message from body.message || `HTTP <status>`)
 *   • X-Salon-Slug attached on catalog routes; Bearer attached on protected routes
 *   • case-insensitive Authorization detection + lowercase strip on retry
 *     (the two reviewer fixes the Windows suite pins)
 *
 * The port pulls tokens from an injected `tokenProvider` instead of a
 * module-level refresh singleton, so the refresh path is exercised through the
 * provider mock rather than a mocked `refreshAccessToken`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PosApiClient,
  getBearerToken,
  isAuthEndpoint,
  withBearer,
} from '../src/renderer/android-pos/port/api-client';

// ─── helpers ───────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.test';

/** A TokenProvider whose methods are vitest mocks, so tests can both script
 *  return values (mockResolvedValueOnce) and assert call counts. The return
 *  type is inferred so each `vi.fn(impl)` keeps its precise signature (and
 *  stays assignable to TokenProvider). */
function makeProvider(opts: { accessToken?: string | null } = {}) {
  // explicit `null` is preserved (distinct from "use the default token").
  const current: string | null = opts.accessToken !== undefined ? opts.accessToken : 'access-1';
  return {
    getAccessToken: vi.fn(async () => current),
    refresh: vi.fn(async () => false),
    onExpired: vi.fn(() => undefined),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Capture (url, init) for the most recent fetch call. */
function lastCall(fetchMock: ReturnType<typeof vi.fn>): {
  url: string;
  init: RequestInit;
} {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── endpoint transport shapes ─────────────────────────────────────────────

describe('endpoint shapes — URL / method / headers / body', () => {
  it('loginWithEmail → POST /api/v1/auth/login with emailOrPhone+password, no Bearer', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider() });
    fetchMock.mockResolvedValueOnce(json({ access_token: 't', user: { id: 'u' } }));

    await client.loginWithEmail('cashier@salon.test', 'pw');

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/v1/auth/login`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    // login carries NO Authorization header — it's what obtains the token.
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ emailOrPhone: 'cashier@salon.test', password: 'pw' });
  });

  it('getMe → GET /api/v1/auth/me with Bearer staff JWT', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider({ accessToken: 'staff-jwt' }) });
    fetchMock.mockResolvedValueOnce(json({ id: 'u1', email: 'a@b' }));

    await client.getMe();

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/v1/auth/me`);
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer staff-jwt');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBeUndefined();
  });

  it('getPosProducts legacy → GET /warehouse/public/products with since+page+X-Salon-Slug', async () => {
    const client = new PosApiClient({
      baseUrl: BASE_URL,
      tokenProvider: makeProvider(),
      salonSlug: 'chesaigon',
    });
    // one full page of <100 items terminates the legacy loop in one fetch
    fetchMock
      .mockResolvedValueOnce(json({ items: [{ id: 'p1' }], nextSince: 'T2', serverTime: 'now' }))
      .mockResolvedValueOnce(json([])); // categories

    const res = await client.getPosProducts('T1');

    const productsCall = fetchMock.mock.calls[0];
    expect(productsCall[0]).toBe(`${BASE_URL}/api/v1/warehouse/public/products?limit=100&since=T1&page=1`);
    expect(productsCall[1].method).toBeUndefined(); // GET has no explicit method
    const headers = productsCall[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-1');
    expect(headers['X-Salon-Slug']).toBe('chesaigon');

    const categoriesCall = fetchMock.mock.calls[1];
    expect(categoriesCall[0]).toBe(`${BASE_URL}/api/v1/warehouse/public/categories`);
    expect((categoriesCall[1].headers as Record<string, string>)['X-Salon-Slug']).toBe('chesaigon');

    expect(res).toMatchObject({ products: [{ id: 'p1' }], categoriesComplete: true, nextSince: 'T2', serverTime: 'now' });
  });

  it('getPosProducts cursorV2 → uses syncCursor + sync-v2 route + pageCursor pagination', async () => {
    const client = new PosApiClient({
      baseUrl: BASE_URL,
      tokenProvider: makeProvider(),
      salonSlug: 'cs',
    });
    // page 1 hasMore → page 2 last → categories
    fetchMock
      .mockResolvedValueOnce(json({
        items: [{ id: 'p1' }],
        hasMore: true,
        nextPageCursor: 'cur-2',
        nextSyncCursor: 'final-cursor',
      }))
      .mockResolvedValueOnce(json({ items: [{ id: 'p2' }], hasMore: false, nextSyncCursor: 'final-cursor' }))
      .mockResolvedValueOnce(json([{ id: 'cat-1' }])); // categories (raw array)

    const res = await client.getPosProducts('start-cursor', { cursorV2: true });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE_URL}/api/v1/warehouse/public/products/sync-v2?limit=100&syncCursor=start-cursor`,
    );
    // second page swaps syncCursor → pageCursor (cursorV2 deletes page + syncCursor, sets pageCursor)
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${BASE_URL}/api/v1/warehouse/public/products/sync-v2?limit=100&pageCursor=cur-2`,
    );
    expect(res.nextSyncCursor).toBe('final-cursor');
    expect(res.products).toEqual([{ id: 'p1' }, { id: 'p2' }]);
    expect(res.categories).toEqual([{ id: 'cat-1' }]);
  });

  it('getPosCategories → GET /warehouse/public/categories with Bearer + X-Salon-Slug', async () => {
    const client = new PosApiClient({
      baseUrl: BASE_URL,
      tokenProvider: makeProvider({ accessToken: 't' }),
      salonSlug: 'salon-x',
    });
    fetchMock.mockResolvedValueOnce(json([{ id: 'c1' }, { id: 'c2' }]));

    const res = await client.getPosCategories();

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/v1/warehouse/public/categories`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer t');
    expect(headers['X-Salon-Slug']).toBe('salon-x');
    expect(res).toEqual({ categories: [{ id: 'c1' }, { id: 'c2' }], complete: true });
  });

  it('createPosOrder → POST /api/v1/b2b/pos/orders with dto passed through', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider() });
    fetchMock.mockResolvedValueOnce(json({ id: 'srv-1' }));

    const dto = { items: [{ variantId: 'v1', quantity: 2 }], paymentMethod: 'CASH', shiftId: 's1' };
    const res = await client.createPosOrder(dto);

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/v1/b2b/pos/orders`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
    expect(JSON.parse(init.body as string)).toEqual(dto);
    expect(res).toEqual({ id: 'srv-1' });
  });

  it('finishOrder → POST /b2b/pos/orders/:id/finish with { notes: "POS auto-finish" }', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider() });
    fetchMock.mockResolvedValueOnce(json({ ok: true }));

    await client.finishOrder('ord-42');

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/v1/b2b/pos/orders/ord-42/finish`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ notes: 'POS auto-finish' });
  });

  it('finishOrder returns null on 404/501 (endpoint not deployed / not found)', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider() });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(client.finishOrder('x')).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(new Response('', { status: 501 }));
    await expect(client.finishOrder('y')).resolves.toBeNull();
  });

  it('getServerOrders → GET /b2b/pos/orders with exact query params + sliced envelope', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider() });
    fetchMock.mockResolvedValueOnce(json({ orders: [{ id: 'o1' }], total: 1, page: 1, limit: 20 }));

    const res = await client.getServerOrders({
      from: '2026-07-01',
      to: '2026-07-18',
      paymentMethod: 'CASH',
      requiresInvoice: false,
    });

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(
      `${BASE_URL}/api/v1/b2b/pos/orders?from=2026-07-01&to=2026-07-18&paymentMethod=CASH&requiresInvoice=false&page=1&limit=20`,
    );
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
    expect(res).toEqual({ orders: [{ id: 'o1' }], total: 1, page: 1, limit: 20 });
  });

  it('openPosShift → POST /pos/shifts/open merging machineId', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider(), machineId: 'm-1' });
    fetchMock.mockResolvedValueOnce(json({ shiftId: 'sh-1' }));

    const res = await client.openPosShift({ staffId: 'st-1', openingCash: 50000 });

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/v1/pos/shifts/open`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ staffId: 'st-1', openingCash: 50000, machineId: 'm-1' });
    expect(res).toEqual({ shiftId: 'sh-1' });
  });

  it('closePosShift → POST /pos/shifts/:id/close with closingCash', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider() });
    fetchMock.mockResolvedValueOnce(json({ report: {} }));

    await client.closePosShift('sh-1', { closingCash: 12345 });

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/v1/pos/shifts/sh-1/close`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ closingCash: 12345 });
  });

  it('strips the trailing slash from baseUrl', async () => {
    const client = new PosApiClient({ baseUrl: `${BASE_URL}/`, tokenProvider: makeProvider() });
    fetchMock.mockResolvedValueOnce(json({ id: 'u' }));
    await client.getMe();
    expect(lastCall(fetchMock).url).toBe(`${BASE_URL}/api/v1/auth/me`);
  });
});

// ─── 401 retry semantics (parity with api-client-401-retry.test.ts) ─────────

describe('401 refresh+retry — on 401 with Bearer, refresh then retry once with NEW token', () => {
  it('refresh succeeds → retry once with the new access token', async () => {
    const provider = makeProvider();
    // first getAccessToken (initial req) → access-1; after refresh → new-access
    provider.getAccessToken
      .mockResolvedValueOnce('access-1')
      .mockResolvedValueOnce('new-access');
    provider.refresh.mockResolvedValueOnce(true);
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: provider });

    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(json({ id: 'u1' }, 200));

    const res = await client.getMe();

    expect(res).toEqual({ id: 'u1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.refresh).toHaveBeenCalledTimes(1);

    // Critical (Windows reviewer claim 6): the retry MUST carry the NEW token.
    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer new-access');
  });

  it('preserves method, body, and other headers on retry', async () => {
    const provider = makeProvider();
    provider.getAccessToken.mockResolvedValueOnce('old').mockResolvedValueOnce('fresh');
    provider.refresh.mockResolvedValueOnce(true);
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: provider });

    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(json({ id: 'srv' }, 200));

    await client.createPosOrder({ id: 'order-1' });

    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(retryInit.method).toBe('POST');
    expect(retryInit.body).toBe(JSON.stringify({ id: 'order-1' }));
    const headers = retryInit.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer fresh');
  });

  it('refresh fails → onExpired fired, original 401 returned, NO retry', async () => {
    const provider = makeProvider();
    provider.refresh.mockResolvedValueOnce(false);
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: provider });

    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));

    // getMe surfaces the 401 as a thrown Error (its !ok path).
    await expect(client.getMe()).rejects.toThrow('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(provider.onExpired).toHaveBeenCalledTimes(1);
  });

  it('a second 401 on retry is returned as-is — exactly one refresh, no onExpired', async () => {
    const provider = makeProvider();
    provider.getAccessToken.mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    provider.refresh.mockResolvedValueOnce(true);
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: provider });

    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }));

    await expect(client.getMe()).rejects.toThrow('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(2); // exactly one retry
    expect(provider.refresh).toHaveBeenCalledTimes(1); // no second refresh
    expect(provider.onExpired).not.toHaveBeenCalled(); // refresh succeeded
  });

  it('does NOT refresh on a non-2xx that is not 401', async () => {
    const provider = makeProvider();
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: provider });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));

    await expect(client.getMe()).rejects.toThrow('HTTP 500');
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('loginWithEmail 401 does NOT refresh (no Bearer header on the login route)', async () => {
    const provider = makeProvider();
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: provider });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));

    await expect(client.loginWithEmail('a@b', 'wrong')).rejects.toThrow('HTTP 401');
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(provider.onExpired).not.toHaveBeenCalled();
  });
});

// ─── error propagation shape parity ────────────────────────────────────────

describe('error propagation — Error(message) from body.message || `HTTP <status>`', () => {
  it('uses body.message when present', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider() });
    fetchMock.mockResolvedValueOnce(json({ message: 'Invalid credentials' }, 400));
    await expect(client.loginWithEmail('a', 'b')).rejects.toThrow('Invalid credentials');
  });

  it('falls back to HTTP status when body is empty / unparseable', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider() });
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 422 }));
    await expect(client.createPosOrder({})).rejects.toThrow('HTTP 422');
  });

  it('getPosProducts throws the full error envelope (status / code / resetRequired)', async () => {
    const client = new PosApiClient({
      baseUrl: BASE_URL,
      tokenProvider: makeProvider(),
      salonSlug: 'cs',
    });
    fetchMock.mockResolvedValueOnce(
      json({ error: 'SYNC_CURSOR_INVALID', message: 'cursor stale', resetRequired: true }, 409),
    );

    let caught: any;
    try {
      await client.getPosProducts('stale', { cursorV2: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe('cursor stale');
    expect(caught.status).toBe(409);
    expect(caught.code).toBe('SYNC_CURSOR_INVALID');
    expect(caught.resetRequired).toBe(true);
    expect(caught.serverBody).toMatchObject({ error: 'SYNC_CURSOR_INVALID' });
  });
});

// ─── pure helper parity (the two reviewer fixes Windows pins) ──────────────

describe('helpers — case-insensitive Authorization handling', () => {
  it('getBearerToken detects canonical, lowercase, and mixed-case headers', () => {
    expect(getBearerToken({ headers: { Authorization: 'Bearer abc' } })).toBe('abc');
    expect(getBearerToken({ headers: { authorization: 'Bearer xyz' } })).toBe('xyz');
    expect(getBearerToken({ headers: { AUTHORIZATION: 'Bearer MIXED' } })).toBe('MIXED');
    expect(getBearerToken({ headers: { Authorization: 'basic abc' } })).toBeNull();
    expect(getBearerToken({ headers: { 'X-Other': 'Bearer nope' } })).toBeNull();
    expect(getBearerToken({} as RequestInit)).toBeNull();
  });

  it('withBearer strips every case-variant then sets canonical with the new token', () => {
    const out = withBearer(
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer old',
          AUTHORIZATION: 'Bearer old2',
          'X-Salon-Slug': 'cs',
        },
        body: 'x',
      } as unknown as RequestInit,
      'fresh',
    );
    const headers = out.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer fresh');
    expect(headers.authorization).toBeUndefined();
    expect(headers.AUTHORIZATION).toBeUndefined();
    expect(headers['X-Salon-Slug']).toBe('cs');
    // no stale token survives under any casing
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'authorization') expect(v).toBe('Bearer fresh');
    }
  });

  it('isAuthEndpoint matches the 5 no-retry auth routes and rejects others', () => {
    expect(isAuthEndpoint('https://x/api/v1/auth/login')).toBe(true);
    expect(isAuthEndpoint('https://x/api/v1/auth/refresh')).toBe(true);
    expect(isAuthEndpoint('https://x/api/v1/auth/logout')).toBe(true);
    expect(isAuthEndpoint('https://x/api/v1/auth/check-token/abc')).toBe(true);
    expect(isAuthEndpoint('https://x/api/v1/auth/register')).toBe(true);
    expect(isAuthEndpoint('https://x/api/v1/auth/me')).toBe(false);
    expect(isAuthEndpoint('https://x/api/v1/b2b/pos/orders')).toBe(false);
  });
});

// ─── no-auth-token guard ───────────────────────────────────────────────────

describe('requireToken — absent staff JWT is surfaced, not sent as Bearer null', () => {
  it('protected routes throw NO_AUTH_TOKEN when getAccessToken returns null', async () => {
    const client = new PosApiClient({
      baseUrl: BASE_URL,
      tokenProvider: makeProvider({ accessToken: null }),
    });
    await expect(client.getMe()).rejects.toThrow(/NO_AUTH_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── generic request passthrough (billiard online-only transport, T4) ──────

describe('request — generic /api/v1-relative authenticated JSON call', () => {
  it('GET → <base>/api/v1<path> with Bearer, no body, returns parsed JSON', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider({ accessToken: 'staff-jwt' }) });
    fetchMock.mockResolvedValueOnce(json([{ resource: { id: 't1' } }]));

    const res = await client.request('GET', '/billiard/dashboard');

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/v1/billiard/dashboard`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer staff-jwt');
    expect(init.body).toBeUndefined();
    expect(res).toEqual([{ resource: { id: 't1' } }]);
  });

  it('POST serializes the body and the URL/method match', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider() });
    fetchMock.mockResolvedValueOnce(json({ ok: true }));

    const res = await client.request('post', '/billiard/sessions', { resourceId: 'r1' });

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE_URL}/api/v1/billiard/sessions`);
    expect(init.method).toBe('POST'); // method is normalized to uppercase
    expect(JSON.parse(init.body as string)).toEqual({ resourceId: 'r1' });
    expect(res).toEqual({ ok: true });
  });

  it('non-2xx throws an Error carrying .status and the server message (money path)', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider() });
    fetchMock.mockResolvedValueOnce(json({ message: 'already-paid' }, 400));

    let caught: any;
    try {
      await client.request('POST', '/billiard/sessions/s1/pay', { method: 'CASH' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe('already-paid');
    expect(caught.status).toBe(400);
  });

  it('an empty 2xx body resolves to null (no JSON.parse of "")', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider() });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    await expect(client.request('DELETE', '/billiard/sessions/s1/items/i9')).resolves.toBeNull();
  });

  it('protected routes throw NO_AUTH_TOKEN when getAccessToken returns null', async () => {
    const client = new PosApiClient({ baseUrl: BASE_URL, tokenProvider: makeProvider({ accessToken: null }) });
    await expect(client.request('GET', '/billiard/dashboard')).rejects.toThrow(/NO_AUTH_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
