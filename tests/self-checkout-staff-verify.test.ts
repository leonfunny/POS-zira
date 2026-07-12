import { describe, expect, it } from 'vitest';
import {
  evaluateStaffVerify,
  initialStaffVerifyGate,
  isRealStaffCodeConfigured,
  LEGACY_DEFAULT_STAFF_CODE,
  STAFF_VERIFY_LOCKOUT_MS,
  StaffVerifyGate,
} from '../src/shared/self-checkout-staff-verify';

const T0 = 1_000_000;

describe('self-checkout staff verify (fail-closed gate)', () => {
  it('rejects when no code is configured — a public kiosk must fail closed', () => {
    const { result } = evaluateStaffVerify(initialStaffVerifyGate, '0000', undefined, T0);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_configured');
  });

  it('rejects the universally-known legacy default 123456 even if it is the configured code', () => {
    const { result } = evaluateStaffVerify(initialStaffVerifyGate, LEGACY_DEFAULT_STAFF_CODE, LEGACY_DEFAULT_STAFF_CODE, T0);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_configured');
    expect(isRealStaffCodeConfigured(LEGACY_DEFAULT_STAFF_CODE)).toBe(false);
  });

  it('accepts the correct configured code and resets the gate', () => {
    const { gate, result } = evaluateStaffVerify(initialStaffVerifyGate, '4821', '4821', T0);
    expect(result.valid).toBe(true);
    expect(gate).toEqual(initialStaffVerifyGate);
  });

  it('rejects a wrong code and decrements the attempt budget', () => {
    const { gate, result } = evaluateStaffVerify(initialStaffVerifyGate, '0000', '4821', T0);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('wrong');
    expect(gate.attemptsLeft).toBe(2);
  });

  it('locks out after 3 wrong attempts and the lock persists across a fresh gate reference (window remount)', () => {
    let gate: StaffVerifyGate = initialStaffVerifyGate;
    for (let i = 0; i < 3; i++) {
      gate = evaluateStaffVerify(gate, '0000', '4821', T0).gate;
    }
    // Even a correct code is refused while locked — the main-process gate is
    // authoritative, so re-opening the payment window cannot clear it.
    const locked = evaluateStaffVerify(gate, '4821', '4821', T0 + 1);
    expect(locked.result.valid).toBe(false);
    expect(locked.result.reason).toBe('locked');
    expect(locked.result.lockedUntil).toBe(T0 + STAFF_VERIFY_LOCKOUT_MS);
  });

  it('allows attempts again once the lockout window elapses', () => {
    const lockedGate: StaffVerifyGate = { attemptsLeft: 3, lockedUntil: T0 + STAFF_VERIFY_LOCKOUT_MS };
    const after = evaluateStaffVerify(lockedGate, '4821', '4821', T0 + STAFF_VERIFY_LOCKOUT_MS + 1);
    expect(after.result.valid).toBe(true);
  });

  it('does not spend the attempt budget on not_configured (config error is not a guess)', () => {
    const { gate } = evaluateStaffVerify(initialStaffVerifyGate, '0000', '   ', T0);
    expect(gate.attemptsLeft).toBe(3);
  });
});
