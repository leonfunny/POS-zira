import { afterEach, describe, expect, it, vi } from 'vitest';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { adaptServerOrder, adaptServerOrderItem } from '../src/shared/pos-order-adapter';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

afterEach(() => vi.restoreAllMocks());
function payload(linked = true): any {
  return {
    id: 'remote-order', createdAt: '2026-09-01T12:00:00.000Z', orderNumber: 'REMOTE-1', status: 'COMPLETED',
    posMode: 'restaurant', posOrderType: 'dine_in', subtotal: '20.00', total: '20.00', taxAmount: '0',
    paidAmount: '20.00', paymentMethod: 'CASH', shiftId: 'remote-shift',
    externalMetadata: { meta: { restaurant: { schemaVersion: 1, tableId: 'table-A', covers: 2,
      lines: ['a', 'b'].map((s, i) => ({ localLineId: `local-${s}`, ...(linked ? { orderItemId: `server-${s}` } : {}),
        productId: 'tea', lineIndex: i, notes: `note-${s}`, course: i + 2 })) } } },
    items: ['b', 'a'].map(s => ({ id: `server-${s}`, productId: 'tea', productName: 'Tea',
      totalUnits: 1, unitPrice: '10.00', totalPrice: '10.00', grossUnitPrice: '10.00', grossTotalPrice: '10.00', taxRate: 0 })),
  };
}
function adapted(p = payload()) {
  return { order: adaptServerOrder(p), items: p.items.map((i: any) => adaptServerOrderItem(i, p.id, p)) };
}
async function setup() {
  const persistence = new MemoryAndroidPersistence();
  const db = await initAndroidDb({ locateFile: null, persistence });
  const repo = createOrderRepo(db);
  const ingest = (p = payload()) => { const a = adapted(p); return repo.upsertFromServer(a.order, a.items); };
  return { db, repo, persistence, ingest };
}

describe('Android explicit server history cache', () => {
  it('persists exact duplicate-product links across reload without sale side effects', async () => {
    const { db, repo, persistence, ingest } = await setup();
    repo.openShift('active-shift', 'staff', 'Cashier', 0);
    expect(ingest()).toEqual({ inserted: true, localOrderId: 'remote-order' });
    expect(repo.getById('remote-order')).toMatchObject({ source: 'SERVER', synced: 1, shift_id: null,
      backend_id: 'remote-order', created_at: '2026-09-01T12:00:00.000Z', total: 2000,
      table_id: 'table-A', covers: 2, sync_metadata_eligible: 0, sync_payload_json: null });
    expect(repo.getUnsynced()).toEqual([]);
    expect(db.all('SELECT * FROM sequence_counters')).toEqual([]);
    expect(db.all('SELECT * FROM pos_restaurant_checks')).toEqual([]);
    expect(db.all("SELECT * FROM orders WHERE shift_id = 'active-shift'")).toEqual([]);
    await db.flush();
    const reopened = createOrderRepo(await initAndroidDb({ locateFile: null, persistence }));
    expect(reopened.getItemsByOrderId('remote-order').sort((a: any, b: any) => a.id.localeCompare(b.id))).toMatchObject([
      { id: 'server-a', restaurant_line_id: 'local-a', notes: 'note-a', course: 2, total: 1000 },
      { id: 'server-b', restaurant_line_id: 'local-b', notes: 'note-b', course: 3, total: 1000 },
    ]);
  });
  it.each(['same-id', 'backend-alias', 'pending-server', 'frozen-server'])('protects existing %s rows and their items', async kind => {
    const { db, repo, ingest } = await setup();
    ingest();
    if (kind === 'backend-alias') {
      db.run("UPDATE orders SET id = 'local-order', source = 'POS'");
      db.run("UPDATE order_items SET order_id = 'local-order'");
    } else db.run('UPDATE orders SET source = ?, synced = ?, sync_payload_json = ? WHERE id = ?',
      [kind === 'same-id' ? 'POS' : 'SERVER', kind === 'pending-server' ? 0 : 1,
        kind === 'frozen-server' ? 'immutable-payload' : null, 'remote-order']);
    db.run("UPDATE order_items SET notes = 'local only', course = 9");
    const beforeOrders = db.all('SELECT * FROM orders'); const beforeItems = db.all('SELECT * FROM order_items');
    expect(ingest()).toEqual({ inserted: false, localOrderId: kind === 'backend-alias' ? 'local-order' : 'remote-order' });
    expect(db.all('SELECT * FROM orders')).toEqual(beforeOrders);
    expect(db.all('SELECT * FROM order_items')).toEqual(beforeItems);
  });
  it('repairs exact server metadata but preserves newer refund and accounting facts', async () => {
    const { db, repo, ingest } = await setup(); ingest(payload(false));
    expect(repo.getItemsByOrderId('remote-order').every((i: any) => i.notes === null && i.course === null && i.restaurant_line_id === null)).toBe(true);
    db.run("UPDATE orders SET total = 1900, refund_amount = 500, refund_lines = 'newer-refund', shift_id = 'wrong-shift'");
    db.run('UPDATE order_items SET price = 950, total = 950');
    expect(ingest().inserted).toBe(false);
    expect(repo.getById('remote-order')).toMatchObject({ total: 1900, refund_amount: 500, refund_lines: 'newer-refund', shift_id: null });
    expect(repo.getItemsByOrderId('remote-order').find((i: any) => i.id === 'server-a')).toMatchObject({ notes: 'note-a', course: 2, restaurant_line_id: 'local-a', price: 950, total: 950 });
  });
  it('does not rebind a proven line or partially enrich a conflicting batch', async () => {
    const { db, ingest } = await setup(); ingest();
    db.run("UPDATE order_items SET restaurant_line_id = 'previous-link', notes = 'previous-note' WHERE id = 'server-a'");
    db.run("UPDATE order_items SET notes = 'preserve-b' WHERE id = 'server-b'");
    const before = db.all('SELECT * FROM order_items'); ingest();
    expect(db.all('SELECT * FROM order_items')).toEqual(before);
  });
  it('ignores malformed and unlinked line metadata without inventing provenance', async () => {
    const { repo, ingest } = await setup(); const p = payload();
    p.externalMetadata.meta.restaurant.lines[1].orderItemId = 'server-a'; ingest(p);
    expect(repo.getItemsByOrderId('remote-order').every((i: any) => i.restaurant_line_id === null && i.notes === null && i.course === null)).toBe(true);
  });
  it('rejects foreign item ownership before inserting any order', async () => {
    const { db, repo } = await setup();
    db.run("INSERT INTO order_items (id, order_id, name, price, quantity, total) VALUES ('server-b', 'another-order', 'Other', 100, 1, 100)");
    const a = adapted(); expect(() => repo.upsertFromServer(a.order, a.items)).toThrow('ANDROID_HISTORY_FOREIGN_ITEM_ID');
    expect(repo.getById('remote-order')).toBeNull();
    expect(db.get<any>("SELECT order_id FROM order_items WHERE id = 'server-b'")?.order_id).toBe('another-order');
  });
  it('rolls back the header and first item if the second item write fails', async () => {
    const { db, repo } = await setup(); const run = db.run.bind(db); let count = 0;
    vi.spyOn(db, 'run').mockImplementation((sql, params) => {
      if (sql.startsWith('INSERT INTO order_items') && ++count === 2) throw new Error('disk-write-injection');
      return run(sql, params);
    });
    const a = adapted(); expect(() => repo.upsertFromServer(a.order, a.items)).toThrow('disk-write-injection');
    expect(repo.getById('remote-order')).toBeNull(); expect(db.all('SELECT * FROM order_items')).toEqual([]);
  });
  it.each(['invalid-money', 'invalid-date', 'duplicate-item', 'wrong-order', 'no-items', 'billiard'])('rejects %s without writing', async kind => {
    const { db, repo } = await setup(); const a = adapted();
    if (kind === 'invalid-money') a.order.total = NaN;
    if (kind === 'invalid-date') a.order.created_at = 'not-a-date';
    if (kind === 'duplicate-item') a.items[1].id = a.items[0].id;
    if (kind === 'wrong-order') a.items[1].order_id = 'foreign';
    if (kind === 'no-items') a.items = {} as any;
    if (kind === 'billiard') a.order.mode = 'billiard';
    expect(() => repo.upsertFromServer(a.order, a.items)).toThrow(/ANDROID_HISTORY_/);
    expect(db.all('SELECT * FROM orders')).toEqual([]);
  });
  it('refuses a changed server item set rather than deleting historical lines', async () => {
    const { db, ingest } = await setup(); ingest(); const before = db.all('SELECT * FROM order_items');
    const p = payload(); p.items.pop();
    expect(() => ingest(p)).toThrow('ANDROID_HISTORY_ITEM_SET_MISMATCH');
    expect(db.all('SELECT * FROM order_items')).toEqual(before);
  });
  it('exposes persistence failure and leaves the last durable image unchanged', async () => {
    const { db, persistence, ingest } = await setup();
    await db.flush(); persistence.failSave = true;
    ingest(); await expect(db.flush()).rejects.toThrow();
    persistence.failSave = false;
    const reopened = createOrderRepo(await initAndroidDb({ locateFile: null, persistence }));
    expect(reopened.getById('remote-order')).toBeNull();
    // In-memory commit is not durable success; the transport must await flush.
    await db.flush();
    const retried = createOrderRepo(await initAndroidDb({ locateFile: null, persistence }));
    expect(retried.getById('remote-order')?.source).toBe('SERVER');
  });
});
