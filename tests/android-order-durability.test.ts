import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore, type TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';
import type { AndroidDbInitOptions } from '../src/renderer/android-pos/shim/db/db';

/**
 * B3 — a paid order that never reached disk must NOT be reported as recorded.
 *
 * Flush failure is injected through the PERSISTENCE seam (the same injection
 * `tests/android-real-transport.test.ts` already uses): a rejecting
 * `saveImage` makes `AndroidDatabase.flush()` reject naturally, so nothing
 * inside the transport has to be stubbed.
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

/** Factory copied from tests/android-real-transport.test.ts:42. */
function build(overrides: { seed?: Record<string, unknown>; dbInit?: AndroidDbInitOptions } = {}) {
  const configStore = new ShimConfigStore({
    storage: memoryStorage(),
    seed: overrides.seed as never,
  });
  const tokenStorage = memoryStorage();
  const tokenStore = new TokenStore({ storage: tokenStorage });
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
  return { configStore, tokenStore, tokenStorage, transport };
}

/** `state.failSaves > 0` → the next N saveImage calls reject. */
function flakyPersistence() {
  const state = { failSaves: 0, saves: 0 };
  return {
    state,
    persistence: {
      loadImage: async () => null,
      saveImage: async () => {
        state.saves += 1;
        if (state.failSaves > 0) {
          state.failSaves -= 1;
          throw new Error('disk full');
        }
      },
      quarantineImage: async () => {},
    },
  };
}

const SEEDED_STOCK = 5;

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

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Logged-in transport with `p1` seeded at `stock` and an open shift. The seed
 * flushes go through the same persistence, so failures are armed only AFTER
 * setup completes.
 */
async function transportWithStockAndShift(stock: number, allowOversell = false) {
  const { state, persistence } = flakyPersistence();
  const built = build({
    seed: { allowOversell } as Record<string, unknown>,
    dbInit: { locateFile: NODE_LOCATE_FILE, persistence },
  });

  fetchMock.mockResolvedValue(jsonResponse(LOGIN_BODY));
  await built.transport.loginWithEmail!('staff@salon.pl', 'pw');

  fetchMock.mockImplementation(async (url: unknown) => {
    const target = String(url);
    if (target.includes('/warehouse/public/products')) {
      return jsonResponse({
        products: [{
          id: 'p1',
          name: 'Gel Polish',
          sku: 'SKU-1',
          retailPrice: '49.00',
          totalStockQty: stock,
          availableQty: stock,
          itemType: 'stockable',
          trackInventory: true,
          template: { id: 't1', taxRate: '23' },
        }],
        categories: [],
        nextSyncCursor: 'durability-cursor',
      });
    }
    return jsonResponse({ categories: [] });
  });
  expect(await built.transport.syncProducts!()).toMatchObject({ success: true, productsCount: 1 });

  fetchMock.mockResolvedValue(jsonResponse({ shiftId: 'server-shift' }));
  const open = await built.transport.openShift!({ staffId: 'staff-1', staffName: 'Ala Nowak', openingCash: 10000 });
  expect(open.success).toBe(true);

  expect(await built.transport.getProductById!('p1')).toMatchObject({ in_stock: stock });

  return { ...built, state, shiftId: open.shiftId! };
}

describe('createOrder durability (B3)', () => {
  test('both flushes fail → fail closed, order rolled back, stock restored, retry re-creates cleanly', async () => {
    const { transport, state, shiftId } = await transportWithStockAndShift(SEEDED_STOCK);

    // create-flush AND rollback-flush both fail.
    state.failSaves = 2;
    const first = await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);

    expect(first.success).toBe(false);
    expect(first.error).toContain('order-durability-failed');
    expect((first as any).rollbackDurabilityError).toBeTruthy();

    // In-memory rollback happened even though its own flush failed.
    expect(await transport.getOrderDetail!('local-order-1')).toBeNull();
    expect((await transport.getProductById!('p1')) as any).toMatchObject({
      in_stock: SEEDED_STOCK,
      available_qty: SEEDED_STOCK,
    });

    // Persistence healthy again → the retry re-creates cleanly (no duplicate lie).
    const retry = await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);
    expect(retry).toMatchObject({ success: true, id: 'local-order-1' });
    expect(await transport.getOrderDetail!('local-order-1')).not.toBeNull();
    expect((await transport.getProductById!('p1')) as any).toMatchObject({
      in_stock: SEEDED_STOCK - 1,
      available_qty: SEEDED_STOCK - 1,
    });
  });

  test('only the create flush fails → fail closed without a rollbackDurabilityError', async () => {
    const { transport, state, shiftId } = await transportWithStockAndShift(SEEDED_STOCK);

    state.failSaves = 1;
    const result = await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);

    expect(result.success).toBe(false);
    expect(result.error).toContain('order-durability-failed');
    expect((result as any).rollbackDurabilityError).toBeUndefined();
    expect(await transport.getOrderDetail!('local-order-1')).toBeNull();
    expect((await transport.getProductById!('p1')) as any).toMatchObject({
      in_stock: SEEDED_STOCK,
      available_qty: SEEDED_STOCK,
    });
  });

  test('rollback does not fabricate stock past a MAX(0) clamped decrement', async () => {
    // p1 seeded at 0 with allowOversell off: the decrement CLAMPS at 0, so an
    // arithmetic (+quantity) rollback would invent a unit that never existed.
    const { transport, state, shiftId } = await transportWithStockAndShift(0, false);

    state.failSaves = 1;
    const result = await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);

    expect(result.success).toBe(false);
    expect((await transport.getProductById!('p1')) as any).toMatchObject({
      in_stock: 0,       // NOT 1
      available_qty: 0,  // NOT 1
    });
  });

  test('rollback restores the true pre-order stock when one variant spans two cart lines', async () => {
    // The cart merges lines only when variantId AND staffId AND course all
    // match (pos-store.ts cart/addItem), so the SAME product sold by two
    // technicians is two lines over one variant — routine in a salon. Capturing
    // the variant row once per LINE would snapshot the already-decremented
    // value on the second pass and restore short by one unit.
    const { transport, state, shiftId } = await transportWithStockAndShift(SEEDED_STOCK);
    const twoLinesOneVariant = [
      { ...CASH_ITEMS[0], id: 'line-1', staff_id: 's1', staff_name: 'Ala' },
      { ...CASH_ITEMS[0], id: 'line-2', staff_id: 's2', staff_name: 'Beata' },
    ];

    state.failSaves = 1;
    const result = await transport.createOrder!(
      { ...CASH_ORDER(shiftId), subtotal: 9800, total: 9800 },
      twoLinesOneVariant,
    );

    expect(result.success).toBe(false);
    expect((await transport.getProductById!('p1')) as any).toMatchObject({
      in_stock: SEEDED_STOCK,       // both units back, not SEEDED_STOCK - 1
      available_qty: SEEDED_STOCK,
    });
  });

  test('happy path unchanged: flush succeeds → {success:true, id} and the order is readable', async () => {
    const { transport, shiftId } = await transportWithStockAndShift(SEEDED_STOCK);

    const result = await transport.createOrder!(CASH_ORDER(shiftId), CASH_ITEMS);

    expect(result).toMatchObject({ success: true, id: 'local-order-1' });
    expect(await transport.getOrderDetail!('local-order-1')).not.toBeNull();
    expect((await transport.getProductById!('p1')) as any).toMatchObject({
      in_stock: SEEDED_STOCK - 1,
      available_qty: SEEDED_STOCK - 1,
    });
  });
});
