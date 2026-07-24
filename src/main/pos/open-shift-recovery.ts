export interface LocalOpenShift {
  id: string;
  staff_id: string | null;
  staff_name: string | null;
  opened_at: string;
}

type ShiftRecoveryDatabase = {
  all<T>(sql: string, params?: unknown[]): T[];
};

type ShiftRecoveryStore = {
  getState(): {
    session?: {
      isOpen?: boolean;
      shiftId?: string | null;
      staffId?: string | null;
      staffName?: string | null;
    };
  };
  dispatch(action: {
    type: 'session/open';
    payload: {
      shiftId: string;
      staffId: string | null;
      staffName: string | null;
      openedAt: string;
    };
  }): unknown;
};

export function getSingleLocalOpenShift(
  db: ShiftRecoveryDatabase,
): LocalOpenShift | null {
  const openShifts = db.all<LocalOpenShift>(
    'SELECT id, staff_id, staff_name, opened_at FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC',
  );
  if (openShifts.length > 1) {
    throw new Error(
      'Multiple local POS shifts are open. Reconcile and close the duplicate shifts before taking payment.',
    );
  }
  return openShifts[0] ?? null;
}

export function assertLocalOpenShiftMatchesSession(
  db: ShiftRecoveryDatabase,
  store: ShiftRecoveryStore | null | undefined,
): LocalOpenShift {
  if (!store) throw new Error('POS is not ready.');

  const session = store.getState().session;
  const shiftId = String(session?.shiftId || '').trim();
  const staffId = String(session?.staffId || '').trim();
  const staffName = String(session?.staffName || '').trim();
  if (!session?.isOpen || !shiftId || !staffId || !staffName) {
    throw new Error('Open a complete POS shift before taking payment.');
  }

  const openShift = getSingleLocalOpenShift(db);
  if (!openShift || openShift.id !== shiftId) {
    throw new Error('The POS shift is not open in the local payment journal. Close and reopen the shift.');
  }
  if (
    !String(openShift.staff_id || '').trim()
    || !String(openShift.staff_name || '').trim()
    || openShift.staff_id !== staffId
  ) {
    throw new Error('The local POS shift staff is incomplete or does not match the active cashier.');
  }
  return openShift;
}

export function recoverOpenShiftFromLocal(
  db: ShiftRecoveryDatabase,
  store: ShiftRecoveryStore | null | undefined,
): LocalOpenShift | null {
  if (!store) return null;

  const openShift = getSingleLocalOpenShift(db);
  if (!openShift) return null;
  if (!String(openShift.staff_id || '').trim() || !String(openShift.staff_name || '').trim()) {
    throw new Error('The local POS shift has no complete cashier identity. Close and reopen the shift.');
  }

  const currentSession = store.getState().session;
  if (currentSession?.isOpen && currentSession.shiftId === openShift.id) {
    return openShift;
  }

  store.dispatch({
    type: 'session/open',
    payload: {
      shiftId: openShift.id,
      staffId: openShift.staff_id,
      staffName: openShift.staff_name,
      openedAt: openShift.opened_at,
    },
  });
  return openShift;
}
