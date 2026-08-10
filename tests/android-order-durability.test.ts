import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore, type TokenStoreStorage } from '../src/renderer/android-pos/shim/token-store';
import { initAndroidDb, type AndroidDbInitOptions } from '../src/renderer/android-pos/shim/db/db';
import { ShimPosStore } from '../src/renderer/android-pos/shim/pos-store';
import { createHoldOrderRepo } from '../src/renderer/android-pos/shim/db/hold-repo';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { createBilliardHandoffRepo } from '../src/renderer/android-pos/shim/db/billiard-handoff-repo';
import { createBilliardHandoff } from '../src/renderer/android-pos/shim/billiard-handoff';
import { createRestoredCartHandoff } from '../src/renderer/android-pos/shim/restored-cart-handoff';
import {
  buildBilliardInterruptionHoldPayload,
  capturePosCheckoutSnapshot,
  withRestoredInterruptionMarker,
} from '../src/shared/pos/billiard-pos-handoff';

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

async function restoredCreateFixture(
  existingOrder = false,
  tenderState: 'READY' | 'TENDER_COMMITTING' = 'TENDER_COMMITTING',
) {
  let image: Uint8Array | null = null;
  const persistenceState = { failSaves: 0 };
  const persistence = {
    loadImage: async () => image ? new Uint8Array(image) : null,
    saveImage: async (next: Uint8Array) => {
      if (persistenceState.failSaves > 0) {
        persistenceState.failSaves -= 1;
        throw new Error('restored image save failed');
      }
      image = new Uint8Array(next);
    },
    quarantineImage: async () => {},
  };
  const seedDb = await initAndroidDb({ locateFile: NODE_LOCATE_FILE, persistence });
  const posStore = new ShimPosStore();
  seedDb.run(
    'INSERT INTO shifts (id, staff_id, staff_name, opening_cash) VALUES (?, ?, ?, ?)',
    ['restored-shift', 'staff-1', 'Ala Nowak', 0],
  );
  posStore.dispatch({
    type: 'session/open',
    payload: { shiftId: 'restored-shift', staffId: 'staff-1', staffName: 'Ala Nowak', openedAt: 'now' },
  });
  posStore.dispatch({
    type: 'cart/addItem',
    payload: {
      id: 'restored-line', variantId: 'p-restored', name: 'Protected item', sku: 'REST-1',
      price: 2400, quantity: 1, total: 2400, vatRate: 23,
    },
  });
  const scope = { salonId: 'salon-1', userId: 'staff-1', registerId: 'register-1' };
  const snapshot = capturePosCheckoutSnapshot(posStore.getState(), scope, 'retail');
  const journal = {
    orderId: 'restored-order-1',
    clientAttemptId: 'restored:restored-order-1',
    state: tenderState,
    updatedAt: '2026-08-09T12:00:00.000Z',
  };
  const payload = {
    ...buildBilliardInterruptionHoldPayload({
      snapshot,
      checkoutId: 'checkout-restored-1',
      sessionId: 'billiard-session-1',
    }),
    restoreState: 'ACTIVE_CART_BACKUP' as const,
    restoredCheckout: journal,
  };
  createHoldOrderRepo(seedDb).upsert('protected-restored-1', 'Interrupted cart', payload);
  const order = {
    id: journal.orderId,
    client_attempt_id: journal.clientAttemptId,
    order_number: null,
    number_series: 'ORDER',
    status: 'COMPLETED',
    subtotal: posStore.getState().cart.subtotal,
    discount: posStore.getState().cart.discount,
    tax: posStore.getState().cart.tax,
    total: posStore.getState().cart.total,
    payment_method: 'CASH',
    payment_amount: posStore.getState().cart.total,
    change_amount: 0,
    shift_id: 'restored-shift',
    staff_id: 'staff-1',
    staff_name: 'Ala Nowak',
    source: 'POS',
    mode: 'retail',
    synced: 0,
  };
  const items = [{
    id: 'restored-paid-line', order_id: journal.orderId, variant_id: 'p-restored',
    name: 'Protected item', sku: 'REST-1', price: 2400, quantity: 1,
    total: 2400, vat_rate: 23,
  }];
  if (existingOrder) createOrderRepo(seedDb).create(order, items);
  await seedDb.flush();

  const configStore = new ShimConfigStore({
    storage: memoryStorage(),
    seed: {
      salonId: scope.salonId,
      registerCode: scope.registerId,
      posMode: 'retail',
      authUser: { ...LOGIN_BODY.user, id: scope.userId, salonId: scope.salonId },
    } as any,
  });
  const transport = createRealTransport({
    configStore,
    tokenStore: new TokenStore({ storage: memoryStorage() }),
    dbInit: { locateFile: NODE_LOCATE_FILE, persistence },
    agentConnection: {
      connect: async () => ({ connected: false, reason: 'no-key' as const }),
      disconnect: async () => {},
      isConnected: () => false,
      getPushedJobStatus: () => null,
      onJobStatus: () => () => {},
    },
  });
  const liveStore = new ShimPosStore();
  liveStore.dispatch({
    type: 'state/replaceCheckoutSnapshot',
    payload: { snapshot: withRestoredInterruptionMarker(snapshot, 'protected-restored-1', 'checkout-restored-1', journal) },
  });
  transport.attachPosStore!(liveStore);
  return { transport, liveStore, persistence, persistenceState, configStore, order, items };
}

function billiardBundle() {
  return {
    schemaVersion: 1,
    sessionId: 'billiard-session-order',
    checkoutId: 'billiard-checkout-order',
    discountGrosze: 3300,
    totalGrosze: 17000,
    lines: [
      {
        lineKey: 'time-1', kind: 'TIME', variantId: 'billiard-service', displayName: 'Playing time',
        quantity: 1, sellBy: 'PIECE', saleUnit: 'min', unitPriceGrosze: 12300,
        grossTotalGrosze: 12300, allocatedDiscountGrosze: 2300, payableGrosze: 10000,
        vatRate: 23, durationMinutes: 60, inventoryPolicy: 'NONE', refundPolicy: 'FORBIDDEN',
      },
      {
        lineKey: 'fnb-1', kind: 'FNB', sessionItemId: 'session-item-1', variantId: 'cola-variant', displayName: 'Cola',
        quantity: 1, sellBy: 'PIECE', saleUnit: 'szt', unitPriceGrosze: 8000,
        grossTotalGrosze: 8000, allocatedDiscountGrosze: 1000, payableGrosze: 7000,
        vatRate: 8, inventoryPolicy: 'ALREADY_CONSUMED', refundPolicy: 'ALLOWED_NO_RESTOCK',
      },
    ],
  };
}

async function billiardCreateFixture() {
  let image: Uint8Array | null = null;
  const persistenceState = { failSaves: 0 };
  const persistence = {
    loadImage: async () => image ? new Uint8Array(image) : null,
    saveImage: async (next: Uint8Array) => {
      if (persistenceState.failSaves > 0) {
        persistenceState.failSaves -= 1;
        throw new Error('billiard image save failed');
      }
      image = new Uint8Array(next);
    },
    quarantineImage: async () => {},
  };
  const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE, persistence });
  database.run(
    'INSERT INTO shifts (id, staff_id, staff_name, opening_cash) VALUES (?, ?, ?, ?)',
    ['billiard-shift', 'staff-1', 'Ala Nowak', 0],
  );
  const configStore = new ShimConfigStore({
    storage: memoryStorage(),
    seed: {
      salonId: 'salon-1',
      registerCode: 'register-1',
      agentId: 'register-1',
      posMode: 'retail',
      authUser: { ...LOGIN_BODY.user, id: 'staff-1', salonId: 'salon-1' },
    } as any,
  });
  const liveStore = new ShimPosStore();
  liveStore.dispatch({
    type: 'session/open',
    payload: { shiftId: 'billiard-shift', staffId: 'staff-1', staffName: 'Ala Nowak', openedAt: 'now' },
  });
  const seedHandoff = createBilliardHandoff({
    configStore,
    posStore: liveStore,
    db: async () => database,
    isFiscalPrinterAssigned: async () => false,
    isPrintAgentConnected: () => false,
  });
  await expect(seedHandoff.prepare({ posCheckout: billiardBundle() })).resolves.toMatchObject({ success: true });
  const opened = await seedHandoff.markPaymentOpened('billiard-checkout-order');
  await expect(seedHandoff.beginTender('billiard-checkout-order', opened.token!))
    .resolves.toMatchObject({ success: true });
  const record = createBilliardHandoffRepo(database).get('billiard-checkout-order')!;
  const bundle = billiardBundle();
  const order = {
    id: record.orderId,
    order_number: null,
    number_series: 'ORDER',
    status: 'COMPLETED',
    subtotal: bundle.lines.reduce((sum, line) => sum + line.grossTotalGrosze, 0),
    discount: bundle.discountGrosze,
    tax: liveStore.getState().cart.tax,
    total: bundle.totalGrosze,
    payment_method: 'CASH',
    payment_amount: bundle.totalGrosze,
    change_amount: 0,
    shift_id: 'billiard-shift',
    staff_id: 'staff-1',
    staff_name: 'Ala Nowak',
    source: 'POS',
    mode: 'retail',
    synced: 0,
    client_attempt_id: record.clientAttemptId,
    billiard_origin_json: JSON.stringify({
      type: 'BILLIARD_SESSION',
      sessionId: record.sessionId,
      checkoutId: record.checkoutId,
      snapshotVersion: bundle.schemaVersion,
    }),
  };
  const items = bundle.lines.map((line: any) => ({
    id: `${record.orderId}:${line.lineKey}`,
    order_id: record.orderId,
    variant_id: line.variantId,
    name: line.displayName,
    sku: line.sku ?? '',
    price: line.unitPriceGrosze,
    quantity: line.quantity,
    sale_quantity: line.quantity,
    sale_unit: line.saleUnit,
    sell_by: line.sellBy,
    total: line.grossTotalGrosze,
    vat_rate: line.vatRate,
    billiard_json: JSON.stringify({
      kind: line.kind, sessionItemId: line.sessionItemId, lineKey: line.lineKey,
      durationMinutes: line.durationMinutes, displayName: line.displayName,
      inventoryPolicy: line.inventoryPolicy, refundPolicy: line.refundPolicy,
      sellBy: line.sellBy, saleUnit: line.saleUnit,
      grossTotalGrosze: line.grossTotalGrosze,
      allocatedDiscountGrosze: line.allocatedDiscountGrosze,
      payableGrosze: line.payableGrosze,
    }),
    inventory_policy: line.inventoryPolicy,
    refund_policy: line.refundPolicy,
    allocated_discount: line.allocatedDiscountGrosze,
    payable_total: line.payableGrosze,
  }));
  await database.flush();

  const transport = createRealTransport({
    configStore,
    tokenStore: new TokenStore({ storage: memoryStorage() }),
    dbInit: { locateFile: NODE_LOCATE_FILE, persistence },
    agentConnection: {
      connect: async () => ({ connected: false, reason: 'no-key' as const }),
      disconnect: async () => {},
      isConnected: () => false,
      getPushedJobStatus: () => null,
      onJobStatus: () => () => {},
    },
  });
  transport.attachPosStore!(liveStore);
  return { transport, liveStore, persistence, persistenceState, configStore, order, items };
}

describe('createOrder durability (B3)', () => {
  test.each([
    ['invalid tender', (h: Awaited<ReturnType<typeof billiardCreateFixture>>) => [
      { ...h.order, payment_method: 'BITCOIN' },
      h.items,
    ]],
    ['shift switch', (h: Awaited<ReturnType<typeof billiardCreateFixture>>) => [
      { ...h.order, shift_id: 'different-shift' },
      h.items,
    ]],
    ['normalization throw', (h: Awaited<ReturnType<typeof billiardCreateFixture>>) => [
      h.order,
      {} as any,
    ]],
  ] as const)(
    'post-Billiard-COMMITTING %s becomes durable UNCERTAIN and OWNER can resolve immediately',
    async (_label, request) => {
      const h = await billiardCreateFixture();
      const [order, items] = request(h);
      await expect(h.transport.createOrder!(order, items as any)).resolves.toMatchObject({
        success: false,
        outcomeUncertain: true,
        orderId: h.order.id,
      });
      const reopened = await initAndroidDb({ locateFile: NODE_LOCATE_FILE, persistence: h.persistence });
      expect(createBilliardHandoffRepo(reopened).get('billiard-checkout-order')?.state)
        .toBe('POS_TENDER_UNCERTAIN');

      h.configStore.setConfig({
        authUser: { ...(h.configStore.getRawConfig().authUser as any), role: 'OWNER' },
      } as any);
      await expect(h.transport.billiardResolveUncertainTender!({
        target: { type: 'BILLIARD', checkoutId: 'billiard-checkout-order' },
        reason: 'Terminal checked; no payment was collected',
        confirmedNoPaymentRemains: true,
      })).resolves.toMatchObject({ success: true, resolved: true, targetType: 'BILLIARD' });
    },
  );

  test('Billiard order flush failure becomes UNCERTAIN instead of ordinary rollback/retry', async () => {
    const h = await billiardCreateFixture();
    h.persistenceState.failSaves = 1;
    await expect(h.transport.createOrder!(h.order, h.items)).resolves.toMatchObject({
      success: false,
      outcomeUncertain: true,
      orderId: h.order.id,
    });
    const reopened = await initAndroidDb({ locateFile: NODE_LOCATE_FILE, persistence: h.persistence });
    expect(createBilliardHandoffRepo(reopened).get('billiard-checkout-order')?.state)
      .toBe('POS_TENDER_UNCERTAIN');
    expect(createOrderRepo(reopened).getById(h.order.id)).not.toBeNull();
  });

  test('cross-salon Billiard create preserves recovery-required without synthetic reconciliation', async () => {
    const h = await billiardCreateFixture();
    h.configStore.setConfig({ salonId: 'different-salon' } as any);
    const result = await h.transport.createOrder!(
      { ...h.order, payment_method: 'BITCOIN' },
      h.items,
    );
    expect(result).toMatchObject({
      success: false,
      protectedInterruptionRecoveryRequired: { checkoutId: 'billiard-checkout-order' },
    });
    expect(result.outcomeUncertain).toBeUndefined();
    expect(result.restoredCartReconciliation).toBeUndefined();
    const reopened = await initAndroidDb({ locateFile: NODE_LOCATE_FILE, persistence: h.persistence });
    expect(createBilliardHandoffRepo(reopened).get('billiard-checkout-order')?.state)
      .toBe('POS_TENDER_COMMITTING');
  });

  test('real transport dispatch cannot remove the final READY restored line or rewrite its Hold', async () => {
    const h = await restoredCreateFixture(false, 'READY');
    const beforeImage = new Uint8Array((await h.persistence.loadImage())!);
    await h.transport.posDispatch!({
      type: 'cart/updateQuantity',
      payload: { id: 'restored-line', quantity: 0 },
    });
    expect(h.liveStore.getState().cart.items).toHaveLength(1);
    expect(h.liveStore.getState().cart.items[0].quantity).toBe(1);
    expect(await h.persistence.loadImage()).toEqual(beforeImage);
  });

  test.each([
    ['invalid tender', (h: Awaited<ReturnType<typeof restoredCreateFixture>>) => [
      { ...h.order, payment_method: 'BITCOIN' },
      h.items,
    ]],
    ['shift switch', (h: Awaited<ReturnType<typeof restoredCreateFixture>>) => [
      { ...h.order, shift_id: 'closed-or-other-shift' },
      h.items,
    ]],
    ['normalization throw', (h: Awaited<ReturnType<typeof restoredCreateFixture>>) => [
      h.order,
      {} as any,
    ]],
  ] as const)(
    'post-COMMITTING %s becomes durable UNCERTAIN and OWNER can resolve without restart',
    async (_label, request) => {
      const h = await restoredCreateFixture();
      const [order, items] = request(h);
      const result = await h.transport.createOrder!(order, items as any);
      expect(result).toMatchObject({
        success: false,
        outcomeUncertain: true,
        restoredCartReconciliation: { holdId: 'protected-restored-1' },
      });
      expect(h.liveStore.getState().checkoutDraft.restoredInterruption).toMatchObject({
        tenderState: 'TENDER_UNCERTAIN',
        persistenceError: expect.any(String),
      });
      const reopened = await initAndroidDb({ locateFile: NODE_LOCATE_FILE, persistence: h.persistence });
      expect(createHoldOrderRepo(reopened).get('protected-restored-1')?.payload.restoredCheckout.state)
        .toBe('TENDER_UNCERTAIN');

      h.configStore.setConfig({
        authUser: { ...(h.configStore.getRawConfig().authUser as any), role: 'OWNER' },
      } as any);
      await expect(h.transport.billiardResolveUncertainTender!({
        target: { type: 'RESTORED_CART', holdId: 'protected-restored-1' },
        reason: 'Terminal checked; no payment was collected',
        confirmedNoPaymentRemains: true,
      })).resolves.toMatchObject({ success: true, resolved: true });
      expect(h.liveStore.getState().checkoutDraft.restoredInterruption).toMatchObject({
        tenderState: 'READY',
      });
      expect(h.liveStore.getState().checkoutDraft.restoredInterruption?.persistenceError).toBeUndefined();
    },
  );

  test('cross-register restored create preserves recovery-required without synthetic reconciliation', async () => {
    const h = await restoredCreateFixture();
    h.configStore.setConfig({ registerCode: 'different-register' } as any);
    const result = await h.transport.createOrder!(
      { ...h.order, payment_method: 'BITCOIN' },
      h.items,
    );
    expect(result).toMatchObject({
      success: false,
      protectedInterruptionRecoveryRequired: { holdId: 'protected-restored-1' },
    });
    expect(result.outcomeUncertain).toBeUndefined();
    expect(result.restoredCartReconciliation).toBeUndefined();
    const reopened = await initAndroidDb({ locateFile: NODE_LOCATE_FILE, persistence: h.persistence });
    expect(createHoldOrderRepo(reopened).get('protected-restored-1')?.payload.restoredCheckout.state)
      .toBe('TENDER_COMMITTING');
  });

  test('restored order and PAID_TOMBSTONE cross one barrier before live clear is unlocked', async () => {
    const h = await restoredCreateFixture();
    const result = await h.transport.createOrder!(h.order, h.items);
    expect(result).toMatchObject({
      success: true,
      id: 'restored-order-1',
      paymentCommitted: true,
    });
    expect(h.liveStore.getState().checkoutDraft.restoredInterruption?.tenderState).toBe('PAID_TOMBSTONE');
    // The transport authorises but does not clear: PaymentModal owns that last
    // renderer step, and the reducer now permits it only after the tombstone.
    expect(h.liveStore.getState().cart.items).toHaveLength(1);
    h.liveStore.dispatch({ type: 'cart/completeCheckout' });
    expect(h.liveStore.getState().cart.items).toHaveLength(0);

    const reopened = await initAndroidDb({ locateFile: NODE_LOCATE_FILE, persistence: h.persistence });
    expect(createOrderRepo(reopened).getById('restored-order-1')).not.toBeNull();
    expect(createHoldOrderRepo(reopened).get('protected-restored-1')?.payload).toMatchObject({
      restoreState: 'PAID_TOMBSTONE',
      restoredCheckout: { state: 'PAID_TOMBSTONE' },
    });
  });

  test('restored order flush failure stays non-clearable; boot tombstones but requires the exact live owner before clear', async () => {
    const h = await restoredCreateFixture();
    h.persistenceState.failSaves = 1;
    await expect(h.transport.createOrder!(h.order, h.items)).resolves.toMatchObject({
      success: false,
      outcomeUncertain: true,
      restoredCartReconciliation: { holdId: 'protected-restored-1' },
    });
    expect(h.liveStore.getState().checkoutDraft.restoredInterruption).toMatchObject({
      tenderState: 'TENDER_UNCERTAIN',
      persistenceError: expect.any(String),
    });
    h.liveStore.dispatch({ type: 'cart/completeCheckout' });
    expect(h.liveStore.getState().cart.items).toHaveLength(1);

    const rebootDb = await initAndroidDb({ locateFile: NODE_LOCATE_FILE, persistence: h.persistence });
    const rebootStore = new ShimPosStore();
    rebootStore.dispatch({
      type: 'session/open',
      payload: { shiftId: 'restored-shift', staffId: 'staff-1', staffName: 'Ala Nowak', openedAt: 'now' },
    });
    const rebootOwner = createRestoredCartHandoff({
      configStore: h.configStore,
      posStore: rebootStore,
      db: async () => rebootDb,
    });
    await expect(rebootOwner.recover()).resolves.toMatchObject({
      success: false,
      restoredCart: false,
      paymentCommitted: true,
      orderId: 'restored-order-1',
      protectedInterruptionRecoveryRequired: { holdId: 'protected-restored-1' },
    });
    expect(rebootStore.getState().cart.items).toHaveLength(0);
    expect(createHoldOrderRepo(rebootDb).get('protected-restored-1')?.payload).toMatchObject({
      restoreState: 'PAID_TOMBSTONE',
      restoredCheckout: { state: 'PAID_TOMBSTONE' },
    });
  });

  test('duplicate restored create verifies the exact order and only then tombstones it', async () => {
    const h = await restoredCreateFixture(true);
    await expect(h.transport.createOrder!(h.order, h.items)).resolves.toMatchObject({
      success: true,
      id: 'restored-order-1',
      duplicate: true,
      paymentCommitted: true,
    });
    const reopened = await initAndroidDb({ locateFile: NODE_LOCATE_FILE, persistence: h.persistence });
    expect(reopened.get<{ n: number }>('SELECT COUNT(*) AS n FROM orders WHERE id = ?', ['restored-order-1'])?.n).toBe(1);
    expect(createHoldOrderRepo(reopened).get('protected-restored-1')?.payload.restoredCheckout.state)
      .toBe('PAID_TOMBSTONE');
  });

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
