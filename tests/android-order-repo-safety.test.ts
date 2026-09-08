import { MemoryAndroidPersistence } from './helpers/android-persistence';
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
  it('upgrades a v4 image without losing its orders, items or shift', async () => {
    const persistence = new MemoryAndroidPersistence();
    const old = await initAndroidDb({ locateFile: null, persistence });
    const repo = createOrderRepo(old);
    repo.openShift('shift', 'staff', 'Cashier', 1000); repo.create(order('shift'), items);
    // Build a v4 fixture in isolated test storage, not a user database.
    old.run('ALTER TABLE order_items DROP COLUMN allocated_discount');
    old.run('ALTER TABLE order_items DROP COLUMN payable_total');
    old.run('DROP TABLE pos_restaurant_checks'); old.run('DROP TABLE pos_tables'); old.run('DROP TABLE pos_device_identity');
    old.run('DROP TABLE pos_table_layout_sync');
    old.run('ALTER TABLE orders DROP COLUMN sync_payload_json');
    old.run('ALTER TABLE orders DROP COLUMN sync_metadata_eligible');
    old.run('PRAGMA user_version = 4'); await old.flush();
    const upgraded = await initAndroidDb({ locateFile: null, persistence });
    expect(createOrderRepo(upgraded).getById('order-1')?.total).toBe(9000);
    expect(createOrderRepo(upgraded).getItemsByOrderId('order-1')[0]).toMatchObject({ total: 10000, allocated_discount: 0, payable_total: null });
    expect(createOrderRepo(upgraded).getActiveShift()?.id).toBe('shift');
    expect(upgraded.all('SELECT * FROM pos_restaurant_checks')).toEqual([]);
    expect(upgraded.getRawHandle().exec('PRAGMA user_version')[0].values[0][0]).toBe(13);
    expect(createOrderRepo(upgraded).getById('order-1')).toMatchObject({ sync_metadata_eligible: 0, sync_payload_json: null });
  });
  it('persists per-line discount allocation and restaurant metadata across a reload', async () => {
    const persistence = new MemoryAndroidPersistence();
    const db = await initAndroidDb({ locateFile: null, persistence });
    createOrderRepo(db).create({ ...order('shift'), mode: 'restaurant', table_id: 'A', covers: 2, order_type: 'dine_in' },
      [{ ...items[0], allocated_discount: 1000, payable_total: 9000, notes: 'No onion', course: 2 }]);
    await db.flush();
    const loaded = await initAndroidDb({ locateFile: null, persistence });
    expect(createOrderRepo(loaded).getItemsByOrderId('order-1')[0]).toMatchObject({
      allocated_discount: 1000, payable_total: 9000, total: 10000, notes: 'No onion', course: 2,
    });
    expect(createOrderRepo(loaded).getById('order-1')).toMatchObject({ discount: 1000, total: 9000, table_id: 'A', covers: 2 });
  });
  it('rejects an itemless paid order without persisting a financial row', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE, persistence: new MemoryAndroidPersistence() });
    const repo = createOrderRepo(database);

    expect(() => repo.create(order('shift-1'), [])).toThrow(
      'POS order must contain at least one item',
    );
    expect(repo.getById('order-1')).toBeNull();
  });

  it('keeps discount out of a second subtraction, reports tip separately, and closes once', async () => {
    const database = await initAndroidDb({ locateFile: NODE_LOCATE_FILE, persistence: new MemoryAndroidPersistence() });
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
    expect(repo.closeShift('shift-1', 1)).toEqual(report);
    expect(database.get<any>('SELECT closing_cash FROM shifts WHERE id = ?', ['shift-1'])?.closing_cash).toBe(19_500);
  });
});
