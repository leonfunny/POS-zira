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
  assertBilliardCheckoutSnapshotIntegrity,
  buildBilliardCheckoutSnapshot,
  buildBilliardInterruptionHoldPayload,
  capturePosCheckoutSnapshot,
  currentPosSnapshotScope,
  isActiveBilliardCheckoutSnapshot,
  samePosSnapshotScope,
  withoutRestoredInterruptionMarker,
  type PosSnapshotScope,
} from '../../../shared/pos/billiard-pos-handoff';
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

/** `crypto.randomUUID` in the WebView; the fallback keeps unit tests portable. */
function newId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
  };
}

export type AndroidBilliardHandoff = ReturnType<typeof createBilliardHandoff>;
