/**
 * Android billiard POS-handoff orchestration (L5 of
 * docs/android-pos/2026-08-02-billiard-pos-handoff-port-plan.md).
 *
 * This is the tablet's half of the settle flow the shared PaymentDialog drives:
 * `onPreflightPos()` → `onPayInPos()` → the frozen cart is tendered in POS.
 * Windows implements it inside PosModule against Electron-only surroundings;
 * everything reusable has been lifted into `src/shared/pos/**` first (L3 + the
 * settle gates), so what is left here is genuinely platform-specific wiring:
 * which durability barrier, which fiscal channel, which register identity.
 *
 * MONEY PATH RULES, in force for every method added to this file:
 *  - Fail CLOSED. Ending a session stops the clock and freezes the bill; a
 *    refusal leaves the table running, which is always recoverable. A wrong
 *    "success" is not.
 *  - Never fake success on a failed durability barrier.
 *  - Refusals must name the fix, because the reader is a cashier with a
 *    customer waiting.
 */

import {
  assertBilliardFiscalPrinterReady,
  assertBilliardRealFiscalGate,
  TABLET_NOT_PAIRED_MESSAGE,
} from '../../../shared/pos/billiard-fiscal-gate';
import {
  adoptPosCheckoutSnapshotScope,
  assertBilliardCheckoutSnapshotIntegrity,
  buildBilliardCheckoutSnapshot,
  buildBilliardInterruptionHoldPayload,
  capturePosCheckoutSnapshot,
  currentPosSnapshotScope,
  isActiveBilliardCheckoutSnapshot,
  samePosSalonRegister,
  samePosSnapshotScope,
  withoutRestoredInterruptionMarker,
  type PosSnapshotScope,
} from '../../../shared/pos/billiard-pos-handoff';
import { assertCommittedBilliardOrder } from '../../../shared/pos/billiard-order-verification';
import {
  normalizeBilliardPosCheckout,
  requiresBilliardTenderReconciliation,
  type BilliardPaymentIntent,
} from '../../../shared/billiard-pos-handoff';
import { assertLocalOpenShiftMatchesSession } from '../../../shared/pos/open-shift-recovery';
import { PosAuthEpochGuard, type PosAuthContext } from '../../../shared/pos/pos-auth-epoch';
import { resolvePosMode } from './config-store';
import type { AgentConfig } from '../../../shared/types';
import type { AndroidDatabase } from './db/db';
import { createBilliardHandoffRepo, type BilliardPosHandoffRecord } from './db/billiard-handoff-repo';
import { createHoldOrderRepo } from './db/hold-repo';
import { createOrderRepo } from './db/order-repo';
import type { ShimConfigStore } from './config-store';
import type { ShimPosStore } from './pos-store';

export interface BilliardHandoffDeps {
  configStore: ShimConfigStore;
  posStore: ShimPosStore;
  /** Lazily-initialised SQL.js handle (the shim opens it on first use). */
  db: () => Promise<AndroidDatabase>;
  /** Is a fiscal printer ASSIGNED to this salon? (remote assignment lookup) */
  isFiscalPrinterAssigned: () => Promise<boolean>;
  /**
   * Is the print-agent socket up right now? D1: the tablet owns no printer, so
   * this socket IS the fiscal path — `assigned` alone is not liveness.
   */
  isPrintAgentConnected: () => boolean;
  /**
   * Verify the register's shift against the server and throw if the last
   * verified answer disagreed with the local journal. Windows runs the SAME
   * check on the billiard tender path — its beginTender calls
   * prepareOrdinaryPosPayment (pos.module.ts:2425), which is where the server
   * shift consistency lives. Optional so tests and the synthetic install can
   * omit it; when absent the boundary keeps its local-only guarantees.
   */
  assertServerShiftConsistent?: () => Promise<void>;
}

export interface BilliardPreflightResult {
  success: boolean;
  error?: string;
}

export interface BilliardPrepareResult {
  success: boolean;
  intent?: BilliardPaymentIntent;
  /** The tender outcome is ambiguous — never reopen payment, reconcile first. */
  outcomeUncertain?: boolean;
  error?: string;
}

export interface BilliardBoundaryResult {
  success: boolean;
  /** Payment must NOT be reopened — an owner has to reconcile the outcome. */
  outcomeUncertain?: boolean;
  /** The money is already recorded locally; charging again would double-bill. */
  paymentCommitted?: boolean;
  orderId?: string;
  token?: string;
  expiresAt?: number;
  error?: string;
  rollbackDurabilityError?: string;
  durabilityError?: string;
}

/** `crypto.randomUUID` in the WebView; the fallback keeps unit tests portable. */
function newId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** How long a payment preflight token stays usable (Windows: POS_PAYMENT_PREFLIGHT_TTL_MS). */
const PAYMENT_PREFLIGHT_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve the register identity, refusing with the actionable message when the
 * tablet has never paired (D2). On Android the only server-known identity is
 * `agentId`, written by agent-connect from the /print-agent/connect response.
 */
export function resolveTabletScope(config: AgentConfig): PosSnapshotScope {
  try {
    return currentPosSnapshotScope(config);
  } catch {
    throw new Error(TABLET_NOT_PAIRED_MESSAGE);
  }
}

export function createBilliardHandoff(deps: BilliardHandoffDeps) {
  // Same guard the Windows module uses: a scope captured before an await must
  // still be the signed-in cashier afterwards, or the work is abandoned.
  const authEpoch = new PosAuthEpochGuard();
  /** Concurrent prepares for the SAME checkout share one attempt — the renderer
   *  can fire twice (double tap, remount) and must not freeze two carts. */
  const inFlight = new Map<string, Promise<BilliardPrepareResult>>();

  const posMode = (): string => resolvePosMode(deps.configStore.getRawConfig());
  /**
   * Issued by markPaymentOpened, spent by beginTender. It binds the tender to
   * ONE order, ONE shift and ONE signed-in cashier, so a payment modal left
   * open across a shift change or a re-login cannot still collect money.
   */
  const paymentPreflights = new Map<string, {
    orderId: string;
    shiftId: string;
    authContext: PosAuthContext;
    expiresAt: number;
  }>();
  /** One tender boundary at a time per checkout — never charge twice. */
  const tenderBoundaryInFlight = new Set<string>();

  const prunePreflights = (): void => {
    const now = Date.now();
    for (const [token, entry] of paymentPreflights) {
      if (entry.expiresAt <= now) paymentPreflights.delete(token);
    }
  };

  const intentOf = (record: BilliardPosHandoffRecord, recovered = false): BilliardPaymentIntent => {
    const tenderOutcomeUncertain = requiresBilliardTenderReconciliation(record.state);
    return {
      checkoutId: record.checkoutId,
      sessionId: record.sessionId,
      orderId: record.orderId,
      clientAttemptId: record.clientAttemptId,
      nonce: newId(),
      shouldAutoOpen: !tenderOutcomeUncertain && !record.autoOpenConsumed && record.state === 'POS_READY',
      recovered,
      tenderOutcomeUncertain: tenderOutcomeUncertain || undefined,
    };
  };

  /**
   * Put the frozen cart on screen — atomically, and only if it is EXACTLY the
   * snapshot the journal holds (pos.module.ts applyBilliardHandoffSnapshot).
   */
  const activateSnapshot = (record: BilliardPosHandoffRecord, scope: PosSnapshotScope): void => {
    if (!samePosSnapshotScope(record.checkoutSnapshot, scope)) {
      throw new Error('Billiard checkout belongs to a different salon, user, or register.');
    }
    if (record.checkoutSnapshot.posMode !== posMode()) {
      throw new Error(
        `This checkout was frozen in ${record.checkoutSnapshot.posMode} mode. `
        + 'Switch POS back to that mode before resuming it.',
      );
    }
    assertBilliardCheckoutSnapshotIntegrity(record);
    deps.posStore.dispatch({
      type: 'state/replaceCheckoutSnapshot',
      payload: { snapshot: record.checkoutSnapshot },
    });
    if (!isActiveBilliardCheckoutSnapshot(deps.posStore.getState(), record.checkoutSnapshot)) {
      throw new Error('POS refused to activate the exact frozen Billiard cart.');
    }
  };

  /**
   * Nothing else may be half-finished on this register before a NEW bill is
   * frozen (pos.module.ts assertNewBilliardHandoffReadiness).
   */
  const assertReadyForNewHandoff = (
    database: AndroidDatabase,
    scope: PosSnapshotScope,
  ): { current: ReturnType<ShimPosStore['getState']> } => {
    const journal = createBilliardHandoffRepo(database);
    if (journal.getRecoverable(scope) || journal.getUncertainForOwner(scope)) {
      throw new Error('Another Billiard checkout is still unresolved on this register.');
    }
    const current = deps.posStore.getState();
    if (current.checkoutDraft.kitchenSelfOrder?.pickupOrderId) {
      throw new Error('Finish or release the active kitchen pickup order before paying a Billiard session.');
    }
    if (current.checkoutDraft.billiard) {
      throw new Error('Another frozen Billiard checkout is already active.');
    }
    if (current.checkoutDraft.restoredInterruption) {
      // The restored-cart journal machinery is not ported yet (next slice), so
      // rather than reason about a cart we cannot fully validate, refuse.
      throw new Error('Finish or hold the restored cart before ending another Billiard session.');
    }
    return { current };
  };

  const captureAuthContext = (scope?: PosSnapshotScope): PosAuthContext =>
    authEpoch.capture(scope ?? resolveTabletScope(deps.configStore.getRawConfig()));

  const isAuthContextCurrent = (context: PosAuthContext): boolean => {
    try {
      return authEpoch.isCurrent(context, resolveTabletScope(deps.configStore.getRawConfig()));
    } catch {
      return false;
    }
  };

  return {
    /** Advance the epoch on logout / salon switch so in-flight work aborts. */
    invalidateAuth(): void {
      authEpoch.advance();
    },

    /**
     * Everything that must hold BEFORE the server session is ended. Windows:
     * pos.module.ts preflightBilliardHandoff.
     *
     * Divergence, recorded rather than hidden: Windows additionally awaits its
     * server shift-verification scheduler
     * (refreshServerShiftConsistencyForPayment). The tablet has no equivalent
     * machinery yet, so it verifies the LOCAL shift only — a shift closed
     * server-side would not be caught here. Tracked in the plan doc; it does
     * not make the tablet worse than it is today, where nothing can settle at
     * all.
     */
    async preflight(): Promise<BilliardPreflightResult> {
      try {
        const config = deps.configStore.getRawConfig();
        const scope = resolveTabletScope(config);
        const authContext = captureAuthContext(scope);

        const database = await deps.db();
        // The cashier must own a complete, locally-journalled open shift.
        // AndroidDatabase already exposes the `all<T>(sql, params)` shape the
        // shared assertion needs — no adapter, no cast.
        assertLocalOpenShiftMatchesSession(database, deps.posStore);

        // D1 — fiscal readiness for a device that owns no printer.
        const assigned = await deps.isFiscalPrinterAssigned().catch(() => false);
        const fiscalPreflight = {
          allowRealFiscalPrint: (config as any).allowRealFiscalPrint,
          fiscalOnCashSale: (config as any).fiscalOnCashSale,
          // A tablet has no directly attached fiscal device. Hard false so the
          // go-live gate below keeps its meaning.
          localFiscalEnabled: false,
          detectedFiscalConfigured: assigned,
        };
        assertBilliardRealFiscalGate(fiscalPreflight);
        assertBilliardFiscalPrinterReady({
          ...fiscalPreflight,
          fiscalChannelConnected: assigned && deps.isPrintAgentConnected(),
        });

        // Durability barrier while the table is STILL RUNNING: if the journal
        // cannot be persisted now, the server session must not be ended.
        try {
          await database.flush();
        } catch (e: any) {
          throw new Error(`POS safety journal is not durable: ${e?.message || e}`);
        }

        if (!isAuthContextCurrent(authContext)) {
          throw new Error('POS user changed while Billiard payment readiness was being checked.');
        }
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      }
    },

    /**
     * Freeze the server's bill into the POS cart. Windows:
     * pos.module.ts prepareBilliardHandoff.
     *
     * The order of operations is the safety property, not an implementation
     * detail: the journal row and the protected hold are written in ONE
     * transaction, that transaction crosses a durability barrier BEFORE the
     * cart is touched, and a failed barrier rolls the in-memory DB back to the
     * still-live cart rather than leaving a half-frozen checkout.
     */
    prepare(input: { posCheckout?: unknown; tableName?: string | null }): Promise<BilliardPrepareResult> {
      let bundle;
      try {
        bundle = normalizeBilliardPosCheckout(input?.posCheckout);
      } catch (error: any) {
        return Promise.resolve({ success: false, error: error?.message || String(error) });
      }

      const running = inFlight.get(bundle.checkoutId);
      if (running) return running;

      const work = (async (): Promise<BilliardPrepareResult> => {
        try {
          const scope = resolveTabletScope(deps.configStore.getRawConfig());
          const authContext = captureAuthContext(scope);
          const database = await deps.db();
          const journal = createBilliardHandoffRepo(database);
          const holds = createHoldOrderRepo(database);
          const orders = createOrderRepo(database);

          // ── Resume: this checkout was already frozen ────────────────────
          const existing = journal.get(bundle.checkoutId);
          if (existing) {
            if (
              existing.salonId !== scope.salonId
              || existing.userId !== scope.userId
              || existing.registerId !== scope.registerId
              || existing.sessionId !== bundle.sessionId
              || JSON.stringify(existing.bundle) !== JSON.stringify(bundle)
            ) {
              throw new Error('This Billiard checkout ID already has a different frozen snapshot.');
            }
            assertBilliardCheckoutSnapshotIntegrity(existing);

            if (orders.getById(existing.orderId)) {
              // The local order is already committed. Verifying it needs the
              // billiard origin columns the Android `orders` table does not
              // carry yet (they arrive with the `complete` slice, which is also
              // the only thing that could have written such a row). Refuse
              // rather than clear a cart we cannot prove matches the order.
              throw new Error(
                'This Billiard checkout already has a committed local order. '
                + 'Finish it on the Windows counter — the tablet cannot yet verify a committed order.',
              );
            }
            if (requiresBilliardTenderReconciliation(existing.state)) {
              // Never reopen tender on an ambiguous outcome.
              return { success: true, outcomeUncertain: true, intent: intentOf(existing, true) };
            }

            assertLocalOpenShiftMatchesSession(database, deps.posStore);
            const liveCheckoutId = deps.posStore.getState().checkoutDraft.billiard?.origin.checkoutId;
            const liveItems = deps.posStore.getState().cart.items.length;
            if (liveItems > 0 && liveCheckoutId !== existing.checkoutId) {
              throw new Error('Another POS cart is active. Hold it before resuming this Billiard checkout.');
            }
            if (liveCheckoutId === existing.checkoutId) {
              if (!isActiveBilliardCheckoutSnapshot(deps.posStore.getState(), existing.checkoutSnapshot)) {
                throw new Error('The active POS cart does not exactly match the frozen Billiard checkout.');
              }
            } else {
              if (!isAuthContextCurrent(authContext)) {
                throw new Error('POS user changed before the Billiard checkout could be activated.');
              }
              activateSnapshot(existing, scope);
            }
            return { success: true, intent: intentOf(existing, true) };
          }

          // ── New checkout ────────────────────────────────────────────────
          assertLocalOpenShiftMatchesSession(database, deps.posStore);
          const { current } = assertReadyForNewHandoff(database, scope);

          const orderId = newId();
          // An in-progress ordinary cart is parked in a PROTECTED hold so the
          // cashier gets it back after the bill is paid — it is never discarded.
          const interruptedHoldId = current.cart.items.length > 0
            ? `billiard-interruption:${bundle.checkoutId}`
            : null;
          const mode = posMode();
          const interruptedSnapshot = interruptedHoldId
            ? withoutRestoredInterruptionMarker(capturePosCheckoutSnapshot(current, scope, mode))
            : null;
          const checkoutSnapshot = buildBilliardCheckoutSnapshot({
            currentState: current,
            bundle,
            scope,
            posMode: mode,
            orderId,
            interruptedHoldId,
            tableName: input?.tableName ? String(input.tableName) : null,
          });

          database.transaction(() => {
            if (interruptedHoldId && interruptedSnapshot) {
              holds.upsert(
                interruptedHoldId,
                'Cart interrupted by Billiard payment',
                buildBilliardInterruptionHoldPayload({
                  snapshot: interruptedSnapshot,
                  sessionId: bundle.sessionId,
                  checkoutId: bundle.checkoutId,
                }),
              );
            }
            journal.create({
              checkoutId: bundle.checkoutId,
              sessionId: bundle.sessionId,
              orderId,
              clientAttemptId: `billiard:${bundle.checkoutId}`,
              salonId: scope.salonId,
              userId: scope.userId,
              registerId: scope.registerId,
              state: 'POS_READY',
              bundle,
              checkoutSnapshot,
              interruptedHoldId,
              autoOpenConsumed: false,
            });
          });

          // Durability barrier BEFORE the cart is touched. On failure, revert
          // sql.js memory to the still-live cart ownership — a half-frozen
          // checkout is worse than no checkout.
          try {
            await database.flush();
          } catch (flushError: any) {
            try {
              database.transaction(() => {
                database.run('DELETE FROM pos_billiard_handoffs WHERE checkout_id = ?', [bundle.checkoutId]);
                if (interruptedHoldId) holds.remove(interruptedHoldId, true);
              });
              void database.flush().catch(() => { /* best-effort */ });
            } catch { /* the revert is best-effort; the throw below is what matters */ }
            throw new Error(`Could not safely hold the current POS cart: ${flushError?.message || flushError}`);
          }

          if (!isAuthContextCurrent(authContext)) {
            throw new Error(
              'POS user changed while the Billiard handoff was being saved. The old user can recover it after login.',
            );
          }

          const record = journal.get(bundle.checkoutId);
          if (!record) throw new Error('Billiard checkout journal was not created.');
          activateSnapshot(record, scope);
          return { success: true, intent: intentOf(record) };
        } catch (error: any) {
          return { success: false, error: error?.message || String(error) };
        }
      })().finally(() => { inFlight.delete(bundle.checkoutId); });

      inFlight.set(bundle.checkoutId, work);
      return work;
    },

    /**
     * The cashier opened the payment modal on a frozen bill. Windows:
     * pos:billiard:mark-payment-opened.
     *
     * Crossing POS_READY → POS_PAYMENT_OPEN is a durable step: if it cannot be
     * persisted it is rolled back, because a payment modal open over an
     * unpersisted boundary is exactly how a charge goes missing after a crash.
     */
    async markPaymentOpened(checkoutId: string): Promise<BilliardBoundaryResult> {
      try {
        const scope = resolveTabletScope(deps.configStore.getRawConfig());
        const authContext = captureAuthContext(scope);
        const database = await deps.db();
        const journal = createBilliardHandoffRepo(database);

        const record = journal.get(String(checkoutId || '').trim());
        if (
          !record
          || record.salonId !== scope.salonId
          || record.userId !== scope.userId
          || record.registerId !== scope.registerId
        ) {
          return { success: false, error: 'Billiard checkout not found on this register.' };
        }

        // Payment preflight: a live, complete, single open shift — re-verified
        // rather than trusted from prepare time.
        const openShift = assertLocalOpenShiftMatchesSession(database, deps.posStore);
        // …and the server has to agree that this register's shift is the one
        // still open. Throws only on a VERIFIED disagreement; being offline
        // leaves the local guarantees in place rather than freezing the till.
        if (deps.assertServerShiftConsistent) {
          await deps.assertServerShiftConsistent();
        }
        if (!isAuthContextCurrent(authContext)) {
          return { success: false, error: 'POS user changed while payment safety was being verified.' };
        }
        if (!isActiveBilliardCheckoutSnapshot(deps.posStore.getState(), record.checkoutSnapshot)) {
          return { success: false, error: 'The active POS cart does not match this frozen Billiard checkout.' };
        }

        if (!journal.markPaymentOpened(record.checkoutId)) {
          return { success: false, error: `Billiard checkout cannot open payment from state ${record.state}.` };
        }
        try {
          await database.flush();
        } catch (flushError: any) {
          journal.rollbackPaymentOpenedBeforeTender(record.checkoutId);
          let rollbackDurabilityError: string | undefined;
          try { await database.flush(); } catch (e: any) { rollbackDurabilityError = e?.message || String(e); }
          return {
            success: false,
            error: flushError?.message || 'Could not persist the Billiard payment-open boundary.',
            rollbackDurabilityError,
          };
        }
        if (!isAuthContextCurrent(authContext)) {
          return { success: false, error: 'POS user changed while Billiard payment was opening.' };
        }

        prunePreflights();
        const token = newId();
        const expiresAt = Date.now() + PAYMENT_PREFLIGHT_TTL_MS;
        paymentPreflights.set(token, {
          orderId: record.orderId,
          shiftId: openShift.id,
          authContext,
          expiresAt,
        });
        return { success: true, token, expiresAt };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      }
    },

    /**
     * The last gate before money is collected. Windows:
     * pos:billiard:begin-tender.
     *
     * Everything here is about NOT charging twice: a boundary already in
     * flight, an order already committed, a state that has already crossed the
     * boundary — each returns without authorizing a charge. The only automatic
     * backward transition is the one made while the renderer has NOT yet been
     * released past the boundary; once that is uncertain, an owner must
     * reconcile.
     */
    async beginTender(checkoutId: string, paymentPreflightToken: string): Promise<BilliardBoundaryResult> {
      const id = String(checkoutId || '').trim();
      if (tenderBoundaryInFlight.has(id)) {
        return {
          success: false,
          outcomeUncertain: true,
          error: 'This Billiard tender boundary is already being prepared. Do not collect payment twice.',
        };
      }
      tenderBoundaryInFlight.add(id);
      try {
        const scope = resolveTabletScope(deps.configStore.getRawConfig());
        const authContext = captureAuthContext(scope);
        const database = await deps.db();
        const journal = createBilliardHandoffRepo(database);
        const orders = createOrderRepo(database);

        const record = journal.get(id);
        if (
          !record
          || record.salonId !== scope.salonId
          || record.userId !== scope.userId
          || record.registerId !== scope.registerId
        ) {
          return { success: false, error: 'Billiard checkout not found on this register.' };
        }
        if (orders.getById(record.orderId)) {
          return {
            success: false,
            paymentCommitted: true,
            orderId: record.orderId,
            error: 'Payment is already recorded locally. Do not charge again.',
          };
        }

        // Spend the preflight token issued by markPaymentOpened.
        prunePreflights();
        const entry = paymentPreflights.get(String(paymentPreflightToken || '').trim());
        if (!entry) {
          return { success: false, error: 'POS payment preflight is missing or expired. Reopen payment before collecting money.' };
        }
        if (entry.orderId !== record.orderId) {
          return { success: false, error: 'POS payment preflight belongs to a different order.' };
        }
        if (entry.authContext.epoch !== authContext.epoch || !isAuthContextCurrent(entry.authContext)) {
          return { success: false, error: 'POS user changed after payment preflight. Reopen payment.' };
        }
        const openShift = assertLocalOpenShiftMatchesSession(database, deps.posStore);
        if (openShift.id !== entry.shiftId) {
          return { success: false, error: 'The POS shift changed after payment preflight. Reopen payment.' };
        }

        if (!isActiveBilliardCheckoutSnapshot(deps.posStore.getState(), record.checkoutSnapshot)) {
          return { success: false, error: 'The active POS cart does not match this frozen Billiard checkout.' };
        }
        if (record.state === 'POS_TENDER_COMMITTING') {
          return {
            success: false,
            outcomeUncertain: true,
            error: 'This Billiard tender was started by an earlier process or request. Do not charge again; reconcile it.',
          };
        }
        if (!journal.markTenderCommitting(record.checkoutId)) {
          const latestState = journal.get(record.checkoutId)?.state || record.state;
          return {
            success: false,
            outcomeUncertain: requiresBilliardTenderReconciliation(latestState),
            error: `Billiard tender cannot start from state ${latestState}.`,
          };
        }

        try {
          await database.flush();
        } catch (flushError: any) {
          // Safe: the renderer was never released past the boundary.
          journal.rollbackTenderBeforeCharge(record.checkoutId, true);
          let rollbackDurabilityError: string | undefined;
          try { await database.flush(); } catch (e: any) { rollbackDurabilityError = e?.message || String(e); }
          return {
            success: false,
            error: flushError?.message || 'Could not persist the Billiard tender boundary.',
            rollbackDurabilityError,
          };
        }

        if (!isAuthContextCurrent(authContext)) {
          const rolledBack = journal.rollbackTenderBeforeCharge(record.checkoutId, true);
          let rollbackOk = true;
          try { await database.flush(); } catch { rollbackOk = false; }
          if (!rolledBack || !rollbackOk) {
            journal.markTenderUncertainAfterRollbackFailure(record.checkoutId);
            let durabilityError: string | undefined;
            try { await database.flush(); } catch (e: any) { durabilityError = e?.message || String(e); }
            return {
              success: false,
              outcomeUncertain: true,
              error: 'POS user changed after the tender boundary was saved and its safe rollback could not be confirmed. '
                + 'Do not charge; owner reconciliation is required.',
              durabilityError,
            };
          }
          return { success: false, error: 'POS user changed before tender collection. No payment was authorized.' };
        }
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      } finally {
        tenderBoundaryInFlight.delete(id);
      }
    },

    /**
     * The order is committed locally — settle the handoff and give the cashier
     * their screen back. Windows: pos:billiard:complete-handoff.
     *
     * By the time this runs the money is already collected, so the cart is
     * cleared ONLY after the committed order has been proved, field by field,
     * to be the frozen allocation (shared assertCommittedBilliardOrder). If it
     * is not, this throws and the cashier keeps a cart to reconcile from —
     * clearing would destroy the last local evidence of what was owed.
     */
    async complete(checkoutId: string, orderId: string): Promise<{
      success: boolean;
      restored?: boolean;
      restoredHoldId?: string | null;
      durabilityError?: string;
      error?: string;
    }> {
      try {
        const scope = resolveTabletScope(deps.configStore.getRawConfig());
        const database = await deps.db();
        const journal = createBilliardHandoffRepo(database);
        const orders = createOrderRepo(database);

        const record = journal.get(String(checkoutId || '').trim());
        const order = record ? orders.getById(record.orderId) : null;
        if (
          !record
          || record.orderId !== orderId
          || record.salonId !== scope.salonId
          || record.userId !== scope.userId
          || record.registerId !== scope.registerId
          || !order
        ) {
          return { success: false, error: 'Committed Billiard order could not be verified.' };
        }

        assertBilliardCheckoutSnapshotIntegrity(record);
        assertCommittedBilliardOrder(record, order, orders.getItemsByOrderId(record.orderId));

        if (record.state !== 'SETTLED') {
          journal.markState(record.checkoutId, 'POS_PAID_SYNC_PENDING');
        }

        // Clear the frozen cart — but only the one that matches this record,
        // and only after the store itself authorises it (L4's exact-identity
        // unlock, which is what `cart/completeCheckout` requires).
        const state = deps.posStore.getState();
        const liveCheckoutId = state.checkoutDraft.billiard?.origin.checkoutId;
        if (liveCheckoutId) {
          if (
            liveCheckoutId !== record.checkoutId
            || !isActiveBilliardCheckoutSnapshot(state, record.checkoutSnapshot)
          ) {
            throw new Error('Refused to clear a POS cart that differs from the committed Billiard checkout.');
          }
          if (!deps.posStore.markBilliardOrderCommitted(record.checkoutId, record.orderId)) {
            throw new Error('Could not authorize clearing the committed Billiard cart.');
          }
          deps.posStore.dispatch({ type: 'cart/completeCheckout' });
        }

        // The parked cart stays in Holds for the cashier to recall. Automatic
        // restore needs the restored-cart journal machinery (next slice), and
        // reinstating a cart without it would hand back an unprotected cart —
        // so it is left where it is, never dropped.
        let durabilityError: string | undefined;
        try {
          await database.flush();
        } catch (e: any) {
          durabilityError = e?.message || String(e);
        }
        return {
          success: true,
          restored: false,
          restoredHoldId: record.interruptedHoldId,
          durabilityError,
        };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      }
    },

    /**
     * Pick the journal back up after the app died. Windows:
     * pos:billiard:recover-handoff.
     *
     * This is the method that makes a tablet safe to settle on at all. An
     * Android process is killed routinely — mid-payment, mid-tender — and the
     * journal outlives the cart. The single most important rule here is the
     * TENDER_COMMITTING branch: a process that died while committing a tender
     * leaves an outcome nobody can know, so recovery marks it UNCERTAIN and
     * payment is never reopened. Guessing "probably not charged" is how a
     * customer pays twice.
     *
     * An OWNER additionally sees an already-uncertain checkout, so the person
     * who can reconcile it can find it.
     */
    async recover(): Promise<{
      success: boolean;
      intent?: BilliardPaymentIntent | null;
      outcomeUncertain?: boolean;
      paymentCommitted?: boolean;
      durabilityError?: string;
      error?: string;
    }> {
      try {
        const config = deps.configStore.getRawConfig();
        const scope = resolveTabletScope(config);
        const authContext = captureAuthContext(scope);
        const database = await deps.db();
        const journal = createBilliardHandoffRepo(database);
        const orders = createOrderRepo(database);
        const isOwner = String(config.authUser?.role || '').toUpperCase() === 'OWNER';

        const record = journal.getRecoverable(scope)
          ?? (isOwner ? journal.getUncertainForOwner({ salonId: scope.salonId, registerId: scope.registerId }) : null);
        if (!record) {
          // Nothing of ours to resume. (Restored-cart discovery — the parked
          // ordinary cart — lands with the restored-cart journal slice; until
          // then a parked cart simply waits in Holds for manual recall.)
          return { success: true, intent: null };
        }

        assertBilliardCheckoutSnapshotIntegrity(record);

        // The money already landed locally before the crash.
        const committed = orders.getById(record.orderId);
        if (committed) {
          assertCommittedBilliardOrder(record, committed, orders.getItemsByOrderId(record.orderId));

          // ALREADY ON THE SERVER. `synced = 1` with a backend id is the local
          // proof that the settle round-trip finished; only the journal write
          // that closes it was lost (process killed between markSynced and
          // markState, or — as on 2026-08-04 — an older build that never wrote
          // the closing state at all). Without this the record sits in
          // POS_PAID_SYNC_PENDING forever, and because an unresolved checkout
          // blocks the register, the tablet can never settle another table:
          // a wedge that no cashier action can clear. Sync cannot fix it
          // either, since a synced order is never handed to sync again.
          if (record.state !== 'SETTLED' && committed.synced === 1 && committed.backend_id) {
            // Two hops on purpose: SETTLED is only reachable from
            // POS_PAID_SYNC_PENDING (billiard-handoff-repo.ts:179-183), and the
            // repo THROWS on an illegal jump. A record interrupted in
            // POS_READY/POS_PAYMENT_OPEN would otherwise crash recovery — which
            // runs at boot, so it would take the whole app down on launch.
            journal.markState(record.checkoutId, 'POS_PAID_SYNC_PENDING');
            journal.markState(record.checkoutId, 'SETTLED');
            let settleDurabilityError: string | undefined;
            try { await database.flush(); } catch (e: any) { settleDurabilityError = e?.message || String(e); }
            if (!isAuthContextCurrent(authContext)) {
              return { success: false, intent: null, paymentCommitted: true, error: 'POS user changed during Billiard recovery.' };
            }
            // Nothing for the cashier to resume: the money is in, the server
            // knows, the register is free again.
            return { success: true, paymentCommitted: true, durabilityError: settleDurabilityError, intent: null };
          }

          if (record.state !== 'SETTLED') {
            journal.markState(record.checkoutId, 'POS_PAID_SYNC_PENDING');
          }
          deps.posStore.markBilliardOrderCommitted(record.checkoutId, record.orderId);
          let durabilityError: string | undefined;
          try { await database.flush(); } catch (e: any) { durabilityError = e?.message || String(e); }
          if (!isAuthContextCurrent(authContext)) {
            return { success: false, intent: null, paymentCommitted: true, error: 'POS user changed during Billiard recovery.' };
          }
          return {
            success: true,
            paymentCommitted: true,
            durabilityError,
            intent: intentOf({ ...record, state: 'POS_PAID_SYNC_PENDING' }, true),
          };
        }

        // Died mid-tender: the outcome is unknowable from here.
        if (record.state === 'POS_TENDER_COMMITTING') {
          if (!journal.markTenderUncertain(record.checkoutId)) {
            return { success: false, intent: null, error: 'Could not lock the interrupted Billiard tender for reconciliation.' };
          }
          let durabilityError: string | undefined;
          try { await database.flush(); } catch (e: any) { durabilityError = e?.message || String(e); }
          if (!isAuthContextCurrent(authContext)) {
            return { success: false, intent: null, outcomeUncertain: true, error: 'POS user changed during tender recovery.' };
          }
          const uncertain = journal.get(record.checkoutId) ?? { ...record, state: 'POS_TENDER_UNCERTAIN' as const };
          return { success: true, outcomeUncertain: true, durabilityError, intent: intentOf(uncertain, true) };
        }
        if (record.state === 'POS_TENDER_UNCERTAIN') {
          return { success: true, outcomeUncertain: true, intent: intentOf(record, true) };
        }

        // READY / PAYMENT_OPEN: put the frozen bill back on screen, unless the
        // cashier has started something else that we must not overwrite.
        const current = deps.posStore.getState();
        const liveCheckout = current.checkoutDraft.billiard?.origin.checkoutId;
        if (current.cart.items.length === 0) {
          activateSnapshot(record, scope);
        } else if (
          liveCheckout !== record.checkoutId
          || !isActiveBilliardCheckoutSnapshot(current, record.checkoutSnapshot)
        ) {
          return {
            success: false,
            intent: null,
            error: 'Another POS cart is active. Hold it before resuming this Billiard checkout.',
          };
        }
        return { success: true, intent: intentOf(record, true) };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      }
    },

    /**
     * The way OUT of an uncertain tender. Windows:
     * pos:billiard:resolve-uncertain-tender (BILLIARD target).
     *
     * `recover()` can leave a checkout in POS_TENDER_UNCERTAIN, which is
     * deliberately a dead end for a cashier: nobody at the till can know
     * whether the customer's card was charged. Only an OWNER who has physically
     * checked the terminal may declare "no payment remains", and that
     * declaration is written into the journal as an append-only audit before
     * the checkout is reopened for payment.
     *
     * Every precondition is a refusal, not a warning.
     */
    async resolveUncertainTender(input: {
      target?: { type?: string; checkoutId?: string; holdId?: string };
      reason?: string;
      confirmedNoPaymentRemains?: boolean;
    }): Promise<{
      success: boolean;
      code?: string;
      resolved?: boolean;
      targetType?: string;
      audit?: unknown;
      intent?: BilliardPaymentIntent;
      paymentCommitted?: boolean;
      error?: string;
      rollbackDurabilityError?: string;
    }> {
      try {
        const config = deps.configStore.getRawConfig();
        if (String(config.authUser?.role || '').toUpperCase() !== 'OWNER') {
          return {
            success: false,
            code: 'OWNER_REQUIRED',
            error: 'Only the salon owner can resolve an uncertain payment outcome.',
          };
        }
        const ownerUserId = String(config.authUser?.id || '').trim();
        if (!ownerUserId) return { success: false, error: 'Owner identity is unavailable.' };

        // The reason is the audit trail. A blank or essay-length one is refused
        // so the record stays meaningful to whoever reads it months later.
        const reason = String(input?.reason || '').trim();
        if (reason.length < 3 || reason.length > 500) {
          return { success: false, error: 'Resolution reason must contain 3 to 500 characters.' };
        }
        if (input?.confirmedNoPaymentRemains !== true) {
          return {
            success: false,
            error: 'Explicit confirmation that no cash/card payment remains is required.',
          };
        }

        if (input?.target?.type !== 'BILLIARD') {
          // The RESTORED_CART lane needs the restored-cart journal, which is not
          // ported yet. Say so instead of silently doing nothing.
          return {
            success: false,
            error: 'Only a Billiard tender can be resolved on the tablet. Use the Windows counter for a restored cart.',
          };
        }

        const scope = resolveTabletScope(config);
        const authContext = captureAuthContext(scope);
        const database = await deps.db();
        const journal = createBilliardHandoffRepo(database);
        const holds = createHoldOrderRepo(database);
        const orders = createOrderRepo(database);

        const checkoutId = String(input.target.checkoutId || '').trim();
        const record = journal.get(checkoutId);
        // Scoped by salon+register, NOT by user: the owner resolving this is
        // usually not the cashier who left it uncertain.
        if (!record || record.salonId !== scope.salonId || record.registerId !== scope.registerId) {
          return { success: false, error: 'Uncertain Billiard checkout was not found for this owner/register.' };
        }
        if (record.state !== 'POS_TENDER_UNCERTAIN') {
          return { success: false, error: `Billiard tender cannot be resolved from state ${record.state}.` };
        }
        if (orders.getById(record.orderId)) {
          return {
            success: false,
            paymentCommitted: true,
            error: 'A local paid order exists. Reconcile it instead of resetting tender.',
          };
        }

        const live = deps.posStore.getState();
        if (live.cart.items.length > 0 && !isActiveBilliardCheckoutSnapshot(live, record.checkoutSnapshot)) {
          return { success: false, error: 'Another POS cart is active. Hold it before resolving this tender.' };
        }

        // The parked cart moves to the OWNER's scope along with the checkout,
        // but only if it is still exactly the protected hold we wrote.
        const interruptionBefore = record.interruptedHoldId ? holds.get(record.interruptedHoldId) : null;
        if (record.interruptedHoldId && (
          !interruptionBefore
          || interruptionBefore.payload?.protected !== true
          || interruptionBefore.payload?.holdReason !== 'BILLIARD_INTERRUPTION'
          || interruptionBefore.payload?.autoRestoreForCheckoutId !== record.checkoutId
          || !samePosSalonRegister(interruptionBefore.payload.snapshot, scope)
        )) {
          return { success: false, error: 'The protected interrupted cart cannot be safely adopted on this owner/register.' };
        }

        const audit = {
          ownerUserId,
          reason,
          confirmedAt: new Date().toISOString(),
          action: 'NO_PAYMENT_REMAINS' as const,
        };

        let resolved = false;
        database.transaction(() => {
          resolved = journal.resolveUncertainTenderAsNoPayment(checkoutId, audit, scope);
          if (resolved && interruptionBefore) {
            holds.replaceProtected(interruptionBefore.id, interruptionBefore.title, {
              ...interruptionBefore.payload,
              snapshot: adoptPosCheckoutSnapshotScope(interruptionBefore.payload.snapshot, scope),
            });
          }
        });
        if (!resolved) {
          return { success: false, error: 'The uncertain Billiard journal changed before it could be resolved.' };
        }

        try {
          await database.flush();
        } catch (flushError: any) {
          // Undo BOTH halves — an audit that is not on disk did not happen.
          database.transaction(() => {
            journal.rollbackNoPaymentResolution(checkoutId, audit, record);
            if (interruptionBefore) {
              holds.replaceProtected(interruptionBefore.id, interruptionBefore.title, interruptionBefore.payload);
            }
          });
          let rollbackDurabilityError: string | undefined;
          try { await database.flush(); } catch (e: any) { rollbackDurabilityError = e?.message || String(e); }
          return {
            success: false,
            error: flushError?.message || 'Owner resolution was not made durable.',
            rollbackDurabilityError,
          };
        }

        if (!isAuthContextCurrent(authContext)) {
          return {
            success: false,
            resolved: true,
            error: 'The owner resolution was saved, but the POS user changed. '
              + 'Sign in as the original owner to recover the cart.',
          };
        }

        const updated = journal.get(checkoutId);
        if (!updated || updated.state !== 'POS_PAYMENT_OPEN') {
          return { success: false, resolved: true, error: 'The owner resolution was saved but could not be reloaded.' };
        }
        if (deps.posStore.getState().cart.items.length === 0) {
          activateSnapshot(updated, scope);
        }
        return {
          success: true,
          resolved: true,
          targetType: 'BILLIARD',
          audit,
          intent: intentOf(updated, true),
        };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      }
    },
  };
}

export type AndroidBilliardHandoff = ReturnType<typeof createBilliardHandoff>;
