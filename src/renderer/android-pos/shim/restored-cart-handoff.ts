/**
 * Durable owner for an ordinary cart restored after a Billiard checkout.
 *
 * The protected Hold is the ledger. No second table is introduced: READY,
 * TENDER_COMMITTING, TENDER_UNCERTAIN and PAID_TOMBSTONE live in its versioned
 * JSON payload, and every cashier-visible forward transition crosses
 * AndroidDatabase.flush() first.
 */

import {
  adoptPosCheckoutSnapshotScope,
  currentPosSnapshotScope,
  getRestorableBilliardInterruptionSnapshot,
  hasEquivalentOrdinaryCart,
  isActiveRestoredCartSnapshot,
  isValidRestoredCartCheckoutJournal,
  samePosSalonRegister,
  samePosSnapshotScope,
  sameRestoredCartCheckoutIdentity,
  withRestoredInterruptionMarker,
  type PosSnapshotScope,
} from '../../../shared/pos/billiard-pos-handoff';
import {
  type PosHoldPayload,
  type ResolveUncertainTenderInput,
  type RestoredCartCheckoutJournal,
  type RestoredCartReconciliation,
  type TenderNoPaymentResolutionAudit,
} from '../../../shared/billiard-pos-handoff';
import { assertCommittedBilliardOrder } from '../../../shared/pos/billiard-order-verification';
import { assertLocalOpenShiftMatchesSession } from '../../../shared/pos/open-shift-recovery';
import { PosAuthEpochGuard, type PosAuthContext } from '../../../shared/pos/pos-auth-epoch';
import type { AndroidDatabase } from './db/db';
import { createBilliardHandoffRepo, type BilliardPosHandoffRecord } from './db/billiard-handoff-repo';
import { createHoldOrderRepo, type HoldOrderDetail } from './db/hold-repo';
import { createOrderRepo } from './db/order-repo';
import type { ShimConfigStore } from './config-store';
import { posReducer, type PosAction, type ShimPosStore } from './pos-store';

export interface ProtectedInterruptionRecoveryRequired {
  durable: boolean;
  count: number;
  holdId: string;
  checkoutId?: string;
  message: string;
}

export interface RestoredCartBoundaryResult {
  success: boolean;
  outcomeUncertain?: boolean;
  paymentCommitted?: boolean;
  orderId?: string;
  error?: string;
  rollbackDurabilityError?: string;
  durabilityError?: string;
  restoredCartReconciliation?: RestoredCartReconciliation;
  protectedInterruptionRecoveryRequired?: ProtectedInterruptionRecoveryRequired;
}

export interface RestoredCartRecoveryResult extends RestoredCartBoundaryResult {
  restoredCart: boolean;
  protectedInterruptionRecoveryRequired?: ProtectedInterruptionRecoveryRequired;
}

export interface RestoredCartHandoffDeps {
  configStore: ShimConfigStore;
  posStore: ShimPosStore;
  db: () => Promise<AndroidDatabase>;
  assertServerShiftConsistent?: () => Promise<void>;
}

interface RegisteredPaymentPreflight {
  token: string;
  orderId: string;
  shiftId: string;
  expiresAt: number;
  authContext: PosAuthContext;
}

export interface PreparedRestoredOrderCommit {
  held: HoldOrderDetail;
  payload: PosHoldPayload;
  journal: RestoredCartCheckoutJournal;
  context: NonNullable<ReturnType<ShimPosStore['getState']>['checkoutDraft']['restoredInterruption']>;
}

export interface StagedRestoredCart {
  held: HoldOrderDetail;
  payload: PosHoldPayload;
  checkoutId: string;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function now(): string {
  return new Date().toISOString();
}

function createJournal(): RestoredCartCheckoutJournal {
  const orderId = newId();
  return {
    orderId,
    clientAttemptId: `restored:${orderId}`,
    state: 'READY',
    updatedAt: now(),
  };
}

function diagnostic(rows: HoldOrderDetail[]): ProtectedInterruptionRecoveryRequired {
  const first = rows[0];
  const checkoutId = String(first.payload.autoRestoreForCheckoutId || '').trim();
  return {
    durable: true,
    count: rows.length,
    holdId: first.id,
    ...(checkoutId ? { checkoutId } : {}),
    message: `Recovery required: ${rows.length} protected cart${rows.length === 1 ? '' : 's'} `
      + 'cannot be verified on this tablet. Do not delete or charge them; contact the salon owner or support.',
  };
}

function diagnosticForContext(
  context: NonNullable<ReturnType<ShimPosStore['getState']>['checkoutDraft']['restoredInterruption']>,
  held: HoldOrderDetail | null,
  detail: string,
): ProtectedInterruptionRecoveryRequired {
  return {
    durable: held != null,
    count: held ? 1 : 0,
    holdId: held?.id ?? context.holdId,
    checkoutId: context.checkoutId,
    message: `Recovery required: ${detail} Do not charge, delete, or reassign this cart; contact the salon owner or support.`,
  };
}

export function createRestoredCartHandoff(deps: RestoredCartHandoffDeps) {
  const authEpoch = new PosAuthEpochGuard();
  const preflights = new Map<string, RegisteredPaymentPreflight>();
  let dispatchQueue: Promise<void> = Promise.resolve();

  const scopeNow = (): PosSnapshotScope => currentPosSnapshotScope(deps.configStore.getRawConfig());
  const posModeNow = (): string => String((deps.configStore.getRawConfig() as any).posMode || 'retail');
  const isAuthCurrent = (context: PosAuthContext): boolean => {
    try { return authEpoch.isCurrent(context, scopeNow()); } catch { return false; }
  };
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = dispatchQueue.then(work, work);
    dispatchQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  const reconciliation = (
    holdId: string,
    checkoutId: string,
    journal: RestoredCartCheckoutJournal,
  ): RestoredCartReconciliation => ({
    holdId,
    checkoutId,
    orderId: journal.orderId,
    clientAttemptId: journal.clientAttemptId,
    reason: 'TENDER_OUTCOME_UNCERTAIN',
    message: 'Payment outcome is uncertain. Do not charge this cart again. '
      + 'Reconcile cash/card and POS Order History with the owner.',
  });

  const markLive = (
    held: HoldOrderDetail,
    payload: PosHoldPayload,
    persistenceError?: string,
    authContext?: PosAuthContext,
  ): void => {
    if (authContext && !isAuthCurrent(authContext)) return;
    if (!isValidRestoredCartCheckoutJournal(payload.restoredCheckout)) return;
    deps.posStore.dispatch({
      type: 'state/replaceCheckoutSnapshot',
      payload: {
        snapshot: withRestoredInterruptionMarker(
          payload.snapshot,
          held.id,
          String(payload.autoRestoreForCheckoutId || ''),
          payload.restoredCheckout,
          persistenceError,
        ),
      },
    });
  };

  const assertExistingOrder = (
    database: AndroidDatabase,
    payload: PosHoldPayload,
    journal: RestoredCartCheckoutJournal,
  ): boolean => {
    const orders = createOrderRepo(database);
    const existing = orders.getById(journal.orderId);
    if (!existing) return false;
    if (
      String(existing.client_attempt_id || '') !== journal.clientAttemptId
      || existing.billiard_origin_json != null
    ) {
      throw new Error('Existing local order conflicts with the restored-cart payment identity.');
    }
    const expected = payload.snapshot.state as any;
    const items = orders.getItemsByOrderId(journal.orderId);
    if (
      Number(existing.subtotal) !== Number(expected.cart?.subtotal)
      || Number(existing.discount) !== Number(expected.cart?.discount)
      || Number(existing.tax) !== Number(expected.cart?.tax)
      || Number(existing.total) !== Number(expected.cart?.total)
      || items.length !== expected.cart?.items?.length
    ) {
      throw new Error('Existing local order conflicts with the restored-cart financial snapshot.');
    }
    expected.cart.items.forEach((cartItem: any, index: number) => {
      const item = items[index];
      if (
        !item
        || String(item.variant_id || '') !== String(cartItem.variantId || '')
        || String(item.name || '') !== String(cartItem.name || '')
        || Number(item.price) !== Number(cartItem.price)
        || Number(item.quantity) !== Number(cartItem.quantity)
        || Number(item.total) !== Number(cartItem.total)
        || Number(item.vat_rate ?? 23) !== Number(cartItem.vatRate ?? 23)
      ) {
        throw new Error(`Existing local order line ${index + 1} conflicts with the restored cart.`);
      }
    });
    return true;
  };

  const validateOrderRequest = (
    prepared: PreparedRestoredOrderCommit,
    order: Record<string, any>,
    items: Array<Record<string, any>>,
  ): void => {
    const { journal, payload, context } = prepared;
    if (!sameRestoredCartCheckoutIdentity(context, journal)) {
      throw new Error('Renderer restored-cart identity does not match the protected journal.');
    }
    if (
      String(order.id || '') !== journal.orderId
      || String(order.client_attempt_id || '') !== journal.clientAttemptId
      || order.billiard_origin_json != null
    ) {
      throw new Error('Restored-cart order identity was not issued by the durable journal.');
    }
    if (journal.state !== 'TENDER_COMMITTING') {
      throw new Error(`Restored-cart tender is not authorized from state ${journal.state}.`);
    }
    const state = deps.posStore.getState();
    if (!isActiveRestoredCartSnapshot(state, payload.snapshot)) {
      throw new Error('The active restored cart does not exactly match its durable protected snapshot.');
    }
    if (
      Number(order.subtotal) !== state.cart.subtotal
      || Number(order.discount) !== state.cart.discount
      || Number(order.tax) !== state.cart.tax
      || Number(order.total) !== state.cart.total
      || items.length !== state.cart.items.length
    ) {
      throw new Error('Restored-cart order totals do not match the protected cart.');
    }
    state.cart.items.forEach((cartItem, index) => {
      const item = items[index];
      if (
        !item
        || String(item.variant_id || '') !== String(cartItem.variantId || '')
        || String(item.name || '') !== String(cartItem.name || '')
        || Number(item.price) !== cartItem.price
        || Number(item.quantity) !== cartItem.quantity
        || Number(item.total) !== cartItem.total
        || Number(item.vat_rate ?? 23) !== Number(cartItem.vatRate ?? 23)
      ) {
        throw new Error(`Restored-cart order line ${index + 1} does not match the protected cart.`);
      }
    });
  };

  const loadActivePrepared = (
    database: AndroidDatabase,
    requiredState?: RestoredCartCheckoutJournal['state'],
  ): PreparedRestoredOrderCommit | null => {
    const state = deps.posStore.getState();
    const context = state.checkoutDraft.restoredInterruption;
    if (!context) return null;
    const scope = scopeNow();
    const held = createHoldOrderRepo(database).get(context.holdId);
    const payload = held?.payload as PosHoldPayload | undefined;
    const journal = payload?.restoredCheckout;
    if (
      !held
      || !payload
      || payload.protected !== true
      || payload.holdReason !== 'BILLIARD_INTERRUPTION'
      || payload.restoreState !== 'ACTIVE_CART_BACKUP'
      || payload.autoRestoreForCheckoutId !== context.checkoutId
      || !samePosSnapshotScope(payload.snapshot, scope)
      || payload.snapshot.posMode !== posModeNow()
      || !isValidRestoredCartCheckoutJournal(journal)
      || !sameRestoredCartCheckoutIdentity(context, journal)
      || (requiredState != null && journal.state !== requiredState)
      || !isActiveRestoredCartSnapshot(state, payload.snapshot)
    ) {
      throw new Error('The active restored cart does not match its exact durable owner.');
    }
    return { held, payload, journal, context };
  };

  const markPreparedFailureUncertain = async (
    database: AndroidDatabase,
    prepared: PreparedRestoredOrderCommit,
    message: string,
    activateLive = true,
  ): Promise<RestoredCartBoundaryResult> => {
    const uncertain: RestoredCartCheckoutJournal = {
      ...prepared.journal,
      state: 'TENDER_UNCERTAIN',
      updatedAt: now(),
    };
    const payload = { ...prepared.payload, restoreState: 'ACTIVE_CART_BACKUP' as const, restoredCheckout: uncertain };
    createHoldOrderRepo(database).replaceProtected(prepared.held.id, prepared.held.title, payload);
    let durabilityError: string | undefined;
    try { await database.flush(); } catch (e: any) { durabilityError = e?.message || String(e); }
    const persistenceError = `Restored-cart payment must be reconciled: ${message}`;
    if (activateLive) {
      markLive(prepared.held, payload, durabilityError
        ? `${persistenceError} (${durabilityError})`
        : persistenceError);
    }
    return {
      success: false,
      outcomeUncertain: true,
      error: `Restored-cart payment outcome is uncertain. Do not charge again. ${message}`,
      durabilityError,
      restoredCartReconciliation: reconciliation(prepared.held.id, prepared.context.checkoutId, uncertain),
    };
  };

  const api = {
    invalidateAuth(): void {
      authEpoch.advance();
      preflights.clear();
    },

    registerPaymentPreflight(input: {
      token: string;
      orderId: string;
      shiftId: string;
      expiresAt: number;
    }): void {
      const token = String(input.token || '').trim();
      if (!token) return;
      preflights.set(token, {
        ...input,
        token,
        authContext: authEpoch.capture(scopeNow()),
      });
    },

    beginTender(holdId: string, token: string): Promise<RestoredCartBoundaryResult> {
      return enqueue(async () => {
        try {
          const scope = scopeNow();
          const authContext = authEpoch.capture(scope);
          const database = await deps.db();
          const holds = createHoldOrderRepo(database);
          const held = holds.get(String(holdId || '').trim());
          const state = deps.posStore.getState();
          const context = state.checkoutDraft.restoredInterruption;
          const payload = held?.payload as PosHoldPayload | undefined;
          const journal = payload?.restoredCheckout;
          if (
            !held
            || !context
            || context.holdId !== held.id
            || !payload
            || payload.protected !== true
            || payload.holdReason !== 'BILLIARD_INTERRUPTION'
            || payload.restoreState !== 'ACTIVE_CART_BACKUP'
            || !samePosSnapshotScope(payload.snapshot, scope)
            || !isValidRestoredCartCheckoutJournal(journal)
            || !sameRestoredCartCheckoutIdentity(context, journal)
          ) {
            return { success: false, error: 'The active restored cart does not match this tender request.' };
          }
          if (createOrderRepo(database).getById(journal.orderId)) {
            return {
              success: false,
              paymentCommitted: true,
              orderId: journal.orderId,
              error: 'Payment is already recorded locally. Do not charge again.',
            };
          }
          if (journal.state === 'TENDER_COMMITTING' || journal.state === 'TENDER_UNCERTAIN') {
            return {
              success: false,
              outcomeUncertain: true,
              error: 'This restored-cart tender already crossed the safety boundary. Do not charge again; reconcile it.',
            };
          }
          if (journal.state !== 'READY' || context.persistenceError) {
            return { success: false, error: context.persistenceError || 'This restored cart is not safe to tender.' };
          }

          const normalizedToken = String(token || '').trim();
          const preflight = preflights.get(normalizedToken);
          if (!preflight || preflight.expiresAt <= Date.now()) {
            preflights.delete(normalizedToken);
            return { success: false, error: 'POS payment preflight is missing or expired. Reopen payment.' };
          }
          if (preflight.orderId !== journal.orderId) {
            return { success: false, error: 'POS payment preflight belongs to a different order.' };
          }
          if (!isAuthCurrent(preflight.authContext) || preflight.authContext.epoch !== authContext.epoch) {
            return { success: false, error: 'POS user changed after payment preflight. Reopen payment.' };
          }
          const openShift = assertLocalOpenShiftMatchesSession(database, deps.posStore);
          if (openShift.id !== preflight.shiftId) {
            return { success: false, error: 'The POS shift changed after payment preflight. Reopen payment.' };
          }
          if (deps.assertServerShiftConsistent) await deps.assertServerShiftConsistent();
          if (!isActiveRestoredCartSnapshot(state, payload.snapshot)) {
            return { success: false, error: 'The active cart does not exactly match its durable protected snapshot.' };
          }

          const committing: RestoredCartCheckoutJournal = {
            ...journal,
            state: 'TENDER_COMMITTING',
            updatedAt: now(),
          };
          const committingPayload = { ...payload, restoredCheckout: committing };
          holds.replaceProtected(held.id, held.title, committingPayload);
          try {
            await database.flush();
          } catch (flushError: any) {
            holds.replaceProtected(held.id, held.title, payload);
            try {
              await database.flush();
              markLive(held, payload, undefined, authContext);
              return {
                success: false,
                error: flushError?.message || 'Could not persist the restored-cart tender boundary.',
              };
            } catch (rollbackError: any) {
              const uncertain: RestoredCartCheckoutJournal = {
                ...journal,
                state: 'TENDER_UNCERTAIN',
                updatedAt: now(),
              };
              const uncertainPayload = { ...payload, restoredCheckout: uncertain };
              holds.replaceProtected(held.id, held.title, uncertainPayload);
              let durabilityError: string | undefined;
              try { await database.flush(); } catch (e: any) { durabilityError = e?.message || String(e); }
              markLive(held, uncertainPayload, durabilityError, authContext);
              return {
                success: false,
                outcomeUncertain: true,
                error: 'The tender boundary and its rollback could not be confirmed. Do not charge; owner reconciliation is required.',
                rollbackDurabilityError: rollbackError?.message || String(rollbackError),
                durabilityError,
                restoredCartReconciliation: reconciliation(held.id, context.checkoutId, uncertain),
              };
            }
          }

          if (!isAuthCurrent(authContext)) {
            holds.replaceProtected(held.id, held.title, payload);
            try {
              await database.flush();
              return { success: false, error: 'POS user changed before tender collection. No payment was authorized.' };
            } catch (rollbackError: any) {
              const uncertain: RestoredCartCheckoutJournal = {
                ...journal,
                state: 'TENDER_UNCERTAIN',
                updatedAt: now(),
              };
              const uncertainPayload = { ...payload, restoredCheckout: uncertain };
              holds.replaceProtected(held.id, held.title, uncertainPayload);
              let durabilityError: string | undefined;
              try { await database.flush(); } catch (e: any) { durabilityError = e?.message || String(e); }
              return {
                success: false,
                outcomeUncertain: true,
                error: 'POS user changed and the restored-cart tender rollback could not be confirmed.',
                rollbackDurabilityError: rollbackError?.message || String(rollbackError),
                durabilityError,
                restoredCartReconciliation: reconciliation(held.id, context.checkoutId, uncertain),
              };
            }
          }
          preflights.delete(normalizedToken);
          markLive(held, committingPayload, undefined, authContext);
          return { success: true };
        } catch (error: any) {
          return { success: false, error: error?.message || String(error) };
        }
      });
    },

    recover(): Promise<RestoredCartRecoveryResult> {
      return enqueue(async () => {
        const empty = (extra: Partial<RestoredCartRecoveryResult> = {}): RestoredCartRecoveryResult => ({
          success: true,
          restoredCart: false,
          ...extra,
        });
        try {
          const scope = scopeNow();
          const authContext = authEpoch.capture(scope);
          const database = await deps.db();
          const holds = createHoldOrderRepo(database);
          const orders = createOrderRepo(database);
          const billiardJournal = createBilliardHandoffRepo(database);
          const relevant = holds.listDetailed().filter((held) => (
            held.payload.protected === true
            && held.payload.holdReason === 'BILLIARD_INTERRUPTION'
            && held.payload.restoreState !== 'PAID_TOMBSTONE'
            && samePosSalonRegister(held.payload.snapshot, scope)
          ));
          if (relevant.length === 0) return empty();

          const exactScope = relevant.filter((held) => samePosSnapshotScope(held.payload.snapshot, scope));
          const isOwner = String(deps.configStore.getRawConfig().authUser?.role || '').toUpperCase() === 'OWNER';
          const ownerUncertain = isOwner
            ? relevant.find((held) => {
                const journal = held.payload.restoredCheckout;
                return isValidRestoredCartCheckoutJournal(journal)
                  && ['TENDER_COMMITTING', 'TENDER_UNCERTAIN'].includes(journal.state)
                  && !orders.getById(journal.orderId);
              })
            : null;
          const found = exactScope[0] ?? ownerUncertain ?? null;
          if (!found || exactScope.length > 1) {
            const required = diagnostic(relevant);
            return { success: false, restoredCart: false, protectedInterruptionRecoveryRequired: required, error: required.message };
          }

          if (found.payload.snapshot.posMode !== posModeNow()) {
            const required = diagnostic([found]);
            return {
              success: false,
              restoredCart: false,
              protectedInterruptionRecoveryRequired: required,
              error: `Switch POS to ${found.payload.snapshot.posMode} mode before protected-cart recovery.`,
            };
          }

          let payload = found.payload;
          let journal = payload.restoredCheckout;
          if (!isValidRestoredCartCheckoutJournal(journal)) {
            if (journal != null) {
              const required = diagnostic([found]);
              return { success: false, restoredCart: false, protectedInterruptionRecoveryRequired: required, error: required.message };
            }
            const checkoutId = String(payload.autoRestoreForCheckoutId || '').trim();
            const sessionId = String(payload.sourceBilliardSessionId || '').trim();
            const record = checkoutId ? billiardJournal.get(checkoutId) : null;
            const committed = record ? orders.getById(record.orderId) : null;
            if (
              !record
              || record.interruptedHoldId !== found.id
              || record.sessionId !== sessionId
              || record.salonId !== scope.salonId
              || record.userId !== scope.userId
              || record.registerId !== scope.registerId
              || !committed
            ) {
              const required = diagnostic([found]);
              return { success: false, restoredCart: false, protectedInterruptionRecoveryRequired: required, error: required.message };
            }
            assertCommittedBilliardOrder(record, committed, orders.getItemsByOrderId(record.orderId));
            journal = createJournal();
            payload = { ...payload, restoreState: 'ACTIVE_CART_BACKUP', restoredCheckout: journal };
            holds.replaceProtected(found.id, found.title, payload);
            await database.flush();
          }

          const checkoutId = String(payload.autoRestoreForCheckoutId || '');
          try {
            if (assertExistingOrder(database, payload, journal)) {
              const paid: RestoredCartCheckoutJournal = {
                ...journal,
                state: 'PAID_TOMBSTONE',
                paidAt: journal.paidAt || now(),
                updatedAt: now(),
              };
              holds.replaceProtected(found.id, found.title, {
                ...payload,
                restoreState: 'PAID_TOMBSTONE',
                restoredCheckout: paid,
              });
              try {
                await database.flush();
              } catch (flushError: any) {
                const uncertain = await markPreparedFailureUncertain(database, {
                  held: found,
                  payload,
                  journal,
                  context: {
                    holdId: found.id,
                    checkoutId,
                    orderId: journal.orderId,
                    clientAttemptId: journal.clientAttemptId,
                    tenderState: journal.state,
                  },
                }, `Paid-order recovery tombstone was not durable: ${flushError?.message || String(flushError)}`, false);
                return { ...uncertain, restoredCart: false, orderId: journal.orderId };
              }
              const live = deps.posStore.getState();
              const marker = live.checkoutDraft.restoredInterruption;
              if (
                !marker
                || marker.holdId !== found.id
                || marker.checkoutId !== checkoutId
                || !sameRestoredCartCheckoutIdentity(marker, journal)
                || !isActiveRestoredCartSnapshot(live, payload.snapshot)
              ) {
                const required = diagnostic([found]);
                return {
                  success: false,
                  restoredCart: false,
                  paymentCommitted: true,
                  orderId: paid.orderId,
                  protectedInterruptionRecoveryRequired: required,
                  error: 'Payment is recorded and the protected cart is tombstoned, but the active POS cart '
                    + 'does not exactly match it. The live cart was left untouched; recovery is required.',
                };
              }
              if (!deps.posStore.markRestoredOrderCommitted(found.id, paid.orderId, paid.clientAttemptId)) {
                const required = diagnostic([found]);
                return {
                  success: false,
                  restoredCart: false,
                  paymentCommitted: true,
                  orderId: paid.orderId,
                  protectedInterruptionRecoveryRequired: required,
                  error: 'Payment is recorded, but the exact restored cart could not be authorized for clear. '
                    + 'The live cart was left untouched; recovery is required.',
                };
              }
              deps.posStore.dispatch({ type: 'cart/completeCheckout' });
              return empty({ paymentCommitted: true, orderId: paid.orderId });
            }
          } catch (error: any) {
            const required = diagnostic([found]);
            return { success: false, restoredCart: false, protectedInterruptionRecoveryRequired: required, error: error?.message || required.message };
          }

          if (journal.state === 'TENDER_COMMITTING') {
            journal = { ...journal, state: 'TENDER_UNCERTAIN', updatedAt: now() };
            payload = { ...payload, restoreState: 'ACTIVE_CART_BACKUP', restoredCheckout: journal };
            holds.replaceProtected(found.id, found.title, payload);
            let durabilityError: string | undefined;
            try { await database.flush(); } catch (error: any) { durabilityError = error?.message || String(error); }
            return empty({
              outcomeUncertain: true,
              durabilityError,
              restoredCartReconciliation: reconciliation(found.id, checkoutId, journal),
            });
          }
          if (journal.state === 'TENDER_UNCERTAIN') {
            return empty({
              outcomeUncertain: true,
              restoredCartReconciliation: reconciliation(found.id, checkoutId, journal),
            });
          }
          if (payload.restoreState !== 'ACTIVE_CART_BACKUP' || journal.state !== 'READY') return empty();

          const current = deps.posStore.getState();
          const marker = current.checkoutDraft.restoredInterruption;
          if (marker?.holdId === found.id && marker.checkoutId === checkoutId) {
            if (!sameRestoredCartCheckoutIdentity(marker, journal)) {
              const required = diagnostic([found]);
              return { success: false, restoredCart: false, protectedInterruptionRecoveryRequired: required, error: required.message };
            }
            return empty({ restoredCart: true });
          }
          if (current.checkoutDraft.billiard) return empty();
          if (current.cart.items.length > 0 && !hasEquivalentOrdinaryCart(current, payload.snapshot)) {
            return { success: false, restoredCart: false, error: 'Another POS cart is active. Hold it before restoring the interrupted cart.' };
          }
          if (!isAuthCurrent(authContext)) return { success: false, restoredCart: false, error: 'POS user changed during restored-cart recovery.' };
          markLive(found, payload, undefined, authContext);
          return empty({ restoredCart: true });
        } catch (error: any) {
          return { success: false, restoredCart: false, error: error?.message || String(error) };
        }
      });
    },

    resolveUncertainTender(input: ResolveUncertainTenderInput): Promise<RestoredCartBoundaryResult & {
      code?: string;
      resolved?: boolean;
      targetType?: string;
      audit?: TenderNoPaymentResolutionAudit;
    }> {
      return enqueue(async () => {
        try {
          const config = deps.configStore.getRawConfig();
          if (String(config.authUser?.role || '').toUpperCase() !== 'OWNER') {
            return { success: false, code: 'OWNER_REQUIRED', error: 'Only the salon owner can resolve an uncertain payment outcome.' };
          }
          if (input?.target?.type !== 'RESTORED_CART') {
            return { success: false, error: 'Unknown restored-cart uncertain-tender target.' };
          }
          const ownerUserId = String(config.authUser?.id || '').trim();
          const reason = String(input.reason || '').trim();
          if (!ownerUserId) return { success: false, error: 'Owner identity is unavailable.' };
          if (reason.length < 3 || reason.length > 500) {
            return { success: false, error: 'Resolution reason must contain 3 to 500 characters.' };
          }
          if (input.confirmedNoPaymentRemains !== true) {
            return { success: false, error: 'Explicit confirmation that no payment remains is required.' };
          }

          const scope = scopeNow();
          const authContext = authEpoch.capture(scope);
          const database = await deps.db();
          const holds = createHoldOrderRepo(database);
          const held = holds.get(String(input.target.holdId || '').trim());
          const payload = held?.payload as PosHoldPayload | undefined;
          const journal = payload?.restoredCheckout;
          if (
            !held
            || !payload
            || payload.protected !== true
            || payload.holdReason !== 'BILLIARD_INTERRUPTION'
            || payload.restoreState !== 'ACTIVE_CART_BACKUP'
            || !samePosSalonRegister(payload.snapshot, scope)
            || !isValidRestoredCartCheckoutJournal(journal)
          ) return { success: false, error: 'Uncertain restored cart was not found for this owner/register.' };
          if (journal.state !== 'TENDER_UNCERTAIN') {
            return { success: false, error: `Restored-cart tender cannot be resolved from state ${journal.state}.` };
          }
          if (createOrderRepo(database).getById(journal.orderId)) {
            return { success: false, paymentCommitted: true, error: 'A local paid order exists. Reconcile it instead of resetting tender.' };
          }
          const live = deps.posStore.getState();
          // Resolving the durable money journal must not depend on the volatile
          // cart still matching its pre-tender image. A trusted/live drift is
          // exactly one reason classifyActiveCommittingFailure locked this row
          // uncertain. Reset the real journal, but only reactivate its saved
          // cart when doing so cannot overwrite another/newer live cart.
          const canReactivateSavedCart = live.cart.items.length === 0
            || isActiveRestoredCartSnapshot(live, payload.snapshot);
          const audit: TenderNoPaymentResolutionAudit = {
            ownerUserId,
            reason,
            confirmedAt: now(),
            action: 'NO_PAYMENT_REMAINS',
          };
          const ready: RestoredCartCheckoutJournal = {
            ...journal,
            state: 'READY',
            updatedAt: audit.confirmedAt,
            resolutionAudits: [...(journal.resolutionAudits ?? []), audit],
          };
          const adopted: PosHoldPayload = {
            ...payload,
            snapshot: adoptPosCheckoutSnapshotScope(payload.snapshot, scope),
            restoredCheckout: ready,
          };
          holds.replaceProtected(held.id, held.title, adopted);
          try {
            await database.flush();
          } catch (flushError: any) {
            holds.replaceProtected(held.id, held.title, payload);
            let rollbackDurabilityError: string | undefined;
            try { await database.flush(); } catch (e: any) { rollbackDurabilityError = e?.message || String(e); }
            return { success: false, error: flushError?.message || 'Owner resolution was not durable.', rollbackDurabilityError };
          }
          if (!isAuthCurrent(authContext)) {
            return { success: false, resolved: true, error: 'The owner resolution was saved, but the POS user changed.' };
          }
          if (canReactivateSavedCart) {
            markLive({ ...held, payload: adopted }, adopted, undefined, authContext);
          }
          return { success: true, resolved: true, targetType: 'RESTORED_CART', audit };
        } catch (error: any) {
          return { success: false, error: error?.message || String(error) };
        }
      });
    },

    prepareOrderCommitWithDatabase(
      database: AndroidDatabase,
      order: Record<string, any>,
      items: Array<Record<string, any>>,
    ): PreparedRestoredOrderCommit | null {
      const prepared = loadActivePrepared(database, 'TENDER_COMMITTING');
      if (!prepared) return null;
      validateOrderRequest(prepared, order, items);
      return prepared;
    },

    async classifyActiveCommittingFailure(
      database: AndroidDatabase | null,
      message: string,
    ): Promise<RestoredCartBoundaryResult | null> {
      const context = deps.posStore.getState().checkoutDraft.restoredInterruption;
      if (!context || context.tenderState !== 'TENDER_COMMITTING') return null;
      let held: HoldOrderDetail | null = null;
      try {
        const activeDatabase = database ?? await deps.db();
        held = createHoldOrderRepo(activeDatabase).get(context.holdId);
        const payload = held?.payload as PosHoldPayload | undefined;
        const journal = payload?.restoredCheckout;
        if (
          !held
          || !payload
          || payload.protected !== true
          || payload.holdReason !== 'BILLIARD_INTERRUPTION'
          || payload.restoreState !== 'ACTIVE_CART_BACKUP'
          || payload.autoRestoreForCheckoutId !== context.checkoutId
          || !isValidRestoredCartCheckoutJournal(journal)
          || journal.state !== 'TENDER_COMMITTING'
          || context.orderId !== journal.orderId
          || context.clientAttemptId !== journal.clientAttemptId
        ) {
          const required = diagnosticForContext(
            context,
            held,
            'The live restored-cart marker cannot be matched to one real COMMITTING protected journal.',
          );
          return { success: false, error: required.message, protectedInterruptionRecoveryRequired: required };
        }

        let scope: PosSnapshotScope;
        try {
          scope = scopeNow();
        } catch {
          const required = diagnosticForContext(context, held, 'The current POS identity is unavailable.');
          return { success: false, error: required.message, protectedInterruptionRecoveryRequired: required };
        }
        if (!samePosSalonRegister(payload.snapshot, scope)) {
          const required = diagnosticForContext(
            context,
            held,
            'This COMMITTING restored cart belongs to a different salon or register.',
          );
          return { success: false, error: required.message, protectedInterruptionRecoveryRequired: required };
        }

        // User drift on the same salon/register (notably cashier logout followed
        // by OWNER login) and cart drift are not reasons to leave a real money
        // boundary COMMITTING. The OWNER resolver is intentionally scoped by
        // salon/register, so lock the actual row and let that durable path act.
        const result = await markPreparedFailureUncertain(activeDatabase, {
          held,
          payload,
          journal,
          context,
        }, message, false);
        deps.posStore.markRestoredTenderUncertain(
          held.id,
          journal.orderId,
          journal.clientAttemptId,
          result.durabilityError
            ? `Restored-cart uncertainty was not confirmed on disk: ${result.durabilityError}`
            : `Restored-cart payment must be reconciled: ${message}`,
        );
        return result;
      } catch (error: any) {
        const required = diagnosticForContext(
          context,
          held,
          `The committing restored-cart owner could not be verified: ${error?.message || String(error)}.`,
        );
        return { success: false, error: required.message, protectedInterruptionRecoveryRequired: required };
      }
    },

    /** Share one exclusive mutation lane with restored dispatch and re-hold. */
    runExclusive<T>(work: () => Promise<T>): Promise<T> {
      return enqueue(work);
    },

    tombstoneOrderBeforeFlush(database: AndroidDatabase, prepared: PreparedRestoredOrderCommit): void {
      const paid: RestoredCartCheckoutJournal = {
        ...prepared.journal,
        state: 'PAID_TOMBSTONE',
        paidAt: prepared.journal.paidAt || now(),
        updatedAt: now(),
      };
      createHoldOrderRepo(database).replaceProtected(prepared.held.id, prepared.held.title, {
        ...prepared.payload,
        restoreState: 'PAID_TOMBSTONE',
        restoredCheckout: paid,
      });
    },

    verifyExistingOrder(database: AndroidDatabase, prepared: PreparedRestoredOrderCommit): void {
      if (!assertExistingOrder(database, prepared.payload, prepared.journal)) {
        throw new Error('Committed restored-cart order is missing locally.');
      }
    },

    markOrderCommittedInLive(prepared: PreparedRestoredOrderCommit): void {
      deps.posStore.markRestoredOrderCommitted(
        prepared.held.id,
        prepared.journal.orderId,
        prepared.journal.clientAttemptId,
      );
    },

    async markOrderFailureUncertain(
      database: AndroidDatabase,
      prepared: PreparedRestoredOrderCommit,
      message: string,
    ): Promise<RestoredCartBoundaryResult> {
      return markPreparedFailureUncertain(database, prepared, message);
    },

    stageAfterBilliardCommit(
      database: AndroidDatabase,
      record: BilliardPosHandoffRecord,
      scope: PosSnapshotScope,
    ): StagedRestoredCart | null {
      if (!record.interruptedHoldId) return null;
      const holds = createHoldOrderRepo(database);
      const held = holds.get(record.interruptedHoldId);
      const payload = held?.payload as PosHoldPayload | undefined;
      const snapshot = getRestorableBilliardInterruptionSnapshot({
        payload,
        checkoutId: record.checkoutId,
        sessionId: record.sessionId,
        scope,
        posMode: posModeNow(),
      });
      if (!held || !payload || !snapshot) {
        throw new Error('Protected Billiard interruption Hold failed exact identity verification.');
      }
      if (payload.restoredCheckout != null && !isValidRestoredCartCheckoutJournal(payload.restoredCheckout)) {
        throw new Error('Protected restored-cart payment journal is invalid. Reconciliation is required.');
      }
      const journal = payload.restoredCheckout ?? createJournal();
      if (journal.state !== 'READY') throw new Error(`Protected cart cannot be restored from state ${journal.state}.`);
      const activePayload = { ...payload, restoreState: 'ACTIVE_CART_BACKUP' as const, restoredCheckout: journal };
      holds.replaceProtected(held.id, held.title, activePayload);
      return { held, payload: activePayload, checkoutId: record.checkoutId };
    },

    activateStaged(staged: StagedRestoredCart | null): boolean {
      if (!staged) return false;
      const current = deps.posStore.getState();
      if (current.cart.items.length > 0 && !hasEquivalentOrdinaryCart(current, staged.payload.snapshot)) {
        throw new Error('Another POS cart is active after Billiard commit; protected cart was not overwritten.');
      }
      markLive(staged.held, staged.payload);
      return true;
    },

    dispatchPosAction(action: PosAction): Promise<void> {
      return enqueue(async () => {
        // Ordinary carts keep the normal synchronous reducer behavior. A
        // restored owner, however, is validated before the reducer is allowed
        // to touch live state, then its candidate snapshot crosses disk first.
        const entry = deps.posStore.getState();
        const entryContext = entry.checkoutDraft.restoredInterruption;
        if (!entryContext) {
          deps.posStore.dispatch(action);
          return;
        }
        if (action.type === 'state/replaceCheckoutSnapshot' || action.type === 'cart/hydrate') {
          throw new Error('Renderer snapshot replacement is not allowed while a restored cart is active.');
        }
        const scope = scopeNow();
        const authContext = authEpoch.capture(scope);
        const database = await deps.db();
        if (!isAuthCurrent(authContext)) {
          throw new Error('POS user changed before the restored-cart action could be verified.');
        }

        const before = deps.posStore.getState();
        const context = before.checkoutDraft.restoredInterruption;
        const holds = createHoldOrderRepo(database);
        const held = context ? holds.get(context.holdId) : null;
        const payload = held?.payload as PosHoldPayload | undefined;
        const journal = payload?.restoredCheckout;
        if (
          before !== entry
          || !context
          || context.holdId !== entryContext.holdId
          || context.checkoutId !== entryContext.checkoutId
          || context.orderId !== entryContext.orderId
          || context.clientAttemptId !== entryContext.clientAttemptId
          || context.tenderState !== entryContext.tenderState
          || !held
          || !payload
          || payload.protected !== true
          || payload.holdReason !== 'BILLIARD_INTERRUPTION'
          || payload.autoRestoreForCheckoutId !== context.checkoutId
          || !samePosSnapshotScope(payload.snapshot, scope)
          || payload.snapshot.posMode !== posModeNow()
          || !isValidRestoredCartCheckoutJournal(journal)
          || !sameRestoredCartCheckoutIdentity(context, journal)
          || !isActiveRestoredCartSnapshot(before, payload.snapshot)
        ) {
          throw new Error('This restored cart is not the exact durable cart owned by this POS session.');
        }

        if (journal.state === 'PAID_TOMBSTONE') {
          if (payload.restoreState !== 'PAID_TOMBSTONE' || action.type !== 'cart/completeCheckout') {
            throw new Error('This restored cart is already paid and may only be cleared.');
          }
          // No await between the final auth/state check and this reducer call.
          if (!isAuthCurrent(authContext) || deps.posStore.getState() !== before) {
            throw new Error('POS state changed before the paid restored cart could be cleared.');
          }
          deps.posStore.dispatch(action);
          return;
        }
        if (journal.state !== 'READY' || payload.restoreState !== 'ACTIVE_CART_BACKUP' || context.persistenceError) {
          throw new Error('This restored cart crossed the tender boundary and cannot be edited.');
        }

        const candidate = posReducer(before, action);
        if (candidate === before) return;
        const nextSnapshot = captureRestoredSnapshot(candidate, payload.snapshot, scope, posModeNow());
        const nextPayload = { ...payload, snapshot: nextSnapshot };

        // Recheck after every await and immediately before the protected write.
        if (
          !isAuthCurrent(authContext)
          || deps.posStore.getState() !== before
          || !isActiveRestoredCartSnapshot(before, payload.snapshot)
        ) {
          throw new Error('POS state changed before the restored-cart action could be saved.');
        }
        holds.replaceProtected(held.id, held.title, nextPayload);
        try {
          await database.flush();
        } catch (error) {
          holds.replaceProtected(held.id, held.title, payload);
          try { await database.flush(); } catch { /* old durable row remains authoritative */ }
          throw error;
        }

        // A concurrent auth/state boundary after the flush invalidates this UI
        // action. Put the old protected snapshot back and never touch live state.
        if (
          !isAuthCurrent(authContext)
          || deps.posStore.getState() !== before
          || !isActiveRestoredCartSnapshot(before, payload.snapshot)
        ) {
          holds.replaceProtected(held.id, held.title, payload);
          try { await database.flush(); } catch { /* recovery will classify the durable row */ }
          throw new Error('POS user or cart changed while the restored-cart action was being saved.');
        }
        deps.posStore.dispatch(action);
        const after = deps.posStore.getState();
        if (!isActiveRestoredCartSnapshot(after, nextSnapshot)) {
          throw new Error('POS refused to apply the durably saved restored-cart action.');
        }
      });
    },
  };

  return api;
}

function captureRestoredSnapshot(
  state: ReturnType<ShimPosStore['getState']>,
  previous: PosHoldPayload['snapshot'],
  scope: PosSnapshotScope,
  posMode: string,
): PosHoldPayload['snapshot'] {
  const copy = JSON.parse(JSON.stringify(state));
  if (copy.checkoutDraft) delete copy.checkoutDraft.restoredInterruption;
  return {
    ...previous,
    state: copy,
    scope: { ...scope },
    posMode,
    capturedAt: now(),
  };
}
