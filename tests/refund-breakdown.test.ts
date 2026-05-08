import { describe, expect, it } from 'vitest';
import {
  getItemRefundBreakdowns,
  getRefundBreakdownLines,
  parseRefundBreakdownLines,
} from '../src/renderer/components/pos/refund-breakdown';

describe('refund breakdown helpers', () => {
  it('computes refunded and remaining quantity/amount per item', () => {
    const order = {
      refund_lines: JSON.stringify([
        { variantId: 'variant-1', sku: 'SKU-1', name: 'Biscuits', quantity: 1, refundAmount: 700, unitPrice: 700, vatRate: 8 },
      ]),
    };
    const [breakdown] = getItemRefundBreakdowns(order, [
      { id: 'item-1', variant_id: 'variant-1', sku: 'SKU-1', name: 'Biscuits', quantity: 5, total: 3500 },
    ]);

    expect(breakdown.refundedQty).toBe(1);
    expect(breakdown.remainingQty).toBe(4);
    expect(breakdown.refundedAmount).toBe(700);
    expect(breakdown.remainingAmount).toBe(2800);
  });

  it('falls back from variantId to sku and then name matching', () => {
    const order = {
      refund_lines: JSON.stringify([
        { sku: 'SKU-2', name: 'Sku matched', quantity: 2, refundAmount: 1000 },
        { name: 'Name matched', quantity: 1, refundAmount: 500 },
      ]),
    };
    const breakdowns = getItemRefundBreakdowns(order, [
      { id: 'item-2', variant_id: null, sku: 'SKU-2', name: 'Sku matched', quantity: 3, total: 1500 },
      { id: 'item-3', variant_id: null, sku: null, name: 'Name matched', quantity: 2, total: 1000 },
    ]);

    expect(breakdowns[0].refundedQty).toBe(2);
    expect(breakdowns[1].refundedQty).toBe(1);
  });

  it('returns empty breakdown lines for missing or corrupt refund_lines', () => {
    expect(parseRefundBreakdownLines(null)).toEqual([]);
    expect(parseRefundBreakdownLines('{ broken json')).toEqual([]);
    expect(getRefundBreakdownLines({ refund_lines: '[]' })).toEqual([]);
  });
});
