import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  assertLocalOpenShiftMatchesSession,
  getVerifiedServerShiftMismatch,
  recoverOpenShiftFromLocal,
  type LocalOpenShift,
} from '../src/main/pos/open-shift-recovery';

function fakeStore() {
  let session = {
    isOpen: false,
    shiftId: null as string | null,
    staffId: null as string | null,
    staffName: null as string | null,
  };
  const dispatch = vi.fn((action: any) => {
    session = {
      isOpen: action.payload.shiftId != null,
      shiftId: action.payload.shiftId,
      staffId: action.payload.staffId,
      staffName: action.payload.staffName,
    };
  });
  return {
    getState: () => ({ session }),
    dispatch,
  };
}

describe('POS auth-boundary shift recovery', () => {
  // Regression: logout cleared the open shift from RAM and login did not put it
  // back, so the cashier was invited to create a conflicting second shift.
  it('restores the existing local shift without creating another database row', () => {
    const openShift: LocalOpenShift = {
      id: 'shift-existing',
      staff_id: 'staff-1',
      staff_name: 'Anna',
      opened_at: '2026-07-24T08:00:00.000Z',
    };
    const db = {
      all: vi.fn(() => [openShift]),
      run: vi.fn(),
    };
    const store = fakeStore();

    expect(recoverOpenShiftFromLocal(db, store)).toEqual(openShift);
    expect(store.dispatch).toHaveBeenCalledWith({
      type: 'session/open',
      payload: {
        shiftId: 'shift-existing',
        staffId: 'staff-1',
        staffName: 'Anna',
        openedAt: '2026-07-24T08:00:00.000Z',
      },
    });
    expect(db.run).not.toHaveBeenCalled();
  });

  it('keeps the POS session closed when no local shift is open', () => {
    const db = { all: vi.fn(() => []) };
    const store = fakeStore();

    expect(recoverOpenShiftFromLocal(db, store)).toBeNull();
    expect(store.dispatch).not.toHaveBeenCalled();
  });

  it('does not re-dispatch a shift that is already active in RAM', () => {
    const openShift: LocalOpenShift = {
      id: 'shift-existing',
      staff_id: 'staff-1',
      staff_name: 'Anna',
      opened_at: '2026-07-24T08:00:00.000Z',
    };
    const db = { all: vi.fn(() => [openShift]) };
    const store = fakeStore();
    recoverOpenShiftFromLocal(db, store);
    store.dispatch.mockClear();

    expect(recoverOpenShiftFromLocal(db, store)).toEqual(openShift);
    expect(store.dispatch).not.toHaveBeenCalled();
  });

  it('fails closed instead of reviving one of several local open shifts', () => {
    const store = fakeStore();
    const db = {
      all: vi.fn(() => [
        {
          id: 'shift-new',
          staff_id: 'staff-1',
          staff_name: 'Anna',
          opened_at: '2026-07-24T09:00:00.000Z',
        },
        {
          id: 'shift-old',
          staff_id: 'staff-1',
          staff_name: 'Anna',
          opened_at: '2026-07-23T09:00:00.000Z',
        },
      ]),
    };

    expect(() => recoverOpenShiftFromLocal(db, store)).toThrow(/multiple local POS shifts/i);
    expect(store.dispatch).not.toHaveBeenCalled();
  });

  it('requires the RAM session to match the single complete local shift', () => {
    const openShift: LocalOpenShift = {
      id: 'shift-existing',
      staff_id: 'staff-1',
      staff_name: 'Anna',
      opened_at: '2026-07-24T08:00:00.000Z',
    };
    const db = { all: vi.fn(() => [openShift]) };
    const store = fakeStore();
    recoverOpenShiftFromLocal(db, store);

    expect(assertLocalOpenShiftMatchesSession(db, store)).toEqual(openShift);
  });

  it('blocks a RAM-only shift whose local row is closed or missing', () => {
    const db = { all: vi.fn(() => []) };
    const store = fakeStore();
    store.dispatch({
      type: 'session/open',
      payload: {
        shiftId: 'shift-closed',
        staffId: 'staff-1',
        staffName: 'Anna',
      },
    });

    expect(() => assertLocalOpenShiftMatchesSession(db, store)).toThrow(/not open in the local payment journal/i);
  });

  it('fails closed on a server-confirmed missing or different register shift', () => {
    expect(getVerifiedServerShiftMismatch({
      localShiftId: 'shift-a',
      localBackendShiftId: null,
      serverShiftId: null,
    })).toMatch(/server confirmed.*no active shift/i);
    expect(getVerifiedServerShiftMismatch({
      localShiftId: 'shift-a',
      localBackendShiftId: null,
      serverShiftId: 'shift-b',
    })).toMatch(/does not match server shift/i);
  });

  it('accepts the same local or reconciled backend shift identity', () => {
    expect(getVerifiedServerShiftMismatch({
      localShiftId: 'shift-a',
      localBackendShiftId: null,
      serverShiftId: 'shift-a',
    })).toBeNull();
    expect(getVerifiedServerShiftMismatch({
      localShiftId: 'local-a',
      localBackendShiftId: 'server-a',
      serverShiftId: 'server-a',
    })).toBeNull();
  });

  it('runs the same recovery path after the user logs in', () => {
    const source = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    const loginHandler = source.slice(
      source.indexOf("bus.on('user:logged-in'"),
      source.indexOf('setupSocketHandlers'),
    );

    expect(loginHandler).toContain('recoverOpenShiftFromLocal(database, this.posStore)');
    expect(loginHandler).toContain('if (localShiftRecoverySafe) this.scheduleShiftVerification(openShift?.id ?? null)');
  });

  it('recovers a local or server shift before creating a new one', () => {
    const source = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    const recovery = source.slice(
      source.indexOf('private async openOrRecoverShift'),
      source.indexOf('private allowCustomerDisplayIpc'),
    );
    const openHandler = source.slice(
      source.indexOf("ipcMain.handle('pos:shift:open'"),
      source.indexOf("ipcMain.handle('pos:shift:close'"),
    );

    expect(recovery).toContain('recoverOpenShiftFromLocal(database, this.posStore)');
    expect(recovery).toContain('apiClient.getActiveShift(token, machineId)');
    expect(recovery).toContain('await this.shiftController.retryUnsyncedShifts()');
    expect(recovery.indexOf('recoverOpenShiftFromLocal(database, this.posStore)'))
      .toBeLessThan(recovery.indexOf('this.shiftController.openShift'));
    expect(openHandler).toContain('this.shiftOpenInFlight');
    expect(openHandler).toContain('this.openOrRecoverShift(data)');
  });

  it('freshly verifies before collection and uses the order-bound token at protected tender boundaries', () => {
    const source = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('await this.refreshServerShiftConsistencyForPayment(openShift.id)');

    // The billiard handoff is the money path that still round-trips to the
    // server before it lets a tender start, so both of its entry points must
    // verify. Pinned by enclosing method rather than by a raw call count: the
    // ordinary POS preflight deliberately stopped waiting on the server (see
    // pos-payment-preflight-no-network-wait.test.ts), so a count would just
    // encode how many callers happen to exist today.
    const enclosing = (name: string): string => {
      const start = source.indexOf(`private async ${name}(`);
      expect(start, `${name}() not found`).toBeGreaterThan(-1);
      const next = source.indexOf('\n  private async ', start + 1);
      return source.slice(start, next === -1 ? source.length : next);
    };
    expect(enclosing('preflightBilliardHandoff'))
      .toContain('await this.refreshServerShiftConsistencyForPayment(openShift.id)');
    expect(enclosing('prepareBilliardHandoff'))
      .toContain('await this.refreshServerShiftConsistencyForPayment(openShift.id)');
    const billiardBoundary = source.slice(
      source.indexOf("ipcMain.handle('pos:billiard:begin-tender'"),
      source.indexOf("ipcMain.handle('pos:restored-cart:begin-tender'"),
    );
    const restoredBoundary = source.slice(
      source.indexOf("ipcMain.handle('pos:restored-cart:begin-tender'"),
      source.indexOf("ipcMain.handle('pos:billiard:resolve-uncertain-tender'"),
    );
    expect(billiardBoundary).toContain('this.assertOrdinaryPosPaymentPreflight(paymentPreflightToken, record.orderId, authContext)');
    expect(billiardBoundary).toContain('this.billiardTenderBoundaryInFlight.has(normalizedCheckoutId)');
    expect(billiardBoundary).toContain('this.billiardTenderBoundaryInFlight.add(normalizedCheckoutId)');
    expect(billiardBoundary).toContain('this.billiardTenderBoundaryInFlight.delete(normalizedCheckoutId)');
    expect(billiardBoundary).toContain('const latest = billiardPosHandoffRepo.get(record.checkoutId)');
    expect(restoredBoundary).toContain('this.assertOrdinaryPosPaymentPreflight(paymentPreflightToken, journal.orderId, authContext)');
    expect(billiardBoundary).not.toContain('refreshServerShiftConsistencyForPayment');
    expect(restoredBoundary).not.toContain('refreshServerShiftConsistencyForPayment');
    expect(source).toContain('Ignoring stale server shift verification result');
    expect(source).toContain('for (;;) {');
    expect(source).toContain('generation === this.shiftVerificationGeneration');
  });

  it('fails closed without machineId and never auto-merges different shift ids', () => {
    const source = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    const verifier = source.slice(
      source.indexOf('private async verifyShiftWithServer'),
      source.indexOf('private allowCustomerDisplayIpc'),
    );

    expect(verifier).toContain('if (!configuredMachineId)');
    expect(verifier).toContain('has no machineId');
    expect(verifier).toContain('getActiveShift(token, configuredMachineId)');
    expect(verifier).not.toContain('canReconcileActiveShift(');
    expect(verifier).not.toContain('UPDATE shifts SET backend_id');
    expect(source).not.toContain('canReconcileActiveShift(');
  });

  it('crosses the disk durability barrier before close sync, session clear, or Z-report printing', () => {
    const source = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    const finalize = source.slice(
      source.indexOf('private async finalizeDurableShiftClose'),
      source.indexOf('private capturePosAuthContext'),
    );
    const closeHandler = source.slice(
      source.indexOf("ipcMain.handle('pos:shift:close'"),
      source.indexOf("ipcMain.handle(\n      'self-checkout:help-request'"),
    );

    const barrier = finalize.indexOf('await database.saveCoalesced()');
    expect(barrier).toBeGreaterThan(-1);
    expect(barrier).toBeLessThan(finalize.indexOf('syncDurableShiftClose'));
    expect(barrier).toBeLessThan(finalize.indexOf('closeSessionIfShiftMatches([report.shiftId])'));
    expect(barrier).toBeLessThan(finalize.indexOf('printZReport(report)'));
    expect(finalize).toContain('durabilityPendingShiftCloses.set');
    expect(closeHandler).toContain('deferSyncUntilDurable: true');
    expect(closeHandler).toContain('return this.finalizeDurableShiftClose(report, true)');
  });

  it('coalesces concurrent Windows close requests for the same shift', () => {
    const source = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    const closeHandler = source.slice(
      source.indexOf("ipcMain.handle('pos:shift:close'"),
      source.indexOf("ipcMain.handle(\n      'self-checkout:help-request'"),
    );

    expect(source).toContain('private shiftCloseInFlight = new Map');
    expect(closeHandler).toContain('this.shiftCloseInFlight.get(data.shiftId)');
    expect(closeHandler).toContain('this.shiftCloseInFlight.set(data.shiftId, operation)');
    expect(closeHandler).toContain('this.shiftCloseInFlight.delete(data.shiftId)');
  });

  it('makes a new shift durable before backend sync, billiard open, or session activation', () => {
    const source = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    const recovery = source.slice(
      source.indexOf('private async openOrRecoverShift'),
      source.indexOf('private allowCustomerDisplayIpc'),
    );
    const finalize = source.slice(
      source.indexOf('private async finalizeDurableShiftOpen'),
      source.indexOf('private capturePosAuthContext'),
    );

    const openCall = recovery.indexOf('this.shiftController.openShift');
    const pendingLookup = recovery.indexOf('this.durabilityPendingShiftOpens.values()');
    const localRecovery = recovery.indexOf('recoverOpenShiftFromLocal(database, this.posStore)');
    const barrier = finalize.indexOf('await database.saveCoalesced()');
    const backendSync = finalize.indexOf('syncDurableShiftOpen', barrier);
    const billiardOpen = finalize.indexOf('this.billiardShiftLink?.open', barrier);
    const sessionOpen = finalize.indexOf("type: 'session/open'", barrier);

    expect(openCall).toBeGreaterThan(-1);
    expect(pendingLookup).toBeGreaterThan(-1);
    expect(pendingLookup).toBeLessThan(localRecovery);
    expect(recovery.slice(pendingLookup, localRecovery)).toContain(
      'return this.finalizeDurableShiftOpen(durabilityPending)',
    );
    expect(recovery.slice(openCall)).toContain('deferSyncUntilDurable: true');
    expect(recovery.slice(openCall)).toContain('return this.finalizeDurableShiftOpen');
    expect(barrier).toBeGreaterThan(-1);
    expect(backendSync).toBeGreaterThan(barrier);
    expect(billiardOpen).toBeGreaterThan(barrier);
    expect(sessionOpen).toBeGreaterThan(barrier);
    const durabilityDecision = finalize.slice(barrier, backendSync);
    expect(durabilityDecision).toMatch(/if\s*\(\s*!\w+\.success\s*\)/);
    expect(durabilityDecision).toContain('durabilityPending: true');
  });
});
