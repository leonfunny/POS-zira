import { describe, expect, it } from 'vitest';
import {
  allocateRefundEventTenders, supportsRefundEventV1, validateCanonicalRefundEvent,
  type RefundEventExpected, type RefundEventTenderAllocation, type RefundTenderMethod,
} from '../src/shared/refund-event';

const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const expected = (): RefundEventExpected => ({
  refundRequestId: uuid(1), orderId: uuid(2), salonId: uuid(3), shiftId: uuid(4), operatorId: uuid(5),
  machineId: 'android-persistent-device', deltaAmountMinor: 100,
  tenderAllocations: [{ method: 'CASH', amountMinor: 60 }, { method: 'CARD', amountMinor: 40 }],
});
const event = (): any => ({ ...expected(), schemaVersion: 1, occurredAt: '2026-09-08T13:45:01.123Z' });
const rows = (...amounts: number[]): RefundEventTenderAllocation[] => amounts.map((amountMinor, index) => ({
  method: (['CASH', 'CARD', 'BLIK', 'BANK_TRANSFER', 'OTHER'] as RefundTenderMethod[])[index], amountMinor,
}));
const invalidNumbers = [undefined, null, '1', true, -1, -0, 0.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];

describe('explicit refund event capability', () => {
  it('accepts direct numeric v1 while retaining independent capability fields', () => {
    expect(supportsRefundEventV1({ refundEventVersion: 1, restaurantMetadataVersion: 1 })).toBe(true);
  });
  it.each([undefined, null, [], true, 1, {}, { refundEventVersion: '1' }, { refundEventVersion: true },
    { refundEventVersion: 0 }, { refundEventVersion: 2 }, { refundEventVersion: NaN },
    { data: { refundEventVersion: 1 } }, Object.create({ refundEventVersion: 1 })])('rejects absent/coerced/wrapped capability %#', raw => {
    expect(supportsRefundEventV1(raw)).toBe(false);
  });
});

describe('canonical refund event authority', () => {
  it('matches exact frozen bindings, ignores response array order, returns a detached normalized event', () => {
    const raw = event(); const frozen = expected(); const before = JSON.stringify([raw, frozen]);
    const result = validateCanonicalRefundEvent(raw, frozen);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.event.tenderAllocations).toEqual([{ method: 'CARD', amountMinor: 40 }, { method: 'CASH', amountMinor: 60 }]);
    expect(JSON.stringify([raw, frozen])).toBe(before);
    raw.tenderAllocations[0].amountMinor = 999;
    expect(result.event.tenderAllocations[1].amountMinor).toBe(60);
  });
  for (const key of ['refundRequestId', 'orderId', 'salonId', 'shiftId', 'operatorId'] as const) {
    it.each([undefined, null, '', ' ', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', uuid(99)])(`rejects returned ${key} %#`, value => {
      const raw = event(); raw[key] = value;
      expect(validateCanonicalRefundEvent(raw, expected()).ok).toBe(false);
    });
    it.each([undefined, null, '', 'not-a-uuid', '00000000-0000-0000-0000-000000000000'])(`rejects malformed matching expected ${key} %#`, value => {
      const raw = event(); const frozen = expected() as any; raw[key] = value; frozen[key] = value;
      expect(validateCanonicalRefundEvent(raw, frozen).ok).toBe(false);
    });
  }
  it.each([undefined, null, '', ' ', ' device', 'device ', 'x'.repeat(256), 1])('rejects malformed device on both sides %#', value => {
    const raw = event(); const frozen = expected() as any; raw.machineId = value; frozen.machineId = value;
    expect(validateCanonicalRefundEvent(raw, frozen).ok).toBe(false);
  });
  it('rejects a different valid device', () => {
    expect(validateCanonicalRefundEvent({ ...event(), machineId: 'other-device' }, expected()).ok).toBe(false);
  });
  it.each([undefined, null, '1', 0, 2, true])('rejects wrong/missing version %#', schemaVersion => {
    expect(validateCanonicalRefundEvent({ ...event(), schemaVersion }, expected()).ok).toBe(false);
  });
  it.each([undefined, null, '', 0, 'junk', '2026-02-30T00:00:00.000Z', '2026-09-08',
    '2026-09-08T13:45:01', '2026-09-08T13:45:01.123+00:00', '2026-09-08T24:00:00.000Z',
    '2026-13-08T13:45:01.123Z', '2026-09-08T13:45:61.123Z'])('rejects noncanonical or invalid timestamp %#', occurredAt => {
    expect(validateCanonicalRefundEvent({ ...event(), occurredAt }, expected()).ok).toBe(false);
  });
  it('accepts valid leap day without depending on current time (cached replay)', () => {
    expect(validateCanonicalRefundEvent({ ...event(), occurredAt: '2024-02-29T00:00:00.000Z' }, expected()).ok).toBe(true);
  });
  it.each([...invalidNumbers, 0, 99, 101])('rejects invalid/mismatching delta %#', deltaAmountMinor => {
    expect(validateCanonicalRefundEvent({ ...event(), deltaAmountMinor }, expected()).ok).toBe(false);
  });
  it.each([...invalidNumbers, 0])('rejects malformed expected delta even when response matches %#', value => {
    const frozen = expected() as any; frozen.deltaAmountMinor = value;
    expect(validateCanonicalRefundEvent({ ...event(), deltaAmountMinor: value }, frozen).ok).toBe(false);
  });
  const invalidAllocations: any[] = [undefined, null, {}, [], [null], [{ method: 'CASH', amount: 100 }],
    [{ method: 'cash', amountMinor: 100 }], [{ method: 'TRANSFER', amountMinor: 100 }],
    [{ method: 'CREDIT', amountMinor: 100 }], rows(50, 49), rows(50, 51),
    [{ method: 'CASH', amountMinor: 50 }, { method: 'CASH', amountMinor: 50 }],
    [...rows(60, 40), { method: 'OTHER', amountMinor: 0 }],
    ...invalidNumbers.map(amountMinor => [{ method: 'CASH', amountMinor }])];
  it.each(invalidAllocations.map((value, index) => ({ value, index })))('rejects invalid returned allocations $index', ({ value }) => {
    expect(validateCanonicalRefundEvent({ ...event(), tenderAllocations: value }, expected()).ok).toBe(false);
  });
  it.each(invalidAllocations.map((value, index) => ({ value, index })))('rejects malformed expected allocations $index', ({ value }) => {
    const frozen = expected() as any; frozen.tenderAllocations = value;
    expect(validateCanonicalRefundEvent({ ...event(), tenderAllocations: value }, frozen).ok).toBe(false);
  });
  it('rejects same sum but different per-method allocation or method set', () => {
    expect(validateCanonicalRefundEvent({ ...event(), tenderAllocations: rows(61, 39) }, expected()).ok).toBe(false);
    expect(validateCanonicalRefundEvent({ ...event(), tenderAllocations: [{ method: 'OTHER', amountMinor: 100 }] }, expected()).ok).toBe(false);
  });
  it.each([null, undefined, [], true])('rejects malformed event and expectation roots %#', value => {
    expect(validateCanonicalRefundEvent(value, expected()).ok).toBe(false);
    expect(validateCanonicalRefundEvent(event(), value as any).ok).toBe(false);
  });
  it('supports every exact allowed method including OTHER', () => {
    const frozen = { ...expected(), deltaAmountMinor: 5, tenderAllocations: rows(1, 1, 1, 1, 1) };
    expect(validateCanonicalRefundEvent({ ...event(), ...frozen }, frozen).ok).toBe(true);
  });
  it('accepts MAX_SAFE_INTEGER total and rejects overflowing allocation sums', () => {
    const frozen = { ...expected(), deltaAmountMinor: Number.MAX_SAFE_INTEGER, tenderAllocations: rows(Number.MAX_SAFE_INTEGER) };
    expect(validateCanonicalRefundEvent({ ...event(), ...frozen }, frozen).ok).toBe(true);
    const overflow = { ...frozen, tenderAllocations: rows(Number.MAX_SAFE_INTEGER, 1) };
    expect(validateCanonicalRefundEvent({ ...event(), ...overflow }, overflow).ok).toBe(false);
  });
});

describe('exact remaining-capacity refund allocator', () => {
  it('splits two grosze across four equal capacities without rounding to three', () => {
    expect(allocateRefundEventTenders(2, rows(1, 1, 1, 1))).toEqual({ ok: true, tenderAllocations: [
      { method: 'BANK_TRANSFER', amountMinor: 1 }, { method: 'BLIK', amountMinor: 1 },
    ] });
  });
  it('uses largest remainders before lexical ties', () => {
    expect(allocateRefundEventTenders(3, rows(5, 3, 2))).toEqual({ ok: true, tenderAllocations: rows(1, 1, 1).sort((a, b) => a.method < b.method ? -1 : 1) });
  });
  it('is deterministic across input permutations and never mutates capacities', () => {
    const capacities = rows(1, 1, 1, 1, 1); const before = JSON.stringify(capacities);
    const result = allocateRefundEventTenders(3, capacities);
    expect(allocateRefundEventTenders(3, [...capacities].reverse())).toEqual(result);
    expect(JSON.stringify(capacities)).toBe(before);
  });
  it('consumes remaining capacities exactly across repeated single-cent partials', () => {
    const capacities = rows(1, 1, 1, 1);
    const allocated: string[] = [];
    for (let count = 0; count < 4; count += 1) {
      const result = allocateRefundEventTenders(1, capacities);
      if (!result.ok) throw new Error(result.error);
      expect(result.tenderAllocations).toHaveLength(1);
      const allocation = result.tenderAllocations[0]; allocated.push(allocation.method);
      capacities.find(row => row.method === allocation.method)!.amountMinor -= allocation.amountMinor;
    }
    expect(new Set(allocated).size).toBe(4);
    expect(capacities.every(row => row.amountMinor === 0)).toBe(true);
    expect(allocateRefundEventTenders(1, capacities).ok).toBe(false);
  });
  it('omits exhausted methods and allocates the complete remaining balance', () => {
    expect(allocateRefundEventTenders(4, rows(0, 4, 0))).toEqual({ ok: true, tenderAllocations: [{ method: 'CARD', amountMinor: 4 }] });
  });
  it.each([...invalidNumbers, 0])('rejects malformed/nonpositive delta %#', delta => {
    expect(allocateRefundEventTenders(delta as number, rows(100)).ok).toBe(false);
  });
  it.each([undefined, null, [], {}, [null], rows(0), rows(1), rows(Number.MAX_SAFE_INTEGER, 1),
    [{ method: 'CASH', amountMinor: 2 }, { method: 'CASH', amountMinor: 2 }],
    [{ method: 'cash', amountMinor: 2 }], [{ method: 'SPLIT', amountMinor: 2 }],
    ...invalidNumbers.map(amountMinor => [{ method: 'CASH', amountMinor }])].map((value, index) => ({ value, index })))('rejects malformed/insufficient capacities $index', ({ value }) => {
    expect(allocateRefundEventTenders(2, value as any).ok).toBe(false);
  });
  it('keeps exact products beyond Number precision at the safe-integer boundary', () => {
    const capacities = rows(Number.MAX_SAFE_INTEGER - 1, 1);
    expect(allocateRefundEventTenders(Number.MAX_SAFE_INTEGER - 1, capacities)).toEqual({ ok: true,
      tenderAllocations: [{ method: 'CARD', amountMinor: 1 }, { method: 'CASH', amountMinor: Number.MAX_SAFE_INTEGER - 2 }] });
    expect(allocateRefundEventTenders(Number.MAX_SAFE_INTEGER, capacities)).toEqual({ ok: true,
      tenderAllocations: [{ method: 'CARD', amountMinor: 1 }, { method: 'CASH', amountMinor: Number.MAX_SAFE_INTEGER - 1 }] });
  });
  it('exhaustively preserves exact sum/capacity and ordering for small four-method inputs', () => {
    for (let a = 0; a <= 3; a += 1) for (let b = 0; b <= 3; b += 1)
      for (let c = 0; c <= 3; c += 1) for (let d = 0; d <= 3; d += 1) {
        const capacities = rows(a, b, c, d);
        for (let delta = 1; delta <= a + b + c + d; delta += 1) {
          const result = allocateRefundEventTenders(delta, capacities);
          if (!result.ok) throw new Error(result.error);
          expect(result.tenderAllocations.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(delta);
          expect(result.tenderAllocations.every(row => Number.isSafeInteger(row.amountMinor) && row.amountMinor > 0
            && row.amountMinor <= capacities.find(capacity => capacity.method === row.method)!.amountMinor)).toBe(true);
          expect(allocateRefundEventTenders(delta, [...capacities].reverse())).toEqual(result);
        }
      }
  });
});
