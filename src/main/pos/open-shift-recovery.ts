export interface LocalOpenShift {
  id: string;
  staff_id: string | null;
  staff_name: string | null;
  opened_at: string;
}

type ShiftRecoveryDatabase = {
  get<T>(sql: string, params?: unknown[]): T | null | undefined;
};

type ShiftRecoveryStore = {
  getState(): {
    session?: {
      isOpen?: boolean;
      shiftId?: string | null;
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

export function recoverOpenShiftFromLocal(
  db: ShiftRecoveryDatabase,
  store: ShiftRecoveryStore | null | undefined,
): LocalOpenShift | null {
  if (!store) return null;

  const openShift = db.get<LocalOpenShift>(
    'SELECT id, staff_id, staff_name, opened_at FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1',
  ) ?? null;
  if (!openShift) return null;

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
