import { describe, expect, it } from 'vitest';

import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';

const NODE_LOCATE_FILE = null;

function order(shiftId: string) {
  return {
    id: 'order-1',
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
  };
}

const items = [{
  id: 'item-1',
  order_id: 'order-1',
  variant_id: 'variant-1',
  name: 'Manicure',
  sku: 'SERVICE-1',
  price: 10_000,
  quantity: 1,
  total: 10_000,
  vat_rate: 23,
}];

describe('Android order/shift repository safety invariants', () => {
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
    repo.create(order('shift-1'), items);

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
});
