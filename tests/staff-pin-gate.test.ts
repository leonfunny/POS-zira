import { describe, expect, it } from 'vitest';
import {
  LOCKOUT_MS,
  MAX_ATTEMPTS,
  canAttempt,
  initialStaffPinGateState,
  recordFailure,
  recordSuccess,
} from '../src/renderer/windows/self-checkout/lib/staff-pin-gate';

describe('staff PIN gate', () => {
  it('locks for 30 seconds after three failures and resets attempts', () => {
    const now = 10_000;
    let state = initialStaffPinGateState;

    state = recordFailure(state, now);
    expect(state).toEqual({ attemptsLeft: 2, lockedUntil: null });

    state = recordFailure(state, now + 1);
    expect(state).toEqual({ attemptsLeft: 1, lockedUntil: null });

    state = recordFailure(state, now + 2);
    expect(state).toEqual({ attemptsLeft: MAX_ATTEMPTS, lockedUntil: now + 2 + LOCKOUT_MS });
  });

  it('blocks attempts while locked and allows them again at lockedUntil', () => {
    const now = 20_000;
    const locked = {
      attemptsLeft: MAX_ATTEMPTS,
      lockedUntil: now + LOCKOUT_MS,
    };

    expect(canAttempt(locked, now + LOCKOUT_MS - 1)).toBe(false);
    expect(canAttempt(locked, now + LOCKOUT_MS)).toBe(true);
  });

  it('resets the counter on success', () => {
    const state = recordFailure(recordFailure(initialStaffPinGateState, 1_000), 1_001);

    expect(state.attemptsLeft).toBe(1);
    expect(recordSuccess()).toEqual(initialStaffPinGateState);
  });
});
