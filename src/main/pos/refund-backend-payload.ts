export type RefundType = 'FULL' | 'PARTIAL';

export interface RefundIpcLine {
  variantId?: string;
  sku?: string;
  name?: string;
  quantity: number;
  unitPrice: number;
  refundAmount: number;
  restock: boolean;
}

export interface RefundIpcPayload {
  type: RefundType;
  refundRequestId?: string;
  reason?: string;
  amount?: number;
  lines?: RefundIpcLine[];
  manualAdjustmentAmount?: number;
}

export interface LocalRefundLine {
  variantId?: string;
  name: string;
  quantity: number;
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
  },
): RefundBackendValidationResult {
  const summary = getRefundBackendResponseSummary(result);
  const refundAmountGrosze = plnToGrosze(result.refundAmount);
  const refundedAmountGrosze = getRefundedAmountGrosze(result);
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
  const expectedCumulative = opts.type === 'FULL'
    ? opts.orderTotalGrosze
    : opts.alreadyRefundedGrosze + opts.requestedAmountGrosze;
  const refundAmountMismatch = refundAmountGrosze == null || Math.abs(refundAmountGrosze - opts.requestedAmountGrosze) > 1;
  const totalRefundedMismatch = refundedAmountGrosze == null || Math.abs(refundedAmountGrosze - expectedCumulative) > 1;
  const amountMismatch = refundAmountMismatch || totalRefundedMismatch;

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

export function toRefundBackendPayload(data: RefundIpcPayload): Record<string, any> {
  const lines = (data.lines ?? []).map(l => ({
    variantId: l.variantId,
    sku: l.sku,
    name: l.name,
    quantity: l.quantity,
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

  return backendPayload;
}
