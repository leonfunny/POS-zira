/**
 * Sticky server-shift consistency for the payment boundary.
 *
 * The rule this encodes, taken verbatim from the Windows counter
 * (pos.module.ts verifyShiftWithServer): **a transport failure is not proof of
 * a mismatch.** Losing signal must never block the till — a shop with a flaky
 * 4G tablet would simply stop selling. Only an answer from the server that
 * actually disagrees with the local journal blocks payment, and that answer is
 * remembered until a later successful check clears it.
 *
 * The stickiness matters as much as the check. Without it, a cashier who hits a
 * verified mismatch could retry into an offline window and be waved straight
 * through, which is the one path where money lands in a shift the server
 * considers closed.
 *
 * Pure and dependency-free so both shells can hold the same state machine and
 * so every branch is unit-testable without a network.
 */

export interface ServerShiftConsistency {
  /**
   * A completed verification. `mismatch` is the message from
   * getVerifiedServerShiftMismatch (null when local and server agree).
   */
  recordVerified(mismatch: string | null): void;
  /**
   * The check could not reach the server. Deliberately a no-op on the stored
   * state: keep whatever the last real answer was, and keep selling.
   */
  recordUnreachable(): void;
  /** Throws with the remembered message when the last verified answer disagreed. */
  assertConsistent(): void;
  /** The remembered mismatch message, or null. */
  current(): string | null;
  /** Forget everything — a new session's shift has nothing to do with the old one. */
  reset(): void;
}

export function createServerShiftConsistency(): ServerShiftConsistency {
  let mismatch: string | null = null;

  return {
    recordVerified(next: string | null): void {
      mismatch = next && next.trim() ? next : null;
    },
    recordUnreachable(): void {
      // Intentionally empty. See the header: unreachable ≠ inconsistent.
    },
    assertConsistent(): void {
      if (mismatch) throw new Error(mismatch);
    },
    current(): string | null {
      return mismatch;
    },
    reset(): void {
      mismatch = null;
    },
  };
}
