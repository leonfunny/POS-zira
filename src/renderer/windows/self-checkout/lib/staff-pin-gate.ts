export const MAX_ATTEMPTS = 3;
export const LOCKOUT_MS = 30_000;

export interface StaffPinGateState {
  attemptsLeft: number;
  lockedUntil: number | null;
}

export const initialStaffPinGateState: StaffPinGateState = {
  attemptsLeft: MAX_ATTEMPTS,
  lockedUntil: null,
};

export function canAttempt(state: StaffPinGateState, now: number): boolean {
  return state.lockedUntil === null || now >= state.lockedUntil;
}

export function recordFailure(
  state: StaffPinGateState,
  now: number,
): StaffPinGateState {
  if (!canAttempt(state, now)) return state;

  const attemptsLeft = Math.max(0, state.attemptsLeft - 1);
  if (attemptsLeft === 0) {
    return {
      attemptsLeft: MAX_ATTEMPTS,
      lockedUntil: now + LOCKOUT_MS,
    };
  }

  return {
    attemptsLeft,
    lockedUntil: null,
  };
}

export function recordSuccess(): StaffPinGateState {
  return initialStaffPinGateState;
}
