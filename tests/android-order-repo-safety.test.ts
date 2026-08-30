import { describe, expect, it } from 'vitest';

import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';

const NODE_LOCATE_FILE = null;

function order(shiftId: string, id = 'order-1', overrides: Record<string, unknown> = {}) {
  return {
    id,
    order_number: 'ZAM-20260830-0001',
    status: 'COMPLETED',
    subtotal: 10_000,
    discount: 1_000,
    tax: 0,
    total: 9_000,
    payment_method: 'CASH',
    payment_amount: 10_000,
    change_amount: 500,
    shift_id: shiftId,
    source: 'POS',
    tip: 500,
    mode: 'salon',
    ...overrides,
  };
}

const items = (orderId = 'order-1') => [{
  id: `item-${orderId}`,
  order_id: orderId,
  variant_id: 'variant-1',
  name: 'Manicure',
  sku: 'SERVICE-1',
  price: 10_000,
  quantity: 1,
  total: 10_000,
  vat_rate: 23,
}];

describe('Android order/shift repository safety invariants', () => {
  it('clears the refund ledger at the salon tenant boundary', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    database.run(
      `INSERT INTO android_refund_events (
         id, order_id, shift_id, amount, payment_method, occurred_at
       ) VALUES ('old-salon-refund', 'old-order', NULL, 2000, 'CASH', datetime('now'))`,
    );

    database.clearSalonData();

    expect(database.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM android_refund_events',
    )?.count).toBe(0);
  });

  it('rejects an itemless paid order without persisting a financial row', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const repo = createOrderRepo(database);

    expect(() => repo.create(order('shift-1'), [])).toThrow(
      'POS order must contain at least one item',
    );
    expect(repo.getById('order-1')).toBeNull();
  });

  it('keeps discount out of a second subtraction, reports tip separately, and closes once', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const repo = createOrderRepo(database);
    repo.openShift('shift-1', 'staff-1', 'Cashier', 10_000);
    repo.create(order('shift-1'), items());

    const report = repo.closeShift('shift-1', 19_500);

    expect(report).toMatchObject({
      totalSales: 9_000,
      totalDiscounts: 1_000,
      totalTips: 500,
      cashTotal: 9_500,
      difference: 0,
    });
    expect(() => repo.closeShift('shift-1', 19_500)).toThrowError(
      expect.objectContaining({ code: 'SHIFT_ALREADY_CLOSED' }),
    );
  });

  it('attributes a refund to the shift where cash is returned, not the sale shift', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const repo = createOrderRepo(database);
    repo.openShift('sale-shift', 'staff-1', 'Cashier', 10_000);
    repo.create(order('sale-shift'), items());
    repo.closeShift('sale-shift', 19_500);

    repo.openShift('refund-shift', 'staff-1', 'Cashier', 10_000);
    repo.recordRefundEvent({
      id: 'refund-1',
      orderId: 'order-1',
      shiftId: 'refund-shift',
      amount: 2_000,
      paymentMethod: 'CASH',
    });
    repo.markRefunded('order-1', 2_000, 'return', 'PARTIAL');

    const report = repo.closeShift('refund-shift', 8_000);

    expect(report).toMatchObject({
      totalOrders: 0,
      refundTransactions: 1,
      totalRefunds: 2_000,
      totalSales: -2_000,
      cashTotal: -2_000,
      expectedClosingCash: 8_000,
      difference: 0,
    });
  });

  it('subtracts an old split-payment refund from each original tender bucket', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const repo = createOrderRepo(database);
    const splitTenders = JSON.stringify([
      { method: 'CASH', amount: 6_000 },
      { method: 'CARD', amount: 4_000 },
    ]);
    repo.openShift('sale-shift', 'staff-1', 'Cashier', 10_000);
    repo.create(order('sale-shift', 'split-order', {
      subtotal: 10_000,
      discount: 0,
      total: 10_000,
      tip: 0,
      payment_method: 'SPLIT',
      payment_amount: 10_000,
      change_amount: 0,
      payment_tenders: splitTenders,
    }), items('split-order'));
    repo.closeShift('sale-shift', 16_000);

    repo.openShift('refund-shift', 'staff-1', 'Cashier', 10_000);
    repo.recordRefundEvent({
      id: 'split-refund',
      orderId: 'split-order',
      shiftId: 'refund-shift',
      amount: 5_000,
      paymentMethod: 'SPLIT',
      paymentTenders: splitTenders,
    });
    repo.markRefunded('split-order', 5_000, 'return', 'PARTIAL');

    expect(repo.closeShift('refund-shift', 7_000)).toMatchObject({
      totalSales: -5_000,
      cashTotal: -3_000,
      cardTotal: -2_000,
      expectedClosingCash: 7_000,
      difference: 0,
    });
  });

  it('keeps all drawer payments while fiscal-only sales exclude non-fiscal orders', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE });
    const repo = createOrderRepo(database);
    repo.openShift('shift-1', 'staff-1', 'Cashier', 10_000);
    repo.create(order('shift-1', 'fiscal-card', {
      total: 10_000,
      discount: 0,
      tip: 0,
      payment_method: 'CARD',
      payment_amount: 10_000,
      change_amount: 0,
    }), items('fiscal-card'));
    repo.markFiscalPrinted('fiscal-card');
    repo.create(order('shift-1', 'non-fiscal-cash', {
      total: 5_000,
      discount: 0,
      tip: 0,
      payment_method: 'CASH',
      payment_amount: 5_000,
      change_amount: 0,
    }), items('non-fiscal-cash'));

    const report = repo.closeShift('shift-1', 15_000, true);

    expect(report).toMatchObject({
      fiscalOnlySales: true,
      totalOrders: 1,
      totalSales: 10_000,
      cardTotal: 10_000,
      cashTotal: 5_000,
      expectedClosingCash: 15_000,
      difference: 0,
    });
  });
});
