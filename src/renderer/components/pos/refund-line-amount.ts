import {
  calculateLineTotalGrosze,
  normalizeSellBy,
  roundSaleQuantity,
} from '../../../shared/pos-sale';

export interface RefundLineAmountItem {
  price: number;
  quantity: number;
  total?: number | null;
  sell_by?: string | null;
}

export interface RefundLineAmountBasisInput extends RefundLineAmountItem {
  remainingQuantity: number;
  refundedAmount?: number | null;
  /** Frozen post-discount line allocation; used for Billiard lines. */
  authoritativePayableTotal?: number | null;
}

function toGrosze(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/**
 * Build the financial basis for the still-refundable quantity. Billiard lines
 * use their persisted post-discount allocation, never catalog unit price or
 * the pre-discount sold total.
 */
export function buildRefundLineAmountBasis(input: RefundLineAmountBasisInput): RefundLineAmountItem {
  const originalTotal = input.authoritativePayableTotal == null
    ? toGrosze(input.total)
    : toGrosze(input.authoritativePayableTotal);
  return {
    price: input.price,
    quantity: input.remainingQuantity,
    total: Math.max(0, originalTotal - toGrosze(input.refundedAmount)),
    sell_by: input.sell_by,
  };
}

export function getRefundLineUnitPrice(item: RefundLineAmountItem): number {
  const sellBy = normalizeSellBy(item.sell_by);
  const quantity = roundSaleQuantity(Number(item.quantity) || 0, sellBy);
  const total = toGrosze(item.total);
  if (quantity > 0 && total > 0) {
    return Math.round(total / quantity);
  }
  return toGrosze(item.price);
}

export function calculateRefundLineAmount(item: RefundLineAmountItem, selectedQuantity: number): number {
  const sellBy = normalizeSellBy(item.sell_by);
  const lineQuantity = roundSaleQuantity(Number(item.quantity) || 0, sellBy);
  const quantity = roundSaleQuantity(Number(selectedQuantity) || 0, sellBy);
  const total = toGrosze(item.total);
  if (quantity <= 0) return 0;
  if (total <= 0 || lineQuantity <= 0) {
    return calculateLineTotalGrosze(toGrosze(item.price), quantity, sellBy);
  }
  if (quantity >= lineQuantity) return total;
  return Math.min(total, Math.round(total * quantity / lineQuantity));
}
