import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore, type TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';

/**
 * Packet E1b — refund flow + Z-report refund/discount subtraction.
 *
 * Covers the four behaviors the packet enumerates:
 *  1. full refund of a SYNCED order → POST /refund with the passed DTO verbatim,
 *     local status REFUNDED, restock of restock:true lines (track_inventory=1
 *     only), and the Z-report totalRefunds + reduced cashTotal.
 *  2. partial refund → PARTIAL_REFUND.
 *  3. unsynced order refund refused (refund a not-yet-synced order = cancel it).
 *
 * The transport owns its lazily-initialized SQL.js DB, so products are seeded
 * through the public surface (syncProducts) and read back through getProducts —
 * the same path the renderer uses. Order money is integer grosze throughout;
 * the backend /refund response carries PLN decimals (the renderer grosses them
 * up via toGrosze), matching Windows.
 */

/** Node-friendly sql.js load — mirrors tests/android-real-transport.test.ts. */
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

/** Catalog rows the sync normalizes into p1 (track_inventory=1) + p2 (=0). */
const CATALOG_PAGE = {
  items: [
    { id: 'p1', name: 'Gel Polish', sku: 'SKU-1', retailPrice: 20, itemType: 'stockable', trackInventory: true, totalStockQty: 5, sellBy: 'PIECE', saleUnit: 'szt' },
    { id: 'p2', name: 'Nail File', sku: 'SKU-2', retailPrice: 9, itemType: 'service', trackInventory: false, totalStockQty: 5, sellBy: 'PIECE', saleUnit: 'szt' },
  ],
  hasMore: false,
  nextSyncCursor: 'cursor-1',
  serverTime: '2026-07-19T00:00:00.000Z',
};

function build() {
  const configStore = new ShimConfigStore({ storage: memoryStorage(), seed: {} as never });
  const tokenStore = new TokenStore({ storage: memoryStorage() });
  const transport = createRealTransport({
    configStore,
    tokenStore,
    dbInit: { locateFile: NODE_LOCATE_FILE },
  });
  return { configStore, tokenStore, transport };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A CASH order with two lines: p1 (stockable, qty 2) + p2 (service, qty 1). */
const ORDER = (shiftId: string, id: string) => ({
  id,
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
const ITEMS = (orderId: string) => [
  { id: 'l1', order_id: orderId, variant_id: 'p1', name: 'Gel Polish', sku: 'SKU-1', price: 2000, quantity: 2, sell_by: 'PIECE', total: 4000, vat_rate: 23 },
  { id: 'l2', order_id: orderId, variant_id: 'p2', name: 'Nail File', sku: 'SKU-2', price: 900, quantity: 1, sell_by: 'PIECE', total: 900, vat_rate: 23 },
];

/** Log in, open a shift, and sync the catalog so p1/p2 exist in the local DB. */
async function bootstrap() {
  fetchMock.mockResolvedValue(jsonResponse(LOGIN_BODY));
  const built = build();
  await built.transport.loginWithEmail!('staff@salon.pl', 'pw');

  // Routes that are ambient to every setup step.
  const ambient = async (url: unknown): Promise<Response> => {
    const target = String(url);
    if (target.endsWith('/api/v1/auth/login')) return jsonResponse(LOGIN_BODY);
    if (target.endsWith('/api/v1/pos/shifts/open')) return jsonResponse({ shiftId: 'server-shift' });
    if (target.includes('/api/v1/warehouse/public/products/sync-v2')) return jsonResponse(CATALOG_PAGE);
    if (target.endsWith('/api/v1/warehouse/public/categories')) return jsonResponse([]);
    throw new Error(`unexpected ambient fetch: ${target}`);
  };
  fetchMock.mockImplementation(async (url: unknown) => ambient(url));

  const open = await built.transport.openShift!({ staffId: 'staff-1', staffName: 'Ala Nowak', openingCash: 10000 });
  expect(open.success).toBe(true);
  await built.transport.syncProducts!();
  return { ...built, shiftId: open.shiftId! };
}

/** Push a local order to the backend so it gains backend_id (becomes refundable). */
async function syncOrder(transport: ReturnType<typeof build>['transport'], backendId = 'backend-1') {
  fetchMock.mockImplementation(async (url: unknown) => {
    const target = String(url);
    if (target.endsWith('/api/v1/auth/login')) return jsonResponse(LOGIN_BODY);
    if (target.endsWith('/api/v1/pos/shifts/open')) return jsonResponse({ shiftId: 'server-shift' });
    if (target.includes('/api/v1/warehouse/public/products/sync-v2')) return jsonResponse(CATALOG_PAGE);
    if (target.endsWith('/api/v1/warehouse/public/categories')) return jsonResponse([]);
    if (target.endsWith('/api/v1/b2b/pos/orders')) return jsonResponse({ id: backendId });
    if (target.endsWith(`/${backendId}/finish`)) return jsonResponse({});
    throw new Error(`unexpected sync fetch: ${target}`);
  });
  await transport.syncOrders!();
}

describe('android refund (E1b)', () => {
  test('full refund of a synced order: POSTs the DTO verbatim, marks REFUNDED, restocks track_inventory=1 only, Z-report subtracts', async () => {
    const { transport, shiftId } = await bootstrap();
    await transport.createOrder!(ORDER(shiftId, 'order-full'), ITEMS('order-full'));
    await syncOrder(transport);

    // Stock after the sale: p1 (track_inventory=1) decremented 5→2; p2 (=0) untouched.
    let products = await transport.getProducts!();
    const p1Before = products.find((p) => p.id === 'p1')!;
    const p2Before = products.find((p) => p.id === 'p2')!;
    expect(p1Before.in_stock).toBe(3);
    expect((p1Before as any).track_inventory).toBe(1);
    expect(p2Before.in_stock).toBe(5);
    expect((p2Before as any).track_inventory).toBe(0);

    const dto = {
      type: 'FULL' as const,
      refundRequestId: 'refund-1',
      reason: 'customer-request',
      amount: 4900, // grosze — the renderer builds this; transport passes it through
      lines: [
        { variantId: 'p1', sku: 'SKU-1', name: 'Gel Polish', quantity: 2, unit: 'szt', unitPrice: 2000, refundAmount: 4000, restock: true, vatRate: 23 },
        { variantId: 'p2', sku: 'SKU-2', name: 'Nail File', quantity: 1, unit: 'szt', unitPrice: 900, refundAmount: 900, restock: true, vatRate: 23 },
      ],
    };

    const requests: Array<{ url: string; body: any }> = [];
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (init?.body) requests.push({ url: target, body: JSON.parse(String(init.body)) });
      if (target.endsWith('/api/v1/b2b/pos/orders/backend-1/refund')) {
        // Backend response: PLN decimals (renderer grosses up via toGrosze).
        return jsonResponse({ status: 'REFUNDED', refundAmount: 49, totalRefundedAmount: 49, refundedLines: [] });
      }
      if (target.endsWith('/api/v1/b2b/pos/orders/backend-1/finish')) return jsonResponse({});
      if (target.endsWith('/api/v1/b2b/pos/orders')) return jsonResponse({ id: 'backend-1' });
      if (target.includes('/api/v1/warehouse/public/products/sync-v2')) return jsonResponse(CATALOG_PAGE);
      if (target.endsWith('/api/v1/warehouse/public/categories')) return jsonResponse([]);
      if (target.endsWith('/api/v1/pos/shifts/server-shift/close')) return jsonResponse({});
      throw new Error(`unexpected fetch: ${target}`);
    });

    const result = await transport.refundOrder!('order-full', dto);
    expect(result.success).toBe(true);

    // The DTO is passed through VERBATIM (the renderer builds it; no rebuild).
    const refundCall = requests.find((r) => r.url.endsWith('/api/v1/b2b/pos/orders/backend-1/refund'));
    expect(refundCall).toBeDefined();
    expect(refundCall!.body).toEqual(dto);

    // Local order marked REFUNDED with the cumulative refund_amount (grosze).
    const detail = await transport.getOrderDetail!('order-full');
    expect(detail?.order.status).toBe('REFUNDED');
    expect(detail?.order.refund_amount).toBe(4900);

    // Restock: p1 (track_inventory=1) restocked +2 → 5; p2 (=0) NOT restocked → 5.
    products = await transport.getProducts!();
    expect(products.find((p) => p.id === 'p1')!.in_stock).toBe(5);
    expect(products.find((p) => p.id === 'p2')!.in_stock).toBe(5);

    // Z-report: the refund is subtracted from totalSales AND the cash bucket.
    const closed = await transport.closeShift!({ shiftId, closingCash: 10000 });
    expect(closed.success).toBe(true);
    expect(closed.report).toMatchObject({
      totalRefunds: 4900,
      totalDiscounts: 0,
      totalSales: 0, // gross 4900 − refunds 4900 − discounts 0
      cashTotal: 0, // sale 4900 CASH − refund 4900 CASH
      cardTotal: 0,
      totalOrders: 1,
    });
  });

  test('partial refund → PARTIAL_REFUND, restocks only the refunded stockable line', async () => {
    const { transport, shiftId } = await bootstrap();
    await transport.createOrder!(ORDER(shiftId, 'order-partial'), ITEMS('order-partial'));
    await syncOrder(transport);

    // p1 is 3 after the sale (5 − 2).
    expect((await transport.getProducts!()).find((p) => p.id === 'p1')!.in_stock).toBe(3);

    const dto = {
      type: 'PARTIAL' as const,
      refundRequestId: 'refund-2',
      reason: 'one-item-returned',
      amount: 2000, // grosze — refund 1× p1
      lines: [
        { variantId: 'p1', sku: 'SKU-1', name: 'Gel Polish', quantity: 1, unit: 'szt', unitPrice: 2000, refundAmount: 2000, restock: true, vatRate: 23 },
      ],
    };

    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.endsWith('/api/v1/b2b/pos/orders/backend-1/refund')) {
        return jsonResponse({ status: 'PARTIAL_REFUND', refundAmount: 20, totalRefundedAmount: 20, refundedLines: [] });
      }
      if (target.endsWith('/api/v1/b2b/pos/orders/backend-1/finish')) return jsonResponse({});
      if (target.endsWith('/api/v1/b2b/pos/orders')) return jsonResponse({ id: 'backend-1' });
      if (target.includes('/api/v1/warehouse/public/products/sync-v2')) return jsonResponse(CATALOG_PAGE);
      if (target.endsWith('/api/v1/warehouse/public/categories')) return jsonResponse([]);
      if (target.endsWith('/api/v1/pos/shifts/server-shift/close')) return jsonResponse({});
      throw new Error(`unexpected fetch: ${target}`);
    });

    const result = await transport.refundOrder!('order-partial', dto);
    expect(result.success).toBe(true);

    const detail = await transport.getOrderDetail!('order-partial');
    expect(detail?.order.status).toBe('PARTIAL_REFUND');
    expect(detail?.order.refund_amount).toBe(2000);

    // p1 restocked +1 → 4 (partial refund of 1 of the 2 sold units).
    expect((await transport.getProducts!()).find((p) => p.id === 'p1')!.in_stock).toBe(4);

    const closed = await transport.closeShift!({ shiftId, closingCash: 10000 });
    expect(closed.report).toMatchObject({
      totalRefunds: 2000,
      totalSales: 2900, // gross 4900 − refunds 2000
      cashTotal: 2900, // sale 4900 CASH − refund 2000 CASH
    });
  });

  test('an unsynced order is refused — refund a not-yet-synced order = cancel it', async () => {
    const { transport, shiftId } = await bootstrap();
    await transport.createOrder!(ORDER(shiftId, 'order-unsynced'), ITEMS('order-unsynced'));
    // NOTE: deliberately NOT synced — no backend_id.

    fetchMock.mockClear();
    const result = await transport.refundOrder!('order-unsynced', { type: 'FULL', amount: 4900, lines: [] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not synced/i);

    // No refund request should have touched the backend.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/refund'))).toBe(false);
  });

  test('an already-fully-refunded order is refused', async () => {
    const { transport, shiftId } = await bootstrap();
    await transport.createOrder!(ORDER(shiftId, 'order-twice'), ITEMS('order-twice'));
    await syncOrder(transport);

    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.endsWith('/api/v1/b2b/pos/orders/backend-1/refund')) {
        return jsonResponse({ status: 'REFUNDED', refundAmount: 49, totalRefundedAmount: 49 });
      }
      if (target.endsWith('/api/v1/b2b/pos/orders/backend-1/finish')) return jsonResponse({});
      if (target.endsWith('/api/v1/b2b/pos/orders')) return jsonResponse({ id: 'backend-1' });
      if (target.includes('/api/v1/warehouse/public/products/sync-v2')) return jsonResponse(CATALOG_PAGE);
      if (target.endsWith('/api/v1/warehouse/public/categories')) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${target}`);
    });

    const first = await transport.refundOrder!('order-twice', {
      type: 'FULL', amount: 4900,
      lines: [{ variantId: 'p1', name: 'Gel Polish', quantity: 2, unitPrice: 2000, refundAmount: 4000, restock: true, vatRate: 23 }],
    });
    expect(first.success).toBe(true);

    const second = await transport.refundOrder!('order-twice', {
      type: 'FULL', amount: 4900, lines: [],
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already fully refunded/i);
  });
});
