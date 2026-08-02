/**
 * Android billiard POS-handoff journal — port of the Windows
 * `billiardPosHandoffRepo` (src/main/database/repos/billiard-pos-handoff-repo.ts),
 * unchanged SQL and unchanged state machine.
 *
 * This is the durable record of a frozen billiard checkout while the cashier
 * tenders it in POS. Its state machine is the money-path safety net: every
 * transition is guarded, the backward edges exist only where the caller can
 * positively attest that no tender was charged, and a crossed tender boundary
 * can never silently become "paid".
 *
 *     POS_READY ─▶ POS_PAYMENT_OPEN ─▶ POS_TENDER_COMMITTING ─▶ POS_TENDER_UNCERTAIN
 *         │               │                      │                       │
 *         └───────────────┴──────────────────────┴───────────────────────┴─▶ POS_PAID_SYNC_PENDING ─▶ SETTLED
 *
 * Only the shape changes vs Windows: a factory bound to an injected
 * `AndroidDatabase` instead of a module singleton (local convention —
 * createOrderRepo/createProductRepo). `AndroidDatabase` exposes the same
 * get/run/all/transaction surface as the Windows `database` handle, so the
 * statements below are byte-identical to their source.
 */

import type {
  BilliardLocalHandoffState,
  BilliardPosCheckoutBundle,
  PosCheckoutSnapshot,
  TenderNoPaymentResolutionAudit,
} from '../../../../shared/billiard-pos-handoff';
import type { AndroidDatabase } from './db';

interface HandoffDbRow {
  checkout_id: string;
  session_id: string;
  order_id: string;
  client_attempt_id: string;
  salon_id: string;
  user_id: string;
  register_id: string;
  state: BilliardLocalHandoffState;
  snapshot_json: string;
  interrupted_hold_id: string | null;
  auto_open_consumed: number;
  created_at: string;
  updated_at: string;
}

export interface BilliardCorrectionIntent {
  orderId: string;
  requestId: string;
  reason: string;
  state: 'READY' | 'SERVER_CONFIRMED';
  updatedAt: string;
  response?: unknown;
}

export interface BilliardPosHandoffRecord {
  checkoutId: string;
  sessionId: string;
  orderId: string;
  clientAttemptId: string;
  salonId: string;
  userId: string;
  registerId: string;
  state: BilliardLocalHandoffState;
  bundle: BilliardPosCheckoutBundle;
  checkoutSnapshot: PosCheckoutSnapshot;
  interruptedHoldId: string | null;
  autoOpenConsumed: boolean;
  createdAt: string;
  updatedAt: string;
  tenderResolutionAudits?: TenderNoPaymentResolutionAudit[];
  correctionIntent?: BilliardCorrectionIntent;
}

function adapt(row: HandoffDbRow | null): BilliardPosHandoffRecord | null {
  if (!row) return null;
  try {
    const payload = JSON.parse(row.snapshot_json);
    return {
      checkoutId: row.checkout_id,
      sessionId: row.session_id,
      orderId: row.order_id,
      clientAttemptId: row.client_attempt_id,
      salonId: row.salon_id,
      userId: row.user_id,
      registerId: row.register_id,
      state: row.state,
      bundle: payload.bundle,
      checkoutSnapshot: payload.checkoutSnapshot,
      interruptedHoldId: row.interrupted_hold_id,
      autoOpenConsumed: row.auto_open_consumed === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tenderResolutionAudits: Array.isArray(payload.tenderResolutionAudits)
        ? payload.tenderResolutionAudits
        : [],
      correctionIntent: payload.correctionIntent && typeof payload.correctionIntent === 'object'
        ? payload.correctionIntent
        : undefined,
    };
  } catch {
    // An unparseable journal is treated as absent — never as a blank checkout.
    return null;
  }
}

export function createBilliardHandoffRepo(database: AndroidDatabase) {
  const repo = {
    get(checkoutId: string): BilliardPosHandoffRecord | null {
      return adapt(database.get<HandoffDbRow>(
        'SELECT * FROM pos_billiard_handoffs WHERE checkout_id = ?',
        [checkoutId],
      ));
    },

    getByOrderId(orderId: string): BilliardPosHandoffRecord | null {
      return adapt(database.get<HandoffDbRow>(
        'SELECT * FROM pos_billiard_handoffs WHERE order_id = ?',
        [orderId],
      ));
    },

    /** Crash-recovery lane, scoped to salon+user+register (never cross-tenant). */
    getRecoverable(scope: { salonId: string; userId: string; registerId: string }): BilliardPosHandoffRecord | null {
      return adapt(database.get<HandoffDbRow>(
        `SELECT * FROM pos_billiard_handoffs
         WHERE salon_id = ? AND user_id = ? AND register_id = ?
           AND state IN ('POS_READY', 'POS_PAYMENT_OPEN', 'POS_TENDER_COMMITTING', 'POS_TENDER_UNCERTAIN', 'POS_PAID_SYNC_PENDING')
         ORDER BY updated_at DESC LIMIT 1`,
        [scope.salonId, scope.userId, scope.registerId],
      ));
    },

    /** OWNER discovery lane: only ambiguous tender states, never active carts. */
    getUncertainForOwner(scope: { salonId: string; registerId: string }): BilliardPosHandoffRecord | null {
      return adapt(database.get<HandoffDbRow>(
        `SELECT * FROM pos_billiard_handoffs
         WHERE salon_id = ? AND register_id = ?
           AND state IN ('POS_TENDER_COMMITTING', 'POS_TENDER_UNCERTAIN')
         ORDER BY updated_at DESC LIMIT 1`,
        [scope.salonId, scope.registerId],
      ));
    },

    create(input: Omit<BilliardPosHandoffRecord, 'createdAt' | 'updatedAt'>): void {
      database.run(
        `INSERT INTO pos_billiard_handoffs (
          checkout_id, session_id, order_id, client_attempt_id,
          salon_id, user_id, register_id, state, snapshot_json,
          interrupted_hold_id, auto_open_consumed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [
          input.checkoutId,
          input.sessionId,
          input.orderId,
          input.clientAttemptId,
          input.salonId,
          input.userId,
          input.registerId,
          input.state,
          JSON.stringify({
            bundle: input.bundle,
            checkoutSnapshot: input.checkoutSnapshot,
            tenderResolutionAudits: input.tenderResolutionAudits ?? [],
            correctionIntent: input.correctionIntent,
          }),
          input.interruptedHoldId,
          input.autoOpenConsumed ? 1 : 0,
        ],
      );
    },

    markState(checkoutId: string, state: BilliardLocalHandoffState): boolean {
      const current = repo.get(checkoutId);
      if (!current) return false;
      if (current.state === state) return true;

      const allowed: Record<BilliardLocalHandoffState, BilliardLocalHandoffState[]> = {
        POS_READY: ['POS_PAYMENT_OPEN', 'POS_PAID_SYNC_PENDING'],
        POS_PAYMENT_OPEN: ['POS_TENDER_COMMITTING', 'POS_PAID_SYNC_PENDING'],
        POS_TENDER_COMMITTING: ['POS_TENDER_UNCERTAIN', 'POS_PAID_SYNC_PENDING'],
        POS_TENDER_UNCERTAIN: ['POS_PAID_SYNC_PENDING'],
        POS_PAID_SYNC_PENDING: ['SETTLED'],
        SETTLED: [],
      };
      if (!allowed[current.state].includes(state)) {
        throw new Error(`Invalid Billiard handoff transition: ${current.state} -> ${state}`);
      }

      database.run(
        `UPDATE pos_billiard_handoffs
         SET state = ?, updated_at = datetime('now')
         WHERE checkout_id = ? AND state = ?`,
        [state, checkoutId, current.state],
      );
      return repo.get(checkoutId)?.state === state;
    },

    markPaymentOpened(checkoutId: string): boolean {
      const current = repo.get(checkoutId);
      if (!current) return false;
      if (current.state === 'POS_PAYMENT_OPEN' && current.autoOpenConsumed) return true;
      if (current.state !== 'POS_READY') return false;
      database.run(
        `UPDATE pos_billiard_handoffs
         SET state = 'POS_PAYMENT_OPEN', auto_open_consumed = 1, updated_at = datetime('now')
         WHERE checkout_id = ? AND state = 'POS_READY'`,
        [checkoutId],
      );
      const updated = repo.get(checkoutId);
      return updated?.state === 'POS_PAYMENT_OPEN' && updated.autoOpenConsumed;
    },

    rollbackPaymentOpenedBeforeTender(checkoutId: string): boolean {
      const current = repo.get(checkoutId);
      if (!current || current.state !== 'POS_PAYMENT_OPEN') return false;
      database.run(
        `UPDATE pos_billiard_handoffs
         SET state = 'POS_READY', auto_open_consumed = 0, updated_at = datetime('now')
         WHERE checkout_id = ? AND state = 'POS_PAYMENT_OPEN'`,
        [checkoutId],
      );
      const updated = repo.get(checkoutId);
      return updated?.state === 'POS_READY' && !updated.autoOpenConsumed;
    },

    markTenderCommitting(checkoutId: string): boolean {
      const current = repo.get(checkoutId);
      if (!current) return false;
      if (current.state !== 'POS_PAYMENT_OPEN') return false;
      database.run(
        `UPDATE pos_billiard_handoffs
         SET state = 'POS_TENDER_COMMITTING', updated_at = datetime('now')
         WHERE checkout_id = ? AND state = 'POS_PAYMENT_OPEN'`,
        [checkoutId],
      );
      return repo.get(checkoutId)?.state === 'POS_TENDER_COMMITTING';
    },

    markTenderUncertain(checkoutId: string): boolean {
      const current = repo.get(checkoutId);
      if (!current) return false;
      if (current.state === 'POS_TENDER_UNCERTAIN') return true;
      if (current.state !== 'POS_TENDER_COMMITTING') return false;
      database.run(
        `UPDATE pos_billiard_handoffs
         SET state = 'POS_TENDER_UNCERTAIN', updated_at = datetime('now')
         WHERE checkout_id = ? AND state = 'POS_TENDER_COMMITTING'`,
        [checkoutId],
      );
      return repo.get(checkoutId)?.state === 'POS_TENDER_UNCERTAIN';
    },

    /**
     * This backward edge is intentionally unavailable after recovery has made
     * the outcome ambiguous. Callers must positively attest that no tender was
     * charged while the process is still in the pre-commit boundary.
     */
    rollbackTenderBeforeCharge(checkoutId: string, noChargeConfirmed: boolean): boolean {
      if (noChargeConfirmed !== true) return false;
      const current = repo.get(checkoutId);
      if (!current || current.state !== 'POS_TENDER_COMMITTING') return false;
      database.run(
        `UPDATE pos_billiard_handoffs
         SET state = 'POS_PAYMENT_OPEN', updated_at = datetime('now')
         WHERE checkout_id = ? AND state = 'POS_TENDER_COMMITTING'`,
        [checkoutId],
      );
      return repo.get(checkoutId)?.state === 'POS_PAYMENT_OPEN';
    },

    markTenderUncertainAfterRollbackFailure(checkoutId: string): boolean {
      const current = repo.get(checkoutId);
      if (!current) return false;
      if (current.state === 'POS_TENDER_UNCERTAIN') return true;
      if (current.state === 'POS_TENDER_COMMITTING') {
        return repo.markTenderUncertain(checkoutId);
      }
      if (current.state !== 'POS_PAYMENT_OPEN') return false;
      database.run(
        `UPDATE pos_billiard_handoffs
         SET state = 'POS_TENDER_UNCERTAIN', updated_at = datetime('now')
         WHERE checkout_id = ? AND state = 'POS_PAYMENT_OPEN'`,
        [checkoutId],
      );
      return repo.get(checkoutId)?.state === 'POS_TENDER_UNCERTAIN';
    },

    /** Owner-only caller persists audit and reset in one sql.js mutation. */
    resolveUncertainTenderAsNoPayment(
      checkoutId: string,
      audit: TenderNoPaymentResolutionAudit,
      adoptScope?: { salonId: string; userId: string; registerId: string },
    ): boolean {
      const current = repo.get(checkoutId);
      if (!current || current.state !== 'POS_TENDER_UNCERTAIN') return false;
      const audits = [...(current.tenderResolutionAudits ?? []), audit];
      const checkoutSnapshot = adoptScope
        ? { ...current.checkoutSnapshot, scope: { ...adoptScope } }
        : current.checkoutSnapshot;
      database.run(
        `UPDATE pos_billiard_handoffs
         SET state = 'POS_PAYMENT_OPEN', user_id = ?, snapshot_json = ?, updated_at = datetime('now')
         WHERE checkout_id = ? AND state = 'POS_TENDER_UNCERTAIN'`,
        [adoptScope?.userId ?? current.userId, JSON.stringify({
          bundle: current.bundle,
          checkoutSnapshot,
          tenderResolutionAudits: audits,
          correctionIntent: current.correctionIntent,
        }), checkoutId],
      );
      const updated = repo.get(checkoutId);
      return updated?.state === 'POS_PAYMENT_OPEN'
        && updated.userId === (adoptScope?.userId ?? current.userId)
        && JSON.stringify(updated.tenderResolutionAudits?.at(-1)) === JSON.stringify(audit);
    },

    /** Revert only the exact in-memory resolution whose disk barrier failed. */
    rollbackNoPaymentResolution(
      checkoutId: string,
      audit: TenderNoPaymentResolutionAudit,
      beforeResolution?: BilliardPosHandoffRecord,
    ): boolean {
      const current = repo.get(checkoutId);
      const audits = [...(current?.tenderResolutionAudits ?? [])];
      if (
        !current
        || current.state !== 'POS_PAYMENT_OPEN'
        || JSON.stringify(audits.at(-1)) !== JSON.stringify(audit)
      ) return false;
      audits.pop();
      const before = beforeResolution?.checkoutId === checkoutId
        && beforeResolution.state === 'POS_TENDER_UNCERTAIN'
        ? beforeResolution
        : null;
      database.run(
        `UPDATE pos_billiard_handoffs
         SET state = 'POS_TENDER_UNCERTAIN', user_id = ?, snapshot_json = ?, updated_at = datetime('now')
         WHERE checkout_id = ? AND state = 'POS_PAYMENT_OPEN'`,
        [before?.userId ?? current.userId, JSON.stringify({
          bundle: before?.bundle ?? current.bundle,
          checkoutSnapshot: before?.checkoutSnapshot ?? current.checkoutSnapshot,
          tenderResolutionAudits: before?.tenderResolutionAudits ?? audits,
          correctionIntent: before?.correctionIntent ?? current.correctionIntent,
        }), checkoutId],
      );
      const rolledBack = repo.get(checkoutId);
      return rolledBack?.state === 'POS_TENDER_UNCERTAIN'
        && rolledBack.userId === (before?.userId ?? current.userId);
    },

    setCorrectionIntent(orderId: string, intent: BilliardCorrectionIntent | null): boolean {
      const current = repo.getByOrderId(orderId);
      if (!current) return false;
      database.run(
        `UPDATE pos_billiard_handoffs
         SET snapshot_json = ?, updated_at = datetime('now')
         WHERE order_id = ?`,
        [JSON.stringify({
          bundle: current.bundle,
          checkoutSnapshot: current.checkoutSnapshot,
          tenderResolutionAudits: current.tenderResolutionAudits ?? [],
          correctionIntent: intent || undefined,
        }), orderId],
      );
      const updated = repo.getByOrderId(orderId);
      return intent
        ? JSON.stringify(updated?.correctionIntent) === JSON.stringify(intent)
        : updated?.correctionIntent == null;
    },
  };
  return repo;
}

export type AndroidBilliardHandoffRepo = ReturnType<typeof createBilliardHandoffRepo>;
