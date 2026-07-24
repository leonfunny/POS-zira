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

  it('awaits the authoritative shift check at every protected tender entry point', () => {
    const source = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('await this.refreshServerShiftConsistencyForPayment(openShift.id)');
    expect(source.match(/await this\.refreshServerShiftConsistencyForPayment\(openShift\.id\)/g)?.length)
      .toBeGreaterThanOrEqual(5);
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
});
