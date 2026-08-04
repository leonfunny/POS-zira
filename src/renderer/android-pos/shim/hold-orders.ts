/**
 * Hold / Recall for the Android till — parking a customer's basket.
 *
 * Ported from the Windows IPC handlers (pos.module.ts `pos:hold:*`). The repo
 * and its table were already here (hold-repo.ts, schema v5) serving the billiard
 * interrupted-cart path; nothing connected them to the cashier, so the toolbar
 * button was live and always failed. This is the wiring.
 *
 * WHY THIS IS A MONEY PATH, even though no money moves:
 *  - A parked basket is a sale the shop has not taken yet. Losing it loses the
 *    sale and the customer's patience, and the cashier has no way to reconstruct
 *    twenty scanned items from memory.
 *  - So a hold is only reported as held once it is ON DISK. A failed durability
 *    barrier rolls the row back and refuses — the cart stays on screen, which is
 *    recoverable. Claiming "held" over a lost row is not.
 *  - Recall is the same bet in reverse: the row is removed only after the cart
 *    has been put back, and a failed barrier restores BOTH sides.
 *
 * Scope rules carried over verbatim: a held cart belongs to one
 * (salon, user, register) and one POS mode, and the protected rows the billiard
 * interruption path owns are never listed, recalled or removed by a cashier.
 */

import {
  capturePosCheckoutSnapshot,
  currentPosSnapshotScope,
  samePosSnapshotScope,
  type PosSnapshotScope,
} from '../../../shared/pos/billiard-pos-handoff';
import {
  POS_CHECKOUT_SNAPSHOT_VERSION,
  type PosCheckoutSnapshot,
} from '../../../shared/billiard-pos-handoff';
import { PosAuthEpochGuard, type PosAuthContext } from '../../../shared/pos/pos-auth-epoch';
import type { AndroidDatabase } from './db/db';
import { createHoldOrderRepo } from './db/hold-repo';
import type { ShimConfigStore } from './config-store';
import type { ShimPosStore } from './pos-store';

export interface HoldOrdersDeps {
  configStore: ShimConfigStore;
  posStore: ShimPosStore;
  db: () => Promise<AndroidDatabase>;
}

export interface HoldResult {
  success: boolean;
  error?: string;
  rollbackDurabilityError?: string;
}

export function createHoldOrders(deps: HoldOrdersDeps) {
  const authEpoch = new PosAuthEpochGuard();
  /** One recall at a time — two concurrent recalls would race the live cart. */
  let recallInFlight: string | null = null;

  const scopeNow = (): PosSnapshotScope => currentPosSnapshotScope(deps.configStore.getRawConfig());
  const posModeNow = (): string => String((deps.configStore.getRawConfig() as any).posMode || 'retail');
  const isAuthCurrent = (context: PosAuthContext): boolean => {
    try {
      return authEpoch.isCurrent(context, scopeNow());
    } catch {
      // Identity became unreadable (signed out mid-flight) — treat as changed.
      return false;
    }
  };

  return {
    /** A new session must not inherit the previous cashier's epoch. */
    invalidateAuth(): void {
      authEpoch.advance();
      recallInFlight = null;
    },

    /** Park the live cart. pos.module.ts:5713-5786. */
    async createCurrent(id: string, title: string): Promise<HoldResult> {
      try {
        const holdId = String(id || '').trim();
        if (!holdId) return { success: false, error: 'A hold id is required.' };

        const state = deps.posStore.getState();
        if (!state.cart.items.length) return { success: false, error: 'Cart is empty.' };
        if (state.checkoutDraft?.billiard) {
          return { success: false, error: 'Frozen Billiard checkout cannot be held.' };
        }
        if (state.checkoutDraft?.kitchenSelfOrder?.pickupOrderId) {
          return { success: false, error: 'Active kitchen pickup cannot be held.' };
        }
        if ((state.checkoutDraft as any)?.restoredInterruption) {
          // The Windows counter validates a long list of safe-state conditions
          // before it lets a restored interruption cart be re-held. That slice
          // (beginRestoredTender + auto-restore) is not ported here, so the
          // conditions cannot be checked — refuse rather than hold a cart whose
          // ownership this build cannot reason about.
          return { success: false, error: 'A restored interruption cart can only be held at the Windows counter.' };
        }

        const scope = scopeNow();
        const authContext = authEpoch.capture(scope);
        const database = await deps.db();
        const repo = createHoldOrderRepo(database);

        const payload = {
          schemaVersion: POS_CHECKOUT_SNAPSHOT_VERSION,
          holdReason: 'MANUAL' as const,
          protected: false,
          snapshot: capturePosCheckoutSnapshot(state, scope, posModeNow()),
        };

        database.transaction(() => {
          repo.upsert(holdId, String(title || '').trim() || 'Held cart', payload);
          repo.prune();
        });

        // Durability barrier. Until this succeeds the cart is NOT held.
        let flushError: string | undefined;
        try {
          await database.flush();
        } catch (e: any) {
          flushError = e?.message || String(e);
        }
        if (flushError) {
          try {
            repo.remove(holdId, true);
            await database.flush().catch(() => { /* best effort */ });
          } catch { /* the live cart is still on screen either way */ }
          return { success: false, error: `Held cart was not saved: ${flushError}` };
        }

        if (!isAuthCurrent(authContext)) {
          // The row is on disk and belongs to the previous cashier, who can
          // recall it after signing back in. Do NOT clear the new user's screen.
          return {
            success: false,
            error: 'POS user changed after the Hold was saved; the previous user can recall it after login.',
          };
        }

        deps.posStore.dispatch({ type: 'cart/clear' });
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    },

    /** Put a parked cart back on screen. pos.module.ts:5848-5921. */
    async recall(id: string): Promise<HoldResult> {
      try {
        const holdId = String(id || '').trim();
        if (!holdId) return { success: false, error: 'A hold id is required.' };
        if (recallInFlight) {
          return { success: false, error: 'Another held cart recall is still being saved.' };
        }
        if (deps.posStore.getState().cart.items.length > 0) {
          return { success: false, error: 'Hold the current cart before recalling another one.' };
        }

        const scope = scopeNow();
        const authContext = authEpoch.capture(scope);
        const database = await deps.db();
        const repo = createHoldOrderRepo(database);
        const held = repo.get(holdId);

        if (!held?.payload?.snapshot || !samePosSnapshotScope(held.payload.snapshot, scope)) {
          return { success: false, error: 'Held cart does not belong to this salon, user, and register.' };
        }
        if (held.payload.protected === true) {
          return { success: false, error: 'This protected Billiard interruption cart is restored automatically after payment.' };
        }
        if (held.payload.snapshot.posMode !== posModeNow()) {
          return { success: false, error: `Switch POS to ${held.payload.snapshot.posMode} mode before recalling this cart.` };
        }

        // What to put back if the barrier fails — captured BEFORE we touch it.
        const beforeSnapshot = capturePosCheckoutSnapshot(deps.posStore.getState(), scope, posModeNow());
        const pending: PosCheckoutSnapshot = JSON.parse(JSON.stringify(held.payload.snapshot));
        (pending.state as any).checkoutDraft = {
          ...((pending.state as any).checkoutDraft || {}),
          holdRecallPending: { holdId },
        };

        recallInFlight = holdId;
        try {
          deps.posStore.dispatch({ type: 'state/replaceCheckoutSnapshot', payload: { snapshot: pending } });
          repo.remove(holdId);

          let flushError: string | undefined;
          try {
            await database.flush();
          } catch (e: any) {
            flushError = e?.message || String(e);
          }
          if (flushError) {
            // Both halves go back: the row returns to disk and the screen
            // returns to what the cashier had. A half-applied recall would
            // silently destroy a parked basket.
            repo.upsert(held.id, held.title, held.payload);
            if (isAuthCurrent(authContext)) {
              deps.posStore.dispatch({ type: 'state/replaceCheckoutSnapshot', payload: { snapshot: beforeSnapshot } });
            }
            let rollbackDurabilityError: string | undefined;
            try { await database.flush(); } catch (e: any) { rollbackDurabilityError = e?.message || String(e); }
            return {
              success: false,
              error: `Held cart recall was not saved; the live cart was rolled back: ${flushError}`,
              rollbackDurabilityError,
            };
          }

          if (!isAuthCurrent(authContext)) {
            repo.upsert(held.id, held.title, held.payload);
            let rollbackDurabilityError: string | undefined;
            try { await database.flush(); } catch (e: any) { rollbackDurabilityError = e?.message || String(e); }
            return {
              success: false,
              error: 'POS user changed during Hold recall; the held cart was put back rather than opened in another account.',
              rollbackDurabilityError,
            };
          }

          // Drop the pending marker now that the row is really gone.
          deps.posStore.dispatch({
            type: 'state/replaceCheckoutSnapshot',
            payload: { snapshot: held.payload.snapshot },
          });
          return { success: true };
        } finally {
          if (recallInFlight === holdId) recallInFlight = null;
        }
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    },

    /** Only this cashier's own, unprotected, same-mode holds. pos.module.ts:5924-5934. */
    async list(): Promise<any[]> {
      try {
        const scope = scopeNow();
        const repo = createHoldOrderRepo(await deps.db());
        return repo.list().filter((row: { id: string }) => {
          const held = repo.get(row.id);
          return held?.payload?.protected !== true
            && !!held?.payload?.snapshot
            && samePosSnapshotScope(held.payload.snapshot, scope);
        });
      } catch {
        return [];
      }
    },

    async get(id: string): Promise<any | null> {
      try {
        const scope = scopeNow();
        const held = createHoldOrderRepo(await deps.db()).get(String(id || '').trim());
        if (!held?.payload?.snapshot || !samePosSnapshotScope(held.payload.snapshot, scope)) return null;
        if (held.payload.protected === true) return null;
        return held;
      } catch {
        return null;
      }
    },

    /** Discard a parked cart. Protected rows are not the cashier's to discard. */
    async remove(id: string): Promise<HoldResult> {
      try {
        const holdId = String(id || '').trim();
        const scope = scopeNow();
        const database = await deps.db();
        const repo = createHoldOrderRepo(database);
        const held = repo.get(holdId);
        if (!held) return { success: false, error: 'Held cart not found.' };
        if (held.payload?.protected === true) {
          return { success: false, error: 'This protected Billiard interruption cart cannot be discarded.' };
        }
        if (!held.payload?.snapshot || !samePosSnapshotScope(held.payload.snapshot, scope)) {
          return { success: false, error: 'Held cart does not belong to this salon, user, and register.' };
        }
        repo.remove(holdId);
        try {
          await database.flush();
        } catch (e: any) {
          // The row is gone in memory but may come back on the next load.
          // Say so rather than reporting a clean discard.
          return { success: false, error: `Discard was not saved: ${e?.message || String(e)}` };
        }
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    },
  };
}

export type AndroidHoldOrders = ReturnType<typeof createHoldOrders>;
