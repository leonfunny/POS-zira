import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/logger', () => ({
  default: {
    warn: vi.fn(),
  },
}));

import {
  adaptServerOrder,
  adaptServerOrderItem,
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

  it('stores mirrored net-priced server rows as local gross prices for receipts', () => {
    const serverOrder = {
      id: 'server-pos-1',
      status: 'PENDING_STOCK',
      subtotal: '5.71',
      discountAmount: '0.00',
      taxAmount: '0.29',
      total: '6.00',
      paidAmount: '6.00',
      paymentMethod: 'CASH',
      priceType: 'brutto',
      taxIncluded: false,
      posMode: 'retail',
      createdAt: '2026-06-07T10:21:10.675Z',
    };

    const adapted = adaptServerOrder(serverOrder);
    const item = adaptServerOrderItem({
      id: 'line-1',
      variantId: 'variant-soy-milk',
      productName: 'Sữa đậu nành bán theo cốc',
      productSku: 'MOON-260601-NE6',
      variantSku: 'MOON-260601-NE6',
      unitPrice: '5.7143',
      totalPrice: '5.71',
      taxRate: '5.00',
      totalUnits: 1,
      packQuantity: 1,
    }, adapted.id, serverOrder);

    expect(adapted.subtotal).toBe(600);
    expect(adapted.tax).toBe(29);
    expect(adapted.total).toBe(600);
    expect(item.price).toBe(600);
    expect(item.total).toBe(600);
    expect(item.vat_rate).toBe(5);
  });

  it('uses explicit gross fields for BRUTTO mirrored rows without double-grossing', () => {
    const serverOrder = {
      id: 'POS260607-0085',
      status: 'PAID',
      subtotal: '14.95',
      discountAmount: '0.00',
      taxAmount: '2.05',
      total: '17.00',
      paidAmount: '17.00',
      paymentMethod: 'CASH',
      priceType: 'brutto',
      posMode: 'retail',
      createdAt: '2026-06-07T10:21:10.675Z',
    };

    const adapted = adaptServerOrder(serverOrder);
    const items = [
      adaptServerOrderItem({
        id: 'line-1',
        variantId: 'variant-23',
        productName: 'VAT 23 item',
        unitPrice: '7',
        totalPrice: '7',
        netUnitPrice: '5.6911',
        netTotalPrice: '5.69',
        grossUnitPrice: '7',
        grossTotalPrice: '7',
        taxRate: '23.00',
        totalUnits: 1,
      }, adapted.id, serverOrder),
      adaptServerOrderItem({
        id: 'line-2',
        variantId: 'variant-8',
        productName: 'VAT 8 item',
        unitPrice: '10',
        totalPrice: '10',
        netUnitPrice: '9.2593',
        netTotalPrice: '9.26',
        grossUnitPrice: '10',
        grossTotalPrice: '10',
        taxRate: '8.00',
        totalUnits: 1,
      }, adapted.id, serverOrder),
    ];

    expect(adapted.subtotal).toBe(1700);
    expect(adapted.tax).toBe(205);
    expect(adapted.total).toBe(1700);
    expect(items[0].price).toBe(700);
    expect(items[0].total).toBe(700);
    expect(items[1].price).toBe(1000);
    expect(items[1].total).toBe(1000);
    expect(items.reduce((sum, item) => sum + item.total, 0)).toBe(1700);
    expect(items.reduce((sum, item) => sum + item.total, 0)).not.toBe(1941);
  });

  it('uses explicit gross fields for NETTO mirrored rows', () => {
    const serverOrder = {
      id: 'POS260607-0109',
      status: 'PAID',
      subtotal: '4.00',
      discountAmount: '0.00',
      taxAmount: '0.20',
      total: '4.20',
      paidAmount: '4.20',
      paymentMethod: 'CARD',
      priceType: 'netto',
      posMode: 'retail',
      createdAt: '2026-06-07T10:21:10.675Z',
    };

    const adapted = adaptServerOrder(serverOrder);
    const item = adaptServerOrderItem({
      id: 'line-1',
      variantId: 'variant-5',
      productName: 'VAT 5 item',
      unitPrice: '4.0000',
      totalPrice: '4.00',
      netUnitPrice: 4,
      netTotalPrice: 4,
      grossUnitPrice: 4.2,
      grossTotalPrice: 4.2,
      taxRate: '5.00',
      totalUnits: 1,
    }, adapted.id, serverOrder);

    expect(adapted.subtotal).toBe(420);
    expect(adapted.tax).toBe(20);
    expect(adapted.total).toBe(420);
    expect(item.price).toBe(420);
    expect(item.total).toBe(420);
  });

  it('uses explicit gross totals for weighted server rows without recalculating', () => {
    const serverOrder = {
      id: 'server-weight-gross',
      status: 'PAID',
      subtotal: '3.33',
      discountAmount: '0.00',
      taxAmount: '0.77',
      total: '4.10',
      paidAmount: '4.10',
      paymentMethod: 'CASH',
      priceType: 'brutto',
      posMode: 'retail',
      createdAt: '2026-06-07T10:21:10.675Z',
    };

    const item = adaptServerOrderItem({
      id: 'line-weight',
      variantId: 'variant-weight',
      productName: 'Weighted item',
      unitPrice: '12.34',
      totalPrice: '4.10',
      customPrice: '12.34',
      grossUnitPrice: '12.34',
      grossTotalPrice: '4.10',
      taxRate: '23.00',
      saleQuantity: '0.333',
      saleUnit: 'kg',
      sellBy: 'WEIGHT',
    }, serverOrder.id, serverOrder);

    expect(item.price).toBe(1234);
    expect(item.total).toBe(410);
    expect(item.total).not.toBe(411);
    expect(item.total).not.toBe(504);
    expect(item.sell_by).toBe('WEIGHT');
  });

  it('keeps already gross-priced server rows unchanged', () => {
    const serverOrder = {
      id: 'server-pos-gross',
      status: 'PAID',
      subtotal: '6.00',
      discountAmount: '0.00',
      taxAmount: '0.29',
      total: '6.00',
      paidAmount: '6.00',
      paymentMethod: 'CASH',
      posMode: 'retail',
      createdAt: '2026-06-07T10:21:10.675Z',
    };

    const adapted = adaptServerOrder(serverOrder);
    const item = adaptServerOrderItem({
      id: 'line-1',
      variantId: 'variant-soy-milk',
      productName: 'Sữa đậu nành bán theo cốc',
      unitPrice: '6.00',
      totalPrice: '6.00',
      taxRate: '5.00',
      totalUnits: 1,
    }, adapted.id, serverOrder);

    expect(adapted.subtotal).toBe(600);
    expect(item.price).toBe(600);
    expect(item.total).toBe(600);
  });
});
