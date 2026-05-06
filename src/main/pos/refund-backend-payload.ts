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
  reason?: string;
  amount?: number;
  lines?: RefundIpcLine[];
  manualAdjustmentAmount?: number;
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

  if (lines.length > 0) {
    backendPayload.lines = lines;
  }

  if (data.type === 'PARTIAL') {
    const amount = data.amount ?? data.lines?.reduce((sum, l) => sum + l.refundAmount, 0);
    if (amount != null) {
      backendPayload.amount = amount / 100;
    }
  }

  if (data.manualAdjustmentAmount != null) {
    backendPayload.manualAdjustmentAmount = data.manualAdjustmentAmount / 100;
  }

  return backendPayload;
}
