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
import { currentPosSnapshotScope, type PosSnapshotScope } from '../../../shared/pos/billiard-pos-handoff';
import { assertLocalOpenShiftMatchesSession } from '../../../shared/pos/open-shift-recovery';
import { PosAuthEpochGuard, type PosAuthContext } from '../../../shared/pos/pos-auth-epoch';
import type { AgentConfig } from '../../../shared/types';
import type { AndroidDatabase } from './db/db';
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
  };
}

export type AndroidBilliardHandoff = ReturnType<typeof createBilliardHandoff>;
