/**
 * Adapts server PosOrder (camelCase, PLN string decimals) → local OrderRow shape
 * (snake_case, grosze integers) for the History UI.
 *
 * Field names verified via curl against GET /api/v1/b2b/pos/orders?period=week.
 */

import logger from '../logger';

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
    name: l.name ?? '',
    quantity:
      typeof l.quantity === 'number'
        ? l.quantity
        : parseInt(String(l.quantity), 10) || 1,
    unitPrice: toGrosze(l.unitPrice),
    refundAmount: toGrosze(l.refundAmount),
    vatRate: toVatRate(l.taxRate, 23),
    sku: l.sku ?? undefined,
  }));
  return JSON.stringify(out);
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
    subtotal: toGrosze(s.subtotal),
    discount: toGrosze(s.discountAmount),
    tax: toGrosze(s.taxAmount),
    total: toGrosze(s.total),
    payment_method: s.paymentMethod ?? null,
    payment_amount: toGrosze(s.paidAmount),
    change_amount: toGrosze(s.changeAmount),
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
    payment_tenders: null,
    sync_error: null,
    sync_attempts: 0,
    _origin: 'server' as const,
  };
}

export function adaptServerOrderItem(item: any, orderId: string): any {
  return {
    id: item.id ?? `${orderId}-${item.variantId ?? String(Math.random()).slice(2, 10)}`,
    order_id: orderId,
    variant_id: item.variantId ?? null,
    name: item.productName ?? '',
    sku: item.variantSku ?? null,
    price: toGrosze(item.unitPrice),
    quantity: item.packQuantity ?? 1,
    total: toGrosze(item.totalPrice),
    vat_rate: toVatRate(item.taxRate, 23),
  };
}
