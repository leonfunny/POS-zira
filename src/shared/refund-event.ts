/** Opt-in V1 helpers only. No network, persistence, legacy allocation or protocol activation. */
export type RefundTenderMethod = 'CASH' | 'CARD' | 'BLIK' | 'BANK_TRANSFER' | 'OTHER';
export interface RefundEventTenderAllocation {
  method: RefundTenderMethod;
  /** Integer grosze, never PLN. */
  amountMinor: number;
}
export interface RefundEventExpected {
  refundRequestId: string;
  orderId: string;
  salonId: string;
  shiftId: string;
  machineId: string;
  operatorId: string;
  deltaAmountMinor: number;
  tenderAllocations: readonly RefundEventTenderAllocation[];
}
export interface CanonicalRefundEvent extends RefundEventExpected {
  schemaVersion: 1;
  occurredAt: string;
  tenderAllocations: RefundEventTenderAllocation[];
}
export type RefundEventValidationResult = { ok: true; event: CanonicalRefundEvent } | { ok: false; error: string };
export type RefundEventAllocationResult = { ok: true; tenderAllocations: RefundEventTenderAllocation[] } | { ok: false; error: string };

const methods = new Set<string>(['CASH', 'CARD', 'BLIK', 'BANK_TRANSFER', 'OTHER']);
const scopeKeys = ['refundRequestId', 'orderId', 'salonId', 'shiftId', 'operatorId'] as const;
const maxMinor = BigInt(Number.MAX_SAFE_INTEGER);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const minor = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const machine = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 255 && value === value.trim();
const compareMethod = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Only a direct explicit numeric capability is support; no wrapper/alias/truthiness inference. */
export function supportsRefundEventV1(capabilities: unknown): boolean {
  return record(capabilities) && Object.prototype.hasOwnProperty.call(capabilities, 'refundEventVersion')
    && capabilities.refundEventVersion === 1;
}

function readAllocations(raw: unknown, allowZero: boolean): { rows: RefundEventTenderAllocation[]; total: bigint } | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > methods.size) return null;
  const seen = new Set<string>();
  const rows: RefundEventTenderAllocation[] = [];
  let total = 0n;
  for (const row of raw) {
    if (!record(row) || typeof row.method !== 'string' || !methods.has(row.method) || seen.has(row.method)
      || !minor(row.amountMinor) || (!allowZero && row.amountMinor === 0)) return null;
    seen.add(row.method);
    total += BigInt(row.amountMinor);
    if (total > maxMinor) return null;
    rows.push({ method: row.method as RefundTenderMethod, amountMinor: row.amountMinor });
  }
  rows.sort((a, b) => compareMethod(a.method, b.method));
  return { rows, total };
}

/** Backend emits Date.toISOString(): reject invalid dates which Date.parse silently normalizes. */
function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/**
 * Validate rawResponse.refundEvent against the durably frozen V1 request.
 * Caller must ALSO validate the ordinary authoritative response and require its
 * deltaGrosze === expected.deltaAmountMinor before confirming local money/stock.
 * This helper does not authenticate a source or prove remaining-capacity history.
 */
export function validateCanonicalRefundEvent(rawEvent: unknown, expected: RefundEventExpected): RefundEventValidationResult {
  const fail = (error: string): RefundEventValidationResult => ({ ok: false, error });
  if (!record(expected) || scopeKeys.some(key => !uuid(expected[key])) || !machine(expected.machineId)
    || !minor(expected.deltaAmountMinor) || expected.deltaAmountMinor === 0) return fail('Invalid frozen refund event scope');
  const requested = readAllocations(expected.tenderAllocations, false);
  if (!requested || requested.total !== BigInt(expected.deltaAmountMinor)) return fail('Invalid frozen refund event allocations');
  if (!record(rawEvent) || rawEvent.schemaVersion !== 1
    || scopeKeys.some(key => !uuid(rawEvent[key]) || rawEvent[key] !== expected[key])
    || !machine(rawEvent.machineId) || rawEvent.machineId !== expected.machineId
    || !minor(rawEvent.deltaAmountMinor) || rawEvent.deltaAmountMinor !== expected.deltaAmountMinor
    || !canonicalTimestamp(rawEvent.occurredAt)) return fail('Refund event identity, version, amount or timestamp mismatch');
  const returned = readAllocations(rawEvent.tenderAllocations, false);
  if (!returned || returned.total !== BigInt(rawEvent.deltaAmountMinor) || returned.rows.length !== requested.rows.length
    || returned.rows.some((row, index) => row.method !== requested.rows[index].method
      || row.amountMinor !== requested.rows[index].amountMinor)) return fail('Refund event tender allocations mismatch');
  return { ok: true, event: {
    schemaVersion: 1, refundRequestId: rawEvent.refundRequestId as string, orderId: rawEvent.orderId as string,
    salonId: rawEvent.salonId as string, shiftId: rawEvent.shiftId as string, operatorId: rawEvent.operatorId as string,
    machineId: rawEvent.machineId, occurredAt: rawEvent.occurredAt, deltaAmountMinor: rawEvent.deltaAmountMinor,
    tenderAllocations: returned.rows,
  } };
}

/**
 * Largest-remainder allocation over explicit, fully reconciled REMAINING capacity.
 * Caller must refuse incomplete history; this function never infers prior refunds.
 * BigInt products avoid precision loss. Lexical method order breaks equal remainders
 * identically on every device; zero allocations are omitted (V1 requires positives).
 */
export function allocateRefundEventTenders(
  deltaAmountMinor: number,
  remainingCapacities: readonly RefundEventTenderAllocation[],
): RefundEventAllocationResult {
  const fail = (error: string): RefundEventAllocationResult => ({ ok: false, error });
  if (!minor(deltaAmountMinor) || deltaAmountMinor === 0) return fail('Invalid refund event delta');
  const capacities = readAllocations(remainingCapacities, true);
  const delta = BigInt(deltaAmountMinor);
  if (!capacities || capacities.total === 0n || delta > capacities.total) return fail('Invalid or insufficient remaining tender capacity');
  const shares = capacities.rows.map(row => {
    const product = delta * BigInt(row.amountMinor);
    return { method: row.method, capacity: row.amountMinor, amount: product / capacities.total, remainder: product % capacities.total };
  });
  const remaining = delta - shares.reduce((sum, share) => sum + share.amount, 0n);
  shares.sort((a, b) => a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : compareMethod(a.method, b.method));
  // Sum of fractional shares is an integer strictly smaller than the number of methods.
  for (let index = 0; index < Number(remaining); index += 1) shares[index].amount += 1n;
  if (shares.some(share => share.amount > BigInt(share.capacity))
    || shares.reduce((sum, share) => sum + share.amount, 0n) !== delta) return fail('Invalid refund event allocation');
  const tenderAllocations = shares.filter(share => share.amount > 0n)
    .map(share => ({ method: share.method, amountMinor: Number(share.amount) }))
    .sort((a, b) => compareMethod(a.method, b.method));
  return { ok: true, tenderAllocations };
}
