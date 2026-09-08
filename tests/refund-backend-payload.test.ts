import { describe, expect, it } from 'vitest';
import { toRefundBackendPayload, mergeRefundLines, type RefundIpcLine } from '../src/shared/refund-backend-payload';
import * as windows from '../src/main/pos/refund-backend-payload';
import { buildRefundRequest } from '../src/renderer/components/pos/refund-request';
import { getRemainingRefundableItems } from '../src/renderer/components/pos/refund-quantities';
import { getItemRefundBreakdowns, getRefundBreakdownLines } from '../src/renderer/components/pos/refund-breakdown';

const line = (orderItemId?: string): RefundIpcLine => ({ orderItemId, variantId: 'same-product', name: 'Tea',
  quantity: 1, unitPrice: 1799, refundAmount: 1799, restock: true });

describe('exact refund backend identity', () => {
  it.each(['FULL', 'PARTIAL'] as const)('sends %s duplicate products as distinct exact items, never legacy lines', type => {
    const request = buildRefundRequest({ type, refundRequestId: 'request-1', computedRefundTotal: 3598,
      lines: [line('server-b'), line('server-a')] });
    expect(toRefundBackendPayload(request)).toEqual({ type, reason: undefined, refundRequestId: 'request-1', amount: 35.98,
      items: [{ orderItemId: 'server-b', quantity: 1, restock: true }, { orderItemId: 'server-a', quantity: 1, restock: true }] });
  });
  it('preserves weighted quantity and converts money once only at the network boundary', () => {
    const payload = toRefundBackendPayload({ type: 'PARTIAL', lines: [{ ...line('server-kg'), quantity: 0.75, unit: 'kg', refundAmount: 1500 }],
      manualAdjustmentAmount: 123, tenderAllocations: [{ method: 'CASH', amount: 1500 }] });
    expect(payload).toMatchObject({ items: [{ orderItemId: 'server-kg', quantity: 0.75, restock: true, unit: 'kg' }],
      amount: 15, manualAdjustmentAmount: 1.23, tenderAllocations: [{ method: 'CASH', amount: 15 }] });
    expect(payload.items[0]).not.toHaveProperty('unitPrice');
    expect(payload.items[0]).not.toHaveProperty('refundAmount');
    expect(payload).not.toHaveProperty('lines');
  });
  it.each([undefined, '', ' ', ' leading', 'trailing ', 'x'.repeat(129), null, 123])('rejects mixed or invalid exact identity %s', bad => {
    expect(() => toRefundBackendPayload({ type: 'PARTIAL', lines: [line('valid'), { ...line(), orderItemId: bad as any }] })).toThrow(/orderItemId/);
  });
  it('rejects duplicated item identity even if products or names differ', () => {
    expect(() => toRefundBackendPayload({ type: 'FULL', lines: [line('same'), { ...line('same'), variantId: 'different' }] })).toThrow(/orderItemId/);
  });
  it('rejects mixed Billiard and ordinary lines', () => {
    expect(() => toRefundBackendPayload({ type: 'PARTIAL', lines: [{ ...line('server-a'), billiardLineKey: 'time-key' }, line('server-b')] })).toThrow(/billiardLineKey/);
  });
  it('retains Billiard stable keys and never substitutes the server or product ID', () => {
    const payload = toRefundBackendPayload({ type: 'PARTIAL', lines: [{ ...line('server-a'), billiardLineKey: 'stable-time-key' }] });
    expect(payload.items).toEqual([{ billiardLineKey: 'stable-time-key', quantity: 1, restock: false }]);
    expect(payload).not.toHaveProperty('lines');
  });
  it('keeps legacy unidentified callers compatible without inventing exact IDs', () => {
    const payload = toRefundBackendPayload({ type: 'PARTIAL', lines: [line()] });
    expect(payload).toMatchObject({ amount: 17.99, lines: [{ variantId: 'same-product', unitPrice: 17.99, refundAmount: 17.99 }] });
    expect(payload).not.toHaveProperty('items');
  });
  it('deduplicates ordinary retries by request and exact item, not product', () => {
    const first = ['server-b', 'server-a'].map(id => ({ ...line(id), refundRequestId: 'request-1' }));
    expect(mergeRefundLines(JSON.stringify(first), [...first].reverse())).toEqual(first);
    expect(mergeRefundLines(JSON.stringify(first), [{ ...first[0], refundRequestId: 'request-2' }])).toHaveLength(3);
    expect(mergeRefundLines(null, [line(), line()])).toHaveLength(2);
  });
  it('keeps Billiard and normal journal identity namespaces independent', () => {
    const normal = { ...line('same-key'), refundRequestId: 'request-1' };
    const billiard = { ...line(), billiardLineKey: 'same-key', refundRequestId: 'request-1' };
    expect(mergeRefundLines(JSON.stringify([normal, billiard]), [normal, billiard])).toEqual([normal, billiard]);
  });
  it('keeps the Windows import as the exact same pure implementation', () => {
    expect(windows.toRefundBackendPayload).toBe(toRefundBackendPayload);
    expect(windows.mergeRefundLines).toBe(mergeRefundLines);
  });
  it('does not consume the other same-product line after an exact refund', () => {
    const items = ['server-b', 'server-a'].map(id => ({ id, variant_id: 'same-product', name: 'Tea', quantity: 1, price: 1799, total: 1799 }));
    const order = { total: 3598, refund_amount: 1799, refund_lines: JSON.stringify([line('server-a')]) };
    expect(getRemainingRefundableItems(order, items).items.map(i => i.maxQty)).toEqual([1, 0]);
    expect(getItemRefundBreakdowns(order, items).map(i => i.refundedAmount)).toEqual([0, 1799]);
  });
  it('does not relabel an unknown explicit server ID as a local product match', () => {
    const items = [{ id: 'local-id', variant_id: 'same-product', name: 'Tea', quantity: 1, price: 1799, total: 1799 }];
    const order = { total: 3598, refund_amount: 1799, refund_lines: JSON.stringify([line('server-other')]) };
    expect(getRefundBreakdownLines(order, items)[0].orderItemId).toBe('server-other');
    expect(getItemRefundBreakdowns(order, items)[0].refundedAmount).toBe(0);
    expect(getRemainingRefundableItems(order, items).items[0].maxQty).toBe(1);
  });
  it('retains legacy no-ID quantity and breakdown behavior', () => {
    const items = [{ id: 'local-id', variant_id: 'same-product', name: 'Tea', quantity: 2, price: 1799, total: 3598 }];
    const order = { total: 3598, refund_amount: 1799, refund_lines: JSON.stringify([line()]) };
    expect(getRemainingRefundableItems(order, items).items[0].maxQty).toBe(1);
    expect(getItemRefundBreakdowns(order, items)[0].refundedAmount).toBe(1799);
  });
});
