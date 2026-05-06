export type RefundType = 'FULL' | 'PARTIAL';

export interface RefundLineInput {
  variantId?: string;
  sku?: string;
  name?: string;
  quantity: number;
  unitPrice: number;
  refundAmount: number;
  restock: boolean;
}

export interface RefundRequestInput {
  type: RefundType;
  reason?: string;
  lines: RefundLineInput[];
  computedRefundTotal: number;
}

export function buildRefundRequest(input: RefundRequestInput): {
  type: RefundType;
  reason?: string;
  amount?: number;
  lines: RefundLineInput[];
} {
  return {
    type: input.type,
    reason: input.reason,
    ...(input.type === 'PARTIAL' ? { amount: input.computedRefundTotal } : {}),
    lines: input.lines,
  };
}
