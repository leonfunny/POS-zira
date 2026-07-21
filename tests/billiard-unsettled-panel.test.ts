import { describe, expect, it } from 'vitest';
import { sortUnsettledNewestFirst, summarizeUnsettled } from '../src/renderer/components/billiard/utils';

function unsettled(overrides: Record<string, unknown> = {}): any {
  return {
    status: 'COMPLETED',
    paymentStatus: 'UNPAID',
    totalCharge: '100.00',
    paidAmount: '0.00',
    ...overrides,
  };
}

describe('summarizeUnsettled — the numbers on the floor chip', () => {
  it('returns zeros for an empty or missing list', () => {
    expect(summarizeUnsettled([])).toEqual({ count: 0, totalOutstanding: 0 });
    expect(summarizeUnsettled(undefined)).toEqual({ count: 0, totalOutstanding: 0 });
    expect(summarizeUnsettled(null)).toEqual({ count: 0, totalOutstanding: 0 });
  });

  it('counts sessions and sums the still-owed amounts (decimal strings, partials)', () => {
    const sessions = [
      unsettled(),
      unsettled({ paymentStatus: 'PARTIAL', totalCharge: '50.00', paidAmount: '20.00' }),
    ];
    expect(summarizeUnsettled(sessions)).toEqual({ count: 2, totalOutstanding: 130 });
  });
});

describe('sortUnsettledNewestFirst — panel row order', () => {
  it('sorts by endedAt descending, falling back to startedAt, without mutating input', () => {
    const a = unsettled({ id: 'a', endedAt: '2026-07-01T10:00:00.000Z' });
    const b = unsettled({ id: 'b', endedAt: '2026-07-19T10:00:00.000Z' });
    const c = unsettled({ id: 'c', endedAt: null, startedAt: '2026-07-10T10:00:00.000Z' });

    const input = [a, c, b];
    expect(sortUnsettledNewestFirst(input).map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(input.map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });
});
