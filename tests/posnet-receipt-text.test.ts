import { describe, expect, it } from 'vitest';

import { ReceiptFormatter } from '../src/main/hardware/posnet/receipt-formatter';

describe('POSNET receipt text safety', () => {
  it('folds a frozen Billiard table and duration into an ASCII-safe fiscal name', () => {
    const receipt = new ReceiptFormatter().formatOrder({
      orderId: 'billiard-order-time',
      orderNumber: 'POS-B-TIME',
      items: [{
        name: 'Bàn #10 — 60 min',
        quantity: 1,
        unitPrice: 6000,
        totalPrice: 6000,
        vatRate: 23,
        unit: 'usł.',
      }],
      payment: { method: 'CASH', amount: 6000 },
      subtotal: 6000,
      total: 6000,
    });

    expect(receipt.items[0]).toMatchObject({
      name: 'Ban #10 - 60 min',
      quantity: 1,
      price: 6000,
      total: 6000,
    });
    expect(Buffer.from(receipt.items[0].name, 'ascii').toString('ascii'))
      .toBe(receipt.items[0].name);
  });
});
