export type RefundType = 'FULL' | 'PARTIAL';

export interface RefundIpcLine {
  variantId?: string;
  sku?: string;
  name?: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  refundAmount: number;
  restock: boolean;
  vatRate?: number;
}

export interface RefundTenderAllocation {
  method: string;
  amount: number;
}

export interface RefundIpcPayload {
  type: RefundType;
  refundRequestId?: string;
  reason?: string;
  amount?: number;
  lines?: RefundIpcLine[];
  tenderAllocations?: RefundTenderAllocation[];
  manualAdjustmentAmount?: number;
}

export interface LocalRefundLine {
  variantId?: string;
  name: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  refundAmount: number;
  vatRate?: number;
  sku?: string;
}

export interface RefundBackendResult {
  success?: boolean;
  refundAmount?: number | string | null;
  totalRefundedAmount?: number | string | null;
  status?: string;
  restocked?: any[];
  refundedLines?: any[];
  stockMovementIds?: any[];
  refundReason?: string | null;
}

export function parseLocalRefundLines(raw: string | null | undefined): LocalRefundLine[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function mergeRefundLines(
  existingRefundLinesJson: string | null | undefined,
  deltaRefundLines: LocalRefundLine[],
): LocalRefundLine[] {
  return [
    ...parseLocalRefundLines(existingRefundLinesJson),
    ...deltaRefundLines,
  ];
}

export interface RefundBackendSummary {
  status?: string;
  refundAmount: number | null;
  totalRefundedAmount: number | null;
  refundedLinesLength: number;
  stockMovementIdsLength: number;
}

export type RefundBackendValidationResult = {
  ok: boolean;
  classification: 'confirmedComplete' | 'mutatedButIncomplete' | 'rejected';
  error?: string;
  refundAmountGrosze: number | null;
  refundedAmountGrosze: number | null;
  summary: RefundBackendSummary;
  mutationDetected: boolean;
  requiresRefresh: boolean;
  overRefund: boolean;
  missingLines: boolean;
  missingStockMovement: boolean;
  missingTotalRefundedAmount: boolean;
  amountMismatch: boolean;
};

function plnToGrosze(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (!isFinite(n)) return null;
  return Math.round(n * 100);
}

function getRefundedLinesAmountGrosze(result: RefundBackendResult): number | null {
  if (!Array.isArray(result.refundedLines) || result.refundedLines.length === 0) return null;
  let total = 0;
  let hasAmount = false;
  for (const line of result.refundedLines) {
    const amount = plnToGrosze((line as any)?.refundAmount);
    if (amount == null || amount <= 0) continue;
    total += amount;
    hasAmount = true;
  }
  return hasAmount ? total : null;
}

export function getRefundedAmountGrosze(result: RefundBackendResult): number | null {
  return plnToGrosze(result.totalRefundedAmount);
}

export function getRefundBackendResponseSummary(result: RefundBackendResult): RefundBackendSummary {
  return {
    status: result.status,
    refundAmount: result.refundAmount == null ? null : Number(result.refundAmount),
    totalRefundedAmount: result.totalRefundedAmount == null ? null : Number(result.totalRefundedAmount),
    refundedLinesLength: Array.isArray(result.refundedLines) ? result.refundedLines.length : 0,
    stockMovementIdsLength: Array.isArray(result.stockMovementIds)
      ? result.stockMovementIds.length
      : Array.isArray(result.restocked)
        ? result.restocked.length
        : 0,
  };
}

export function validateRefundBackendResponse(
  result: RefundBackendResult,
  opts: {
    type: RefundType;
    requestedAmountGrosze: number;
    orderTotalGrosze: number;
    alreadyRefundedGrosze: number;
    requireRefundedLines: boolean;
    requireStockMovement: boolean;
    /**
     * Optional gross-up factor applied to `requestedAmountGrosze` for
     * the strict amount comparison. Server now derives the refund delta
     * server-side as gross when an order is `priceType=brutto`, so the
     * client's net-based `requestedAmountGrosze` will be smaller than
     * the response's `refundAmount`. Pass `1 + tax/subtotal` (typically
     * 1.08, 1.05, 1.23 …) to keep the strict equality check while
     * tolerating the server-side gross-up.
     */
    grossUpFactor?: number;
    /**
     * Additional acceptable refund deltas in grosze. This is used when
     * the client selected/refunded net line amounts but the backend
     * correctly reports gross refund amounts.
     */
    expectedDeltaGroszeCandidates?: number[];
  },
): RefundBackendValidationResult {
  const summary = getRefundBackendResponseSummary(result);
  const refundAmountGrosze = plnToGrosze(result.refundAmount);
  const refundedAmountGrosze = getRefundedAmountGrosze(result);
  const refundedLinesAmountGrosze = getRefundedLinesAmountGrosze(result);
  const mutationDetected = (
    result.status === 'REFUNDED' ||
    result.status === 'PARTIAL_REFUND' ||
    (refundAmountGrosze != null && refundAmountGrosze > 0) ||
    (refundedAmountGrosze != null && refundedAmountGrosze > opts.alreadyRefundedGrosze)
  );
  const overRefund = refundedAmountGrosze != null && refundedAmountGrosze > opts.orderTotalGrosze;
  const missingLines = opts.requireRefundedLines && summary.refundedLinesLength === 0;
  const missingStockMovement = opts.requireStockMovement && summary.stockMovementIdsLength === 0;
  const missingTotalRefundedAmount = refundedAmountGrosze == null;
  const factor = opts.grossUpFactor && opts.grossUpFactor > 1 ? opts.grossUpFactor : 1;
  const expectedDeltaGrosze = Math.round(opts.requestedAmountGrosze * factor);
  const expectedDeltaCandidates = Array.from(new Set([
    expectedDeltaGrosze,
    refundedLinesAmountGrosze,
    ...(opts.expectedDeltaGroszeCandidates ?? []),
  ].filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)));
  // Allow a 1-grosz rounding tolerance plus an extra 1-grosz per percent
  // of gross-up to absorb compounding rounding errors when the server
  // grosses up each line individually before summing.
  const tolerance = factor > 1 ? Math.max(2, Math.ceil(factor * 2)) : 1;
  const amountMatches = expectedDeltaCandidates.some((delta) => {
    const expectedCumulative = opts.type === 'FULL'
      ? opts.orderTotalGrosze
      : opts.alreadyRefundedGrosze + delta;
    return refundAmountGrosze != null
      && refundedAmountGrosze != null
      && Math.abs(refundAmountGrosze - delta) <= tolerance
      && Math.abs(refundedAmountGrosze - expectedCumulative) <= tolerance;
  });
  const amountMismatch = !amountMatches;

  const fail = (
    classification: RefundBackendValidationResult['classification'],
    error: string,
  ): RefundBackendValidationResult => ({
    ok: false,
    classification,
    error,
    refundAmountGrosze,
    refundedAmountGrosze,
    summary,
    mutationDetected,
    requiresRefresh: mutationDetected,
    overRefund,
    missingLines,
    missingStockMovement,
    missingTotalRefundedAmount,
    amountMismatch,
  });

  if (result.success === false && !mutationDetected) {
    return fail('rejected', 'Backend rejected refund');
  }
  if (result.success === false) {
    return fail('mutatedButIncomplete', 'Backend reported failure after a refund mutation signal');
  }
  if (!mutationDetected) {
    return fail('rejected', 'Backend refund response did not include a mutation signal');
  }
  if (overRefund) {
    return fail('mutatedButIncomplete', 'Backend refund response exceeds the order total');
  }
  if (missingTotalRefundedAmount) {
    return fail('mutatedButIncomplete', 'Backend refund response did not include totalRefundedAmount');
  }
  if (amountMismatch) {
    return fail('mutatedButIncomplete', 'Backend refund response amount does not match the requested refund delta or cumulative total');
  }
  if (missingLines) {
    return fail('mutatedButIncomplete', 'Backend refund response did not include refundedLines for the refunded POS lines');
  }
  if (missingStockMovement) {
    return fail('mutatedButIncomplete', 'Backend refund response did not include stockMovementIds for restock=true lines');
  }

  return {
    ok: true,
    classification: 'confirmedComplete',
    refundAmountGrosze,
    refundedAmountGrosze,
    summary,
    mutationDetected: true,
    requiresRefresh: false,
    overRefund: false,
    missingLines: false,
    missingStockMovement: false,
    missingTotalRefundedAmount: false,
    amountMismatch: false,
  };
}

export function buildRefundMutationError(result: RefundBackendValidationResult): string {
  if (result.overRefund) {
    return 'Backend reported a refund greater than the order total. Refreshing order; do not retry.';
  }
  if (result.missingLines || result.missingStockMovement || result.missingTotalRefundedAmount || result.amountMismatch) {
    return 'Refund may have been applied on server but response is incomplete. Refreshing order; do not retry.';
  }
  return result.error || 'Refund failed';
}

function normalizeRefundTenderMethod(method: unknown): string | null {
  const raw = typeof method === 'string' ? method.trim().toUpperCase() : '';
  if (!raw || raw === 'SPLIT' || raw === 'MIXED') return null;
  if (raw === 'TRANSFER' || raw === 'INVOICE') return 'BANK_TRANSFER';
  return raw;
}

function normalizeMinorAmount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

export function normalizeRefundTenderAllocations(
  tenders: RefundTenderAllocation[] | null | undefined,
): RefundTenderAllocation[] {
  if (!Array.isArray(tenders)) return [];
  return tenders
    .map((t) => {
      const method = normalizeRefundTenderMethod((t as any)?.method);
      const amount = normalizeMinorAmount((t as any)?.amount);
      return method && amount > 0 ? { method, amount } : null;
    })
    .filter((t): t is RefundTenderAllocation => t !== null);
}

function fallbackRefundTender(refundAmountGrosze: number, fallbackMethod?: string | null): RefundTenderAllocation[] {
  const method = normalizeRefundTenderMethod(fallbackMethod);
  const amount = normalizeMinorAmount(refundAmountGrosze);
  return method && amount > 0 ? [{ method, amount }] : [];
}

export function allocateRefundTenders(
  paymentTendersJson: string | null | undefined,
  refundAmountGrosze: number,
  fallbackMethod?: string | null,
): RefundTenderAllocation[] {
  const refundAmount = normalizeMinorAmount(refundAmountGrosze);
  if (refundAmount <= 0) return [];

  let source: RefundTenderAllocation[] = [];
  if (paymentTendersJson) {
    try {
      const parsed = JSON.parse(paymentTendersJson);
      source = normalizeRefundTenderAllocations(Array.isArray(parsed) ? parsed : []);
    } catch {
      source = [];
    }
  }

  if (source.length === 0) return fallbackRefundTender(refundAmount, fallbackMethod);

  const tenderTotal = source.reduce((sum, t) => sum + t.amount, 0);
  if (tenderTotal <= 0) return fallbackRefundTender(refundAmount, fallbackMethod);

  let distributed = 0;
  return source
    .map((t, index) => {
      const isLast = index === source.length - 1;
      const amount = isLast
        ? refundAmount - distributed
        : Math.round(refundAmount * (t.amount / tenderTotal));
      distributed += amount;
      return amount > 0 ? { method: t.method, amount } : null;
    })
    .filter((t): t is RefundTenderAllocation => t !== null);
}

export function toRefundBackendPayload(data: RefundIpcPayload): Record<string, any> {
  const lines = (data.lines ?? []).map(l => ({
    variantId: l.variantId,
    sku: l.sku,
    name: l.name,
    quantity: l.quantity,
    ...(l.unit ? { unit: l.unit, saleUnit: l.unit } : {}),
    unitPrice: l.unitPrice / 100,
    refundAmount: l.refundAmount / 100,
    restock: l.restock,
  }));

  const backendPayload: Record<string, any> = {
    type: data.type,
    reason: data.reason,
  };

  if (data.refundRequestId) {
    backendPayload.refundRequestId = data.refundRequestId;
  }

  if (lines.length > 0) {
    backendPayload.lines = lines;
  }

  const amount = data.amount ?? data.lines?.reduce((sum, l) => sum + l.refundAmount, 0);
  if (amount != null) {
    backendPayload.amount = amount / 100;
  }

  if (data.manualAdjustmentAmount != null) {
    backendPayload.manualAdjustmentAmount = data.manualAdjustmentAmount / 100;
  }

  const tenderAllocations = normalizeRefundTenderAllocations(data.tenderAllocations);
  if (tenderAllocations.length > 0) {
    backendPayload.tenderAllocations = tenderAllocations.map((t) => ({
      method: t.method,
      amount: t.amount / 100,
    }));
  }

  return backendPayload;
}
