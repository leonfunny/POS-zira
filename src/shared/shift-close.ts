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
