// Authoritative staff-code verification for the self-checkout assisted-payment
// gate. This is the ONLY thing standing between a public kiosk customer and
// self-approving "money received", so the rules here are deliberately strict:
//
//  - Fail closed: an unconfigured code (or the universally-known legacy default
//    '123456') NEVER verifies. The salon must set a real per-terminal code.
//  - Lockout lives in the MAIN process (this state is owned by the IPC handler),
//    so it cannot be bypassed by unmounting/remounting the payment window.
//  - Constant-time comparison so the code can't be recovered by timing.
//
// Pure + dependency-free on purpose: unit-tested directly and safe to import
// from either process.

export const STAFF_VERIFY_MAX_ATTEMPTS = 3;
export const STAFF_VERIFY_LOCKOUT_MS = 30_000;

// The hard-coded default that shipped in DEFAULT_DELETE_CONFIRM. A configured
// code equal to this is treated as "not configured" — it is public knowledge.
export const LEGACY_DEFAULT_STAFF_CODE = '123456';

export interface StaffVerifyGate {
  attemptsLeft: number;
  lockedUntil: number | null;
}

export const initialStaffVerifyGate: StaffVerifyGate = {
  attemptsLeft: STAFF_VERIFY_MAX_ATTEMPTS,
  lockedUntil: null,
};

export type StaffVerifyReason = 'ok' | 'not_configured' | 'locked' | 'wrong';

export interface StaffVerifyResult {
  valid: boolean;
  reason: StaffVerifyReason;
  attemptsLeft?: number;
  lockedUntil?: number | null;
}

// Constant-time string compare. Different lengths short-circuit to false; that
// only leaks the length of a short numeric PIN, which is acceptable here.
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function isRealStaffCodeConfigured(configuredCode: string | undefined | null): boolean {
  const configured = (configuredCode ?? '').trim();
  return configured.length > 0 && configured !== LEGACY_DEFAULT_STAFF_CODE;
}

/**
 * Evaluate one staff-code attempt against the current lockout gate.
 * Returns the next gate state and the result to hand back to the renderer.
 */
export function evaluateStaffVerify(
  gate: StaffVerifyGate,
  code: string,
  configuredCode: string | undefined | null,
  now: number,
): { gate: StaffVerifyGate; result: StaffVerifyResult } {
  const configured = (configuredCode ?? '').trim();

  // Fail closed before touching the lockout budget: an unconfigured / default
  // code can never authorize a payment, no matter what the customer types.
  if (!isRealStaffCodeConfigured(configured)) {
    return { gate, result: { valid: false, reason: 'not_configured' } };
  }

  // Still locked out from a previous burst of wrong guesses.
  if (gate.lockedUntil !== null && now < gate.lockedUntil) {
    return {
      gate,
      result: { valid: false, reason: 'locked', lockedUntil: gate.lockedUntil },
    };
  }

  // Lock window elapsed — start fresh before evaluating this attempt.
  const active: StaffVerifyGate =
    gate.lockedUntil !== null && now >= gate.lockedUntil ? initialStaffVerifyGate : gate;

  if (timingSafeEqualStr(String(code ?? ''), configured)) {
    return { gate: initialStaffVerifyGate, result: { valid: true, reason: 'ok' } };
  }

  const attemptsLeft = Math.max(0, active.attemptsLeft - 1);
  if (attemptsLeft === 0) {
    const lockedUntil = now + STAFF_VERIFY_LOCKOUT_MS;
    return {
      gate: { attemptsLeft: STAFF_VERIFY_MAX_ATTEMPTS, lockedUntil },
      result: { valid: false, reason: 'wrong', attemptsLeft: 0, lockedUntil },
    };
  }

  return {
    gate: { attemptsLeft, lockedUntil: null },
    result: { valid: false, reason: 'wrong', attemptsLeft },
  };
}
