import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore } from '../src/renderer/android-pos/shim/token-store';
import { buildOrdersNamespace } from '../src/renderer/android-pos/shim/stubs';
import { MemoryAndroidPersistence } from './helpers/android-persistence';
import { createServerHistoryTransport } from '../src/renderer/android-pos/shim/server-history';

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); } };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function detail(overrides: Record<string, any> = {}) {
  return { id: 'server-1', salonId: 'salon-1', orderNumber: 'ORDER-1',
    createdAt: '2026-09-08T08:00:00Z', total: 20, subtotal: 20,
    paymentMethod: 'CASH', paidAmount: 20, status: 'COMPLETED',
    items: [
      { id: 'line-2', orderId: 'server-1', productVariantId: 'same-product', productName: 'Meal', quantity: 1, unitPrice: 10, total: 10 },
      { id: 'line-1', orderId: 'server-1', productVariantId: 'same-product', productName: 'Meal', quantity: 1, unitPrice: 10, total: 10 },
    ], ...overrides };
}
async function setup() {
  const configStore = new ShimConfigStore({ storage: storage(), seed: {
    apiUrl: 'https://history.test', salonId: 'salon-1',
    authUser: { id: 'staff-1', salonId: 'salon-1' },
  } as never });
  const tokenStore = new TokenStore({ storage: storage(), allowInsecureFallback: true });
  await tokenStore.setTokens('test-access', 'test-refresh');
  const persistence = new MemoryAndroidPersistence();
  const transport = createRealTransport({ configStore, tokenStore,
    dbInit: { locateFile: null, persistence },
    agentConnection: { connect: vi.fn(), disconnect: vi.fn(), getPushedJobStatus: vi.fn() } as never });
  const orders = buildOrdersNamespace({ transport } as never);
  return { configStore, tokenStore, persistence, transport, orders };
}
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Android server history transport', () => {
  it('delegates the server list, retaining filters/pagination and never importing automatically', async () => {
    const { orders, transport } = await setup();
    fetchMock.mockResolvedValue(response({ orders: [detail()], total: 81, page: 3, limit: 7 }));
    const result = await orders.getServerList({ page: 3, limit: 7, staffName: 'A B', paymentMethod: 'CARD', requiresInvoice: false });
    expect(result).toMatchObject({ source: 'server', total: 81, page: 3, limit: 7 });
    expect(result.orders[0]).toMatchObject({ id: 'server-1', _origin: 'server' });
    expect(result.items['server-1'].map((item: any) => item.id)).toEqual(['line-2', 'line-1']);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ page: '3', limit: '7', staffName: 'A B', paymentMethod: 'CARD', requiresInvoice: 'false' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-access');
    expect((await transport.getOrderHistory!({})).orders).toEqual([]);
  });

  it('distinguishes authenticated empty, network error and unconfigured history', async () => {
    const { orders, tokenStore } = await setup();
    fetchMock.mockResolvedValue(response({ orders: [], total: 0, page: 2, limit: 9 }));
    expect(await orders.getServerList({ page: 2, limit: 9 })).toMatchObject({ source: 'server', orders: [], total: 0, page: 2 });
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await orders.getServerList({ page: 2, limit: 9 })).toMatchObject({ source: 'network-error', error: 'offline', page: 2, limit: 9 });
    await tokenStore.clear(); fetchMock.mockClear();
    expect(await orders.getServerList({})).toMatchObject({ source: 'unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mirrors only the requested detail with a 404-only alternate-kind lookup', async () => {
    const { orders, transport } = await setup();
    fetchMock.mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(response(detail()));
    expect(await orders.mirrorFromServer('server-1', 'cash')).toMatchObject({ success: true, localOrderId: 'server-1', wasSplit: false });
    expect(fetchMock.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual([
      '/api/v1/b2b/pos/orders/cash/server-1', '/api/v1/b2b/pos/orders/invoiced/server-1',
    ]);
    const local = await transport.getOrderDetail!('server-1');
    expect(local?.order).toMatchObject({ source: 'SERVER', synced: 1, shift_id: null, total: 2000 });
    expect(local?.items).toHaveLength(2);
    expect(await orders.getRefundDetail('server-1')).toMatchObject({ success: false, error: 'Only an authenticated owner or manager can refund on Android' });
    expect(fetchMock.mock.calls.every(call => !call[1].method || call[1].method === 'GET')).toBe(true);
  });

  it.each([
    ['wrong parent', { id: 'wrong' }], ['wrong salon', { salonId: 'another' }],
    ['wrong line ownership', { items: [{ id: 'line', orderId: 'another' }] }],
    ['duplicate IDs', { items: [{ id: 'same' }, { id: 'same' }] }],
    ['missing line ID', { items: [{ name: 'Meal' }] }],
    ['empty detail', { items: [] }], ['missing original date', { createdAt: undefined }],
  ])('rejects %s before mirror mutation', async (_name, overrides) => {
    const { orders, transport } = await setup();
    fetchMock.mockResolvedValue(response(detail(overrides)));
    expect(await orders.mirrorFromServer('server-1', 'cash')).toMatchObject({ success: false });
    expect((await transport.getOrderHistory!({})).orders).toEqual([]);
  });

  it.each(['staff', 'salon', 'server', 'token', 'logout'])('rejects a %s context switch while the response is pending', async kind => {
    const { orders, transport, configStore, tokenStore } = await setup();
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const pending = orders.mirrorFromServer('server-1', 'cash');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    if (kind === 'staff') configStore.setConfig({ authUser: { id: 'staff-2', salonId: 'salon-1' } } as never);
    if (kind === 'salon') configStore.setConfig({ salonId: 'salon-2' });
    if (kind === 'server') configStore.setConfig({ apiUrl: 'https://other.test' } as never);
    if (kind === 'token' || kind === 'logout') await tokenStore.clear();
    if (kind === 'token') await tokenStore.setTokens('other-access', 'other-refresh');
    finish(response(detail()));
    expect(await pending).toMatchObject({ success: false, error: 'ORDER_HISTORY_CONTEXT_CHANGED' });
    expect((await transport.getOrderHistory!({})).orders).toEqual([]);
  });

  it('does not return stale list data after a same-salon staff change', async () => {
    const { orders, configStore } = await setup();
    fetchMock.mockImplementation(async () => {
      configStore.setConfig({ authUser: { id: 'staff-2', salonId: 'salon-1' } } as never);
      return response({ orders: [detail()], total: 1 });
    });
    expect(await orders.getServerList({})).toMatchObject({ source: 'network-error', orders: [], error: 'ORDER_HISTORY_CONTEXT_CHANGED' });
  });

  it('keeps flush failure visible instead of reporting a durable mirror success', async () => {
    const { orders, persistence } = await setup();
    persistence.failSave = true;
    fetchMock.mockResolvedValue(response(detail()));
    expect(await orders.mirrorFromServer('server-1', 'cash')).toMatchObject({ success: false });
    persistence.failSave = false;
  });

  it.each([403, 500])('does not retry another detail kind after HTTP %s', async status => {
    const { orders } = await setup();
    fetchMock.mockResolvedValue(response({ message: 'unavailable' }, status));
    expect(await orders.mirrorFromServer('server-1', 'cash')).toMatchObject({ success: false, error: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ orders: null }, { orders: {} }, { orders: [detail({ salonId: 'other' })] }])('rejects malformed/foreign list data %j', async body => {
    const { orders } = await setup(); fetchMock.mockResolvedValue(response(body));
    expect(await orders.getServerList({})).toMatchObject({ source: 'network-error', orders: [] });
  });

  it('retains exact notes/course when identical product lines arrive reversed', async () => {
    const { orders, transport } = await setup();
    const raw = detail({ posMode: 'restaurant', posOrderType: 'dine_in', externalMetadata: { meta: { restaurant: {
      schemaVersion: 1, tableId: 'table-A', covers: 2, lines: [
        { orderItemId: 'line-1', localLineId: 'origin-1', productId: 'same-product', lineIndex: 0, notes: 'No onion', course: 1 },
        { orderItemId: 'line-2', localLineId: 'origin-2', productId: 'same-product', lineIndex: 1, notes: 'Extra sauce', course: 2 },
      ],
    } } } });
    raw.items.forEach((item: any) => { item.productId = 'same-product'; });
    fetchMock.mockImplementation(async () => response(raw));
    expect(await orders.mirrorFromServer('server-1', 'cash')).toMatchObject({ success: true });
    const local = await transport.getOrderDetail!('server-1');
    expect(local?.order).toMatchObject({ table_id: 'table-A', covers: 2, order_type: 'dine_in' });
    expect(local?.items.find(item => item.id === 'line-1')).toMatchObject({ notes: 'No onion', course: 1, restaurant_line_id: 'origin-1' });
    expect(local?.items.find(item => item.id === 'line-2')).toMatchObject({ notes: 'Extra sauce', course: 2, restaurant_line_id: 'origin-2' });
  });

  it.each([0, 1])('preserves local POS rows (synced=%s), pending upload, stock and shift when IDs collide', async synced => {
    const { orders, transport } = await setup();
    const db = await transport.getRestaurantDatabase!();
    db.run("INSERT INTO product_variants (id, name, in_stock, available_qty) VALUES ('same-product', 'Meal', 9, 9)");
    db.run("INSERT INTO shifts (id, opening_cash) VALUES ('local-shift', 12345)");
    db.run(`INSERT INTO orders (id, backend_id, status, source, synced, shift_id, total, sync_payload_json)
      VALUES ('local-1', 'server-1', 'COMPLETED', 'POS', ?, 'local-shift', 4567, '{"frozen":true}')`, [synced]);
    db.run("INSERT INTO order_items (id, order_id, name, notes, course, total) VALUES ('local-line', 'local-1', 'Meal', 'Preserve', 3, 4567)");
    const before = db.all('SELECT * FROM orders'); const lines = db.all('SELECT * FROM order_items');
    fetchMock.mockResolvedValue(response(detail()));
    expect(await orders.mirrorFromServer('server-1', 'cash')).toMatchObject({ success: true, localOrderId: 'local-1' });
    expect(db.all('SELECT * FROM orders')).toEqual(before);
    expect(db.all('SELECT * FROM order_items')).toEqual(lines);
    expect(db.get('SELECT in_stock, available_qty FROM product_variants')).toEqual({ in_stock: 9, available_qty: 9 });
    expect(db.get('SELECT opening_cash FROM shifts')).toEqual({ opening_cash: 12345 });
  });

  it('does not refresh/retry a 401 under a different staff identity', async () => {
    const { orders, configStore } = await setup();
    fetchMock.mockImplementation(async () => {
      configStore.setConfig({ authUser: { id: 'staff-2', salonId: 'salon-1' } } as never);
      return response({}, 401);
    });
    expect(await orders.getServerList({})).toMatchObject({ source: 'network-error', error: 'ORDER_HISTORY_CONTEXT_CHANGED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails a token-rotated history snapshot closed, then allows a fresh read', async () => {
    const { orders } = await setup();
    fetchMock.mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }));
    expect(await orders.getServerList({})).toMatchObject({ source: 'network-error', error: 'ORDER_HISTORY_CONTEXT_CHANGED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValue(response({ orders: [], total: 0 }));
    expect(await orders.getServerList({})).toMatchObject({ source: 'server' });
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer rotated-access');
  });

  it('rechecks identity after lazy database initialization, before any import mutation', async () => {
    const { configStore, tokenStore, transport } = await setup();
    const db = await transport.getRestaurantDatabase!();
    const run = vi.spyOn(db, 'run'); const flush = vi.spyOn(db, 'flush');
    const history = createServerHistoryTransport({ configStore, tokenStore,
      serverUrl: 'https://history.test', currentServerUrl: () => 'https://history.test',
      client: { getServerOrderDetail: vi.fn(async () => detail()) } as never,
      db: async () => {
        configStore.setConfig({ authUser: { id: 'staff-2', salonId: 'salon-1' } } as never);
        return db;
      },
    });
    expect(await history.mirrorOrderFromServer!('server-1', 'cash')).toMatchObject({ success: false, error: 'ORDER_HISTORY_CONTEXT_CHANGED' });
    expect(run).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled();
  });

  it('does not return a successful stale mirror after the durability await changes staff', async () => {
    const { orders, configStore, transport } = await setup();
    const db = await transport.getRestaurantDatabase!();
    const original = db.flush.bind(db);
    vi.spyOn(db, 'flush').mockImplementation(async () => {
      await original();
      configStore.setConfig({ authUser: { id: 'staff-2', salonId: 'salon-1' } } as never);
    });
    fetchMock.mockResolvedValue(response(detail()));
    expect(await orders.mirrorFromServer('server-1', 'cash')).toMatchObject({ success: false, error: 'ORDER_HISTORY_CONTEXT_CHANGED' });
  });

  it('preserves a pending local order whose primary ID equals the server ID', async () => {
    const { orders, transport } = await setup();
    const db = await transport.getRestaurantDatabase!();
    db.run("INSERT INTO orders (id, source, synced, total, sync_payload_json) VALUES ('server-1', 'POS', 0, 7654, '{\"immutable\":true}')");
    const before = db.all('SELECT * FROM orders');
    fetchMock.mockResolvedValue(response(detail()));
    expect(await orders.mirrorFromServer('server-1', 'cash')).toMatchObject({ success: true, localOrderId: 'server-1' });
    expect(db.all('SELECT * FROM orders')).toEqual(before);
    expect(db.all('SELECT * FROM order_items')).toEqual([]);
  });

  it('rejects staff switch-away-and-back even when the original identity/token is restored', async () => {
    const { orders, configStore, transport } = await setup();
    const originalUser = configStore.getRawConfig().authUser;
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const pending = orders.mirrorFromServer('server-1', 'cash');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    configStore.setConfig({ authUser: { id: 'staff-2', salonId: 'salon-1' } } as never);
    configStore.setConfig({ authUser: originalUser });
    finish(response(detail()));
    expect(await pending).toMatchObject({ success: false, error: 'ORDER_HISTORY_CONTEXT_CHANGED' });
    expect((await transport.getOrderHistory!({})).orders).toEqual([]);
  });
});
