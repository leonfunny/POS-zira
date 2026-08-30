export interface ShiftAccountingOrder {
  status?: string | null;
  total?: number | null;
  discount?: number | null;
  tip?: number | null;
  payment_method?: string | null;
  payment_amount?: number | null;
  change_amount?: number | null;
  payment_tenders?: string | null;
}

export interface ShiftPaymentAllocation {
  method: string;
  amount: number;
}

export interface ShiftPaymentBuckets {
  cash: number;
  card: number;
  blik: number;
  transfer: number;
}

export interface ShiftSalesAccounting {
  salesTotal: number;
  totalDiscounts: number;
  totalTips: number;
  payments: ShiftPaymentBuckets;
}

const FINALIZED_SHIFT_SALE_STATUSES = new Set([
  'COMPLETED',
  'DELIVERED',
  'PAID',
  'PARTIAL_REFUND',
  'REFUNDED',
]);

function money(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount) : 0;
}

function parseTenderSnapshot(value: string | null | undefined): ShiftPaymentAllocation[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const allocations: ShiftPaymentAllocation[] = [];
    for (const value of parsed) {
      const row = value as { method?: unknown; amount?: unknown };
      const method = String(row?.method ?? '').trim().toUpperCase();
      const rawAmount = Number(row?.amount);
      if (!method || !Number.isFinite(rawAmount) || rawAmount < 0) return null;
      allocations.push({ method, amount: money(rawAmount) });
    }
    return allocations;
  } catch {
    return null;
  }
}

export function emptyShiftPaymentBuckets(): ShiftPaymentBuckets {
  return { cash: 0, card: 0, blik: 0, transfer: 0 };
}

export function addShiftPayment(
  buckets: ShiftPaymentBuckets,
  method: string | null | undefined,
  amountValue: unknown,
  sign = 1,
): void {
  const amount = money(amountValue) * sign;
  const normalized = String(method ?? '').trim().toUpperCase();
  if (normalized === 'CASH') buckets.cash += amount;
  else if (normalized === 'CARD') buckets.card += amount;
  else if (normalized === 'BLIK') buckets.blik += amount;
  else if (
    normalized === 'TRANSFER'
    || normalized === 'BANK_TRANSFER'
    || normalized === 'INVOICE'
  ) buckets.transfer += amount;
}

/**
 * A shift report is a ledger of settled sales, not every order row carrying the
 * shift id. Local checkouts persist COMPLETED; server mirrors may use PAID or
 * one of the refund terminal states. Unknown/open/cancelled states fail closed.
 * Legacy rows without a status are accepted only when they still carry payment
 * evidence.
 */
export function isShiftSaleOrder(order: ShiftAccountingOrder): boolean {
  const status = String(order.status ?? '').trim().toUpperCase();
  if (status && !FINALIZED_SHIFT_SALE_STATUSES.has(status)) return false;

  const primaryMethod = String(order.payment_method ?? '').trim();
  if (primaryMethod) return true;
  if (!order.payment_tenders) return false;
  return parseTenderSnapshot(order.payment_tenders) !== null;
}

/**
 * Tender allocations represent the money actually kept after change. Split
 * payments already persist exact allocations. A single payment persists cash
 * received separately, so subtract change; legacy rows fall back to sale+tip.
 */
export function getOrderPaymentAllocations(order: ShiftAccountingOrder): ShiftPaymentAllocation[] {
  const allocations = parseTenderSnapshot(order.payment_tenders);
  if (allocations) {
    const expected = money(order.total) + money(order.tip);
    const allocated = allocations.reduce((sum, row) => sum + row.amount, 0);
    if (allocated === expected) {
      return allocations;
    }
  }

  const settled = money(order.payment_amount) - money(order.change_amount);
  const fallback = money(order.total) + money(order.tip);
  return [{
    method: String(order.payment_method ?? '').trim().toUpperCase(),
    amount: settled > 0 ? settled : fallback,
  }];
}

/** Allocate a refund back across the immutable sale tender snapshot. */
export function getRefundPaymentAllocations(
  order: ShiftAccountingOrder,
  refundAmountValue: unknown,
): ShiftPaymentAllocation[] {
  const refundAmount = Math.max(0, money(refundAmountValue));
  if (refundAmount === 0) return [];

  // Refund events retain the immutable tender snapshot but intentionally do
  // not duplicate the sale total. Trust a structurally valid snapshot here;
  // getOrderPaymentAllocations has a stricter total-equality check for sales.
  const tenders = parseTenderSnapshot(order.payment_tenders)
    ?? getOrderPaymentAllocations(order);
  if (tenders.length <= 1) {
    return [{
      method: tenders[0]?.method ?? String(order.payment_method ?? '').trim().toUpperCase(),
      amount: refundAmount,
    }];
  }

  const tenderTotal = tenders.reduce((sum, tender) => sum + Math.max(0, money(tender.amount)), 0);
  if (tenderTotal <= 0) {
    return [{ method: tenders[0]?.method ?? '', amount: refundAmount }];
  }

  // Largest-remainder allocation guarantees non-negative integer amounts and
  // an exact sum even with three or more tenders (independent rounding can
  // otherwise over-allocate and make the final tender negative).
  const weighted = tenders.map((tender, index) => {
    const exact = refundAmount * (Math.max(0, money(tender.amount)) / tenderTotal);
    const amount = Math.floor(exact);
    return { method: tender.method, amount, remainder: exact - amount, index };
  });
  let remainder = refundAmount - weighted.reduce((sum, tender) => sum + tender.amount, 0);
  const byRemainder = [...weighted].sort((left, right) =>
    right.remainder - left.remainder || left.index - right.index,
  );
  for (let index = 0; index < byRemainder.length && remainder > 0; index += 1) {
    byRemainder[index].amount += 1;
    remainder -= 1;
  }
  return weighted.map(({ method, amount }) => ({ method, amount }));
}

export function summarizeShiftSales(orders: ShiftAccountingOrder[]): ShiftSalesAccounting {
  const payments = emptyShiftPaymentBuckets();
  let salesTotal = 0;
  let totalDiscounts = 0;
  let totalTips = 0;

  for (const order of orders) {
    salesTotal += money(order.total);
    totalDiscounts += money(order.discount);
    totalTips += money(order.tip);
    for (const allocation of getOrderPaymentAllocations(order)) {
      addShiftPayment(payments, allocation.method, allocation.amount);
    }
  }

  return { salesTotal, totalDiscounts, totalTips, payments };
}
