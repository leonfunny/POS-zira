import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/logger', () => ({
  default: {
    warn: vi.fn(),
  },
}));

import {
  adaptServerOrder,
  normalizePaymentTendersJson,
} from '../src/main/sync/pos-order-adapter';

describe('pos order adapter', () => {
  it('normalises backend tender amounts from PLN to local grosze JSON', () => {
    const json = normalizePaymentTendersJson([
      { method: 'CASH', amount: 20, reference: null },
      { method: 'CARD', amount: '27.64', reference: 'auth-1' },
    ]);

    expect(JSON.parse(json!)).toEqual([
      { method: 'CASH', amount: 2000 },
      { method: 'CARD', amount: 2764, reference: 'auth-1' },
    ]);
  });

  it('stores split-payment tenders from full mirror payloads', () => {
    const adapted = adaptServerOrder({
      id: 'server-order-1',
      status: 'PAID',
      subtotal: '45.37',
      discountAmount: '0.00',
      taxAmount: '2.27',
      total: '47.64',
      paidAmount: '47.64',
      paymentMethod: 'SPLIT',
      posMode: 'retail',
      createdAt: '2026-05-22T12:02:08.000Z',
      tenders: [
        { method: 'CASH', amount: 20 },
        { method: 'CARD', amount: 27.64 },
      ],
    });

    expect(adapted.payment_method).toBe('SPLIT');
    expect(JSON.parse(adapted.payment_tenders)).toEqual([
      { method: 'CASH', amount: 2000 },
      { method: 'CARD', amount: 2764 },
    ]);
  });

  it('uses explicit cashReceived for mirrored server cash orders', () => {
    const adapted = adaptServerOrder({
      id: 'server-cash-1',
      status: 'PAID',
      subtotal: '14.00',
      discountAmount: '0.00',
      taxAmount: '2.62',
      total: '14.00',
      paidAmount: '14.00',
      cashReceived: '50.00',
      changeAmount: '36.00',
      paymentMethod: 'CASH',
      posMode: 'retail',
      createdAt: '2026-06-01T12:02:08.000Z',
    });

    expect(adapted.payment_amount).toBe(5000);
    expect(adapted.change_amount).toBe(3600);
  });

  it('derives legacy server cash received when backend only sends paidAmount plus changeAmount', () => {
    const adapted = adaptServerOrder({
      id: 'server-cash-legacy',
      status: 'PAID',
      subtotal: '14.00',
      discountAmount: '0.00',
      taxAmount: '2.62',
      total: '14.00',
      paidAmount: '14.00',
      changeAmount: '36.00',
      paymentMethod: 'CASH',
      posMode: 'retail',
      createdAt: '2026-06-01T12:02:08.000Z',
    });

    expect(adapted.payment_amount).toBe(5000);
    expect(adapted.change_amount).toBe(3600);
  });

  it('does not reinterpret non-cash paidAmount as cash received', () => {
    const adapted = adaptServerOrder({
      id: 'server-card-1',
      status: 'PAID',
      subtotal: '14.00',
      discountAmount: '0.00',
      taxAmount: '2.62',
      total: '14.00',
      paidAmount: '14.00',
      changeAmount: '36.00',
      paymentMethod: 'CARD',
      posMode: 'retail',
      createdAt: '2026-06-01T12:02:08.000Z',
    });

    expect(adapted.payment_amount).toBe(1400);
    expect(adapted.change_amount).toBe(3600);
  });
});
