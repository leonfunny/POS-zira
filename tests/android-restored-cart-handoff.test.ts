import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  buildBilliardInterruptionHoldPayload,
  capturePosCheckoutSnapshot,
  withRestoredInterruptionMarker,
} from '../src/shared/pos/billiard-pos-handoff';
import type { PosHoldPayload, RestoredCartCheckoutJournal } from '../src/shared/billiard-pos-handoff';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { createHoldOrderRepo } from '../src/renderer/android-pos/shim/db/hold-repo';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { ShimPosStore } from '../src/renderer/android-pos/shim/pos-store';
import { createRestoredCartHandoff } from '../src/renderer/android-pos/shim/restored-cart-handoff';
import { createHoldOrders } from '../src/renderer/android-pos/shim/hold-orders';

const NODE_LOCATE_FILE = null;
const scope = { salonId: 'salon-1', userId: 'user-1', registerId: 'register-1' };

function mapStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

function line(id = 'line-1') {
  return {
    id,
    variantId: 'variant-1',
    name: 'Ordinary item',
    sku: 'SKU-1',
    price: 1200,
    quantity: 2,
    total: 2400,
    vatRate: 23,
  };
}

interface Harness {
  database: AndroidDatabase;
  configStore: ShimConfigStore;
  posStore: ShimPosStore;
  restored: ReturnType<typeof createRestoredCartHandoff>;
  holdId: string;
  checkoutId: string;
  journal: RestoredCartCheckoutJournal;
}

async function harness(options: { role?: string; activate?: boolean } = {}): Promise<Harness> {
  const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
  const configStore = new ShimConfigStore({
    storage: mapStorage(),
    seed: {
      salonId: scope.salonId,
      registerCode: scope.registerId,
      posMode: 'retail',
      authUser: {
        id: scope.userId,
        email: 'cashier@example.test',
        firstName: 'Cashier',
        lastName: 'One',
        role: options.role ?? 'STAFF',
        salonId: scope.salonId,
      },
    } as any,
  });
  const posStore = new ShimPosStore();
  database.run(
    'INSERT INTO shifts (id, staff_id, staff_name, opening_cash) VALUES (?, ?, ?, ?)',
    ['shift-1', scope.userId, 'Cashier One', 0],
  );
  posStore.dispatch({
    type: 'session/open',
    payload: {
      shiftId: 'shift-1',
      staffId: scope.userId,
      staffName: 'Cashier One',
      openedAt: '2026-08-09T08:00:00.000Z',
    },
  });
  posStore.dispatch({ type: 'cart/addItem', payload: line() as any });
  const snapshot = capturePosCheckoutSnapshot(posStore.getState(), scope, 'retail');
  const holdId = 'protected-hold-1';
  const checkoutId = 'billiard-checkout-1';
  const journal: RestoredCartCheckoutJournal = {
    orderId: 'restored-order-1',
    clientAttemptId: 'restored:restored-order-1',
    state: 'READY',
    updatedAt: '2026-08-09T08:05:00.000Z',
  };
  const payload: PosHoldPayload = {
    ...buildBilliardInterruptionHoldPayload({
      snapshot,
      checkoutId,
      sessionId: 'billiard-session-1',
    }),
    restoreState: 'ACTIVE_CART_BACKUP',
    restoredCheckout: journal,
  };
  createHoldOrderRepo(database).upsert(holdId, 'Interrupted cart', payload);
  if (options.activate !== false) {
    posStore.dispatch({
      type: 'state/replaceCheckoutSnapshot',
      payload: { snapshot: withRestoredInterruptionMarker(snapshot, holdId, checkoutId, journal) },
    });
  } else {
    posStore.dispatch({ type: 'cart/clear' });
  }
  await database.flush();
  const restored = createRestoredCartHandoff({
    configStore,
    posStore,
    db: async () => database,
  });
  return { database, configStore, posStore, restored, holdId, checkoutId, journal };
}

function registerPreflight(h: Harness, token = 'preflight-1') {
  h.restored.registerPaymentPreflight({
    token,
    orderId: h.journal.orderId,
    shiftId: 'shift-1',
    expiresAt: Date.now() + 60_000,
  });
}

function seedExistingRestoredOrder(h: Harness, clientAttemptId: string) {
  const cart = createHoldOrderRepo(h.database).get(h.holdId)!.payload.snapshot.state.cart;
  createOrderRepo(h.database).create({
    id: h.journal.orderId,
    order_number: 'ZAM-1',
    status: 'COMPLETED',
    subtotal: cart.subtotal,
    discount: cart.discount,
    tax: cart.tax,
    total: cart.total,
    client_attempt_id: clientAttemptId,
  }, cart.items.map((item: any, index: number) => ({
    id: `paid-line-${index}`,
    order_id: h.journal.orderId,
    variant_id: item.variantId,
    name: item.name,
    sku: item.sku,
    price: item.price,
    quantity: item.quantity,
    total: item.total,
    vat_rate: item.vatRate,
  })));
}

describe('restored-cart tender boundary', () => {
  test('READY becomes durably TENDER_COMMITTING before success; duplicate begin cannot authorize twice', async () => {
    const h = await harness();
    registerPreflight(h);

    await expect(h.restored.beginTender(h.holdId, 'preflight-1')).resolves.toEqual({ success: true });
    expect(createHoldOrderRepo(h.database).get(h.holdId)?.payload.restoredCheckout.state)
      .toBe('TENDER_COMMITTING');

    const duplicate = await h.restored.beginTender(h.holdId, 'preflight-1');
    expect(duplicate).toMatchObject({ success: false, outcomeUncertain: true });
  });

  test('wrong hold/token/identity, auth switch, shift switch and snapshot drift all fail closed', async () => {
    const wrongHold = await harness();
    registerPreflight(wrongHold);
    await expect(wrongHold.restored.beginTender('other-hold', 'preflight-1'))
      .resolves.toMatchObject({ success: false });
    await expect(wrongHold.restored.beginTender(wrongHold.holdId, 'wrong-token'))
      .resolves.toMatchObject({ success: false });

    const wrongIdentity = await harness();
    registerPreflight(wrongIdentity);
    const wrongIdentitySnapshot = capturePosCheckoutSnapshot(
      wrongIdentity.posStore.getState(),
      scope,
      'retail',
    );
    wrongIdentity.posStore.dispatch({
      type: 'state/replaceCheckoutSnapshot',
      payload: {
        snapshot: withRestoredInterruptionMarker(
          wrongIdentitySnapshot,
          wrongIdentity.holdId,
          wrongIdentity.checkoutId,
          {
            ...wrongIdentity.journal,
            clientAttemptId: 'restored:other',
          },
        ),
      },
    });
    await expect(wrongIdentity.restored.beginTender(wrongIdentity.holdId, 'preflight-1'))
      .resolves.toMatchObject({ success: false });

    const authChanged = await harness();
    registerPreflight(authChanged);
    authChanged.restored.invalidateAuth();
    await expect(authChanged.restored.beginTender(authChanged.holdId, 'preflight-1'))
      .resolves.toMatchObject({ success: false });

    const shiftChanged = await harness();
    registerPreflight(shiftChanged);
    shiftChanged.database.run("UPDATE shifts SET closed_at = datetime('now') WHERE id = ?", ['shift-1']);
    shiftChanged.database.run(
      'INSERT INTO shifts (id, staff_id, staff_name, opening_cash) VALUES (?, ?, ?, ?)',
      ['shift-2', scope.userId, 'Cashier One', 0],
    );
    shiftChanged.posStore.dispatch({
      type: 'session/open',
      payload: { shiftId: 'shift-2', staffId: scope.userId, staffName: 'Cashier One' },
    });
    await expect(shiftChanged.restored.beginTender(shiftChanged.holdId, 'preflight-1'))
      .resolves.toMatchObject({ success: false });

    const drifted = await harness();
    registerPreflight(drifted);
    drifted.posStore.dispatch({ type: 'cart/addItem', payload: line('line-2') as any });
    await expect(drifted.restored.beginTender(drifted.holdId, 'preflight-1'))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/exactly match/i) });
  });

  test('flush failure rolls back only before release; failed rollback becomes uncertain', async () => {
    const safe = await harness();
    registerPreflight(safe);
    const realSafeFlush = safe.database.flush.bind(safe.database);
    let safeCalls = 0;
    (safe.database as any).flush = vi.fn(async () => {
      safeCalls += 1;
      if (safeCalls === 1) throw new Error('disk full');
      return realSafeFlush();
    });
    const safeResult = await safe.restored.beginTender(safe.holdId, 'preflight-1');
    expect(safeResult).toMatchObject({ success: false });
    expect(safeResult.outcomeUncertain).not.toBe(true);
    expect(createHoldOrderRepo(safe.database).get(safe.holdId)?.payload.restoredCheckout.state).toBe('READY');

    const failedRollback = await harness();
    registerPreflight(failedRollback);
    (failedRollback.database as any).flush = vi.fn(async () => { throw new Error('disk full'); });
    await expect(failedRollback.restored.beginTender(failedRollback.holdId, 'preflight-1'))
      .resolves.toMatchObject({ success: false, outcomeUncertain: true });
    expect(createHoldOrderRepo(failedRollback.database).get(failedRollback.holdId)?.payload.restoredCheckout.state)
      .toBe('TENDER_UNCERTAIN');
  });

  test('cashier logout then same-register OWNER relogin locks and resolves the real COMMITTING journal', async () => {
    const h = await harness();
    registerPreflight(h);
    await expect(h.restored.beginTender(h.holdId, 'preflight-1')).resolves.toEqual({ success: true });
    h.restored.invalidateAuth();
    h.configStore.setConfig({
      authUser: { ...(h.configStore.getRawConfig().authUser as any), id: 'owner-2', role: 'OWNER' },
    } as any);

    await expect(h.restored.classifyActiveCommittingFailure(h.database, 'checkout validation failed'))
      .resolves.toMatchObject({ success: false, outcomeUncertain: true });
    expect(createHoldOrderRepo(h.database).get(h.holdId)?.payload.restoredCheckout.state)
      .toBe('TENDER_UNCERTAIN');
    await expect(h.restored.resolveUncertainTender({
      target: { type: 'RESTORED_CART', holdId: h.holdId },
      reason: 'Owner checked terminal; no payment remains',
      confirmedNoPaymentRemains: true,
    })).resolves.toMatchObject({ success: true, resolved: true });
  });

  test('cart drift after begin still durably locks the real restored journal uncertain', async () => {
    const h = await harness();
    registerPreflight(h);
    await h.restored.beginTender(h.holdId, 'preflight-1');
    const drifted = capturePosCheckoutSnapshot(h.posStore.getState(), scope, 'retail');
    (drifted.state as any).cart.items.push({
      ...line('drifted-line'),
      variantId: 'drifted-variant',
      name: 'Unexpected live line',
    });
    h.posStore.dispatch({ type: 'state/replaceCheckoutSnapshot', payload: { snapshot: drifted } });

    await expect(h.restored.classifyActiveCommittingFailure(h.database, 'cart drifted'))
      .resolves.toMatchObject({ success: false, outcomeUncertain: true });
    expect(createHoldOrderRepo(h.database).get(h.holdId)?.payload.restoredCheckout.state)
      .toBe('TENDER_UNCERTAIN');
    expect(h.posStore.getState().cart.items).toHaveLength(2);
    expect(h.posStore.getState().checkoutDraft.restoredInterruption?.tenderState)
      .toBe('TENDER_UNCERTAIN');

    h.configStore.setConfig({
      authUser: { ...(h.configStore.getRawConfig().authUser as any), role: 'OWNER' },
    } as any);
    const driftedLiveBeforeResolution = JSON.stringify(h.posStore.getState());
    await expect(h.restored.resolveUncertainTender({
      target: { type: 'RESTORED_CART', holdId: h.holdId },
      reason: 'Owner verified that no payment remains',
      confirmedNoPaymentRemains: true,
    })).resolves.toMatchObject({ success: true, resolved: true });
    expect(createHoldOrderRepo(h.database).get(h.holdId)?.payload.restoredCheckout.state)
      .toBe('READY');
    expect(JSON.stringify(h.posStore.getState())).toBe(driftedLiveBeforeResolution);
  });

  test.each(['salon', 'register'] as const)(
    'cross-%s restored classifier does not mutate and returns recovery-required',
    async (boundary) => {
      const h = await harness();
      registerPreflight(h);
      await h.restored.beginTender(h.holdId, 'preflight-1');
      const before = JSON.stringify(createHoldOrderRepo(h.database).get(h.holdId)?.payload);
      if (boundary === 'salon') h.configStore.setConfig({ salonId: 'salon-other' } as any);
      if (boundary === 'register') h.configStore.setConfig({ registerCode: 'register-other' } as any);

      const result = await h.restored.classifyActiveCommittingFailure(h.database, 'scope drift');
      expect(result).toMatchObject({
        success: false,
        protectedInterruptionRecoveryRequired: { holdId: h.holdId },
      });
      expect(result?.outcomeUncertain).toBeUndefined();
      expect(result?.restoredCartReconciliation).toBeUndefined();
      expect(JSON.stringify(createHoldOrderRepo(h.database).get(h.holdId)?.payload)).toBe(before);
    },
  );
});

describe('restored-cart crash recovery and owner resolution', () => {
  test('Billiard completion stages the exact protected owner before activating its live cart', async () => {
    const h = await harness({ activate: false });
    const staged = h.restored.stageAfterBilliardCommit(h.database, {
      checkoutId: h.checkoutId,
      sessionId: 'billiard-session-1',
      interruptedHoldId: h.holdId,
    } as any, scope);
    expect(staged).toMatchObject({ checkoutId: h.checkoutId, held: { id: h.holdId } });
    expect(h.posStore.getState().cart.items).toHaveLength(0);

    await h.database.flush();
    expect(h.restored.activateStaged(staged)).toBe(true);
    expect(h.posStore.getState().cart.items).toHaveLength(1);
    expect(h.posStore.getState().checkoutDraft.restoredInterruption).toMatchObject({
      holdId: h.holdId,
      orderId: h.journal.orderId,
      tenderState: 'READY',
    });
  });

  test('kill after COMMITTING deterministically enters reconciliation and never restores Pay', async () => {
    const h = await harness({ activate: false });
    const repo = createHoldOrderRepo(h.database);
    const held = repo.get(h.holdId)!;
    repo.replaceProtected(held.id, held.title, {
      ...held.payload,
      restoredCheckout: { ...held.payload.restoredCheckout, state: 'TENDER_COMMITTING' },
    });
    await h.database.flush();

    const result = await h.restored.recover();
    expect(result).toMatchObject({
      success: true,
      restoredCart: false,
      restoredCartReconciliation: {
        holdId: h.holdId,
        orderId: h.journal.orderId,
      },
    });
    expect(repo.get(h.holdId)?.payload.restoredCheckout.state).toBe('TENDER_UNCERTAIN');
    expect(h.posStore.getState().cart.items).toHaveLength(0);
  });

  test('READY restores the exact protected snapshot and beats an empty ordinary store', async () => {
    const h = await harness({ activate: false });
    const result = await h.restored.recover();
    expect(result).toMatchObject({ success: true, restoredCart: true });
    expect(h.posStore.getState().cart.items).toHaveLength(1);
    expect(h.posStore.getState().checkoutDraft.restoredInterruption).toMatchObject({
      holdId: h.holdId,
      orderId: h.journal.orderId,
      tenderState: 'READY',
    });
  });

  test('an exact pre-existing local order is tombstoned; a conflicting identity is recovery-required', async () => {
    const paid = await harness();
    seedExistingRestoredOrder(paid, paid.journal.clientAttemptId);
    await paid.database.flush();
    await expect(paid.restored.recover()).resolves.toMatchObject({
      success: true,
      paymentCommitted: true,
      restoredCart: false,
    });
    expect(createHoldOrderRepo(paid.database).get(paid.holdId)?.payload).toMatchObject({
      restoreState: 'PAID_TOMBSTONE',
      restoredCheckout: { state: 'PAID_TOMBSTONE' },
    });

    const conflict = await harness({ activate: false });
    seedExistingRestoredOrder(conflict, 'restored:wrong');
    await conflict.database.flush();
    await expect(conflict.restored.recover()).resolves.toMatchObject({
      success: false,
      protectedInterruptionRecoveryRequired: { holdId: conflict.holdId },
    });
  });

  test('paid-order recovery never clears an unrelated ordinary live cart', async () => {
    const h = await harness({ activate: false });
    seedExistingRestoredOrder(h, h.journal.clientAttemptId);
    await h.database.flush();
    h.posStore.dispatch({
      type: 'cart/addItem',
      payload: {
        ...line('ordinary-live-line'),
        variantId: 'ordinary-live-variant',
        name: 'Walk-in item',
        price: 500,
        quantity: 1,
        total: 500,
      } as any,
    });
    const before = JSON.stringify(h.posStore.getState());

    await expect(h.restored.recover()).resolves.toMatchObject({
      success: false,
      restoredCart: false,
      paymentCommitted: true,
      orderId: h.journal.orderId,
      protectedInterruptionRecoveryRequired: { holdId: h.holdId },
    });
    expect(JSON.stringify(h.posStore.getState())).toBe(before);
    expect(h.posStore.getState().checkoutDraft.restoredInterruption).toBeUndefined();
    expect(createHoldOrderRepo(h.database).get(h.holdId)?.payload).toMatchObject({
      restoreState: 'PAID_TOMBSTONE',
      restoredCheckout: { state: 'PAID_TOMBSTONE' },
    });
  });

  test('paid-order recovery leaves an exact cart untouched when committed-clear authorization races', async () => {
    const h = await harness();
    seedExistingRestoredOrder(h, h.journal.clientAttemptId);
    await h.database.flush();
    const before = JSON.stringify(h.posStore.getState());
    vi.spyOn(h.posStore, 'markRestoredOrderCommitted').mockReturnValue(false);

    await expect(h.restored.recover()).resolves.toMatchObject({
      success: false,
      restoredCart: false,
      paymentCommitted: true,
      protectedInterruptionRecoveryRequired: { holdId: h.holdId },
    });
    expect(JSON.stringify(h.posStore.getState())).toBe(before);
    expect(h.posStore.getState().cart.items).toHaveLength(1);
  });

  test('boot tombstone flush failure remains reconciliation-only until a later verified recovery', async () => {
    const h = await harness({ activate: false });
    seedExistingRestoredOrder(h, h.journal.clientAttemptId);
    await h.database.flush();
    const realFlush = h.database.flush.bind(h.database);
    let calls = 0;
    (h.database as any).flush = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boot tombstone disk failure');
      return realFlush();
    });
    await expect(h.restored.recover()).resolves.toMatchObject({
      success: false,
      restoredCart: false,
      outcomeUncertain: true,
      restoredCartReconciliation: { holdId: h.holdId },
    });
    expect(createHoldOrderRepo(h.database).get(h.holdId)?.payload.restoredCheckout.state)
      .toBe('TENDER_UNCERTAIN');
    expect(h.posStore.getState().cart.items).toHaveLength(0);

    const uncertainHeld = createHoldOrderRepo(h.database).get(h.holdId)!;
    h.posStore.dispatch({
      type: 'state/replaceCheckoutSnapshot',
      payload: {
        snapshot: withRestoredInterruptionMarker(
          uncertainHeld.payload.snapshot,
          h.holdId,
          h.checkoutId,
          uncertainHeld.payload.restoredCheckout!,
        ),
      },
    });

    await expect(h.restored.recover()).resolves.toMatchObject({
      success: true,
      restoredCart: false,
      paymentCommitted: true,
    });
    expect(createHoldOrderRepo(h.database).get(h.holdId)?.payload.restoredCheckout.state)
      .toBe('PAID_TOMBSTONE');
  });

  test('only OWNER can durably resolve an uncertain restored cart to READY with an audit', async () => {
    const staff = await harness();
    const staffRepo = createHoldOrderRepo(staff.database);
    const staffHeld = staffRepo.get(staff.holdId)!;
    staffRepo.replaceProtected(staffHeld.id, staffHeld.title, {
      ...staffHeld.payload,
      restoredCheckout: { ...staffHeld.payload.restoredCheckout, state: 'TENDER_UNCERTAIN' },
    });
    await expect(staff.restored.resolveUncertainTender({
      target: { type: 'RESTORED_CART', holdId: staff.holdId },
      reason: 'Terminal checked',
      confirmedNoPaymentRemains: true,
    })).resolves.toMatchObject({ success: false, code: 'OWNER_REQUIRED' });

    const owner = await harness({ role: 'OWNER' });
    const ownerRepo = createHoldOrderRepo(owner.database);
    const ownerHeld = ownerRepo.get(owner.holdId)!;
    ownerRepo.replaceProtected(ownerHeld.id, ownerHeld.title, {
      ...ownerHeld.payload,
      restoredCheckout: { ...ownerHeld.payload.restoredCheckout, state: 'TENDER_UNCERTAIN' },
    });
    await owner.database.flush();
    await expect(owner.restored.resolveUncertainTender({
      target: { type: 'RESTORED_CART', holdId: owner.holdId },
      reason: 'Terminal checked; no payment remains',
      confirmedNoPaymentRemains: true,
    })).resolves.toMatchObject({ success: true, resolved: true, targetType: 'RESTORED_CART' });
    expect(ownerRepo.get(owner.holdId)?.payload.restoredCheckout).toMatchObject({
      state: 'READY',
      resolutionAudits: [{ ownerUserId: scope.userId, action: 'NO_PAYMENT_REMAINS' }],
    });
  });
});

describe('restored-cart reducer guard', () => {
  test('clear and completeCheckout cannot remove the cart before PAID_TOMBSTONE', async () => {
    const h = await harness();
    const beforeHold = JSON.stringify(createHoldOrderRepo(h.database).get(h.holdId)?.payload);
    h.posStore.dispatch({ type: 'cart/updateQuantity', payload: { id: 'line-1', quantity: 0 } });
    h.posStore.dispatch({ type: 'cart/clear' });
    h.posStore.dispatch({ type: 'cart/completeCheckout' });
    expect(h.posStore.getState().cart.items).toHaveLength(1);

    await h.restored.dispatchPosAction({
      type: 'cart/updateQuantity',
      payload: { id: 'line-1', quantity: 0 },
    });
    expect(h.posStore.getState().cart.items).toHaveLength(1);
    expect(JSON.stringify(createHoldOrderRepo(h.database).get(h.holdId)?.payload)).toBe(beforeHold);

    expect(h.posStore.markRestoredOrderCommitted(
      h.holdId,
      h.journal.orderId,
      h.journal.clientAttemptId,
    )).toBe(true);
    h.posStore.dispatch({ type: 'cart/completeCheckout' });
    expect(h.posStore.getState().cart.items).toHaveLength(0);
  });

  test('re-hold atomically replaces the protected owner before clearing the READY cart', async () => {
    const h = await harness();
    const holds = createHoldOrders({
      configStore: h.configStore,
      posStore: h.posStore,
      db: async () => h.database,
      runRestoredCartExclusive: (work) => h.restored.runExclusive(work),
    });
    await expect(holds.createCurrent('manual-restored-1', 'Customer will return'))
      .resolves.toEqual({ success: true });
    expect(createHoldOrderRepo(h.database).get(h.holdId)).toBeNull();
    expect(createHoldOrderRepo(h.database).get('manual-restored-1')?.payload).toMatchObject({
      protected: false,
      holdReason: 'MANUAL',
    });
    expect(createHoldOrderRepo(h.database).get('manual-restored-1')?.payload.snapshot.state.checkoutDraft.restoredInterruption)
      .toBeUndefined();
    expect(h.posStore.getState().cart.items).toHaveLength(0);
    expect(h.posStore.getState().checkoutDraft.restoredInterruption).toBeUndefined();
  });

  test('re-hold reusing an old prunable id always reserves and preserves its durable manual owner', async () => {
    const h = await harness();
    const repo = createHoldOrderRepo(h.database);
    const protectedRow = repo.get(h.holdId)!;
    const oldTarget = 'manual-old-target';
    const manualPayload = {
      schemaVersion: protectedRow.payload.schemaVersion,
      holdReason: 'MANUAL' as const,
      protected: false,
      snapshot: protectedRow.payload.snapshot,
    };
    repo.upsert(oldTarget, 'Old target', manualPayload);
    h.database.run(
      'UPDATE pos_hold_orders SET created_at = ? WHERE id = ?',
      ['2000-01-01T00:00:00.000Z', oldTarget],
    );
    for (let index = 0; index < 25; index += 1) {
      const id = `newer-manual-${String(index).padStart(2, '0')}`;
      repo.upsert(id, id, manualPayload);
      h.database.run(
        'UPDATE pos_hold_orders SET created_at = ? WHERE id = ?',
        [`2099-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, id],
      );
    }
    await h.database.flush();
    const holds = createHoldOrders({
      configStore: h.configStore,
      posStore: h.posStore,
      db: async () => h.database,
      runRestoredCartExclusive: (work) => h.restored.runExclusive(work),
    });

    await expect(holds.createCurrent(oldTarget, 'Reused exact cart')).resolves.toEqual({ success: true });
    expect(repo.get(oldTarget)?.payload).toMatchObject({ protected: false, holdReason: 'MANUAL' });
    expect(repo.get(oldTarget)?.payload.snapshot.state.cart.items[0].quantity).toBe(2);
    expect(repo.get(h.holdId)).toBeNull();
    expect(repo.list().filter((row) => row.protected !== true)).toHaveLength(20);
    expect(h.posStore.getState().cart.items).toHaveLength(0);
  });

  test('failed re-hold durability restores the protected row and leaves the live cart owned', async () => {
    const h = await harness();
    const realFlush = h.database.flush.bind(h.database);
    let calls = 0;
    (h.database as any).flush = async () => {
      calls += 1;
      if (calls === 1) throw new Error('disk full');
      return realFlush();
    };
    const holds = createHoldOrders({
      configStore: h.configStore,
      posStore: h.posStore,
      db: async () => h.database,
      runRestoredCartExclusive: (work) => h.restored.runExclusive(work),
    });
    await expect(holds.createCurrent('manual-restored-1', 'Customer will return'))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/disk full/) });
    expect(createHoldOrderRepo(h.database).get('manual-restored-1')).toBeNull();
    expect(createHoldOrderRepo(h.database).get(h.holdId)?.payload.restoredCheckout.state).toBe('READY');
    expect(h.posStore.getState().cart.items).toHaveLength(1);
    expect(h.posStore.getState().checkoutDraft.restoredInterruption?.holdId).toBe(h.holdId);
  });

  test('a re-hold waiting for DB owns the lane, so a concurrent edit cannot create a newer cart under it', async () => {
    const h = await harness();
    let resolveDb!: (database: AndroidDatabase) => void;
    let signalDb!: () => void;
    const dbRequested = new Promise<void>((resolve) => { signalDb = resolve; });
    const delayedDb = new Promise<AndroidDatabase>((resolve) => { resolveDb = resolve; });
    const holds = createHoldOrders({
      configStore: h.configStore,
      posStore: h.posStore,
      db: async () => { signalDb(); return delayedDb; },
      runRestoredCartExclusive: (work) => h.restored.runExclusive(work),
    });

    const rehold = holds.createCurrent('manual-delayed-db', 'Delayed DB hold');
    await dbRequested;
    const edit = h.restored.dispatchPosAction({
      type: 'cart/updateQuantity',
      payload: { id: 'line-1', quantity: 4 },
    });
    expect(h.posStore.getState().cart.items[0].quantity).toBe(2);
    resolveDb(h.database);

    await expect(rehold).resolves.toEqual({ success: true });
    await edit;
    expect(createHoldOrderRepo(h.database).get('manual-delayed-db')?.payload.snapshot.state.cart.items[0].quantity)
      .toBe(2);
    expect(createHoldOrderRepo(h.database).get(h.holdId)).toBeNull();
    expect(h.posStore.getState().cart.items).toHaveLength(0);
  });

  test('an edit already flushing completes first; queued re-hold captures the newer durable owner exactly', async () => {
    const h = await harness();
    const realFlush = h.database.flush.bind(h.database);
    let releaseFlush!: () => void;
    let signalFlush!: () => void;
    const flushEntered = new Promise<void>((resolve) => { signalFlush = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFlush = resolve; });
    let calls = 0;
    (h.database as any).flush = vi.fn(async () => {
      calls += 1;
      if (calls === 1) { signalFlush(); await gate; }
      return realFlush();
    });
    const holds = createHoldOrders({
      configStore: h.configStore,
      posStore: h.posStore,
      db: async () => h.database,
      runRestoredCartExclusive: (work) => h.restored.runExclusive(work),
    });

    const edit = h.restored.dispatchPosAction({
      type: 'cart/updateQuantity',
      payload: { id: 'line-1', quantity: 3 },
    });
    await flushEntered;
    const rehold = holds.createCurrent('manual-after-edit', 'Newest cart');
    expect(createHoldOrderRepo(h.database).get('manual-after-edit')).toBeNull();
    releaseFlush();

    await edit;
    await expect(rehold).resolves.toEqual({ success: true });
    expect(createHoldOrderRepo(h.database).get('manual-after-edit')?.payload.snapshot.state.cart.items[0].quantity)
      .toBe(3);
    expect(createHoldOrderRepo(h.database).get(h.holdId)).toBeNull();
    expect(h.posStore.getState().cart.items).toHaveLength(0);
  });

  test('restored transition freeze refuses trusted live drift before the first durable re-hold image', async () => {
    const h = await harness();
    const realFlush = h.database.flush.bind(h.database);
    let releaseFlush!: () => void;
    let signalFlush!: () => void;
    const flushEntered = new Promise<void>((resolve) => { signalFlush = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFlush = resolve; });
    let calls = 0;
    (h.database as any).flush = vi.fn(async () => {
      calls += 1;
      if (calls === 1) { signalFlush(); await gate; }
      if (calls > 1) throw new Error('no compensation flush may be required');
      return realFlush();
    });
    const holds = createHoldOrders({
      configStore: h.configStore,
      posStore: h.posStore,
      db: async () => h.database,
      runRestoredCartExclusive: (work) => h.restored.runExclusive(work),
    });

    const rehold = holds.createCurrent('manual-frozen-transition', 'Exact frozen cart');
    await flushEntered;
    const newer = capturePosCheckoutSnapshot(h.posStore.getState(), scope, 'retail');
    (newer.state as any).cart.items[0].quantity = 5;
    (newer.state as any).cart.items[0].total = 6000;
    (newer.state as any).cart.subtotal = 6000;
    (newer.state as any).cart.tax = 1122;
    (newer.state as any).cart.total = 6000;
    h.posStore.dispatch({ type: 'state/replaceCheckoutSnapshot', payload: { snapshot: newer } });
    expect(h.posStore.getState().cart.items[0].quantity).toBe(2);
    releaseFlush();

    await expect(rehold).resolves.toEqual({ success: true });
    expect(calls).toBe(1);
    expect(createHoldOrderRepo(h.database).get('manual-frozen-transition')?.payload.snapshot.state.cart.items[0].quantity)
      .toBe(2);
    expect(createHoldOrderRepo(h.database).get(h.holdId)).toBeNull();
    expect(h.posStore.getState().cart.items).toHaveLength(0);
  });

  test('logout and same-identity relogin after the first flush clears the exact live owner and leaves a recallable manual Hold', async () => {
    const h = await harness();
    const realFlush = h.database.flush.bind(h.database);
    let releaseFlush!: () => void;
    let signalFlush!: () => void;
    const flushEntered = new Promise<void>((resolve) => { signalFlush = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFlush = resolve; });
    (h.database as any).flush = vi.fn(async () => {
      signalFlush();
      await gate;
      return realFlush();
    });
    const holds = createHoldOrders({
      configStore: h.configStore,
      posStore: h.posStore,
      db: async () => h.database,
      runRestoredCartExclusive: (work) => h.restored.runExclusive(work),
    });

    const rehold = holds.createCurrent('manual-auth-switch', 'Previous cashier cart');
    await flushEntered;
    const sameUser = h.configStore.getRawConfig().authUser;
    holds.invalidateAuth(); // logout boundary
    h.configStore.setConfig({ authUser: undefined } as any);
    holds.invalidateAuth(); // same-user/register login boundary
    h.configStore.setConfig({ authUser: sameUser } as any);
    h.posStore.dispatch({
      type: 'cart/updateQuantity',
      payload: { id: 'line-1', quantity: 5 },
    });
    expect(h.posStore.getState().cart.items[0].quantity).toBe(2);
    releaseFlush();

    await expect(rehold).resolves.toEqual({ success: true });
    expect(createHoldOrderRepo(h.database).get('manual-auth-switch')?.payload.snapshot.state.cart.items[0].quantity)
      .toBe(2);
    expect(createHoldOrderRepo(h.database).get(h.holdId)).toBeNull();
    expect(h.posStore.getState().cart.items).toHaveLength(0);
    expect(h.posStore.getState().checkoutDraft.restoredInterruption).toBeUndefined();

    // Recall proves both that the lock was released and that the exact owner
    // moved durably rather than being lost across the auth epoch change.
    await expect(holds.recall('manual-auth-switch')).resolves.toEqual({ success: true });
    expect(createHoldOrderRepo(h.database).get('manual-auth-switch')).toBeNull();
    expect(h.posStore.getState().cart.items[0].quantity).toBe(2);
    expect(h.posStore.getState().checkoutDraft.restoredInterruption).toBeUndefined();
  });

  test('a newer durable protected owner appearing during re-hold is never removed or cleared', async () => {
    const h = await harness();
    const original = createHoldOrderRepo(h.database).get(h.holdId)!;
    const newerPayload = {
      ...original.payload,
      snapshot: { ...original.payload.snapshot, capturedAt: '2026-08-10T01:00:00.000Z' },
    };
    const realFlush = h.database.flush.bind(h.database);
    let releaseFlush!: () => void;
    let signalFlush!: () => void;
    const flushEntered = new Promise<void>((resolve) => { signalFlush = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFlush = resolve; });
    let calls = 0;
    (h.database as any).flush = vi.fn(async () => {
      calls += 1;
      if (calls === 1) { signalFlush(); await gate; }
      return realFlush();
    });
    const holds = createHoldOrders({
      configStore: h.configStore,
      posStore: h.posStore,
      db: async () => h.database,
      runRestoredCartExclusive: (work) => h.restored.runExclusive(work),
    });

    const rehold = holds.createCurrent('manual-newer-owner-race', 'Must be rolled back');
    await flushEntered;
    createHoldOrderRepo(h.database).upsert(h.holdId, original.title, newerPayload);
    releaseFlush();

    await expect(rehold).resolves.toMatchObject({ success: false });
    expect(createHoldOrderRepo(h.database).get('manual-newer-owner-race')).toBeNull();
    expect(createHoldOrderRepo(h.database).get(h.holdId)?.payload.snapshot.capturedAt)
      .toBe('2026-08-10T01:00:00.000Z');
    expect(h.posStore.getState().cart.items).toHaveLength(1);
    expect(h.posStore.getState().checkoutDraft.restoredInterruption?.holdId).toBe(h.holdId);
  });
});

describe('restored-cart durable dispatch ownership', () => {
  test.each(['auth', 'salon', 'register'] as const)(
    '%s switch while DB ownership is pending causes zero live mutation and zero Hold write',
    async (boundary) => {
      const h = await harness();
      let resolveDb!: (database: AndroidDatabase) => void;
      const delayedDb = new Promise<AndroidDatabase>((resolve) => { resolveDb = resolve; });
      const restored = createRestoredCartHandoff({
        configStore: h.configStore,
        posStore: h.posStore,
        db: async () => delayedDb,
      });
      const beforeState = JSON.stringify(h.posStore.getState());
      const beforeHold = JSON.stringify(createHoldOrderRepo(h.database).get(h.holdId)?.payload);
      const pending = restored.dispatchPosAction({
        type: 'cart/updateQuantity',
        payload: { id: 'line-1', quantity: 3 },
      });
      await Promise.resolve();
      await Promise.resolve();
      if (boundary === 'auth') restored.invalidateAuth();
      if (boundary === 'salon') h.configStore.setConfig({ salonId: 'salon-other' } as any);
      if (boundary === 'register') h.configStore.setConfig({ registerCode: 'register-other' } as any);
      resolveDb(h.database);

      await expect(pending).rejects.toThrow(/changed|exact durable cart/i);
      expect(JSON.stringify(h.posStore.getState())).toBe(beforeState);
      expect(JSON.stringify(createHoldOrderRepo(h.database).get(h.holdId)?.payload)).toBe(beforeHold);
    },
  );

  test('a stale action whose live state changed during DB await does not apply or rewrite the Hold', async () => {
    const h = await harness();
    let resolveDb!: (database: AndroidDatabase) => void;
    const delayedDb = new Promise<AndroidDatabase>((resolve) => { resolveDb = resolve; });
    let signalDbRequested!: () => void;
    const dbRequested = new Promise<void>((resolve) => { signalDbRequested = resolve; });
    const restored = createRestoredCartHandoff({
      configStore: h.configStore,
      posStore: h.posStore,
      db: async () => {
        signalDbRequested();
        return delayedDb;
      },
    });
    const beforeHold = JSON.stringify(createHoldOrderRepo(h.database).get(h.holdId)?.payload);
    const pending = restored.dispatchPosAction({
      type: 'cart/updateQuantity',
      payload: { id: 'line-1', quantity: 3 },
    });
    await dbRequested;
    h.posStore.dispatch({ type: 'display/setMode', payload: { mode: 'idle' } as any });
    resolveDb(h.database);

    await expect(pending).rejects.toThrow(/changed|exact durable cart/i);
    expect(h.posStore.getState().cart.items[0].quantity).toBe(2);
    expect(JSON.stringify(createHoldOrderRepo(h.database).get(h.holdId)?.payload)).toBe(beforeHold);
  });

  test('concurrent edits serialize through durable snapshots and never expose an unflushed candidate', async () => {
    const h = await harness();
    const realFlush = h.database.flush.bind(h.database);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    (h.database as any).flush = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await firstGate;
      return realFlush();
    });
    const first = h.restored.dispatchPosAction({
      type: 'cart/updateQuantity',
      payload: { id: 'line-1', quantity: 3 },
    });
    await Promise.resolve();
    await Promise.resolve();
    const second = h.restored.dispatchPosAction({
      type: 'cart/updateQuantity',
      payload: { id: 'line-1', quantity: 4 },
    });
    expect(h.posStore.getState().cart.items[0].quantity).toBe(2);
    releaseFirst();
    await Promise.all([first, second]);
    expect(h.posStore.getState().cart.items[0].quantity).toBe(4);
    expect(createHoldOrderRepo(h.database).get(h.holdId)?.payload.snapshot.state.cart.items[0].quantity)
      .toBe(4);
  });
});
