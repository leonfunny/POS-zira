import { describe, expect, it } from 'vitest';
import {
  getRefundEvents,
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

  it('keeps a nameless weighted refund and resolves the sold product with its unit and event metadata', () => {
    const order = {
      refund_lines: JSON.stringify([{
        orderItemId: 'item-kg',
        variantId: 'variant-kg',
        sku: 'GINGER',
        name: '',
        quantity: '0.750',
        unit: 'kg',
        refundAmount: 1500,
        refundedAt: '2026-07-17T10:00:00.000Z',
        refundRequestId: 'refund-1',
        restock: true,
      }]),
    };
    const items = [{
      id: 'item-kg',
      variant_id: 'variant-kg',
      sku: 'GINGER',
      name: 'Gừng tươi',
      quantity: 1,
      total: 2000,
      sale_unit: 'kg',
      sell_by: 'WEIGHT',
    }];

    const [line] = getRefundBreakdownLines(order, items);
    expect(line).toMatchObject({
      name: 'Gừng tươi',
      quantity: 0.75,
      unit: 'kg',
      refundedAt: '2026-07-17T10:00:00.000Z',
      refundRequestId: 'refund-1',
      restock: true,
    });
    expect(getItemRefundBreakdowns(order, items)[0]).toMatchObject({
      refundedQty: 0.75,
      remainingQty: 0.25,
      refundedAmount: 1500,
    });
  });

  it('falls back to SKU for a missing refund name and groups lines by refund request', () => {
    const order = {
      refund_lines: JSON.stringify([
        { sku: 'SKU-1', name: '', quantity: 1, refundAmount: 500, refundedAt: '2026-07-17T10:00:00.000Z', refundRequestId: 'request-a' },
        { sku: 'SKU-2', name: 'Second', quantity: 2, refundAmount: 1000, refundedAt: '2026-07-17T10:00:00.000Z', refundRequestId: 'request-a' },
        { sku: 'SKU-2', name: 'Second', quantity: 1, refundAmount: 500, refundedAt: '2026-07-17T11:00:00.000Z', refundRequestId: 'request-b' },
      ]),
    };
    const items = [
      { id: 'item-1', variant_id: null, sku: 'SKU-1', name: 'First product', quantity: 1, total: 500 },
      { id: 'item-2', variant_id: null, sku: 'SKU-2', name: 'Second', quantity: 3, total: 1500 },
    ];

    expect(getRefundBreakdownLines(order, items)[0].name).toBe('First product');
    const events = getRefundEvents(order, items);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ refundRequestId: 'request-a', refundAmount: 1500 });
    expect(events[0].lines).toHaveLength(2);
    expect(events[1]).toMatchObject({ refundRequestId: 'request-b', refundAmount: 500 });
  });

  it('uses one sold row when a server item id differs and the same variant appears twice', () => {
    const items = [
      { id: 'local-item-1', variant_id: 'shared-variant', sku: 'SKU', name: 'Same product', quantity: 1, total: 500 },
      { id: 'local-item-2', variant_id: 'shared-variant', sku: 'SKU', name: 'Same product', quantity: 1, total: 500 },
    ];
    const fallbackOrder = {
      refund_lines: JSON.stringify([
        { orderItemId: 'server-item', variantId: 'shared-variant', sku: 'SKU', name: 'Same product', quantity: 1, refundAmount: 500 },
      ]),
    };

    const fallbackBreakdowns = getItemRefundBreakdowns(fallbackOrder, items);
    expect(fallbackBreakdowns.map((entry) => entry.refundedQty)).toEqual([1, 0]);

    const exactOrder = {
      refund_lines: JSON.stringify([
        { orderItemId: 'local-item-2', variantId: 'shared-variant', sku: 'SKU', name: 'Same product', quantity: 1, refundAmount: 500 },
      ]),
    };
    const exactBreakdowns = getItemRefundBreakdowns(exactOrder, items);
    expect(exactBreakdowns.map((entry) => entry.refundedQty)).toEqual([0, 1]);
  });
});
