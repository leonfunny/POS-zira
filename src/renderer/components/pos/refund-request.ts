export type RefundType = 'FULL' | 'PARTIAL';

export interface RefundLineInput {
  variantId?: string;
  sku?: string;
  name?: string;
  quantity: number;
  unitPrice: number;
  refundAmount: number;
  restock: boolean;
  vatRate?: number;
}

export interface RefundRequestInput {
  type: RefundType;
  refundRequestId: string;
  reason?: string;
  lines: RefundLineInput[];
  computedRefundTotal: number;
}

export function buildRefundRequest(input: RefundRequestInput): {
  type: RefundType;
  refundRequestId: string;
  reason?: string;
  amount: number;
  lines: RefundLineInput[];
} {
  return {
    type: input.type,
    refundRequestId: input.refundRequestId,
    reason: input.reason,
    amount: input.computedRefundTotal,
    lines: input.lines,
  };
}
