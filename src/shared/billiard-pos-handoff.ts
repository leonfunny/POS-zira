import {
  calculateLineTotalGrosze,
  isValidSaleQuantity,
  normalizeSaleUnit,
  normalizeSellBy,
  type SellBy,
} from './pos-sale';

export const POS_CHECKOUT_SNAPSHOT_VERSION = 1 as const;

export type BilliardPosLineKind = 'TIME' | 'FNB' | 'MISC' | 'ADJUSTMENT';
export type BilliardInventoryPolicy = 'NONE' | 'ALREADY_CONSUMED';
export type BilliardRefundPolicy = 'FORBIDDEN' | 'ALLOWED_NO_RESTOCK';

export interface BilliardPosCheckoutLine {
  lineKey: string;
  kind: BilliardPosLineKind;
  sessionItemId?: string;
  variantId: string;
  sku?: string | null;
  displayName: string;
  quantity: number;
  sellBy: SellBy;
  saleUnit: string;
  unitPriceGrosze: number;
  grossTotalGrosze: number;
  allocatedDiscountGrosze: number;
  payableGrosze: number;
  vatRate: number;
  durationMinutes?: number;
  inventoryPolicy: BilliardInventoryPolicy;
  refundPolicy: BilliardRefundPolicy;
}

export interface BilliardPosCheckoutBundle {
  schemaVersion: number;
  sessionId: string;
  checkoutId: string;
  totalGrosze: number;
  discountGrosze: number;
  lines: BilliardPosCheckoutLine[];
}

export interface BilliardOrderOrigin {
  type: 'BILLIARD_SESSION';
  sessionId: string;
  checkoutId: string;
  snapshotVersion: number;
}

export interface BilliardCartLineMetadata {
  kind: BilliardPosLineKind;
  sessionItemId?: string;
  lineKey: string;
  durationMinutes?: number;
  displayName: string;
  inventoryPolicy: BilliardInventoryPolicy;
  refundPolicy: BilliardRefundPolicy;
  sellBy: SellBy;
  saleUnit: string;
  grossTotalGrosze: number;
  allocatedDiscountGrosze: number;
  payableGrosze: number;
}

export type BilliardLocalHandoffState =
  | 'POS_READY'
  | 'POS_PAYMENT_OPEN'
  | 'POS_TENDER_COMMITTING'
  | 'POS_TENDER_UNCERTAIN'
  | 'POS_PAID_SYNC_PENDING'
  | 'SETTLED';

export function requiresBilliardTenderReconciliation(state: BilliardLocalHandoffState): boolean {
  return state === 'POS_TENDER_COMMITTING' || state === 'POS_TENDER_UNCERTAIN';
}

export interface BilliardCheckoutContext {
  origin: BilliardOrderOrigin;
  orderId: string;
  clientAttemptId: string;
  handoffId: string;
  interruptedHoldId?: string | null;
  tableName?: string | null;
  /** Set only by Electron main after the local order crossed its disk barrier. */
  orderCommitted?: boolean;
}

export type RestoredCartTenderState =
  | 'READY'
  | 'TENDER_COMMITTING'
  | 'TENDER_UNCERTAIN'
  | 'PAID_TOMBSTONE';

export interface TenderNoPaymentResolutionAudit {
  ownerUserId: string;
  reason: string;
  confirmedAt: string;
  action: 'NO_PAYMENT_REMAINS';
}

/**
 * Durable payment identity for the ordinary cart that was interrupted by a
 * Billiard checkout. This lives inside the protected Hold so a power cut can
 * never turn an already-tendered cart back into a fresh payable cart.
 */
export interface RestoredCartCheckoutJournal {
  orderId: string;
  clientAttemptId: string;
  state: RestoredCartTenderState;
  updatedAt: string;
  paidAt?: string;
  resolutionAudits?: TenderNoPaymentResolutionAudit[];
}

/** Volatile main-process ownership guard while a manual Hold recall fsyncs. */
export interface HoldRecallPendingContext {
  holdId: string;
}

/**
 * Main-process ownership marker for a normal POS cart that was restored after
 * a Billiard payment. The protected Hold remains the durable copy until this
 * cart is paid, held again, or explicitly discarded.
 */
export interface RestoredInterruptionContext {
  holdId: string;
  checkoutId: string;
  orderId: string;
  clientAttemptId: string;
  tenderState: RestoredCartTenderState;
  /** Main-only volatile freeze after a failed protected-Hold disk barrier. */
  persistenceError?: string;
}

export interface RestoredCartReconciliation {
  holdId: string;
  checkoutId: string;
  orderId: string;
  clientAttemptId: string;
  reason: 'TENDER_OUTCOME_UNCERTAIN';
  message: string;
}

export type UncertainTenderResolutionTarget =
  | { type: 'BILLIARD'; checkoutId: string }
  | { type: 'RESTORED_CART'; holdId: string };

export interface ResolveUncertainTenderInput {
  target: UncertainTenderResolutionTarget;
  reason: string;
  confirmedNoPaymentRemains: boolean;
}

export interface PosCheckoutSnapshot {
  schemaVersion: typeof POS_CHECKOUT_SNAPSHOT_VERSION;
  // Kept structurally generic at the shared boundary so Android builds do not
  // import Electron main-process modules. The Windows POS validates/casts the
  // versioned state before applying it atomically.
  state: Record<string, any>;
  posMode: string;
  scope: {
    salonId: string;
    userId: string;
    registerId: string;
  };
  capturedAt: string;
}

export interface PosHoldPayload {
  schemaVersion: typeof POS_CHECKOUT_SNAPSHOT_VERSION;
  holdReason: 'MANUAL' | 'BILLIARD_INTERRUPTION';
  protected: boolean;
  snapshot: PosCheckoutSnapshot;
  sourceBilliardSessionId?: string;
  autoRestoreForCheckoutId?: string;
  restoreState?: 'WAITING_FOR_BILLIARD_PAYMENT' | 'ACTIVE_CART_BACKUP' | 'PAID_TOMBSTONE';
  restoredCheckout?: RestoredCartCheckoutJournal;
}

export interface BilliardPaymentIntent {
  checkoutId: string;
  sessionId: string;
  orderId: string;
  clientAttemptId: string;
  nonce: string;
  shouldAutoOpen: boolean;
  recovered?: boolean;
  /** Never reopen tender: the cashier must reconcile cash/card outcome first. */
  tenderOutcomeUncertain?: boolean;
}

function requiredText(value: unknown, field: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`Invalid billiard POS checkout: missing ${field}`);
  return normalized;
}

function integer(value: unknown, field: string, minimum = 0): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    throw new Error(`Invalid billiard POS checkout: ${field} must be an integer grosz value`);
  }
  return normalized;
}

function quantity(value: unknown, field: string, sellBy: SellBy): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || !isValidSaleQuantity(normalized, sellBy)) {
    throw new Error(`Invalid billiard POS checkout: invalid ${field} for ${sellBy}`);
  }
  return normalized;
}

function linePolicy(kind: BilliardPosLineKind): {
  inventory: BilliardInventoryPolicy;
  refund: BilliardRefundPolicy;
} {
  if (kind === 'TIME') return { inventory: 'NONE', refund: 'FORBIDDEN' };
  if (kind === 'FNB') return { inventory: 'ALREADY_CONSUMED', refund: 'ALLOWED_NO_RESTOCK' };
  if (kind === 'MISC') return { inventory: 'NONE', refund: 'ALLOWED_NO_RESTOCK' };
  return { inventory: 'NONE', refund: 'FORBIDDEN' };
}

/**
 * Accept only the authoritative server checkout bundle. The desktop client
 * must never reconstruct discount allocation, service variants, or stock
 * policy from the looser legacy session payload.
 */
export function normalizeBilliardPosCheckout(input: unknown): BilliardPosCheckoutBundle {
  const raw = input as Record<string, any> | null;
  if (!raw || typeof raw !== 'object') {
    throw new Error('Billiard checkout is unavailable. Refresh the session and try again.');
  }

  const schemaVersion = integer(raw.schemaVersion, 'schemaVersion', 1);
  if (schemaVersion !== POS_CHECKOUT_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported billiard POS checkout version: ${schemaVersion}`);
  }
  const sessionId = requiredText(raw.sessionId, 'sessionId');
  const checkoutId = requiredText(raw.checkoutId, 'checkoutId');
  const totalGrosze = integer(raw.totalGrosze, 'totalGrosze');
  const discountGrosze = integer(raw.discountGrosze ?? 0, 'discountGrosze');
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new Error('Invalid billiard POS checkout: no frozen lines');
  }

  const seen = new Set<string>();
  const lines = raw.lines.map((lineRaw: any, index: number): BilliardPosCheckoutLine => {
    const lineKey = requiredText(lineRaw?.lineKey, `lines[${index}].lineKey`);
    if (seen.has(lineKey)) throw new Error(`Invalid billiard POS checkout: duplicate line ${lineKey}`);
    seen.add(lineKey);

    const kind = requiredText(lineRaw?.kind, `lines[${index}].kind`) as BilliardPosLineKind;
    if (!['TIME', 'FNB', 'MISC', 'ADJUSTMENT'].includes(kind)) {
      throw new Error(`Invalid billiard POS checkout: unsupported line kind ${kind}`);
    }
    const sellBy = normalizeSellBy(lineRaw?.sellBy);
    const saleUnit = normalizeSaleUnit({ saleUnit: lineRaw?.saleUnit, sellBy });
    // Missing sellBy intentionally defaults to PIECE, whose validator rejects
    // decimals. Weighted lines therefore fail closed unless the server marks
    // them explicitly as WEIGHT.
    const lineQuantity = quantity(lineRaw?.quantity, `lines[${index}].quantity`, sellBy);
    const unitPriceGrosze = integer(lineRaw?.unitPriceGrosze, `lines[${index}].unitPriceGrosze`);
    const grossTotalGrosze = integer(lineRaw?.grossTotalGrosze, `lines[${index}].grossTotalGrosze`);
    const allocatedDiscountGrosze = integer(
      lineRaw?.allocatedDiscountGrosze,
      `lines[${index}].allocatedDiscountGrosze`,
    );
    const payableGrosze = integer(lineRaw?.payableGrosze, `lines[${index}].payableGrosze`);
    if (grossTotalGrosze !== calculateLineTotalGrosze(unitPriceGrosze, lineQuantity, sellBy)) {
      throw new Error(`Invalid billiard POS checkout: line total mismatch for ${lineKey}`);
    }
    if (grossTotalGrosze - allocatedDiscountGrosze !== payableGrosze) {
      throw new Error(`Invalid billiard POS checkout: payable allocation mismatch for ${lineKey}`);
    }

    const expectedPolicy = linePolicy(kind);
    if (lineRaw?.inventoryPolicy !== expectedPolicy.inventory || lineRaw?.refundPolicy !== expectedPolicy.refund) {
      throw new Error(`Invalid billiard POS checkout: policy mismatch for ${lineKey}`);
    }
    if (kind === 'TIME' && (lineQuantity !== 1 || sellBy !== 'PIECE')) {
      throw new Error('Invalid billiard POS checkout: playing time quantity must be 1');
    }

    const durationMinutes = lineRaw?.durationMinutes == null
      ? undefined
      : integer(lineRaw.durationMinutes, `lines[${index}].durationMinutes`);
    if (kind === 'TIME' && durationMinutes === undefined) {
      throw new Error('Invalid billiard POS checkout: playing time duration is missing');
    }

    const vatRate = Number(lineRaw?.vatRate);
    // The desktop fiscal contract maps only these Polish rates. Reject the
    // frozen checkout before it can reach payment/order commit; never defer a
    // permanently unprintable VAT failure until after tender was collected.
    if (![23, 8, 5, 0, -1].includes(vatRate)) {
      throw new Error(`Invalid billiard POS checkout: unsupported fiscal VAT ${vatRate} for ${lineKey}`);
    }

    return {
      lineKey,
      kind,
      sessionItemId: lineRaw?.sessionItemId ? String(lineRaw.sessionItemId) : undefined,
      variantId: requiredText(lineRaw?.variantId, `lines[${index}].variantId`),
      sku: lineRaw?.sku == null ? null : String(lineRaw.sku),
      displayName: requiredText(lineRaw?.displayName, `lines[${index}].displayName`),
      quantity: lineQuantity,
      sellBy,
      saleUnit,
      unitPriceGrosze,
      grossTotalGrosze,
      allocatedDiscountGrosze,
      payableGrosze,
      vatRate,
      durationMinutes,
      inventoryPolicy: expectedPolicy.inventory,
      refundPolicy: expectedPolicy.refund,
    };
  });

  const allocatedDiscount = lines.reduce((sum, line) => sum + line.allocatedDiscountGrosze, 0);
  const payable = lines.reduce((sum, line) => sum + line.payableGrosze, 0);
  if (allocatedDiscount !== discountGrosze || payable !== totalGrosze) {
    throw new Error('Invalid billiard POS checkout: frozen total does not match its lines');
  }

  return { schemaVersion, sessionId, checkoutId, totalGrosze, discountGrosze, lines };
}
