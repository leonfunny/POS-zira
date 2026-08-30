export interface ShiftAccountingOrder {
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

function money(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount) : 0;
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
 * Tender allocations represent the money actually kept after change. Split
 * payments already persist exact allocations. A single payment persists cash
 * received separately, so subtract change; legacy rows fall back to sale+tip.
 */
export function getOrderPaymentAllocations(order: ShiftAccountingOrder): ShiftPaymentAllocation[] {
  if (order.payment_tenders) {
    try {
      const parsed = JSON.parse(order.payment_tenders) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        let malformed = false;
        const allocations = parsed
          .map((value) => {
            const row = value as { method?: unknown; amount?: unknown };
            const method = String(row?.method ?? '').trim().toUpperCase();
            const rawAmount = Number(row?.amount);
            if (!method || !Number.isFinite(rawAmount) || rawAmount < 0) {
              malformed = true;
            }
            return {
              method,
              amount: money(row?.amount),
            };
          })
          .filter((row) => row.method && row.amount >= 0);
        const expected = money(order.total) + money(order.tip);
        const allocated = allocations.reduce((sum, row) => sum + row.amount, 0);
        if (
          !malformed
          && allocations.length === parsed.length
          && allocations.length > 0
          && allocated === expected
        ) {
          return allocations;
        }
      }
    } catch {
      // Legacy malformed JSON falls through to the single-payment snapshot.
    }
  }

  const settled = money(order.payment_amount) - money(order.change_amount);
  const fallback = money(order.total) + money(order.tip);
  return [{
    method: String(order.payment_method ?? '').trim().toUpperCase(),
    amount: settled > 0 ? settled : fallback,
  }];
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
