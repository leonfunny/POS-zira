import { MemoryAndroidPersistence } from './helpers/android-persistence';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore, type TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';
import { buildPaymentNamespace } from '../src/renderer/android-pos/shim/stubs';

/** Invalid/unauthorized requests remain fail-closed with the durable coordinator. */

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
  const tokenStore = new TokenStore({ storage: memoryStorage(), allowInsecureFallback: true });
  const transport = createRealTransport({
    configStore,
    tokenStore,
    dbInit: { locateFile: NODE_LOCATE_FILE, persistence: new MemoryAndroidPersistence() },
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
  test.each([true, false])('refund print reports unsupported without a sale reprint or network (real port=%s)', async realPort => {
    const { configStore, transport } = build();
    const requestReceiptPrint = vi.fn(async () => ({ success: true, receiptPrinted: true }));
    const payment = buildPaymentNamespace({
      configStore,
      transport: realPort ? { ...transport, requestReceiptPrint } : {},
    });

    const result = await payment.printRefundReceipt('refunded-order');

    expect(result).toEqual({
      success: false,
      receiptPrinted: false,
      reason: 'unsupported',
      code: 'ANDROID_REFUND_RECEIPT_UNSUPPORTED',
      error: 'Refund receipt printing is not available on Android yet. No receipt was printed.',
    });
    expect(requestReceiptPrint).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('ordinary sale reprint still delegates to the sale receipt coordinator', async () => {
    const { configStore } = build();
    const requestReceiptPrint = vi.fn(async () => ({ success: true, receiptPrinted: true }));
    const payment = buildPaymentNamespace({ configStore, transport: { requestReceiptPrint } });
    expect(await payment.reprintReceipt('sale-order')).toMatchObject({ receiptPrinted: true });
    expect(requestReceiptPrint).toHaveBeenCalledExactlyOnceWith('sale-order', { isReprint: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(['FULL', 'PARTIAL'])('STAFF cannot %s refund or mutate orders, stock, or reports', async type => {
    const { transport, shiftId } = await bootstrap();
    await transport.createOrder!(ORDER(shiftId, 'order-gated'), ITEMS('order-gated'));
    await syncOrder(transport);
    const before = await transport.getOrderDetail!('order-gated');
    const stockBefore = await transport.getProducts!();
    fetchMock.mockClear();
    const dto = { type, refundRequestId: '11111111-1111-4111-8111-111111111111', amount: 4900,
      lines: [{ orderItemId: 'backend-item', variantId: 'p1', quantity: 2,
        unitPrice: 2000, refundAmount: 4000, restock: true }] };
    const first = await transport.refundOrder!('order-gated', dto);
    const replay = await transport.refundOrder!('order-gated', dto);
    expect(first).toMatchObject({ success: false, receiptPrinted: false });
    expect(first.error).toMatch(/authenticated owner or manager/i);
    expect(replay).toEqual(first);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await transport.getOrderDetail!('order-gated')).toEqual(before);
    expect(await transport.getProducts!()).toEqual(stockBefore);
    fetchMock.mockImplementation(async () => jsonResponse({}));
    const closed = await transport.closeShift!({ shiftId, closingCash: 14900 });
    expect(closed.success).toBe(true);
    expect(closed.report).toMatchObject({ totalRefunds: 0, totalSales: 4900, cashTotal: 4900 });
  });

  test.each([null, {}, { type: 'FULL', amount: 4900, lines: [] }])('refuses malformed and unauthenticated direct calls with no HTTP', async dto => {
    const { transport } = build();
    const result = await transport.refundOrder!('unknown-order', dto);
    expect(result).toMatchObject({ success: false, receiptPrinted: false });
    expect(result.error).toMatch(/stable UUID refund request ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
