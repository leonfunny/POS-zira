import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/zira-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { database } from '../src/main/database/database';
import { billiardPosHandoffRepo } from '../src/main/database/repos/billiard-pos-handoff-repo';
import { holdOrderRepo } from '../src/main/database/repos/hold-repo';
import {
  adoptPosCheckoutSnapshotScope,
  samePosSalonRegister,
  samePosSnapshotScope,
  withRestoredInterruptionMarker,
} from '../src/main/pos/billiard-pos-handoff';
import {
  isBilliardCorrectionSourceForOwner,
  resolveBilliardCorrectionCommand,
} from '../src/main/pos/billiard-correction-journal';

let sqlDb: SqlJsDatabase;

function getRow(sql: string, params?: any[]): any | null {
  const statement = sqlDb.prepare(sql);
  try {
    statement.bind(params || []);
    return statement.step() ? statement.getAsObject() : null;
  } finally {
    statement.free();
  }
}

function getRows(sql: string, params?: any[]): any[] {
  const statement = sqlDb.prepare(sql);
  const rows: any[] = [];
  try {
    statement.bind(params || []);
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function record(checkoutId = 'checkout-1') {
  return {
    checkoutId,
    sessionId: 'session-1',
    orderId: `order-${checkoutId}`,
    clientAttemptId: `billiard:${checkoutId}`,
    salonId: 'salon-1',
    userId: 'owner-1',
    registerId: 'register-1',
    state: 'POS_READY' as const,
    bundle: {
      schemaVersion: 1,
      sessionId: 'session-1',
      checkoutId,
      totalGrosze: 1000,
      discountGrosze: 0,
      lines: [],
    },
    checkoutSnapshot: {
      schemaVersion: 1 as const,
      state: {},
      posMode: 'retail',
      scope: { salonId: 'salon-1', userId: 'owner-1', registerId: 'register-1' },
      capturedAt: '2026-07-22T10:00:00.000Z',
    },
    interruptedHoldId: null,
    autoOpenConsumed: false,
  };
}

describe('Billiard POS durable handoff journal', () => {
  beforeEach(async () => {
    const SQL = await initSqlJs();
    sqlDb = new SQL.Database();
    sqlDb.run(`
      CREATE TABLE pos_billiard_handoffs (
        checkout_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        order_id TEXT NOT NULL UNIQUE,
        client_attempt_id TEXT NOT NULL UNIQUE,
        salon_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        register_id TEXT NOT NULL,
        state TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        interrupted_hold_id TEXT,
        auto_open_consumed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    sqlDb.run(`
      CREATE TABLE pos_hold_orders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        items_count INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        staff_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    vi.spyOn(database, 'run').mockImplementation((sql: string, params?: any[]) => {
      sqlDb.run(sql, params || []);
    });
    vi.spyOn(database, 'get').mockImplementation(((sql: string, params?: any[]) => (
      getRow(sql, params)
    )) as any);
    vi.spyOn(database, 'all').mockImplementation(((sql: string, params?: any[]) => (
      getRows(sql, params)
    )) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlDb.close();
  });

  it('crosses the durable tender boundary idempotently and only moves forward', () => {
    billiardPosHandoffRepo.create(record());

    expect(billiardPosHandoffRepo.markPaymentOpened('checkout-1')).toBe(true);
    expect(billiardPosHandoffRepo.markPaymentOpened('checkout-1')).toBe(true);
    expect(billiardPosHandoffRepo.get('checkout-1')).toMatchObject({
      state: 'POS_PAYMENT_OPEN',
      autoOpenConsumed: true,
    });

    expect(billiardPosHandoffRepo.markTenderCommitting('checkout-1')).toBe(true);
    expect(billiardPosHandoffRepo.markTenderCommitting('checkout-1')).toBe(true);
    expect(billiardPosHandoffRepo.get('checkout-1')?.state).toBe('POS_TENDER_COMMITTING');

    expect(billiardPosHandoffRepo.markState('checkout-1', 'POS_PAID_SYNC_PENDING')).toBe(true);
    expect(billiardPosHandoffRepo.markState('checkout-1', 'SETTLED')).toBe(true);
    expect(() => billiardPosHandoffRepo.markState('checkout-1', 'POS_READY')).toThrow(
      'Invalid Billiard handoff transition',
    );
  });

  it('turns a crash before order export into an unretryable uncertain tender', () => {
    billiardPosHandoffRepo.create(record());
    billiardPosHandoffRepo.markPaymentOpened('checkout-1');
    billiardPosHandoffRepo.markTenderCommitting('checkout-1');

    // Simulated restart: the tender boundary is durable, but no order row was
    // exported. Recovery must lock it for reconciliation, never Resume.
    expect(billiardPosHandoffRepo.markTenderUncertain('checkout-1')).toBe(true);
    expect(billiardPosHandoffRepo.getRecoverable({
      salonId: 'salon-1', userId: 'owner-1', registerId: 'register-1',
    })).toMatchObject({ state: 'POS_TENDER_UNCERTAIN' });
    expect(billiardPosHandoffRepo.markPaymentOpened('checkout-1')).toBe(false);
    expect(billiardPosHandoffRepo.rollbackTenderBeforeCharge('checkout-1', true)).toBe(false);
  });

  it('lets an OWNER discover and durably adopt a staff uncertain Billiard tender', () => {
    const staffRecord = record();
    staffRecord.userId = 'staff-1';
    staffRecord.checkoutSnapshot.scope.userId = 'staff-1';
    billiardPosHandoffRepo.create(staffRecord);
    billiardPosHandoffRepo.markPaymentOpened('checkout-1');
    billiardPosHandoffRepo.markTenderCommitting('checkout-1');

    expect(billiardPosHandoffRepo.getRecoverable({
      salonId: 'salon-1', userId: 'owner-1', registerId: 'register-1',
    })).toBeNull();
    expect(billiardPosHandoffRepo.getUncertainForOwner({
      salonId: 'salon-1', registerId: 'register-1',
    })).toMatchObject({ userId: 'staff-1', state: 'POS_TENDER_COMMITTING' });

    billiardPosHandoffRepo.markTenderUncertain('checkout-1');
    const audit = {
      ownerUserId: 'owner-1',
      reason: 'Terminal and cash checked: no payment remains',
      confirmedAt: '2026-07-22T10:05:00.000Z',
      action: 'NO_PAYMENT_REMAINS' as const,
    };
    expect(billiardPosHandoffRepo.resolveUncertainTenderAsNoPayment(
      'checkout-1',
      audit,
      { salonId: 'salon-1', userId: 'owner-1', registerId: 'register-1' },
    )).toBe(true);
    expect(billiardPosHandoffRepo.get('checkout-1')).toMatchObject({
      userId: 'owner-1',
      state: 'POS_PAYMENT_OPEN',
      checkoutSnapshot: { scope: { userId: 'owner-1' } },
      tenderResolutionAudits: [audit],
    });
  });

  it('allows rollback only while no-charge is explicitly confirmed before uncertainty', () => {
    billiardPosHandoffRepo.create(record());
    billiardPosHandoffRepo.markPaymentOpened('checkout-1');
    billiardPosHandoffRepo.markTenderCommitting('checkout-1');

    expect(billiardPosHandoffRepo.rollbackTenderBeforeCharge('checkout-1', false)).toBe(false);
    expect(billiardPosHandoffRepo.rollbackTenderBeforeCharge('checkout-1', true)).toBe(true);
    expect(billiardPosHandoffRepo.get('checkout-1')?.state).toBe('POS_PAYMENT_OPEN');
  });

  it('rejects duplicate checkout/order/client-attempt identities at the journal boundary', () => {
    billiardPosHandoffRepo.create(record());
    expect(() => billiardPosHandoffRepo.create(record())).toThrow(/UNIQUE constraint failed/i);

    const duplicateOrder = record('checkout-2');
    duplicateOrder.orderId = 'order-checkout-1';
    expect(() => billiardPosHandoffRepo.create(duplicateOrder)).toThrow(/UNIQUE constraint failed/i);
  });

  it('reuses a durable correction UUID after a crash and preserves its confirmed response', () => {
    billiardPosHandoffRepo.create(record());
    const ready = {
      orderId: 'order-checkout-1',
      requestId: '11111111-1111-4111-8111-111111111111',
      reason: 'Owner correction after terminal reversal',
      state: 'READY' as const,
      updatedAt: '2026-07-22T10:03:00.000Z',
    };
    expect(billiardPosHandoffRepo.setCorrectionIntent(ready.orderId, ready)).toBe(true);

    // A restarted renderer generated another UUID, but main must replay the
    // exact durable command/body rather than create a second correction.
    expect(resolveBilliardCorrectionCommand(
      billiardPosHandoffRepo.getByOrderId(ready.orderId)?.correctionIntent,
      {
        requestId: '22222222-2222-4222-8222-222222222222',
        reason: 'Different retry text',
      },
    )).toEqual({ requestId: ready.requestId, reason: ready.reason });

    const confirmed = {
      ...ready,
      state: 'SERVER_CONFIRMED' as const,
      updatedAt: '2026-07-22T10:04:00.000Z',
      response: { success: true, status: 'REFUNDED', posCheckout: { checkoutId: 'replacement-1' } },
    };
    expect(billiardPosHandoffRepo.setCorrectionIntent(ready.orderId, confirmed)).toBe(true);
    expect(billiardPosHandoffRepo.getByOrderId(ready.orderId)?.correctionIntent).toEqual(confirmed);
    expect(billiardPosHandoffRepo.setCorrectionIntent(ready.orderId, null)).toBe(true);
    expect(billiardPosHandoffRepo.getByOrderId(ready.orderId)?.correctionIntent).toBeUndefined();
  });

  it('allows the OWNER to adopt a staff-paid source on the same salon/register', () => {
    expect(isBilliardCorrectionSourceForOwner(
      {
        checkoutId: 'checkout-1',
        sessionId: 'session-1',
        salonId: 'salon-1',
        userId: 'staff-who-paid',
        registerId: 'register-1',
      },
      { salonId: 'salon-1', userId: 'owner-correcting', registerId: 'register-1' },
      { checkoutId: 'checkout-1', sessionId: 'session-1' },
    )).toBe(true);
    expect(isBilliardCorrectionSourceForOwner(
      {
        checkoutId: 'checkout-1',
        sessionId: 'session-1',
        salonId: 'salon-1',
        userId: 'staff-who-paid',
        registerId: 'register-2',
      },
      { salonId: 'salon-1', userId: 'owner-correcting', registerId: 'register-1' },
      { checkoutId: 'checkout-1', sessionId: 'session-1' },
    )).toBe(false);
  });

  it('keeps the protected Hold after auto-restore and advances only its lifecycle', () => {
    const snapshot = {
      schemaVersion: 1 as const,
      state: {
        cart: {
          items: [{ id: 'line-1', variantId: 'v1', name: 'Coffee', sku: '', price: 500, quantity: 1, total: 500 }],
          subtotal: 500,
          discount: 0,
          tax: 0,
          total: 500,
        },
        checkoutDraft: { customerNip: '1234567890' },
        session: { staffName: 'Owner' },
      },
      posMode: 'retail',
      scope: { salonId: 'salon-1', userId: 'owner-1', registerId: 'register-1' },
      capturedAt: '2026-07-22T10:00:00.000Z',
    };
    const waiting = {
      schemaVersion: 1 as const,
      holdReason: 'BILLIARD_INTERRUPTION' as const,
      protected: true,
      snapshot,
      sourceBilliardSessionId: 'session-1',
      autoRestoreForCheckoutId: 'checkout-1',
      restoreState: 'WAITING_FOR_BILLIARD_PAYMENT' as const,
    };
    holdOrderRepo.upsert('hold-1', 'Interrupted cart', waiting);
    holdOrderRepo.replaceProtected('hold-1', 'Interrupted cart', {
      ...waiting,
      restoreState: 'ACTIVE_CART_BACKUP',
      restoredCheckout: {
        orderId: 'restored-order-1',
        clientAttemptId: 'restored:restored-order-1',
        state: 'READY',
        updatedAt: '2026-07-22T10:01:00.000Z',
      },
    });

    const journal = holdOrderRepo.get('hold-1')!.payload.restoredCheckout;
    const live = withRestoredInterruptionMarker(snapshot, 'hold-1', 'checkout-1', journal);
    expect(live.state.checkoutDraft.restoredInterruption).toEqual({
      holdId: 'hold-1',
      checkoutId: 'checkout-1',
      orderId: 'restored-order-1',
      clientAttemptId: 'restored:restored-order-1',
      tenderState: 'READY',
    });
    expect(holdOrderRepo.get('hold-1')?.payload).toMatchObject({
      protected: true,
      restoreState: 'ACTIVE_CART_BACKUP',
    });
  });

  it('lets an OWNER adopt only an uncertain restored cart on the same salon/register', () => {
    const staffSnapshot = {
      schemaVersion: 1 as const,
      state: { cart: { items: [], subtotal: 0, discount: 0, tax: 0, total: 0 } },
      posMode: 'retail',
      scope: { salonId: 'salon-1', userId: 'staff-1', registerId: 'register-1' },
      capturedAt: '2026-07-22T10:00:00.000Z',
    };
    const ownerScope = { salonId: 'salon-1', userId: 'owner-1', registerId: 'register-1' };
    expect(samePosSnapshotScope(staffSnapshot, ownerScope)).toBe(false);
    expect(samePosSalonRegister(staffSnapshot, ownerScope)).toBe(true);

    const adopted = adoptPosCheckoutSnapshotScope(staffSnapshot, ownerScope);
    expect(samePosSnapshotScope(adopted, ownerScope)).toBe(true);
    expect(staffSnapshot.scope.userId).toBe('staff-1');
  });
});
