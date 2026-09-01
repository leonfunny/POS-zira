export const SHIFT_ALREADY_CLOSED = 'SHIFT_ALREADY_CLOSED';

export class ShiftAlreadyClosedError extends Error {
  readonly code = SHIFT_ALREADY_CLOSED;

  constructor(shiftId: string) {
    super(`Shift ${shiftId} is already closed`);
    this.name = 'ShiftAlreadyClosedError';
  }
}

export function isShiftAlreadyClosedError(error: unknown): error is ShiftAlreadyClosedError {
  return (error as { code?: unknown } | null)?.code === SHIFT_ALREADY_CLOSED;
}

/**
 * A delayed/concurrent close flow may only clear the renderer session it was
 * created for.  In particular, never let an old close response wipe a newer
 * shift (and its cart) that opened while network sync or Z-report printing was
 * still in progress.
 */
export function shouldCloseActiveShiftSession(
  activeShiftId: string | null | undefined,
  closingShiftIds: Iterable<string>,
): boolean {
  const active = String(activeShiftId || '').trim();
  if (!active) return false;
  for (const shiftId of closingShiftIds) {
    if (active === String(shiftId || '').trim()) return true;
  }
  return false;
}
