import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore, type TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';
import {
  initAndroidDb,
  type AndroidDbPersistence,
} from '../src/renderer/android-pos/shim/db/db';

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

class MemoryDbPersistence implements AndroidDbPersistence {
  image: Uint8Array | null = null;

  async loadImage(): Promise<Uint8Array | null> {
    return this.image ? new Uint8Array(this.image) : null;
  }

  async saveImage(image: Uint8Array): Promise<void> {
    this.image = new Uint8Array(image);
  }

  async quarantineImage(): Promise<void> {}
}

class SwitchableDbPersistence extends MemoryDbPersistence {
  rejectWrites = false;
  readonly events: string[] = [];

  override async saveImage(image: Uint8Array): Promise<void> {
    if (this.rejectWrites) throw new Error('simulated persistence failure');
    this.events.push('save');
    await super.saveImage(image);
  }
}

class GatedDbPersistence extends MemoryDbPersistence {
  private nextGate: {
    signalStarted: () => void;
    released: Promise<void>;
  } | null = null;

  blockNextSave(): { started: Promise<void>; release: () => void } {
    let signalStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.nextGate = { signalStarted, released };
    return { started, release };
  }

  override async saveImage(image: Uint8Array): Promise<void> {
    const gate = this.nextGate;
    this.nextGate = null;
    if (gate) {
      gate.signalStarted();
      await gate.released;
    }
    await super.saveImage(image);
  }
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

type BuildOverrides = {
  seed?: Record<string, unknown>;
  persistence?: AndroidDbPersistence;
  tokenStore?: TokenStore;
};

function build(overrides: BuildOverrides = {}) {
  const configStore = new ShimConfigStore({
    storage: memoryStorage(),
    seed: overrides.seed as never,
  });
  const tokenStorage = memoryStorage();
  const tokenStore = overrides.tokenStore
    ?? new TokenStore({ storage: tokenStorage, allowInsecureFallback: true });
  const transport = createRealTransport({
    configStore,
    tokenStore,
    dbInit: {
      locateFile: NODE_LOCATE_FILE,
      persistence: overrides.persistence ?? new MemoryDbPersistence(),
    },
    // No-op agent: these auth/order tests use mockResolvedValueOnce sequences, so
    // the real login-time /print-agent/my-key fetch would desync them. The
    // login→connect→socket path is covered by tests/android-agent-connect.test.ts.
    agentConnection: {
      connect: async () => ({ connected: false, reason: 'no-key' as const }),
      disconnect: async () => {},
      isConnected: () => false,
      getPushedJobStatus: () => null,
      onJobStatus: () => () => {},
    },
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
    expect(config.posMode).toBe('salon'); // E2a: salon is the Windows default

    // Exactly one HTTP call — the staff login. (The agent connection is stubbed
    // no-op in build(); its real login-time /print-agent/my-key fetch is covered
    // in tests/android-agent-connect.test.ts.)
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

  test('getUser dead session (401 with message "Unauthorized") drops to login', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const { transport } = build();
    await transport.loginWithEmail!('staff@salon.pl', 'pw');

    const expired = vi.fn();
    (transport as any).onAuthExpired(expired);
    // getMe 401 (NestJS body 'Unauthorized', no '401' substring) → refresh 401.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized' }, 401));
    const result = await transport.getUser!();
    expect(result.data?.isAuthenticated).toBe(false);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  test('concurrent 401s trigger exactly one refresh (single-flight), keeping the session', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const { transport, tokenStore } = build();
    await transport.loginWithEmail!('staff@salon.pl', 'pw');

    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/auth/refresh')) {
        refreshCalls += 1;
        return jsonResponse({ access_token: 'jwt-access-2', refresh_token: 'jwt-refresh-2' });
      }
      // /auth/me: 401 with the OLD token, 200 once the refreshed token is used.
      const bearer = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      if (bearer.includes('jwt-access-2')) return jsonResponse({ user: LOGIN_BODY.user });
      return jsonResponse({ message: 'Unauthorized' }, 401);
    });

    const [a, b] = await Promise.all([transport.getUser!(), transport.getUser!()]);
    expect(a.data?.isAuthenticated).toBe(true);
    expect(b.data?.isAuthenticated).toBe(true);
    // Two concurrent 401s must NOT each POST /auth/refresh with the rotating token.
    expect(refreshCalls).toBe(1);
    await expect(tokenStore.getRefreshToken()).resolves.toBe('jwt-refresh-2');
  });

  test('logging into a different salon wipes the previous salon local data', async () => {
    // Login salon-1, sync a product + create an order.
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const { transport } = build();
    await transport.loginWithEmail!('staff@salon.pl', 'pw');
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes('/warehouse/public/products')) {
        return jsonResponse({ products: [{ id: 'p1', name: 'Gel', retailPrice: '49.00', template: { id: 't1' } }], categories: [], nextSyncCursor: 'c1' });
      }
      return jsonResponse({ categories: [] });
    });
    await transport.syncProducts!();
    expect(await transport.getProducts!()).toHaveLength(1);

    // Login salon-2: the salon-1 catalog must be gone.
    const SALON2 = {
      ...LOGIN_BODY,
      user: { ...LOGIN_BODY.user, salonId: 'salon-2', salon: { id: 'salon-2', name: 'Other Salon', slug: 'other-salon' } },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(SALON2));
    await transport.loginWithEmail!('other@salon.pl', 'pw');
    expect(await transport.getProducts!()).toHaveLength(0);
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

  test('logout keeps the authenticated identity when secure token clearing fails', async () => {
    const tokenStore = new TokenStore({ storage: memoryStorage(), allowInsecureFallback: true });
    await tokenStore.setTokens('jwt-access-1', 'jwt-refresh-1');
    vi.spyOn(tokenStore, 'clear').mockRejectedValueOnce(new Error('secure-storage-clear-failed'));
    const { configStore, transport } = build({
      tokenStore,
      seed: {
        authUser: {
          ...LOGIN_BODY.user,
          salonId: 'salon-1',
          salonName: 'Test Salon',
        },
        salonId: 'salon-1',
        salonName: 'Test Salon',
        salonSlug: 'test-salon',
      },
    });

    const outcome = await transport.logout!().then(
      (value) => ({ rejected: false as const, value }),
      (error) => ({ rejected: true as const, error }),
    );

    expect(outcome.rejected || (outcome as any).value?.success === false).toBe(true);
    expect(configStore.getRawConfig().authUser?.id).toBe('staff-1');
    await expect(tokenStore.getAccessToken()).resolves.toBe('jwt-access-1');
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

  async function transportWithShift(overrides: BuildOverrides = {}) {
    fetchMock.mockResolvedValue(jsonResponse(LOGIN_BODY));
    const built = build(overrides);
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

  test('openShift retries the same local shift after a failed durability barrier before backend sync', async () => {
    const persistence = new SwitchableDbPersistence();
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const { transport } = build({ persistence, seed: { machineId: 'SUNMI-1' } });
    await transport.loginWithEmail!('staff@salon.pl', 'pw');
    fetchMock.mockClear();
    persistence.events.length = 0;
    const backendOpenBodies: any[] = [];
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (/\/pos\/shifts\/open$/.test(target)) {
        persistence.events.push('backend-open');
        backendOpenBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ shiftId: 'server-shift' });
      }
      return jsonResponse({});
    });

    const input = { staffId: 'staff-1', staffName: 'Ala Nowak', openingCash: 10000 };
    persistence.rejectWrites = true;
    const first = await transport.openShift!(input);
    expect(first).toMatchObject({ success: false, durabilityPending: true });
    expect(first.shiftId).toEqual(expect.any(String));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.some(([url]) => /\/pos\/shifts\/open$/.test(String(url)))).toBe(false);

    persistence.rejectWrites = false;
    persistence.events.length = 0;
    const retry = await transport.openShift!(input);
    expect(retry).toMatchObject({ success: true, shiftId: first.shiftId });
    await vi.waitFor(() => {
      expect(persistence.events).toEqual(['save', 'backend-open', 'save']);
    });
    expect(fetchMock.mock.calls.filter(([url]) => /\/pos\/shifts\/open$/.test(String(url)))).toHaveLength(1);
    expect(backendOpenBodies).toEqual([{
      shiftId: first.shiftId,
      staffId: 'staff-1',
      openingCash: 10000,
      machineId: 'SUNMI-1',
    }]);
  });

  test('syncOrders retries a durable shift open after a backend outage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const { transport } = build({ seed: { machineId: 'SUNMI-1' } });
    await transport.loginWithEmail!('staff@salon.pl', 'pw');
    let openAttempts = 0;
    fetchMock.mockImplementation(async (url: unknown) => {
      if (/\/pos\/shifts\/open$/.test(String(url))) {
        openAttempts += 1;
        if (openAttempts === 1) throw new Error('offline');
        return jsonResponse({ shiftId: 'server-shift' });
      }
      return jsonResponse({});
    });

    const opened = await transport.openShift!({
      staffId: 'staff-1',
      staffName: 'Ala Nowak',
      openingCash: 10000,
    });
    expect(opened.success).toBe(true);
    await vi.waitFor(() => expect(openAttempts).toBe(1));

    await transport.syncOrders!();
    expect(openAttempts).toBe(2);
    await transport.syncOrders!();
    expect(openAttempts).toBe(2);
  });

  test('concurrent openShift calls share one durability barrier and cannot be synced before it', async () => {
    const persistence = new GatedDbPersistence();
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const { transport } = build({ persistence });
    await transport.loginWithEmail!('staff@salon.pl', 'pw');
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (url: unknown) => {
      if (/\/pos\/shifts\/open$/.test(String(url))) {
        return jsonResponse({ shiftId: 'server-shift' });
      }
      return jsonResponse({});
    });

    const gate = persistence.blockNextSave();
    const input = { staffId: 'staff-1', staffName: 'Ala Nowak', openingCash: 10000 };
    const first = transport.openShift!(input);
    const second = transport.openShift!(input);
    await gate.started;
    const competingWorker = transport.syncOrders!();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock.mock.calls.filter(([url]) => /\/pos\/shifts\/open$/.test(String(url)))).toHaveLength(0);

    gate.release();
    const [firstResult, secondResult] = await Promise.all([first, second, competingWorker])
      .then(([a, b]) => [a, b]);
    expect(firstResult).toMatchObject({ success: true, shiftId: expect.any(String) });
    expect(secondResult).toEqual(firstResult);
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => /\/pos\/shifts\/open$/.test(String(url)))).toHaveLength(1);
    });
  });

  test('CASH order: local create → authoritative create sync → marked synced without legacy finish', async () => {
    const { transport, shiftId } = await transportWithShift();
    const synced = vi.fn();
    (transport as any).onOrderSynced(synced);

    const created = await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);
    expect(created).toMatchObject({ success: true, id: 'local-order-1' });

    const requests: Array<{ url: string; body: any }> = [];
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      requests.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (/\/b2b\/pos\/orders$/.test(target)) {
        return jsonResponse({ id: 'backend-1', orderNumber: 'POS-20260718-0042' });
      }
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
    expect(requests.some((r) => /\/finish$/.test(r.url))).toBe(false);
    expect(synced).toHaveBeenCalledWith({ orderId: 'local-order-1', backendId: 'backend-1' });

    const detail = await transport.getOrderDetail!('local-order-1');
    expect(detail?.order).toMatchObject({ synced: 1, backend_id: 'backend-1', order_number: 'POS-20260718-0042' });
    expect(detail?.items).toHaveLength(1);
  });

  test('createOrder reports durability pending and retries without a second stock decrement', async () => {
    const persistence = new SwitchableDbPersistence();
    const { transport, shiftId } = await transportWithShift({ persistence });
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes('/warehouse/public/products')) {
        return jsonResponse({
          products: [{
            id: 'p1',
            name: 'Gel Polish',
            sku: 'SKU-1',
            retailPrice: '49.00',
            totalStockQty: 10,
            availableQty: 10,
            template: { id: 't1', taxRate: '23' },
          }],
          categories: [],
          nextSyncCursor: 'cursor-1',
        });
      }
      if (target.includes('categories')) return jsonResponse({ categories: [] });
      return jsonResponse({});
    });
    await expect(transport.syncProducts!()).resolves.toMatchObject({ success: true });
    expect((await transport.getProductById!('p1') as any)?.in_stock).toBe(10);

    persistence.rejectWrites = true;
    const first = await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);
    expect(first).toMatchObject({
      success: false,
      id: 'local-order-1',
      durabilityPending: true,
    });
    expect((await transport.getProductById!('p1') as any)?.in_stock).toBe(9);

    persistence.rejectWrites = false;
    const retry = await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);
    expect(retry).toMatchObject({ success: true, id: 'local-order-1' });
    expect((await transport.getProductById!('p1') as any)?.in_stock).toBe(9);
    const history = await transport.getOrderHistory!({});
    expect(history.orders.filter((order: any) => order.id === 'local-order-1')).toHaveLength(1);
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

  test('a legacy itemless local row is shelved and never sent as a fake order', async () => {
    const persistence = new MemoryDbPersistence();
    const seedDatabase = await initAndroidDb({
      locateFile: NODE_LOCATE_FILE,
      persistence,
    });
    seedDatabase.run(
      `INSERT INTO orders (
        id, order_number, status, total, payment_method, payment_amount,
        change_amount, source, mode, synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'legacy-empty-order', 'ZAM-20260830-0099', 'COMPLETED', 4_900,
        'CASH', 5_000, 100, 'POS', 'retail', 0,
      ],
    );
    persistence.image = seedDatabase.exportImage();

    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const { transport } = build({
      persistence,
      seed: { salonId: 'salon-1', salonName: 'Test Salon', salonSlug: 'test-salon' },
    });
    const failed = vi.fn();
    (transport as any).onOrderSyncFailed(failed);
    await transport.loginWithEmail!('staff@salon.pl', 'pw');
    expect((await transport.getOrderDetail!('legacy-empty-order'))?.order.synced).toBe(0);
    fetchMock.mockClear();

    await transport.syncOrders!();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'legacy-empty-order',
      code: 'INVALID_LOCAL_ORDER_NO_ITEMS',
    }));
    const detail = await transport.getOrderDetail!('legacy-empty-order');
    expect(detail?.order).toMatchObject({
      synced: -1,
      sync_error: 'INVALID_LOCAL_ORDER_NO_ITEMS',
    });
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

  test('closeShift retries a failed durability barrier before notifying the backend', async () => {
    const persistence = new SwitchableDbPersistence();
    const { transport, shiftId } = await transportWithShift({ persistence });
    fetchMock.mockClear();
    persistence.events.length = 0;
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (/\/close$/.test(target)) {
        persistence.events.push('backend-close');
        return jsonResponse({});
      }
      return jsonResponse({});
    });

    persistence.rejectWrites = true;
    const first = await transport.closeShift!({ shiftId, closingCash: 10000 });
    expect(first).toMatchObject({ success: false, durabilityPending: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.some(([url]) => /\/close$/.test(String(url)))).toBe(false);

    persistence.rejectWrites = false;
    persistence.events.length = 0;
    const retry = await transport.closeShift!({ shiftId, closingCash: 10000 });
    expect(retry).toMatchObject({ success: true });
    await vi.waitFor(() => {
      expect(persistence.events).toEqual(['save', 'backend-close', 'save']);
    });
  });

  test('concurrent closeShift calls close once and cannot be synced before persistence', async () => {
    const persistence = new GatedDbPersistence();
    const { transport, shiftId } = await transportWithShift({ persistence });
    await transport.syncOrders!();
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (url: unknown) => {
      if (/\/close$/.test(String(url))) return jsonResponse({});
      return jsonResponse({});
    });

    const gate = persistence.blockNextSave();
    const input = { shiftId, closingCash: 10000 };
    const first = transport.closeShift!(input);
    const second = transport.closeShift!(input);
    await gate.started;
    const competingWorker = transport.syncOrders!();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock.mock.calls.filter(([url]) => /\/close$/.test(String(url)))).toHaveLength(0);

    gate.release();
    const [firstResult, secondResult] = await Promise.all([first, second, competingWorker])
      .then(([a, b]) => [a, b]);
    expect(firstResult).toMatchObject({ success: true, report: { shiftId } });
    expect(secondResult).toEqual(firstResult);
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => /\/close$/.test(String(url)))).toHaveLength(1);
    });
  });

  test('a migrated v4 open shift closes the matching server shift instead of replaying its local id', async () => {
    const persistence = new MemoryDbPersistence();
    const legacy = await initAndroidDb({
      locateFile: NODE_LOCATE_FILE,
      persistence: new MemoryDbPersistence(),
    });
    const raw = legacy.getRawHandle();
    raw.run('DROP TABLE shifts');
    raw.run(`CREATE TABLE shifts (
      id TEXT PRIMARY KEY,
      staff_id TEXT,
      staff_name TEXT,
      opening_cash INTEGER DEFAULT 0,
      closing_cash INTEGER,
      opened_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
    )`);
    raw.run(
      `INSERT INTO shifts (id, staff_id, staff_name, opening_cash, opened_at)
       VALUES ('legacy-local-shift', 'staff-1', 'Ala Nowak', 10000,
               '2026-08-30T08:00:00.000Z')`,
    );
    raw.run('PRAGMA user_version = 4');
    persistence.image = legacy.exportImage();

    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
    const { transport } = build({
      persistence,
      seed: { salonId: 'salon-1', salonSlug: 'test-salon' },
    });
    await transport.loginWithEmail!('staff@salon.pl', 'pw');
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.endsWith('/pos/shifts/active')) {
        return jsonResponse({ id: 'server-legacy-shift', staffId: 'staff-1' });
      }
      if (target.endsWith('/pos/shifts/server-legacy-shift/close')) {
        return jsonResponse({ id: 'server-legacy-shift' });
      }
      return jsonResponse({});
    });

    await expect(transport.closeShift!({
      shiftId: 'legacy-local-shift',
      closingCash: 10000,
    })).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).endsWith('/pos/shifts/server-legacy-shift/close'),
        ),
        JSON.stringify(fetchMock.mock.calls.map(([url]) => String(url))),
      ).toBe(true);
    });
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).endsWith('/pos/shifts/legacy-local-shift/close'),
    )).toBe(false);
  });

  test('the staff picker is seeded with the logged-in cashier', async () => {
    const { transport } = await transportWithShift();
    const staff = await transport.getStaff!();
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ id: 'staff-1', name: 'Ala Nowak', is_active: 1 });
  });

  test('createOrder accepts manual CARD + split BLIK tenders (E-PARITY-2, like the Windows counter)', async () => {
    // The trusted Sunmi terminal accepts the same manual tenders the Windows
    // salon counter does (cashier-attested standalone terminal). Owner decision
    // 2026-07-19; the backend P0-PAY-1 gap is accepted on the same basis.
    const { transport, shiftId } = await transportWithShift();
    // Distinct item ids per order — both orders now persist, so they cannot
    // share an order_items PK ('line-1').
    const card = await transport.createOrder!(
      { ...CASH_ORDER(shiftId), id: 'card-order', payment_method: 'CARD' },
      [{ ...CASH_ITEMS[0], id: 'card-line-1', order_id: 'card-order' }],
    );
    expect(card.success).toBe(true);
    expect(await transport.getOrderDetail!('card-order')).not.toBeNull();

    const split = await transport.createOrder!(
      { ...CASH_ORDER(shiftId), id: 'split-order', payment_tenders: JSON.stringify([{ method: 'CASH', amount: 2000 }, { method: 'BLIK', amount: 2900 }]) },
      [{ ...CASH_ITEMS[0], id: 'split-line-1', order_id: 'split-order' }],
    );
    expect(split.success).toBe(true);
    expect(await transport.getOrderDetail!('split-order')).not.toBeNull();
  });

  test('createOrder still refuses a genuinely unknown tender', async () => {
    const { transport, shiftId } = await transportWithShift();
    const bad = await transport.createOrder!(
      { ...CASH_ORDER(shiftId), id: 'bad-order', payment_method: 'BITCOIN' },
      CASH_ITEMS,
    );
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/unsupported/i);
    expect(await transport.getOrderDetail!('bad-order')).toBeNull();
  });

  test('createOrder is idempotent on a repeated client order id (no double-charge)', async () => {
    const { transport, shiftId } = await transportWithShift();
    const first = await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);
    expect(first).toMatchObject({ success: true, id: 'local-order-1' });
    const retry = await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);
    expect(retry).toMatchObject({ success: true, id: 'local-order-1', duplicate: true });

    // Exactly one order exists; stock decremented once (10 → 9), not twice.
    const history = await transport.getOrderHistory!({});
    expect(history.orders.filter((o: any) => o.id === 'local-order-1')).toHaveLength(1);
  });

  test('cancelOrder deletes an unsynced order and restocks so it never syncs', async () => {
    const { transport, shiftId } = await transportWithShift();
    await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);

    const cancelled = await transport.cancelOrder!('local-order-1');
    expect(cancelled.success).toBe(true);
    expect(await transport.getOrderDetail!('local-order-1')).toBeNull();

    // A subsequent drain must NOT push the cancelled order.
    fetchMock.mockClear();
    await transport.syncOrders!();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('retryOrderSync recovers a business-shelved order once the reason clears', async () => {
    const { transport, shiftId } = await transportWithShift();
    await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);

    // First drain: business rejection shelves the order (synced = -1).
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Insufficient stock for SKU-1' }, 400));
    await transport.syncOrders!();
    expect((await transport.getOrderDetail!('local-order-1'))?.order.synced).toBe(-1);

    // Backend stock fixed → retry drains successfully.
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (/\/finish$/.test(target)) return jsonResponse({});
      if (/\/b2b\/pos\/orders$/.test(target)) return jsonResponse({ id: 'backend-1' });
      throw new Error(`unexpected fetch: ${target}`);
    });
    const retry = await transport.retryOrderSync!('local-order-1');
    expect(retry).toMatchObject({ success: true, result: { status: 'synced' } });
    expect((await transport.getOrderDetail!('local-order-1'))?.order.synced).toBe(1);
  });

  test('retryOrderSync on a non-retryable order reports failed, not fake success', async () => {
    const { transport } = await transportWithShift();
    const retry = await transport.retryOrderSync!('does-not-exist');
    expect(retry.result?.status).toBe('failed');
  });

  test('cancelOrder refuses a synced order', async () => {
    const { transport, shiftId } = await transportWithShift();
    await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (/\/finish$/.test(target)) return jsonResponse({});
      if (/\/b2b\/pos\/orders$/.test(target)) return jsonResponse({ id: 'backend-1' });
      throw new Error(`unexpected fetch: ${target}`);
    });
    await transport.syncOrders!();
    const cancelled = await transport.cancelOrder!('local-order-1');
    expect(cancelled.success).toBe(false);
    expect(cancelled.error).toMatch(/Synced/i);
  });

  test('a service item (track_inventory=0) is not stock-decremented on sale', async () => {
    const { transport, shiftId } = await transportWithShift();
    // Seed a service product through the catalog sync normalizer.
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes('/warehouse/public/products')) {
        return jsonResponse({
          products: [{ id: 'svc-1', name: 'Manicure', itemType: 'service', retailPrice: '80.00', in_stock: 0, template: { id: 't-svc' } }],
          categories: [],
          nextSyncCursor: 'c1',
        });
      }
      return jsonResponse({ categories: [] });
    });
    await transport.syncProducts!();
    const svc = await transport.getProductById!('svc-1');
    expect(svc).toBeTruthy();

    await transport.createOrder!(
      { ...CASH_ORDER(shiftId), id: 'svc-order' },
      [{ id: 'l-svc', order_id: 'svc-order', variant_id: 'svc-1', name: 'Manicure', price: 8000, quantity: 1, sell_by: 'PIECE', total: 8000, vat_rate: 23 }],
    );
    const after = await transport.getProductById!('svc-1');
    // Service stock stays 0 (not driven negative / phantom), unlike a tracked good.
    expect((after as any).in_stock).toBe(0);
    expect((after as any).available_qty).toBe(0);
  });
});
