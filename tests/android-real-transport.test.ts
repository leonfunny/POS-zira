import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore, type TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';

/** Node-friendly sql.js load — mirrors tests/android-shim-db.test.ts. */
const NODE_LOCATE_FILE = null;

function memoryStorage(): TokenStoreStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const LOGIN_BODY = {
  access_token: 'jwt-access-1',
  refresh_token: 'jwt-refresh-1',
  user: {
    id: 'staff-1',
    email: 'staff@salon.pl',
    firstName: 'Ala',
    lastName: 'Nowak',
    role: 'STAFF',
    salonId: 'salon-1',
    salon: { id: 'salon-1', name: 'Test Salon', slug: 'test-salon' },
  },
};

function build(overrides: { seed?: Record<string, unknown> } = {}) {
  const configStore = new ShimConfigStore({
    storage: memoryStorage(),
    seed: overrides.seed as never,
  });
  const tokenStorage = memoryStorage();
  const tokenStore = new TokenStore({ storage: tokenStorage });
  const transport = createRealTransport({
    configStore,
    tokenStore,
    dbInit: { locateFile: NODE_LOCATE_FILE },
  });
  return { configStore, tokenStore, tokenStorage, transport };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('real transport auth', () => {
  test('loginWithEmail stores tokens, writes identity into the SHARED config store, returns the S1 shape', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const { configStore, tokenStore, transport } = build();

    const result = await transport.loginWithEmail!('staff@salon.pl', 'pw');

    expect(result.success).toBe(true);
    expect(result.data?.user).toMatchObject({
      id: 'staff-1',
      email: 'staff@salon.pl',
      role: 'STAFF',
      salonId: 'salon-1',
      salonName: 'Test Salon',
    });
    await expect(tokenStore.getAccessToken()).resolves.toBe('jwt-access-1');
    await expect(tokenStore.getRefreshToken()).resolves.toBe('jwt-refresh-1');

    const config = configStore.getRawConfig();
    expect(config.authUser?.id).toBe('staff-1');
    expect(config.salonId).toBe('salon-1');
    expect(config.salonSlug).toBe('test-salon');
    expect(config.posMode).toBe('retail');

    // Hard rail: exactly one HTTP call — the staff login. No pa_ key, no
    // /print-agent/connect, no /print-agent/my-key.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v1/auth/login');
  });

  test('login without an access token fails without storing anything', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: { id: 'x' } }));
    const { tokenStore, transport } = build();
    const result = await transport.loginWithEmail!('a@b.c', 'pw');
    expect(result.success).toBe(false);
    await expect(tokenStore.getAccessToken()).resolves.toBeNull();
  });

  test('getUser with no persisted token reports unauthenticated without any HTTP call', async () => {
    const { transport } = build();
    const result = await transport.getUser!();
    expect(result).toEqual({ success: true, data: { isAuthenticated: false } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('getUser 401 with rejected refresh drops the session and emits auth-expired', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const { configStore, transport } = build();
    await transport.loginWithEmail!('staff@salon.pl', 'pw');

    const expired = vi.fn();
    (transport as any).onAuthExpired(expired);

    // /auth/me → 401, refresh → 401 (dead session), original 401 returned.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ message: 'revoked' }, 401));

    const result = await transport.getUser!();
    expect(result.data?.isAuthenticated).toBe(false);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(configStore.getRawConfig().authUser).toBeUndefined();
  });

  test('getUser transient network error falls back to the cached profile', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const { transport } = build();
    await transport.loginWithEmail!('staff@salon.pl', 'pw');

    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    const result = await transport.getUser!();
    expect(result.data?.isAuthenticated).toBe(true);
    expect(result.data?.user?.id).toBe('staff-1');
  });

  test('logout clears tokens and identity but is not a data wipe', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const { configStore, tokenStore, transport } = build();
    await transport.loginWithEmail!('staff@salon.pl', 'pw');

    const result = await transport.logout!();
    expect(result.success).toBe(true);
    await expect(tokenStore.getAccessToken()).resolves.toBeNull();
    expect(configStore.getRawConfig().authUser).toBeUndefined();
    // salonId survives (S1 §2.B: logout keeps the local mirror healthy for a
    // re-login to the same salon).
    expect(configStore.getRawConfig().salonId).toBe('salon-1');
  });
});

describe('real transport catalog sync', () => {
  const PRODUCT_PAGE = {
    products: [
      {
        id: 'p1',
        name: 'Gel Polish',
        sku: 'SKU-1',
        barcode: '5900000000017',
        retailPrice: '49.00',
        template: { id: 't1', categoryId: 'c1', taxRate: '23' },
      },
    ],
    categories: [{ id: 'c1', name: 'Gel', displayOrder: 1 }],
    nextSyncCursor: 'cursor-1',
  };

  async function loggedInTransport() {
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const built = build();
    await built.transport.loginWithEmail!('staff@salon.pl', 'pw');
    return built;
  }

  test('syncProducts pulls, normalizes to grosze, upserts, advances the cursor, and emits', async () => {
    const { transport } = await loggedInTransport();
    const synced = vi.fn();
    (transport as any).onProductsSynced(synced);

    // getPosProducts internally also fetches the public categories route —
    // route the mock by URL instead of by call order.
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes('/warehouse/public/products')) return jsonResponse(PRODUCT_PAGE);
      if (target.includes('categories')) {
        return jsonResponse({ categories: [{ id: 'c1', name: 'Gel', displayOrder: 1 }] });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    const result = await transport.syncProducts!();
    expect(result).toMatchObject({ success: true, productsCount: 1 });
    expect(synced).toHaveBeenCalledTimes(1);

    const productsCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/warehouse/public/products'));
    expect(productsCall).toBeDefined();
    const syncHeaders = productsCall?.[1]?.headers as Record<string, string>;
    expect(syncHeaders['X-Salon-Slug']).toBe('test-salon');

    // Catalog reads now come from the SQL.js mirror with grosze pricing.
    const products = await transport.getProducts!();
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ id: 'p1', retail_price: 4900, vat_rate: 23 });
    const byBarcode = await transport.getProductByBarcode!('5900000000017');
    expect(byBarcode?.id).toBe('p1');
    const categories = await transport.getCategories!();
    expect(categories).toHaveLength(1);

    // Second sync sends the advanced cursor.
    const callsBefore = fetchMock.mock.calls.length;
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes('/warehouse/public/products')) {
        return jsonResponse({ products: [], categories: [], nextSyncCursor: 'cursor-2' });
      }
      return jsonResponse({ categories: [] });
    });
    await transport.syncProducts!();
    const secondProductsCall = fetchMock.mock.calls
      .slice(callsBefore)
      .find((call) => String(call[0]).includes('/warehouse/public/products'));
    expect(String(secondProductsCall?.[0])).toContain('cursor-1');
  });

  test('syncProducts without auth is a silent no-auth failure with no HTTP call', async () => {
    const { transport } = build();
    const result = await transport.syncProducts!();
    expect(result).toEqual({ success: false, error: 'no-auth' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('real transport orders + shifts (S8+S9)', () => {
  const CASH_ORDER = (shiftId: string) => ({
    id: 'local-order-1',
    order_number: null,
    number_series: 'ORDER',
    status: 'COMPLETED',
    subtotal: 4900,
    discount: 0,
    tax: 0,
    total: 4900,
    payment_method: 'CASH',
    payment_amount: 5000,
    change_amount: 100,
    shift_id: shiftId,
    source: 'POS',
    mode: 'retail',
    synced: 0,
  });
  const CASH_ITEMS = [{
    id: 'line-1', order_id: 'local-order-1', variant_id: 'p1', name: 'Gel Polish',
    sku: 'SKU-1', price: 4900, quantity: 1, sell_by: 'PIECE', total: 4900, vat_rate: 23,
  }];

  async function transportWithShift() {
    fetchMock.mockResolvedValue(jsonResponse(LOGIN_BODY));
    const built = build();
    await built.transport.loginWithEmail!('staff@salon.pl', 'pw');
    fetchMock.mockResolvedValue(jsonResponse({ shiftId: 'server-shift' }));
    const open = await built.transport.openShift!({ staffId: 'staff-1', staffName: 'Ala Nowak', openingCash: 10000 });
    expect(open.success).toBe(true);
    return { ...built, shiftId: open.shiftId! };
  }

  test('createOrder without an open shift is refused (Windows parity)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(LOGIN_BODY));
    const { transport } = build();
    await transport.loginWithEmail!('staff@salon.pl', 'pw');
    const result = await transport.createOrder!(CASH_ORDER('missing-shift'), CASH_ITEMS);
    expect(result.success).toBe(false);
    expect(result.error).toContain('shift');
  });

  test('CASH order: local create → sync sends PLN-decimal DTO → finish → marked synced', async () => {
    const { transport, shiftId } = await transportWithShift();
    const synced = vi.fn();
    (transport as any).onOrderSynced(synced);

    const created = await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);
    expect(created).toMatchObject({ success: true, id: 'local-order-1' });

    const requests: Array<{ url: string; body: any }> = [];
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      requests.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (/\/b2b\/pos\/orders\/backend-1\/finish$/.test(target)) {
        return jsonResponse({ orderNumber: 'POS-20260718-0042' });
      }
      if (/\/b2b\/pos\/orders$/.test(target)) return jsonResponse({ id: 'backend-1' });
      throw new Error(`unexpected fetch: ${target}`);
    });

    await transport.syncOrders!();

    const createCall = requests.find((r) => /\/b2b\/pos\/orders$/.test(r.url));
    expect(createCall).toBeDefined();
    // The S1 §2.F trap: local grosze → backend PLN decimals.
    expect(createCall!.body).toMatchObject({
      id: 'local-order-1',
      priceType: 'brutto',
      paymentMethod: 'CASH',
      paymentAmount: 50,
      changeAmount: 1,
      shiftId,
    });
    expect(createCall!.body.items[0]).toMatchObject({ variantId: 'p1', customPrice: 49, packQuantity: 1 });
    expect(requests.some((r) => /\/finish$/.test(r.url))).toBe(true);
    expect(synced).toHaveBeenCalledWith({ orderId: 'local-order-1', backendId: 'backend-1' });

    const detail = await transport.getOrderDetail!('local-order-1');
    expect(detail?.order).toMatchObject({ synced: 1, backend_id: 'backend-1', order_number: 'POS-20260718-0042' });
    expect(detail?.items).toHaveLength(1);
  });

  test('business-rule rejection shelves the order (synced = -1) and emits failure', async () => {
    const { transport, shiftId } = await transportWithShift();
    const failed = vi.fn();
    (transport as any).onOrderSyncFailed(failed);
    await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);

    fetchMock.mockResolvedValue(jsonResponse({ message: 'Insufficient stock for SKU-1' }, 400));
    await transport.syncOrders!();

    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_STOCK' }));
    const detail = await transport.getOrderDetail!('local-order-1');
    expect(detail?.order.synced).toBe(-1);

    // A second drain must NOT retry a shelved order.
    fetchMock.mockClear();
    await transport.syncOrders!();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('transient failure reverts to pending for retry and eventually shelves at the cap', async () => {
    const { transport, shiftId } = await transportWithShift();
    await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);

    fetchMock.mockRejectedValue(new TypeError('network down'));
    for (let i = 0; i < 5; i += 1) {
      await transport.syncOrders!();
      const detail = await transport.getOrderDetail!('local-order-1');
      expect(detail?.order.synced).toBe(0); // reverted to pending each time
    }
    // Attempt cap reached → next drain shelves without an HTTP call.
    fetchMock.mockClear();
    await transport.syncOrders!();
    expect(fetchMock).not.toHaveBeenCalled();
    const detail = await transport.getOrderDetail!('local-order-1');
    expect(detail?.order.synced).toBe(-1);
  });

  test('closeShift drains orders, aggregates the Z-report, and closes locally', async () => {
    const { transport, shiftId } = await transportWithShift();
    await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (/\/finish$/.test(target)) return jsonResponse({});
      if (/\/b2b\/pos\/orders$/.test(target)) return jsonResponse({ id: 'backend-1' });
      if (/\/close$/.test(target)) return jsonResponse({});
      throw new Error(`unexpected fetch: ${target}`);
    });

    const closed = await transport.closeShift!({ shiftId, closingCash: 14900 });
    expect(closed.success).toBe(true);
    expect(closed.report).toMatchObject({
      shiftId,
      totalSales: 4900,
      totalOrders: 1,
      cashTotal: 4900,
      openingCash: 10000,
      closingCash: 14900,
      difference: 0,
      unsyncedOrders: 0,
    });

    // A second order after close is refused — the shift is gone.
    const after = await transport.createOrder!({ ...CASH_ORDER(shiftId), id: 'local-order-2' }, CASH_ITEMS);
    expect(after.success).toBe(false);
  });

  test('the staff picker is seeded with the logged-in cashier', async () => {
    const { transport } = await transportWithShift();
    const staff = await transport.getStaff!();
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ id: 'staff-1', name: 'Ala Nowak', is_active: 1 });
  });
});
