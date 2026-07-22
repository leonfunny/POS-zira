import type { BilliardCorrectionIntent } from '../database/repos/billiard-pos-handoff-repo';

interface CorrectionSourceIdentity {
  checkoutId: string;
  sessionId: string;
  salonId: string;
  userId: string;
  registerId: string;
}

interface CorrectionScope {
  salonId: string;
  userId: string;
  registerId: string;
}

/**
 * A salon OWNER may correct an order paid by STAFF/MANAGER. The settled
 * source is bound to salon + physical register + frozen checkout identity,
 * while current OWNER role/auth is enforced separately by the IPC handler.
 */
export function isBilliardCorrectionSourceForOwner(
  source: CorrectionSourceIdentity,
  scope: CorrectionScope,
  origin: { checkoutId?: unknown; sessionId?: unknown },
): boolean {
  return source.checkoutId === String(origin.checkoutId || '')
    && source.sessionId === String(origin.sessionId || '')
    && source.salonId === scope.salonId
    && source.registerId === scope.registerId;
}

export function resolveBilliardCorrectionCommand(
  existing: BilliardCorrectionIntent | null | undefined,
  requested: { requestId: string; reason: string },
): { requestId: string; reason: string } {
  return existing
    ? { requestId: existing.requestId, reason: existing.reason }
    : requested;
}
