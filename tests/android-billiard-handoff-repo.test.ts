/**
 * L1+L2 of the billiard POS-handoff port — schema tables + the two ported
 * repos (docs/android-pos/2026-08-02-billiard-pos-handoff-port-plan.md).
 *
 * The journal's state machine is the money-path safety net, so these tests pin
 * the guards rather than the happy path: illegal transitions throw, backward
 * edges only open where no charge can have happened, and a crossed tender
 * boundary can never silently become paid. Every expectation mirrors the
 * Windows repo (src/main/database/repos/billiard-pos-handoff-repo.ts).
 */
import { describe, expect, test } from 'vitest';

import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { createBilliardHandoffRepo } from '../src/renderer/android-pos/shim/db/billiard-handoff-repo';
import { createHoldOrderRepo } from '../src/renderer/android-pos/shim/db/hold-repo';
import type { PosHoldPayload } from '../src/shared/billiard-pos-handoff';

/** Node-friendly sql.js load (same rationale as tests/android-shim-db.test.ts). */
const NODE_LOCATE_FILE = null;

const SCOPE = { salonId: 's1', userId: 'u1', registerId: 'r1' };

async function freshDb(): Promise<AndroidDatabase> {
  return initAndroidDb({ locateFile: NODE_LOCATE_FILE });
}

function seedRecord(repo: ReturnType<typeof createBilliardHandoffRepo>, overrides: Record<string, any> = {}) {
  const checkoutId = overrides.checkoutId ?? 'co1';
  repo.create({
    checkoutId,
    sessionId: 'sess1',
    orderId: overrides.orderId ?? 'ord1',
    clientAttemptId: `billiard:${checkoutId}`,
    salonId: SCOPE.salonId,
    userId: SCOPE.userId,
    registerId: SCOPE.registerId,
    state: 'POS_READY',
    bundle: { checkoutId, sessionId: 'sess1', totalGrosze: 5000 } as any,
    checkoutSnapshot: { schemaVersion: 1, state: {}, posMode: 'retail', scope: SCOPE, capturedAt: 'now' } as any,
    interruptedHoldId: null,
    autoOpenConsumed: false,
    ...overrides,
  });
  return checkoutId;
}

function protectedHoldPayload(overrides: Partial<PosHoldPayload> = {}): PosHoldPayload {
  return {
    schemaVersion: 1,
    holdReason: 'BILLIARD_INTERRUPTION',
    protected: true,
    snapshot: { schemaVersion: 1, state: { cart: { items: [{ id: 'i1' }], total: 1200 } }, posMode: 'retail', scope: SCOPE, capturedAt: 'now' },
    sourceBilliardSessionId: 'sess1',
    autoRestoreForCheckoutId: 'co1',
    restoreState: 'WAITING_FOR_BILLIARD_PAYMENT',
    ...overrides,
  } as PosHoldPayload;
}

describe('android schema v5 — handoff + hold tables', () => {
  test('both tables exist on a fresh DB and survive clearSalonData', async () => {
    const db = await freshDb();
    const repo = createBilliardHandoffRepo(db);
    const holds = createHoldOrderRepo(db);
    seedRecord(repo);
    holds.upsert('h1', 'Parked', protectedHoldPayload());

    expect(repo.get('co1')).not.toBeNull();
    expect(holds.get('h1')).not.toBeNull();

    // Tenant switch must wipe both — a frozen checkout and a parked cart carry
    // the previous salon's money state and order id.
    db.clearSalonData();
    expect(repo.get('co1')).toBeNull();
    expect(holds.get('h1')).toBeNull();
  });

  test('order_id and client_attempt_id are UNIQUE (no two journals per order)', async () => {
    const db = await freshDb();
    const repo = createBilliardHandoffRepo(db);
    seedRecord(repo);
    expect(() => seedRecord(repo, { checkoutId: 'co2', orderId: 'ord1' })).toThrow();
  });
});

describe('handoff journal state machine', () => {
  test('markPaymentOpened is idempotent and only from POS_READY', async () => {
    const db = await freshDb();
    const repo = createBilliardHandoffRepo(db);
    seedRecord(repo);

    expect(repo.markPaymentOpened('co1')).toBe(true);
    expect(repo.get('co1')!.state).toBe('POS_PAYMENT_OPEN');
    expect(repo.get('co1')!.autoOpenConsumed).toBe(true);
    // Re-entry (the renderer re-opens the payment modal) must not fail.
    expect(repo.markPaymentOpened('co1')).toBe(true);

    repo.markTenderCommitting('co1');
    // No longer READY → refuse rather than reopen a committing tender.
    expect(repo.markPaymentOpened('co1')).toBe(false);
  });

  test('illegal transitions throw instead of silently skipping a state', async () => {
    const db = await freshDb();
    const repo = createBilliardHandoffRepo(db);
    seedRecord(repo);
    // READY cannot jump straight to SETTLED — that would mark an uncollected
    // bill as done.
    expect(() => repo.markState('co1', 'SETTLED')).toThrow(/Invalid Billiard handoff transition/);
    expect(repo.markState('co1', 'POS_PAID_SYNC_PENDING')).toBe(true);
    expect(repo.markState('co1', 'SETTLED')).toBe(true);
    // Terminal.
    expect(() => repo.markState('co1', 'POS_READY')).toThrow();
  });

  test('rollbackTenderBeforeCharge requires a positive no-charge attestation', async () => {
    const db = await freshDb();
    const repo = createBilliardHandoffRepo(db);
    seedRecord(repo);
    repo.markPaymentOpened('co1');
    repo.markTenderCommitting('co1');

    // Anything other than an explicit `true` leaves the tender boundary crossed.
    expect(repo.rollbackTenderBeforeCharge('co1', false)).toBe(false);
    expect(repo.rollbackTenderBeforeCharge('co1', undefined as any)).toBe(false);
    expect(repo.get('co1')!.state).toBe('POS_TENDER_COMMITTING');

    expect(repo.rollbackTenderBeforeCharge('co1', true)).toBe(true);
    expect(repo.get('co1')!.state).toBe('POS_PAYMENT_OPEN');
  });

  test('an uncertain tender cannot be rolled back, only resolved by an owner audit', async () => {
    const db = await freshDb();
    const repo = createBilliardHandoffRepo(db);
    seedRecord(repo);
    repo.markPaymentOpened('co1');
    repo.markTenderCommitting('co1');
    repo.markTenderUncertain('co1');

    // The backward edge is closed once the outcome is ambiguous.
    expect(repo.rollbackTenderBeforeCharge('co1', true)).toBe(false);
    expect(repo.get('co1')!.state).toBe('POS_TENDER_UNCERTAIN');

    const audit = { resolvedBy: 'owner1', resolvedAt: 'now', reason: 'terminal showed no charge' } as any;
    expect(repo.resolveUncertainTenderAsNoPayment('co1', audit)).toBe(true);
    const resolved = repo.get('co1')!;
    expect(resolved.state).toBe('POS_PAYMENT_OPEN');
    expect(resolved.tenderResolutionAudits).toHaveLength(1);

    // The audit trail is append-only across resolutions.
    repo.markTenderCommitting('co1');
    repo.markTenderUncertain('co1');
    expect(repo.resolveUncertainTenderAsNoPayment('co1', { ...audit, resolvedAt: 'later' })).toBe(true);
    expect(repo.get('co1')!.tenderResolutionAudits).toHaveLength(2);
  });

  test('rollbackNoPaymentResolution reverts exactly the last audit', async () => {
    const db = await freshDb();
    const repo = createBilliardHandoffRepo(db);
    seedRecord(repo);
    repo.markPaymentOpened('co1');
    repo.markTenderCommitting('co1');
    repo.markTenderUncertain('co1');
    const before = repo.get('co1')!;
    const audit = { resolvedBy: 'owner1', resolvedAt: 'now', reason: 'no charge' } as any;
    repo.resolveUncertainTenderAsNoPayment('co1', audit);

    expect(repo.rollbackNoPaymentResolution('co1', audit, before)).toBe(true);
    const rolledBack = repo.get('co1')!;
    expect(rolledBack.state).toBe('POS_TENDER_UNCERTAIN');
    expect(rolledBack.tenderResolutionAudits).toHaveLength(0);
    // A stale/foreign audit must not rewind anything.
    expect(repo.rollbackNoPaymentResolution('co1', { ...audit, resolvedAt: 'other' }, before)).toBe(false);
  });

  test('recovery lanes are scoped — never cross-tenant, owner lane is tender-only', async () => {
    const db = await freshDb();
    const repo = createBilliardHandoffRepo(db);
    seedRecord(repo);

    expect(repo.getRecoverable(SCOPE)?.checkoutId).toBe('co1');
    expect(repo.getRecoverable({ ...SCOPE, salonId: 'other' })).toBeNull();
    expect(repo.getRecoverable({ ...SCOPE, registerId: 'other' })).toBeNull();

    // POS_READY is an active cart, not an ambiguous tender — the owner lane
    // must not surface it.
    expect(repo.getUncertainForOwner({ salonId: 's1', registerId: 'r1' })).toBeNull();
    repo.markPaymentOpened('co1');
    repo.markTenderCommitting('co1');
    expect(repo.getUncertainForOwner({ salonId: 's1', registerId: 'r1' })?.checkoutId).toBe('co1');

    // A settled journal is no longer recoverable.
    repo.markState('co1', 'POS_PAID_SYNC_PENDING');
    repo.markState('co1', 'SETTLED');
    expect(repo.getRecoverable(SCOPE)).toBeNull();
  });

  test('a corrupt snapshot_json reads as absent, never as a blank checkout', async () => {
    const db = await freshDb();
    const repo = createBilliardHandoffRepo(db);
    seedRecord(repo);
    db.run("UPDATE pos_billiard_handoffs SET snapshot_json = 'not json' WHERE checkout_id = 'co1'");
    expect(repo.get('co1')).toBeNull();
  });
});

describe('held carts — protected rows are safety ledgers', () => {
  test('a protected hold cannot be overwritten, deleted or pruned', async () => {
    const db = await freshDb();
    const holds = createHoldOrderRepo(db);
    holds.upsert('h1', 'Parked', protectedHoldPayload());

    expect(() => holds.upsert('h1', 'Parked', protectedHoldPayload({ sourceBilliardSessionId: 'other' })))
      .toThrow(/Protected held cart already exists/);
    expect(() => holds.remove('h1')).toThrow(/Protected held cart cannot be deleted/);

    holds.prune(0);
    expect(holds.get('h1')).not.toBeNull();

    // The handoff's own teardown may delete it explicitly.
    holds.remove('h1', true);
    expect(holds.get('h1')).toBeNull();
  });

  test('replaceProtected refuses a lifecycle identity change', async () => {
    const db = await freshDb();
    const holds = createHoldOrderRepo(db);
    holds.upsert('h1', 'Parked', protectedHoldPayload());

    expect(() => holds.replaceProtected('h1', 'Parked', protectedHoldPayload({ autoRestoreForCheckoutId: 'other' })))
      .toThrow(/lifecycle identity does not match/);

    // Same identity, new snapshot state = the legitimate update path.
    const next = protectedHoldPayload({ restoreState: 'ACTIVE_CART_BACKUP' });
    holds.replaceProtected('h1', 'Parked', next);
    expect(holds.get('h1')!.payload.restoreState).toBe('ACTIVE_CART_BACKUP');
  });

  test('list hides paid tombstones but keeps them retrievable by id', async () => {
    const db = await freshDb();
    const holds = createHoldOrderRepo(db);
    holds.upsert('h1', 'Parked', protectedHoldPayload({ restoreState: 'PAID_TOMBSTONE' }));
    expect(holds.list()).toHaveLength(0);
    expect(holds.get('h1')).not.toBeNull();
  });

  test('unprotected rows above the prune limit are trimmed', async () => {
    const db = await freshDb();
    const holds = createHoldOrderRepo(db);
    holds.upsert('h1', 'Manual A', { cart: { items: [], total: 0 } });
    holds.upsert('h2', 'Manual B', { cart: { items: [], total: 0 } });
    holds.prune(1);
    expect(holds.list()).toHaveLength(1);
  });
});
