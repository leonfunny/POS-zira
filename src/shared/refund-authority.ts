/** Pure normal-product refund boundary. Scope, replay durability and side effects belong to the caller. */
export interface RefundAuthorityExpected {
  backendOrderId: string;
  requestId: string;
  orderTotalGrosze: number;
  alreadyRefundedGrosze: number;
  expectedDeltaGrosze: number;
  items: Array<{ orderItemId: string; quantity: number; restock: boolean }>;
}

export interface AuthoritativeRefundLine {
  orderItemId: string;
  refundRequestId: string;
  quantity: number;
  unit: string;
  saleUnit: string;
  /** Grosze, not PLN; may have two fractional digits (backend unit price is 4dp PLN). */
  unitPrice: number;
  /** Integer grosze, not PLN. */
  refundAmount: number;
  restock: boolean;
  variantId?: string;
  name?: string | null;
  sku?: string | null;
  vatRate?: number;
  refundedAt?: string;
}

export type RefundAuthorityResult =
  | { ok: true; deltaGrosze: number; cumulativeGrosze: number; status: 'FULL' | 'PARTIAL'; lines: AuthoritativeRefundLine[] }
  | { ok: false; error: string };

export type RefundDetailIdentityResult = { ok: true } | { ok: false; error: string };

/** Validate raw server identity BEFORE adapters which may fill missing legacy IDs. */
export function validateRefundDetailIdentity(
  raw: unknown,
  expected: { backendOrderId: string; salonId: string },
): RefundDetailIdentityResult {
  const fail = (error: string): RefundDetailIdentityResult => ({ ok: false, error });
  if (!record(expected) || !identity(expected.backendOrderId) || !identity(expected.salonId)) return fail('Invalid refund detail scope');
  if (!record(raw) || raw.id !== expected.backendOrderId) return fail('Refund detail order identity mismatch');

  const matchesDeclared = (value: Record<string, unknown>, keys: string[], id: string) =>
    keys.every(key => !(key in value) || value[key] === id);
  const matchesNested = (value: Record<string, unknown>, key: string, id: string) => {
    if (!(key in value)) return true;
    const nested = value[key];
    return record(nested) && (!('id' in nested) || nested.id === id);
  };
  const matchesSalon = (value: Record<string, unknown>) =>
    matchesDeclared(value, ['salonId', 'salon_id'], expected.salonId)
      && matchesNested(value, 'salon', expected.salonId);

  if (!matchesSalon(raw)) return fail('Refund detail salon identity mismatch');
  if (!Array.isArray(raw.items) || raw.items.length === 0) return fail('Refund detail has no canonical items');
  const seen = new Set<string>();
  for (const item of raw.items) {
    if (!record(item) || !identity(item.id) || seen.has(item.id)) return fail('Refund detail item identity missing or duplicated');
    if (!matchesSalon(item)) return fail('Refund detail item salon identity mismatch');
    if (!matchesDeclared(item, ['orderId', 'order_id', 'b2bOrderId', 'b2b_order_id'], expected.backendOrderId)
      || !matchesNested(item, 'order', expected.backendOrderId)) return fail('Refund detail item belongs to another order');
    // A declared nested parent can itself carry a conflicting tenant.
    if (record(item.order) && !matchesSalon(item.order)) return fail('Refund detail item parent salon identity mismatch');
    seen.add(item.id);
  }
  return { ok: true };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function minor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Accept database decimal strings, never parseFloat-style prefixes or implicit coercion. */
function plnToMinor(value: unknown, precision: 2 | 4 = 2): number | null {
  const decimal = precision === 4 ? /^\d+(?:\.\d{1,4})?$/ : /^\d+(?:\.\d{1,2})?$/;
  if (typeof value !== 'number' && (typeof value !== 'string' || !decimal.test(value))) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const scaled = amount * (precision === 4 ? 10000 : 100);
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 0.000001) return null;
  return precision === 4 ? rounded / 100 : rounded;
}

function quantityMilli(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const milli = Math.round(value * 1000);
  return Number.isSafeInteger(milli) && milli > 0 && Math.abs(value * 1000 - milli) <= 0.000001 ? milli : null;
}

export function validateAuthoritativeRefundResult(
  raw: unknown,
  expected: RefundAuthorityExpected,
): RefundAuthorityResult {
  const fail = (error: string): RefundAuthorityResult => ({ ok: false, error });
  if (!record(expected) || !identity(expected.backendOrderId) || !identity(expected.requestId)
    || !minor(expected.orderTotalGrosze) || expected.orderTotalGrosze === 0
    || !minor(expected.alreadyRefundedGrosze) || !minor(expected.expectedDeltaGrosze)
    || expected.expectedDeltaGrosze === 0 || expected.alreadyRefundedGrosze >= expected.orderTotalGrosze
    || expected.expectedDeltaGrosze > expected.orderTotalGrosze - expected.alreadyRefundedGrosze
    || !Array.isArray(expected.items) || expected.items.length === 0) return fail('Invalid refund expectation');

  const requested = new Map<string, { quantity: number; restock: boolean }>();
  for (const item of expected.items) {
    if (!record(item) || !identity(item.orderItemId) || quantityMilli(item.quantity) === null
      || typeof item.restock !== 'boolean' || requested.has(item.orderItemId)) return fail('Invalid or duplicate requested item');
    requested.set(item.orderItemId, item);
  }

  if (!record(raw) || raw.success !== true || raw.orderId !== expected.backendOrderId) return fail('Refund success/order identity was not confirmed');
  if (raw.refundRequestId !== undefined && raw.refundRequestId !== expected.requestId) return fail('Refund request identity mismatch');
  if (raw.status !== 'REFUNDED' && raw.status !== 'PARTIAL_REFUND') return fail('Invalid refund status');
  const delta = plnToMinor(raw.refundAmount);
  const cumulative = plnToMinor(raw.totalRefundedAmount);
  if (delta === null || delta <= 0 || cumulative === null
    || Math.abs(delta - expected.expectedDeltaGrosze) > 1
    || delta > expected.orderTotalGrosze - expected.alreadyRefundedGrosze
    || cumulative !== expected.alreadyRefundedGrosze + delta
    || cumulative > expected.orderTotalGrosze) return fail('Invalid refund delta or cumulative amount');
  if ((raw.status === 'REFUNDED') !== (cumulative === expected.orderTotalGrosze)) return fail('Refund status does not match cumulative amount');
  if (!Array.isArray(raw.refundedLines) || raw.refundedLines.length !== requested.size) return fail('Missing or extra refund lines');

  const lines: AuthoritativeRefundLine[] = [];
  const seen = new Set<string>();
  let linesTotal = 0;
  for (const line of raw.refundedLines) {
    if (!record(line) || !identity(line.orderItemId) || seen.has(line.orderItemId)) return fail('Missing or duplicate returned item identity');
    const selected = requested.get(line.orderItemId);
    if (!selected || quantityMilli(line.quantity) === null
      || quantityMilli(line.quantity) !== quantityMilli(selected.quantity)) return fail('Returned item/quantity does not match request');
    if (line.refundRequestId !== undefined && line.refundRequestId !== expected.requestId) return fail('Returned line request identity mismatch');
    if (typeof line.restock !== 'boolean' || (!selected.restock && line.restock)) return fail('Invalid returned restock flag');
    if (!identity(line.unit) || (line.saleUnit !== undefined && line.saleUnit !== line.unit)) return fail('Missing or inconsistent canonical unit');
    const price = plnToMinor(line.unitPrice, 4);
    const amount = plnToMinor(line.refundAmount);
    if (price === null || amount === null) return fail('Invalid returned line money');
    if (line.variantId !== undefined && !identity(line.variantId)) return fail('Invalid returned product identity');
    if ((line.name !== undefined && line.name !== null && typeof line.name !== 'string')
      || (line.sku !== undefined && line.sku !== null && typeof line.sku !== 'string')) return fail('Invalid returned line description');
    if (line.taxRate !== undefined && (typeof line.taxRate !== 'number' || !Number.isFinite(line.taxRate) || line.taxRate < 0 || line.taxRate > 100)) return fail('Invalid returned tax rate');
    if (line.refundedAt !== undefined && (typeof line.refundedAt !== 'string' || !Number.isFinite(Date.parse(line.refundedAt)))) return fail('Invalid refund timestamp');
    linesTotal += amount;
    if (!Number.isSafeInteger(linesTotal)) return fail('Refund line total exceeds safe precision');
    seen.add(line.orderItemId);
    lines.push({
      orderItemId: line.orderItemId,
      refundRequestId: expected.requestId,
      quantity: line.quantity as number,
      unit: line.unit,
      saleUnit: line.unit,
      unitPrice: price,
      refundAmount: amount,
      restock: line.restock,
      ...(line.variantId !== undefined ? { variantId: line.variantId as string } : {}),
      ...(line.name !== undefined ? { name: line.name as string | null } : {}),
      ...(line.sku !== undefined ? { sku: line.sku as string | null } : {}),
      ...(line.taxRate !== undefined ? { vatRate: line.taxRate as number } : {}),
      ...(line.refundedAt !== undefined ? { refundedAt: line.refundedAt as string } : {}),
    });
  }
  if (Math.abs(linesTotal - delta) > 1) return fail('Refund line sum does not match delta');
  return { ok: true, deltaGrosze: delta, cumulativeGrosze: cumulative, status: raw.status === 'REFUNDED' ? 'FULL' : 'PARTIAL', lines };
}
