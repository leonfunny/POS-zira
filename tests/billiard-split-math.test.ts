import { describe, expect, it } from 'vitest';
import { evenSplitCents } from '../src/renderer/components/billiard/SplitBillDialog';

describe('evenSplitCents', () => {
  it('splits exactly with no lost grosz (10.00 / 3)', () => {
    const parts = evenSplitCents(1000, 3);
    expect(parts).toEqual([334, 333, 333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('handles even divisions', () => {
    expect(evenSplitCents(2000, 4)).toEqual([500, 500, 500, 500]);
  });

  it('sum always equals the total for awkward remainders', () => {
    for (const [total, n] of [[999, 7], [12345, 10], [101, 2], [7, 5]] as const) {
      const parts = evenSplitCents(total, n);
      expect(parts).toHaveLength(n);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      // Shares differ by at most one grosz.
      expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
    }
  });
});
