import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/main/logger', () => ({ default: { warn: vi.fn() } }));
import * as shared from '../src/shared/pos-order-adapter';
import * as windows from '../src/main/sync/pos-order-adapter';

describe('portable server order adapter parity', () => {
  it.each(['retail', 'restaurant', 'billiard'])('keeps the Windows %s order and line mapping identical', mode => {
    const raw: any = { id: 'server', orderNumber: 'REMOTE-1', createdAt: '2026-09-01T12:00:00.000Z', posMode: mode,
      total: '12.30', subtotal: '10.00', taxAmount: '2.30', refundAmount: '1.00', paymentMethod: 'CASH',
      items: [{ id: 'line', productId: 'product', productName: 'Item', unitPrice: '10.00', totalPrice: '10.00', taxRate: 23, totalUnits: 1 }] };
    expect(shared.adaptServerOrder(raw)).toEqual(windows.adaptServerOrder(raw));
    expect(shared.adaptServerOrderItem(raw.items[0], raw.id, raw)).toEqual(windows.adaptServerOrderItem(raw.items[0], raw.id, raw));
  });
  it('re-exports the same financial and refund helpers rather than copies', () => {
    for (const name of ['toGrosze', 'toVatRate', 'normalizeRefundLinesJson', 'mergeRefundLineMetadataJson', 'normalizePaymentTendersJson', 'adaptServerOrderItem'] as const) {
      expect(windows[name]).toBe(shared[name]);
    }
  });
  it('allows a caller-owned warning callback without a platform logger', () => {
    const warn = vi.fn(); shared.adaptServerOrder({ id: 'legacy', createdAt: '2026-09-01T12:00:00Z' }, warn);
    expect(warn).toHaveBeenCalled();
  });
});
