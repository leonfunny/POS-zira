import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  assertLocalOpenShiftMatchesSession,
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
    expect(loginHandler).toContain('if (localShiftRecoverySafe) void this.verifyShiftWithServer(openShift?.id ?? null)');
  });
});
