import type { AgentConfig } from '../../shared/types';
import {
  POS_CHECKOUT_SNAPSHOT_VERSION,
  type BilliardPosCheckoutBundle,
  type PosHoldPayload,
  type PosCheckoutSnapshot,
  type RestoredCartCheckoutJournal,
  type RestoredInterruptionContext,
} from '../../shared/billiard-pos-handoff';
import type { CartItem, PosState } from './pos-store';

type HandoffSnapshotRecord = {
  checkoutId: string;
  sessionId: string;
  orderId: string;
  clientAttemptId: string;
  bundle: BilliardPosCheckoutBundle;
  checkoutSnapshot: PosCheckoutSnapshot;
};

export interface PosSnapshotScope {
  salonId: string;
  userId: string;
  registerId: string;
}

export function currentPosSnapshotScope(config: AgentConfig): PosSnapshotScope {
  const salonId = String(config.salonId || config.authUser?.salonId || '').trim();
  const userId = String(config.authUser?.id || '').trim();
  const registerId = String(config.registerCode || config.machineId || config.agentId || '').trim();
  if (!salonId || !userId || !registerId) {
    throw new Error('POS register identity is incomplete. Sign in and pair this register before checkout.');
  }
  return { salonId, userId, registerId };
}

export function capturePosCheckoutSnapshot(
  state: PosState,
  scope: PosSnapshotScope,
  posMode: string,
): PosCheckoutSnapshot {
  return {
    schemaVersion: POS_CHECKOUT_SNAPSHOT_VERSION,
    state: JSON.parse(JSON.stringify(state)),
    posMode,
    scope: { ...scope },
    capturedAt: new Date().toISOString(),
  };
}

export function samePosSnapshotScope(snapshot: PosCheckoutSnapshot, scope: PosSnapshotScope): boolean {
  return snapshot?.schemaVersion === POS_CHECKOUT_SNAPSHOT_VERSION
    && snapshot.scope?.salonId === scope.salonId
    && snapshot.scope?.userId === scope.userId
    && snapshot.scope?.registerId === scope.registerId;
}

export function samePosSalonRegister(snapshot: PosCheckoutSnapshot, scope: PosSnapshotScope): boolean {
  return snapshot?.schemaVersion === POS_CHECKOUT_SNAPSHOT_VERSION
    && snapshot.scope?.salonId === scope.salonId
    && snapshot.scope?.registerId === scope.registerId;
}

/** Used only after an OWNER audit has durably adopted an uncertain tender. */
export function adoptPosCheckoutSnapshotScope(
  snapshot: PosCheckoutSnapshot,
  scope: PosSnapshotScope,
): PosCheckoutSnapshot {
  const adopted = JSON.parse(JSON.stringify(snapshot)) as PosCheckoutSnapshot;
  adopted.scope = { ...scope };
  return adopted;
}

export function buildBilliardInterruptionHoldPayload(args: {
  snapshot: PosCheckoutSnapshot;
  checkoutId: string;
  sessionId: string;
}): PosHoldPayload {
  return {
    schemaVersion: POS_CHECKOUT_SNAPSHOT_VERSION,
    holdReason: 'BILLIARD_INTERRUPTION',
    protected: true,
    snapshot: args.snapshot,
    sourceBilliardSessionId: args.sessionId,
    autoRestoreForCheckoutId: args.checkoutId,
    restoreState: 'WAITING_FOR_BILLIARD_PAYMENT',
  };
}

export function withRestoredInterruptionMarker(
  snapshot: PosCheckoutSnapshot,
  holdId: string,
  checkoutId: string,
  journal: RestoredCartCheckoutJournal,
  persistenceError?: string,
): PosCheckoutSnapshot {
  const copy = JSON.parse(JSON.stringify(snapshot)) as PosCheckoutSnapshot;
  const restoredInterruption: RestoredInterruptionContext = {
    holdId,
    checkoutId,
    orderId: journal.orderId,
    clientAttemptId: journal.clientAttemptId,
    tenderState: journal.state,
    ...(persistenceError ? { persistenceError } : {}),
  };
  copy.state.checkoutDraft = {
    ...(copy.state.checkoutDraft || {}),
    restoredInterruption,
  };
  return copy;
}

export function isValidRestoredCartCheckoutJournal(
  value: unknown,
): value is RestoredCartCheckoutJournal {
  const journal = value as RestoredCartCheckoutJournal | null | undefined;
  return !!journal
    && typeof journal.orderId === 'string'
    && journal.orderId.length > 0
    && typeof journal.clientAttemptId === 'string'
    && journal.clientAttemptId.length > 0
    && ['READY', 'TENDER_COMMITTING', 'TENDER_UNCERTAIN', 'PAID_TOMBSTONE'].includes(journal.state)
    && typeof journal.updatedAt === 'string'
    && journal.updatedAt.length > 0;
}

export function sameRestoredCartCheckoutIdentity(
  context: RestoredInterruptionContext | null | undefined,
  journal: RestoredCartCheckoutJournal | null | undefined,
): boolean {
  return !!context
    && isValidRestoredCartCheckoutJournal(journal)
    && context.orderId === journal.orderId
    && context.clientAttemptId === journal.clientAttemptId
    && context.tenderState === journal.state;
}

export type RestoredCartRecoveryDisposition = 'RESTORE' | 'RECONCILE' | 'IGNORE' | 'INVALID';

/** Pure restart rule: a crossed tender boundary is never materialized as Pay. */
export function restoredCartRecoveryDisposition(
  payload: PosHoldPayload | null | undefined,
  orderExists: boolean,
): RestoredCartRecoveryDisposition {
  if (!payload || !isValidRestoredCartCheckoutJournal(payload.restoredCheckout)) return 'INVALID';
  if (orderExists || payload.restoreState === 'PAID_TOMBSTONE' || payload.restoredCheckout.state === 'PAID_TOMBSTONE') {
    return 'IGNORE';
  }
  if (payload.restoredCheckout.state === 'TENDER_COMMITTING' || payload.restoredCheckout.state === 'TENDER_UNCERTAIN') {
    return 'RECONCILE';
  }
  return payload.restoreState === 'ACTIVE_CART_BACKUP' && payload.restoredCheckout.state === 'READY'
    ? 'RESTORE'
    : 'IGNORE';
}

export function withoutRestoredInterruptionMarker(snapshot: PosCheckoutSnapshot): PosCheckoutSnapshot {
  const copy = JSON.parse(JSON.stringify(snapshot)) as PosCheckoutSnapshot;
  if (copy.state.checkoutDraft) {
    delete copy.state.checkoutDraft.restoredInterruption;
  }
  return copy;
}

function ordinaryCartLineProjection(item: any): Record<string, any> {
  return {
    variantId: item?.variantId,
    name: item?.name,
    sku: item?.sku ?? '',
    price: item?.price,
    quantity: item?.quantity,
    saleUnit: item?.saleUnit ?? null,
    sellBy: item?.sellBy ?? null,
    total: item?.total,
    staffId: item?.staffId ?? null,
    staffName: item?.staffName ?? null,
    notes: item?.notes ?? null,
    course: item?.course ?? null,
    vatRate: item?.vatRate ?? null,
  };
}

/** Allows recovery to upgrade the old items-only crash cache to the full Hold. */
export function hasEquivalentOrdinaryCart(
  state: PosState,
  snapshot: PosCheckoutSnapshot,
): boolean {
  if (state.checkoutDraft.billiard || state.cart.items.some((item) => item.billiard || item.locked)) return false;
  const savedItems = (snapshot.state as any)?.cart?.items;
  return Array.isArray(savedItems)
    && JSON.stringify(state.cart.items.map(ordinaryCartLineProjection))
      === JSON.stringify(savedItems.map(ordinaryCartLineProjection));
}

function ordinaryCheckoutProjection(state: any): Record<string, any> {
  const checkoutDraft = { ...(state?.checkoutDraft || {}) };
  delete checkoutDraft.restoredInterruption;
  return {
    cart: state?.cart ?? null,
    checkoutDraft,
    activeTable: state?.activeTable ?? null,
    activeCustomer: state?.activeCustomer ?? null,
    tip: Number(state?.tip) || 0,
  };
}

/** Exact financial/customer snapshot check used at the restored-cart tender boundary. */
export function isActiveRestoredCartSnapshot(
  state: PosState,
  snapshot: PosCheckoutSnapshot,
): boolean {
  if (state.checkoutDraft.billiard) return false;
  return JSON.stringify(ordinaryCheckoutProjection(state))
    === JSON.stringify(ordinaryCheckoutProjection(snapshot.state));
}

export function getRestorableBilliardInterruptionSnapshot(args: {
  payload: PosHoldPayload | null | undefined;
  checkoutId: string;
  sessionId: string;
  scope: PosSnapshotScope;
  posMode: string;
}): PosCheckoutSnapshot | null {
  const { payload } = args;
  if (
    !payload?.snapshot
    || payload.protected !== true
    || payload.holdReason !== 'BILLIARD_INTERRUPTION'
    || payload.autoRestoreForCheckoutId !== args.checkoutId
    || payload.sourceBilliardSessionId !== args.sessionId
    || !samePosSnapshotScope(payload.snapshot, args.scope)
    || payload.snapshot.posMode !== args.posMode
  ) {
    return null;
  }
  return payload.snapshot;
}

export function assertBilliardCorrectionHandoffPreflight(args: {
  state: PosState;
  sessionId: string;
  unresolved?: { sessionId: string } | null;
}): void {
  if (args.state.checkoutDraft?.kitchenSelfOrder?.pickupOrderId) {
    throw new Error('Finish or release the active kitchen pickup order before correcting a Billiard order.');
  }
  const activeBilliardSessionId = args.state.checkoutDraft?.billiard?.origin?.sessionId;
  if (activeBilliardSessionId && activeBilliardSessionId !== args.sessionId) {
    throw new Error('Another frozen Billiard checkout is active on this register.');
  }
  if (args.unresolved && args.unresolved.sessionId !== args.sessionId) {
    throw new Error('Another Billiard checkout is still unresolved on this register.');
  }
  // A normal cart is intentionally allowed: prepareBilliardHandoff will save
  // its complete snapshot into a protected durable Hold after correction.
}

export function buildBilliardCheckoutSnapshot(args: {
  currentState: PosState;
  bundle: BilliardPosCheckoutBundle;
  scope: PosSnapshotScope;
  posMode: string;
  orderId: string;
  interruptedHoldId?: string | null;
  tableName?: string | null;
}): PosCheckoutSnapshot {
  const { bundle } = args;
  const origin = {
    type: 'BILLIARD_SESSION' as const,
    sessionId: bundle.sessionId,
    checkoutId: bundle.checkoutId,
    snapshotVersion: bundle.schemaVersion,
  };
  const items: CartItem[] = bundle.lines.map((line) => ({
    id: `${bundle.checkoutId}:${line.lineKey}`,
    variantId: line.variantId,
    name: line.displayName,
    sku: line.sku || '',
    price: line.unitPriceGrosze,
    quantity: line.quantity,
    saleUnit: line.saleUnit,
    sellBy: line.sellBy,
    total: line.grossTotalGrosze,
    vatRate: line.vatRate,
    duration: line.durationMinutes,
    locked: true,
    billiard: {
      kind: line.kind,
      sessionItemId: line.sessionItemId,
      lineKey: line.lineKey,
      durationMinutes: line.durationMinutes,
      displayName: line.displayName,
      inventoryPolicy: line.inventoryPolicy,
      refundPolicy: line.refundPolicy,
      sellBy: line.sellBy,
      saleUnit: line.saleUnit,
      grossTotalGrosze: line.grossTotalGrosze,
      allocatedDiscountGrosze: line.allocatedDiscountGrosze,
      payableGrosze: line.payableGrosze,
    },
  }));
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  // The frozen line allocation is the fiscal source of truth. VAT is embedded
  // in each line's post-discount payable amount, rounded independently to one
  // grosz before summing (important for mixed VAT rates and allocated discounts).
  const tax = bundle.lines.reduce((sum, line) => {
    const rate = Number(line.vatRate) || 0;
    return rate > 0
      ? sum + Math.round(line.payableGrosze - line.payableGrosze * 100 / (100 + rate))
      : sum;
  }, 0);

  const replacement: PosState = {
    ...args.currentState,
    cart: {
      items,
      subtotal,
      discount: bundle.discountGrosze,
      discountType: bundle.discountGrosze > 0 ? 'fixed' : undefined,
      discountPercent: undefined,
      tax,
      total: bundle.totalGrosze,
    },
    checkoutDraft: {
      billiard: {
        origin,
        orderId: args.orderId,
        clientAttemptId: `billiard:${bundle.checkoutId}`,
        handoffId: bundle.checkoutId,
        interruptedHoldId: args.interruptedHoldId ?? null,
        tableName: args.tableName ?? null,
        orderCommitted: false,
      },
    },
    activeTable: null,
    activeCustomer: null,
    tip: 0,
    display: { ...args.currentState.display, mode: 'cart' },
  };

  return capturePosCheckoutSnapshot(replacement, args.scope, args.posMode);
}

function lineProjection(item: any): Record<string, any> {
  return {
    id: item?.id,
    variantId: item?.variantId,
    name: item?.name,
    sku: item?.sku ?? '',
    price: item?.price,
    quantity: item?.quantity,
    saleUnit: item?.saleUnit,
    sellBy: item?.sellBy,
    total: item?.total,
    vatRate: item?.vatRate,
    duration: item?.duration,
    locked: item?.locked,
    billiard: item?.billiard ? {
      kind: item.billiard.kind,
      sessionItemId: item.billiard.sessionItemId,
      lineKey: item.billiard.lineKey,
      durationMinutes: item.billiard.durationMinutes,
      displayName: item.billiard.displayName,
      inventoryPolicy: item.billiard.inventoryPolicy,
      refundPolicy: item.billiard.refundPolicy,
      sellBy: item.billiard.sellBy,
      saleUnit: item.billiard.saleUnit,
      grossTotalGrosze: item.billiard.grossTotalGrosze,
      allocatedDiscountGrosze: item.billiard.allocatedDiscountGrosze,
      payableGrosze: item.billiard.payableGrosze,
    } : null,
  };
}

function checkoutProjection(state: any): Record<string, any> {
  const context = state?.checkoutDraft?.billiard;
  return {
    cart: {
      items: Array.isArray(state?.cart?.items) ? state.cart.items.map(lineProjection) : null,
      subtotal: state?.cart?.subtotal,
      discount: state?.cart?.discount,
      discountType: state?.cart?.discountType,
      tax: state?.cart?.tax,
      total: state?.cart?.total,
    },
    context: context ? {
      origin: context.origin,
      orderId: context.orderId,
      clientAttemptId: context.clientAttemptId,
      handoffId: context.handoffId,
      interruptedHoldId: context.interruptedHoldId ?? null,
      tableName: context.tableName ?? null,
    } : null,
  };
}

/** Fail closed if a persisted safety snapshot drifted from its server bundle. */
export function assertBilliardCheckoutSnapshotIntegrity(record: HandoffSnapshotRecord): void {
  const expected = buildBilliardCheckoutSnapshot({
    currentState: record.checkoutSnapshot.state as PosState,
    bundle: record.bundle,
    scope: record.checkoutSnapshot.scope,
    posMode: record.checkoutSnapshot.posMode,
    orderId: record.orderId,
    interruptedHoldId: (record.checkoutSnapshot.state as any)?.checkoutDraft?.billiard?.interruptedHoldId ?? null,
    tableName: (record.checkoutSnapshot.state as any)?.checkoutDraft?.billiard?.tableName ?? null,
  });
  const actualProjection = checkoutProjection(record.checkoutSnapshot.state);
  const expectedProjection = checkoutProjection(expected.state);
  if (JSON.stringify(actualProjection) !== JSON.stringify(expectedProjection)) {
    throw new Error('Saved Billiard checkout failed integrity validation. Refresh it from the session before payment.');
  }
  const context = (record.checkoutSnapshot.state as any)?.checkoutDraft?.billiard;
  if (
    record.checkoutSnapshot.schemaVersion !== POS_CHECKOUT_SNAPSHOT_VERSION
    || context?.origin?.checkoutId !== record.checkoutId
    || context?.origin?.sessionId !== record.sessionId
    || context?.origin?.snapshotVersion !== record.bundle.schemaVersion
    || context?.orderId !== record.orderId
    || context?.clientAttemptId !== record.clientAttemptId
    || context?.handoffId !== record.checkoutId
  ) {
    throw new Error('Saved Billiard checkout identity failed integrity validation.');
  }
}

/** Exact frozen-cart check used before opening or committing a payment. */
export function isActiveBilliardCheckoutSnapshot(state: PosState, snapshot: PosCheckoutSnapshot): boolean {
  return JSON.stringify(checkoutProjection(state)) === JSON.stringify(checkoutProjection(snapshot.state));
}
