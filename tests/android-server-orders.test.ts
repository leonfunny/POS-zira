import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/main/logger', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { adaptServerOrder as adaptAndroid, adaptServerOrderItem as adaptItemAndroid } from '../src/renderer/android-pos/port/server-order-adapter';
import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore, type TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';
import { __resetShimForTest, installShim } from '../src/renderer/android-pos/shim/index';
import { adaptServerOrder as adaptWindows, adaptServerOrderItem as adaptItemWindows } from '../src/main/sync/pos-order-adapter';
import type { AndroidDbInitOptions } from '../src/renderer/android-pos/shim/db/db';
import type { ShimTransport } from '../src/renderer/android-pos/shim/transport';

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

function build(overrides: { dbInit?: AndroidDbInitOptions } = {}) {
  const configStore = new ShimConfigStore({ storage: memoryStorage() });
  const tokenStore = new TokenStore({ storage: memoryStorage() });
  const transport = createRealTransport({
    configStore,
    tokenStore,
    dbInit: overrides.dbInit ?? { locateFile: NODE_LOCATE_FILE },
    agentConnection: {
      connect: async () => ({ connected: false, reason: 'no-key' as const }),
      disconnect: async () => {},
      isConnected: () => false,
      getPushedJobStatus: () => null,
      onJobStatus: () => () => {},
    },
  });
  return { tokenStore, transport };
}

const fetchMock = vi.fn();

const SERVER_ORDER = {
  id: 'srv-1', orderNumber: 'B2B/2026/08/123', status: 'COMPLETED',
  paymentMethod: 'CASH', paymentStatus: 'PAID', total: 49.0, discountAmount: 0,
  createdAt: '2026-08-06T10:00:00.000Z', staffName: 'Ala Nowak',
  requiresInvoice: false, customerNip: null,
  items: [{ id: 'it-1', variantId: 'p1', productName: 'Gel Polish', quantity: 1, unitPrice: 49.0, vatRate: 23 }],
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  __resetShimForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetShimForTest();
});

describe('server-order-adapter parity', () => {
  test('adaptServerOrder matches the Windows adapter bit-for-bit', () => {
    expect(adaptAndroid(SERVER_ORDER)).toEqual(adaptWindows(SERVER_ORDER));
  });

  test('adaptServerOrderItem matches the Windows adapter bit-for-bit', () => {
    const a = adaptAndroid(SERVER_ORDER);
    expect(adaptItemAndroid(SERVER_ORDER.items[0], a.id, SERVER_ORDER))
      .toEqual(adaptItemWindows(SERVER_ORDER.items[0], a.id, SERVER_ORDER));
  });
});

describe('real server order history', () => {
  test('getServerOrders adapts rows and item map', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ orders: [SERVER_ORDER], total: 1, page: 1, limit: 20 }));
    const { tokenStore, transport } = build();
    await tokenStore.setTokens('staff-jwt');

    const result = await transport.getServerOrders!({ page: 1, limit: 20 });

    expect(result.source).toBe('server');
    expect(result.orders).toEqual([adaptAndroid(SERVER_ORDER)]);
    expect(result.items[result.orders[0].id]).toEqual([
      adaptItemAndroid(SERVER_ORDER.items[0], result.orders[0].id, SERVER_ORDER),
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/b2b/pos/orders');
  });

  test('no auth token reports unconfigured without an HTTP call', async () => {
    const { transport } = build();

    const result = await transport.getServerOrders!({});

    expect(result).toEqual({ orders: [], items: {}, total: 0, page: 1, limit: 20, source: 'unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('network failure reports network-error without throwing', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    const { tokenStore, transport } = build();
    await tokenStore.setTokens('staff-jwt');

    const result = await transport.getServerOrders!({});

    expect(result.source).toBe('network-error');
    expect(result.error).toBeTruthy();
  });

  test('synthetic install keeps the unconfigured literal', async () => {
    const { api } = installShim();

    await expect(api.pos.orders.getServerList({})).resolves.toEqual({
      orders: [], items: {}, total: 0, page: 1, limit: 50, source: 'unconfigured',
    });
  });

  test('the shim actually delegates getServerList to the transport', async () => {
    // The whole point of this packet: getServerList used to be hard-wired to
    // the synthetic empty answer and never consulted the transport. Asserting
    // on transport.getServerOrders() alone would not notice that regression —
    // only driving the shim surface with a transport attached does.
    const served = {
      orders: [{ id: 'srv-1' }],
      items: { 'srv-1': [{ id: 'it-1' }] },
      total: 1,
      page: 1,
      limit: 20,
      source: 'server' as const,
    };
    const transport: ShimTransport = { getServerOrders: async () => served };
    __resetShimForTest();
    const { api } = installShim({ transport });

    await expect(api.pos.orders.getServerList({ page: 1, limit: 20 })).resolves.toEqual(served);
  });
});
