import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore, type TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';

/**
 * Packet E3a — Polish VAT invoicing (NIP lookup + add-invoice + generate-proforma).
 * Harness reused from tests/android-real-transport.test.ts: stubbed fetch + the
 * build()/loggedIn() shape. The order-history view methods are covered by the
 * other suites; this file exercises ONLY the three invoice-creation ports.
 */

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

function build() {
  const configStore = new ShimConfigStore({
    storage: memoryStorage(),
    seed: undefined as never,
  });
  const tokenStorage = memoryStorage();
  const tokenStore = new TokenStore({ storage: tokenStorage, allowInsecureFallback: true });
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

const CASH_ORDER = (shiftId: string, id = 'local-order-1') => ({
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
const CASH_ITEMS = (orderId: string) => [{
  id: 'line-1', order_id: orderId, variant_id: 'p1', name: 'Gel Polish',
  sku: 'SKU-1', price: 4900, quantity: 1, sell_by: 'PIECE', total: 4900, vat_rate: 23,
}];

/** Login + open a shift (an active shift is required to create orders). */
async function loggedIn() {
  fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_BODY));
  const built = build();
  await built.transport.loginWithEmail!('staff@salon.pl', 'pw');
  // openShift's backend POST is fire-and-forget; a default response is enough.
  fetchMock.mockResolvedValue(jsonResponse({ shiftId: 'server-shift' }));
  const open = await built.transport.openShift!({
    staffId: 'staff-1',
    staffName: 'Ala Nowak',
    openingCash: 10000,
  });
  expect(open.success).toBe(true);
  // openShift's backend POST is fire-and-forget; let its microtask chain settle so
  // the "no HTTP call" assertions below are not tripped by the lingering
  // /pos/shifts/open request resolving out from under us.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { ...built, shiftId: open.shiftId! };
}

/** Create an order and drain it so it carries a backend_id (synced). */
async function syncedOrder(built: Awaited<ReturnType<typeof loggedIn>>) {
  await built.transport.createOrder!(CASH_ORDER(built.shiftId), CASH_ITEMS('local-order-1'));
  fetchMock.mockImplementation(async (url: unknown) => {
    const target = String(url);
    if (/\/b2b\/pos\/orders\/backend-1\/finish$/.test(target)) {
      return jsonResponse({ orderNumber: 'POS-20260719-0042' });
    }
    if (/\/b2b\/pos\/orders$/.test(target)) return jsonResponse({ id: 'backend-1' });
    throw new Error(`unexpected fetch: ${target}`);
  });
  await built.transport.syncOrders!();
  const detail = await built.transport.getOrderDetail!('local-order-1');
  expect(detail?.order.backend_id).toBe('backend-1');
}

describe('real transport invoicing — lookupNip (E3a)', () => {
  test('returns the GUS data on 200', async () => {
    const built = await loggedIn();
    const GUS = {
      name: 'Firma Testowa sp. z o.o.',
      nip: '1234567890',
      address: 'ul. Testowa 1, 00-001 Warszawa',
    };
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes('/b2b/pos/customers/nip/')) return jsonResponse(GUS);
      throw new Error(`unexpected fetch: ${target}`);
    });

    const result = await built.transport.lookupNip!('1234567890');

    expect(result).toEqual({ success: true, data: GUS });
    // The sanitized NIP is on the wire (digits only).
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(String(lastCall[0])).toContain('/b2b/pos/customers/nip/1234567890');
  });

  test('returns {success:false} on 404 (no such NIP)', async () => {
    const built = await loggedIn();
    fetchMock.mockResolvedValue(jsonResponse({ message: 'NIP not found' }, 404));

    const result = await built.transport.lookupNip!('1234567890');

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  test('without auth fails with no HTTP call', async () => {
    const { transport } = build();
    const result = await transport.lookupNip!('1234567890');
    expect(result).toEqual({ success: false, error: 'Not authenticated' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects an invalid NIP (not 10 digits) with no HTTP call', async () => {
    const built = await loggedIn();
    fetchMock.mockClear();
    const result = await built.transport.lookupNip!('123');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/10 digits/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('strips non-digit characters before the lookup', async () => {
    const built = await loggedIn();
    fetchMock.mockResolvedValue(jsonResponse({ name: 'Co', nip: '1234567890' }));
    await built.transport.lookupNip!('123-456-78-90');
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    // The wire URL carries the cleaned 10-digit NIP, not the dashed form.
    expect(String(lastCall[0])).toContain('/b2b/pos/customers/nip/1234567890');
  });
});

describe('real transport invoicing — addInvoice (E3a)', () => {
  test('on a synced order PATCHes the route with the DTO and updates the local customer_nip', async () => {
    const built = await loggedIn();
    await syncedOrder(built);
    expect((await built.transport.getOrderDetail!('local-order-1'))?.order.customer_nip).toBeFalsy();

    const backendOrder = {
      id: 'backend-1',
      invoiceNumber: 'FV/2026/07/001',
      status: 'INVOICED',
    };
    let patchedBody: any = null;
    let patchedMethod: string | undefined;
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (/\/b2b\/pos\/orders\/backend-1\/add-invoice$/.test(target)) {
        patchedMethod = init?.method;
        patchedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return jsonResponse(backendOrder);
      }
      throw new Error(`unexpected fetch: ${target}`);
    });

    const result = await built.transport.addInvoice!('local-order-1', {
      customerNip: '1234567890',
      invoiceType: 'VAT',
    });

    expect(result.success).toBe(true);
    expect(result.order).toEqual(backendOrder);
    // The renderer DTO flowed through verbatim (customerNip + invoiceType 'VAT').
    expect(patchedBody).toEqual({ customerNip: '1234567890', invoiceType: 'VAT' });
    expect(patchedMethod).toBe('PATCH');

    // getDetail now reflects the invoiced NIP + the backend-reported status.
    const after = await built.transport.getOrderDetail!('local-order-1');
    expect(after?.order.customer_nip).toBe('1234567890');
    expect(after?.order.status).toBe('INVOICED');
  });

  test('on an UNSYNCED order is refused with no HTTP call', async () => {
    const built = await loggedIn();
    // Created but never drained → no backend_id.
    await built.transport.createOrder!(CASH_ORDER(built.shiftId), CASH_ITEMS('local-order-1'));
    expect((await built.transport.getOrderDetail!('local-order-1'))?.order.backend_id).toBeFalsy();

    fetchMock.mockClear();
    const result = await built.transport.addInvoice!('local-order-1', { customerNip: '1234567890' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sync/i);
    expect(fetchMock).not.toHaveBeenCalled();
    // The local order is untouched (no NIP written for a refused invoice).
    const after = await built.transport.getOrderDetail!('local-order-1');
    expect(after?.order.customer_nip).toBeFalsy();
  });

  test('defaults invoiceType to VAT when the renderer omits it', async () => {
    const built = await loggedIn();
    await syncedOrder(built);
    let patchedBody: any = null;
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (/\/b2b\/pos\/orders\/backend-1\/add-invoice$/.test(String(url))) {
        patchedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return jsonResponse({ id: 'backend-1' });
      }
      throw new Error('unexpected fetch');
    });

    const result = await built.transport.addInvoice!('local-order-1', { customerNip: '1234567890' });

    expect(result.success).toBe(true);
    expect(patchedBody).toEqual({ customerNip: '1234567890', invoiceType: 'VAT' });
  });

  test('on a non-existent order is refused with no HTTP call', async () => {
    const built = await loggedIn();
    fetchMock.mockClear();
    const result = await built.transport.addInvoice!('does-not-exist', { customerNip: '1234567890' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects an invalid NIP (not 10 digits) with no HTTP call', async () => {
    const built = await loggedIn();
    await syncedOrder(built);
    fetchMock.mockClear();
    const result = await built.transport.addInvoice!('local-order-1', { customerNip: '123' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/10 digits/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('real transport invoicing — generateProforma (E3a)', () => {
  test('on a synced order POSTs and returns the proforma', async () => {
    const built = await loggedIn();
    await syncedOrder(built);
    const proforma = { id: 'proforma-1', number: 'PRO-2026-001', total: 49.0 };
    let postedMethod: string | undefined;
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (/\/b2b\/pos\/orders\/backend-1\/generate-proforma$/.test(target)) {
        postedMethod = init?.method;
        return jsonResponse(proforma);
      }
      throw new Error(`unexpected fetch: ${target}`);
    });

    const result = await built.transport.generateProforma!('local-order-1');

    expect(result).toEqual({ success: true, proforma });
    expect(postedMethod).toBe('POST');
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(String(lastCall[0])).toContain('/b2b/pos/orders/backend-1/generate-proforma');
  });

  test('on an UNSYNCED order is refused with no HTTP call', async () => {
    const built = await loggedIn();
    await built.transport.createOrder!(CASH_ORDER(built.shiftId), CASH_ITEMS('local-order-1'));
    fetchMock.mockClear();

    const result = await built.transport.generateProforma!('local-order-1');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sync/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
