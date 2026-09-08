import { adaptServerOrder, adaptServerOrderItem, normalizeRefundLinesJson } from './pos-order-adapter';
import { allocateRefundTenders, toRefundBackendPayload, type LocalRefundLine, type RefundIpcPayload } from './refund-backend-payload';
import { validateRefundDetailIdentity, type RefundAuthorityExpected } from './refund-authority';

export interface AndroidRefundIntentContext {
  backendOrderId: string;
  salonId: string;
  backendShiftId: string;
}
export interface AndroidRefundIntent {
  payload: Record<string, any>;
  expected: RefundAuthorityExpected;
  priorRefundLines: LocalRefundLine[];
}

const fail = (reason: string): never => { throw new Error(`ANDROID_REFUND_INTENT: ${reason}`); };
const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && v === v.trim();
function money(v: unknown, field: string): number {
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(v))) return fail(`Invalid ${field}`);
  const scaled = Number(v) * 100; const result = Math.round(scaled);
  if (!Number.isFinite(scaled) || scaled < 0 || !Number.isSafeInteger(result) || Math.abs(scaled - result) > 0.000001) return fail(`Invalid ${field}`);
  return result;
}
function minor(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return fail(`Invalid ${field}`);
  return v;
}
function priceFour(v: unknown, field: string): number {
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^\d+(?:\.\d{1,4})?$/.test(v))) return fail(`Invalid ${field}`);
  const scaled = Number(v) * 10000; const result = Math.round(scaled);
  if (!Number.isFinite(scaled) || scaled < 0 || !Number.isSafeInteger(result) || Math.abs(scaled - result) > 0.000001) return fail(`Invalid ${field}`);
  return result;
}
function quantity(v: unknown, weighted: boolean): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return fail('Invalid quantity');
  const milli = Math.round(v * 1000);
  if (!Number.isSafeInteger(milli) || Math.abs(v * 1000 - milli) > 0.000001 || (!weighted && milli % 1000 !== 0)) return fail('Invalid quantity precision');
  return milli;
}
function sum(values: number[]): number {
  const result = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(result)) return fail('Unsafe monetary or quantity sum');
  return result;
}
function proportional(amount: number, selected: number, remaining: number): number {
  // BigInt prevents intermediate overflow while keeping round-half-up exact.
  return Number((BigInt(amount) * BigInt(selected) * 2n + BigInt(remaining)) / (BigInt(remaining) * 2n));
}

/** Pure preflight only. Fetch, authorization, replay lookup and durable freeze belong to caller. */
export function prepareAndroidRefundIntent(rawServerDetail: unknown, dto: RefundIpcPayload, context: AndroidRefundIntentContext): AndroidRefundIntent {
  const identity = validateRefundDetailIdentity(rawServerDetail, context);
  if (!identity.ok) return fail(identity.error);
  if (!record(dto) || !uuid(dto.refundRequestId) || !uuid(context.backendShiftId)) return fail('UUID request and backend shift required');
  if (dto.type !== 'FULL' && dto.type !== 'PARTIAL') return fail('Invalid refund type');
  if (dto.manualAdjustmentAmount !== undefined) return fail('Manual adjustments unsupported');
  if (!Array.isArray(dto.lines) || !dto.lines.length) return fail('Exact refund lines required');
  if (dto.reason !== undefined && (typeof dto.reason !== 'string' || dto.reason.length > 2000)) return fail('Invalid refund reason');
  const raw = rawServerDetail as Record<string, any>;
  if (!['COMPLETED', 'DELIVERED', 'PARTIAL_REFUND'].includes(raw.status)) return fail('Order is not refundable');
  if (raw.posMode === 'billiard' || raw.mode === 'billiard' || raw.billiardOrigin || raw.externalMetadata?.meta?.billiardOrigin) return fail('Billiard refunds unsupported');
  for (const field of ['discountAmount', 'tip', 'shippingCost', 'deliveryFee', 'serviceCharge']) {
    if (raw[field] !== undefined && money(raw[field], field) !== 0) return fail('Discounts, tips or fees require canonical allocation');
  }
  const total = money(raw.total, 'order total');
  for (const field of ['subtotal', 'taxAmount', 'paidAmount', 'changeAmount']) {
    if (raw[field] !== undefined) money(raw[field], field);
  }
  const refunded = money(raw.refundAmount ?? 0, 'cumulative refund');
  if (total <= 0 || refunded >= total) return fail('No remaining refundable amount');
  if ((raw.status === 'PARTIAL_REFUND') !== (refunded > 0)) return fail('Refund status and cumulative amount disagree');
  const canonical = new Map<string, { raw: any; quantity: number; price: number; total: number; unit: string; weighted: boolean; refundedQty: number; refundedAmount: number }>();
  for (const item of raw.items) {
    if (item.billiard || item.billiardLineKey || item.billiardLineKind || item.inventoryPolicy || item.refundPolicy) return fail('Special item policies unsupported');
    if (item.sellBy !== 'PIECE' && item.sellBy !== 'WEIGHT') return fail('Explicit canonical sellBy required');
    const weighted = item.sellBy === 'WEIGHT';
    const qty = quantity(item.totalUnits, weighted);
    if (weighted && quantity(item.saleQuantity, true) !== qty) return fail('Canonical weighted quantities disagree');
    if (typeof item.saleUnit !== 'string' || !item.saleUnit.trim() || item.saleUnit !== item.saleUnit.trim()) return fail('Canonical sale unit required');
    if (weighted !== (item.saleUnit.toLowerCase() === 'kg')) return fail('Canonical unit and sellBy disagree');
    const precisePrice = priceFour(item.grossUnitPrice, 'gross unit price');
    const price = Math.round(precisePrice / 100);
    const lineTotal = money(item.grossTotalPrice, 'gross line total');
    if (proportional(precisePrice, qty, 100000) !== lineTotal) return fail('Ambiguous line pricing');
    for (const field of ['allocatedDiscountGrosze', 'allocatedDiscount', 'billiardDiscountAmount']) {
      if (item[field] !== undefined && Number(item[field]) !== 0) return fail('Discounted lines unsupported');
    }
    canonical.set(item.id, { raw: item, quantity: qty, price, total: lineTotal, unit: item.saleUnit, weighted, refundedQty: 0, refundedAmount: 0 });
  }
  if (sum([...canonical.values()].map(i => i.total)) !== total) return fail('Canonical line totals do not reconcile with order total');
  if (raw.refundedLines !== undefined && !Array.isArray(raw.refundedLines)) return fail('Invalid prior refund audit');
  const audit = raw.refundedLines ?? [];
  const seenRequests = new Set<string>();
  for (const line of audit) {
    if (!record(line) || !id(line.orderItemId)) return fail('Prior refund audit has no exact item ID');
    const item = canonical.get(line.orderItemId);
    if (!item) return fail('Prior refund audit belongs to unknown item');
    const qty = quantity(line.quantity, item.weighted);
    const amount = money(line.refundAmount, 'prior line refund');
    priceFour(line.unitPrice, 'prior line price');
    if (line.billiardLineKey || typeof line.restock !== 'boolean' || line.unit !== item.unit
      || (line.saleUnit !== undefined && line.saleUnit !== item.unit)) return fail('Invalid prior refund audit metadata');
    if (line.variantId !== undefined && !id(line.variantId)) return fail('Invalid prior product identity');
    for (const key of ['name', 'sku', 'reason', 'refundReason', 'refundMethod']) {
      if (line[key] !== undefined && line[key] !== null && typeof line[key] !== 'string') return fail('Invalid prior refund description');
    }
    if (line.taxRate !== undefined && (typeof line.taxRate !== 'number' || !Number.isFinite(line.taxRate) || line.taxRate < 0 || line.taxRate > 100)) return fail('Invalid prior refund VAT');
    if (line.refundRequestId !== undefined) {
      if (!uuid(line.refundRequestId)) return fail('Invalid prior request ID');
      if (line.refundRequestId === dto.refundRequestId) return fail('Request already present in authoritative audit');
      const key = JSON.stringify([line.refundRequestId, line.orderItemId]);
      if (seenRequests.has(key)) return fail('Duplicated prior request item');
      seenRequests.add(key);
    }
    if (line.refundedAt !== undefined && (typeof line.refundedAt !== 'string' || !Number.isFinite(Date.parse(line.refundedAt)))) return fail('Invalid prior refund date');
    item.refundedQty = sum([item.refundedQty, qty]); item.refundedAmount = sum([item.refundedAmount, amount]);
    if (item.refundedQty > item.quantity || item.refundedAmount > item.total) return fail('Prior refund exceeds sold line');
  }
  if (sum([...canonical.values()].map(i => i.refundedAmount)) !== refunded) return fail('Prior refund audit does not reconcile');
  if ([...canonical.values()].some(i => i.refundedQty === i.quantity && i.refundedAmount !== i.total)) return fail('Exhausted quantity has unresolved payable amount');
  const selected = new Set<string>();
  const lines = dto.lines.map(line => {
    if (!record(line) || !id(line.orderItemId) || selected.has(line.orderItemId) || line.billiardLineKey) return fail('Invalid or duplicated exact selection');
    const item = canonical.get(line.orderItemId);
    if (!item) return fail('Selected item is not in canonical order');
    const qty = quantity(line.quantity, item.weighted);
    const remainingQty = item.quantity - item.refundedQty; const remainingAmount = item.total - item.refundedAmount;
    if (qty > remainingQty || remainingQty <= 0) return fail('Selected quantity exceeds remaining quantity');
    if (dto.type === 'FULL' && qty !== remainingQty) return fail('Full refund must include all remaining quantities');
    if (typeof line.restock !== 'boolean' || (line.unit !== undefined && line.unit !== item.unit)) return fail('Invalid restock or unit');
    // Backend resolveRefundLineMoney: ordinary partials use original line
    // gross/quantity; the final remaining quantity consumes the exact residue.
    const amount = qty === remainingQty ? remainingAmount : proportional(item.total, qty, item.quantity);
    if (amount > remainingAmount) return fail('Canonical partial exceeds remaining payable');
    if (minor(line.refundAmount, 'renderer line amount') !== amount || minor(line.unitPrice, 'renderer unit price') !== proportional(remainingAmount, 1000, remainingQty)) return fail('Renderer line money differs from canonical amount');
    selected.add(line.orderItemId);
    return { ...line, orderItemId: line.orderItemId, unit: item.unit, unitPrice: item.price, refundAmount: amount };
  });
  if (dto.type === 'FULL' && [...canonical].some(([key, item]) => item.quantity > item.refundedQty && !selected.has(key))) return fail('Full refund omits remaining items');
  const delta = sum(lines.map(i => i.refundAmount));
  if (delta <= 0 || delta > total - refunded || (dto.type === 'FULL' && delta !== total - refunded)
    || minor(dto.amount, 'renderer refund amount') !== delta) return fail('Renderer total differs from canonical refund');
  const methods = new Set(['CASH', 'CARD', 'BLIK', 'BANK_TRANSFER']);
  const tenders = raw.tenders;
  if (tenders !== undefined && (!Array.isArray(tenders) || !tenders.length)) return fail('Invalid canonical tenders');
  if (tenders) {
    for (const tender of tenders) if (!record(tender) || !methods.has(tender.method) || money(tender.amount, 'tender') <= 0) return fail('Invalid canonical tender');
    if (sum(tenders.map((t: any) => money(t.amount, 'tender'))) !== total) return fail('Canonical tenders do not reconcile');
  } else if (!methods.has(raw.paymentMethod)) return fail('Canonical payment allocation unavailable');
  // All raw money used by these permissive legacy adapters has been validated.
  const adapted = adaptServerOrder(raw);
  if (adapted.billiard_origin_json) return fail('Billiard origin unsupported');
  for (const item of raw.items) {
    const mapped = adaptServerOrderItem(item, raw.id, raw);
    if (mapped.billiard_json || mapped.inventory_policy || mapped.refund_policy) return fail('Special item policies unsupported');
    if (mapped.price !== canonical.get(item.id)!.price || mapped.total !== canonical.get(item.id)!.total
      || quantity(mapped.quantity, canonical.get(item.id)!.weighted) !== canonical.get(item.id)!.quantity) return fail('Adapter pricing or quantity disagrees with canonical snapshot');
  }
  const tenderAllocations = allocateRefundTenders(adapted.payment_tenders, delta, raw.paymentMethod);
  if (sum(tenderAllocations.map(t => t.amount)) !== delta) return fail('Refund tender allocation mismatch');
  const payload = toRefundBackendPayload({ type: dto.type, refundRequestId: dto.refundRequestId, reason: dto.reason,
    amount: delta, lines, tenderAllocations }, { shiftId: context.backendShiftId });
  return { payload, expected: { backendOrderId: context.backendOrderId, requestId: dto.refundRequestId,
    orderTotalGrosze: total, alreadyRefundedGrosze: refunded, expectedDeltaGrosze: delta,
    items: lines.map(l => ({ orderItemId: l.orderItemId, quantity: l.quantity, restock: l.restock })) },
    priorRefundLines: (JSON.parse(normalizeRefundLinesJson(audit) ?? '[]') as LocalRefundLine[]).map((line, index) => ({
      ...line, unitPrice: priceFour(audit[index].unitPrice, 'prior line price') / 100,
      vatRate: audit[index].taxRate,
    })) };
}
