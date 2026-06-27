/**
 * Adapts server PosOrder (camelCase, PLN string decimals) → local OrderRow shape
 * (snake_case, grosze integers) for the History UI.
 *
 * Field names verified via curl against GET /api/v1/b2b/pos/orders?period=week.
 */

import logger from '../logger';
import { calculateLineTotalGrosze, normalizeSaleUnit, normalizeSellBy, resolveSaleQuantity } from '../../shared/pos-sale';

const _warnedFields = new Set<string>();

function warnOnce(field: string, sample: any): void {
  if (_warnedFields.has(field)) return;
  _warnedFields.add(field);
  logger.warn(
    `[PosOrderAdapter] Missing field "${field}" in server response. ` +
    `Order id=${sample.id}, status=${sample.status}. Sample keys: ` +
    JSON.stringify(Object.keys(sample))
  );
}

// Exported because applyOrder (entity-applicators) needs the same
// money/vat normalisation when handling inbound update payloads —
// otherwise refundAmount strings like "12.34" land in `orders` as
// text and any vat-rate flatten to 23% silently.
export function toGrosze(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

function toOptionalGrosze(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (!isFinite(n)) return null;
  return Math.round(n * 100);
}

function grossFromNet(netGrosze: number, vatRate: number): number {
  if (netGrosze <= 0 || vatRate <= 0) return netGrosze;
  return Math.round(netGrosze * (100 + vatRate) / 100);
}

function serverOrderLooksNetPriced(s: any): boolean {
  const subtotal = toGrosze(s?.subtotal);
  const tax = toGrosze(s?.taxAmount);
  const discount = toGrosze(s?.discountAmount);
  const total = toGrosze(s?.total);
  if (subtotal <= 0 || tax <= 0 || total <= 0) return false;
  return Math.abs((subtotal + tax - discount) - total) <= 1;
}

function rawItemTotalsMatchOrderGross(serverOrder: any): boolean {
  const items = Array.isArray(serverOrder?.items) ? serverOrder.items : null;
  const expectedGross = toGrosze(serverOrder?.total) + toGrosze(serverOrder?.discountAmount);
  if (!items || items.length === 0 || expectedGross <= 0) return false;

  let sum = 0;
  for (const item of items) {
    const total = toOptionalGrosze(item?.grossTotalPrice ?? item?.totalPrice);
    if (total === null) return false;
    sum += total;
  }

  return Math.abs(sum - expectedGross) <= 1;
}

function resolveServerPaymentAmount(args: {
  paymentMethod: string | null;
  total: number;
  paidAmount: number;
  changeAmount: number;
  cashReceived: number | null;
}): number {
  if (args.paymentMethod !== 'CASH') return args.paidAmount;
  if (args.cashReceived != null) return args.cashReceived;
  if (args.total > 0 && args.changeAmount > 0 && args.paidAmount <= args.total) {
    return args.total + args.changeAmount;
  }
  return args.paidAmount;
}

// Resolves VAT rate while preserving legitimate 0% (export sales). Falls back
// only when value is missing or non-numeric — avoids the `parseFloat('0') || 23`
// trap that would silently rewrite legitimate 0% products to 23%.
export function toVatRate(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return isFinite(n) ? n : fallback;
}

/**
 * Convert a server-side `refundedLines[]` (REST shape, PLN strings,
 * `taxRate`) into the JSON string that local `orders.refund_lines`
 * stores: camelCase, grosze integers, `vatRate`. Returns null if the
 * input has no usable lines — matches the adaptServerOrder
 * convention.
 */
export function normalizeRefundLinesJson(refundedLines: unknown): string | null {
  if (!Array.isArray(refundedLines) || refundedLines.length === 0) return null;
  const out = refundedLines.map((l: any) => ({
    variantId: l.variantId ?? l.variant_id ?? undefined,
    name: l.name ?? '',
    quantity:
      typeof l.quantity === 'number'
        ? l.quantity
        : parseFloat(String(l.quantity)) || 1,
    unit: l.unit ?? l.saleUnit ?? l.sale_unit ?? undefined,
    unitPrice: toGrosze(l.unitPrice),
    refundAmount: toGrosze(l.refundAmount),
    vatRate: toVatRate(l.taxRate, 23),
    sku: l.sku ?? undefined,
  }));
  return JSON.stringify(out);
}

export function normalizePaymentTendersJson(tenders: unknown): string | null {
  if (!Array.isArray(tenders) || tenders.length === 0) return null;
  const out = tenders
    .map((t: any) => {
      const method = typeof t?.method === 'string' ? t.method : null;
      const amount = toGrosze(t?.amount);
      if (!method || amount <= 0) return null;
      const tender: { method: string; amount: number; reference?: string } = { method, amount };
      if (t.reference != null && String(t.reference).length > 0) {
        tender.reference = String(t.reference);
      }
      return tender;
    })
    .filter((t): t is { method: string; amount: number; reference?: string } => Boolean(t));
  return out.length > 0 ? JSON.stringify(out) : null;
}

export function adaptServerOrder(s: any): any {
  if (s.subtotal === undefined) warnOnce('subtotal', s);
  if (s.discountAmount === undefined) warnOnce('discountAmount', s);
  if (s.taxAmount === undefined) warnOnce('taxAmount', s);
  if (s.total === undefined) warnOnce('total', s);
  if (s.paidAmount === undefined) warnOnce('paidAmount', s);
  if (s.posMode === undefined && s.mode === undefined) warnOnce('posMode', s);
  if ((s.status === 'REFUNDED' || s.status === 'PARTIAL_REFUND') && s.refundAmount === undefined) {
    warnOnce('refundAmount', s);
  }

  const total = toGrosze(s.total);
  const discount = toGrosze(s.discountAmount);
  const paidAmount = toGrosze(s.paidAmount);
  const changeAmount = toGrosze(s.changeAmount);
  const paymentMethod = s.paymentMethod ?? null;
  const cashReceived = toOptionalGrosze(s.cashReceived ?? s.cash_received);
  const subtotal = serverOrderLooksNetPriced(s) ? total + discount : toGrosze(s.subtotal);
  const paymentAmount = resolveServerPaymentAmount({
    paymentMethod,
    total,
    paidAmount,
    changeAmount,
    cashReceived,
  });

  return {
    id: s.id,
    order_number: s.orderNumber ?? null,
    status: (() => {
      if (s.status === 'REFUNDED' || s.status === 'PARTIAL_REFUND' || s.status === 'CANCELLED') {
        return s.status;
      }
      const ref = parseFloat(String(s.refundAmount ?? '0'));
      const tot = parseFloat(String(s.total ?? '0'));
      if (isFinite(ref) && isFinite(tot) && tot > 0) {
        if (ref >= tot) return 'REFUNDED';
        if (ref > 0) return 'PARTIAL_REFUND';
      }
      return s.status === 'DELIVERED' ? 'COMPLETED' : (s.status ?? 'COMPLETED');
    })(),
    subtotal,
    discount,
    tax: toGrosze(s.taxAmount),
    total,
    payment_method: paymentMethod,
    payment_amount: paymentAmount,
    change_amount: changeAmount,
    tip: toGrosze(s.tip),
    staff_name: s.staffName ?? null,
    staff_id: s.staffId ?? null,
    shift_id: s.shiftId ?? null,
    created_at: s.createdAt ?? new Date().toISOString(),
    mode: s.posMode ?? s.mode ?? null,
    backend_id: s.id,
    synced: 1,
    refund_amount: toGrosze(s.refundAmount),
    refund_reason: s.refundReason ?? null,
    refunded_at: s.refundedLines?.[0]?.refundedAt ?? null,
    refund_lines: normalizeRefundLinesJson(s.refundedLines),
    customer_id: s.customerId ?? null,
    customer_nip: s.customerNip ?? null,
    customer_name: s.customerName ?? null,
    requires_invoice: Boolean(s.requiresInvoice),
    payment_tenders: normalizePaymentTendersJson(s.tenders),
    sync_error: null,
    sync_attempts: 0,
    _origin: 'server' as const,
  };
}

export function adaptServerOrderItem(item: any, orderId: string, serverOrder?: any): any {
  const sellBy = normalizeSellBy(item.sellBy ?? item.sell_by ?? item.product?.sellBy ?? item.product?.sell_by);
  const rawQuantity = sellBy === 'WEIGHT'
    ? item.saleQuantity ?? item.sale_quantity ?? item.quantity ?? item.totalUnits ?? item.packQuantity ?? 1
    : item.totalUnits ?? item.packQuantity ?? item.saleQuantity ?? item.sale_quantity ?? item.quantity ?? 1;
  const quantity = resolveSaleQuantity({
    quantity: typeof rawQuantity === 'number' ? rawQuantity : parseFloat(String(rawQuantity)) || 1,
    sellBy,
  });
  const saleUnit = normalizeSaleUnit({
    saleUnit: item.saleUnit ?? item.sale_unit ?? item.unit ?? item.product?.saleUnit ?? item.product?.sale_unit,
    sellBy,
  });
  const vatRate = toVatRate(item.taxRate ?? item.tax_rate ?? item.product?.taxRate ?? item.product?.tax_rate, 23);
  const rawTotalsAlreadyGross = rawItemTotalsMatchOrderGross(serverOrder);
  const netPricedServerOrder = serverOrderLooksNetPriced(serverOrder) && !rawTotalsAlreadyGross;
  const explicitGrossUnitPrice = toOptionalGrosze(item.grossUnitPrice);
  const explicitGrossTotal = toOptionalGrosze(item.grossTotalPrice);
  let rawUnitPrice: number | null = null;
  let price: number;
  if (explicitGrossUnitPrice !== null) {
    price = explicitGrossUnitPrice;
  } else {
    rawUnitPrice = toGrosze(item.unitPrice);
    price = netPricedServerOrder ? grossFromNet(rawUnitPrice, vatRate) : rawUnitPrice;
  }

  let total: number;
  if (explicitGrossTotal !== null) {
    total = explicitGrossTotal;
  } else {
    if (rawUnitPrice === null) rawUnitPrice = toGrosze(item.unitPrice);
    const rawTotal = item.totalPrice == null
      ? calculateLineTotalGrosze(rawUnitPrice, quantity, sellBy)
      : toGrosze(item.totalPrice);
    total = netPricedServerOrder ? grossFromNet(rawTotal, vatRate) : rawTotal;
  }
  return {
    id: item.id ?? `${orderId}-${item.variantId ?? item.variant_id ?? item.productId ?? String(Math.random()).slice(2, 10)}`,
    order_id: orderId,
    variant_id: item.variantId ?? item.variant_id ?? item.productId ?? item.product?.id ?? null,
    name: item.productName ?? item.product_name ?? item.product?.name ?? '',
    sku: item.variantSku ?? item.variant_sku ?? item.productSku ?? item.product_sku ?? item.product?.sku ?? null,
    price,
    quantity,
    sale_quantity: quantity,
    sale_unit: saleUnit,
    sell_by: sellBy,
    total,
    vat_rate: vatRate,
  };
}
