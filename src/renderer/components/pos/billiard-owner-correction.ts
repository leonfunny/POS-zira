export interface BilliardCorrectionVisibilityInput {
  role?: string | null;
  billiardOriginJson?: string | null;
  backendId?: string | null;
  synced?: number | null;
  status?: string | null;
}

export function canShowBilliardOwnerCorrection(input: BilliardCorrectionVisibilityInput): boolean {
  return String(input.role || '').toUpperCase() === 'OWNER'
    && Boolean(input.billiardOriginJson)
    && Boolean(input.backendId)
    && input.synced === 1
    && String(input.status || '').toUpperCase() !== 'REFUNDED';
}

export function isBilliardCorrectionInvoiceLinked(order: {
  customerNip?: string | null;
  requiresInvoice?: boolean | null;
  invoiceId?: string | null;
}): boolean {
  return Boolean(order.customerNip || order.requiresInvoice || order.invoiceId);
}

export function hasBilliardCorrectionExternalSettlementRisk(order: {
  paymentMethod?: string | null;
  paymentTendersJson?: string | null;
  hasFiscal?: number | boolean | null;
}): boolean {
  const method = String(order.paymentMethod || '').toUpperCase();
  let split = method === 'SPLIT';
  try {
    const tenders = order.paymentTendersJson ? JSON.parse(order.paymentTendersJson) : null;
    split = split || (Array.isArray(tenders) && tenders.length > 1);
  } catch { /* malformed local tender metadata is not treated as reassurance */ }
  return Boolean(order.hasFiscal)
    || split
    || ['CARD', 'BLIK', 'TRANSFER', 'BANK_TRANSFER'].includes(method);
}

export function canSubmitBilliardOwnerCorrection(input: {
  reason: string;
  shiftOpen: boolean;
  shiftId?: string | null;
  invoiceLinked: boolean;
  externalReversalAcknowledged: boolean;
}): boolean {
  const reason = input.reason.trim();
  return reason.length >= 3
    && reason.length <= 500
    && input.shiftOpen
    && Boolean(input.shiftId)
    && !input.invoiceLinked
    && input.externalReversalAcknowledged;
}

export function createBilliardCorrectionRequestId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('Secure UUID generation is unavailable on this device.');
  }
  return globalThis.crypto.randomUUID();
}
