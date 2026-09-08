import { describe, expect, it } from 'vitest';
import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { applyAndroidSchema } from '../src/renderer/android-pos/shim/db/schema';
import { createRefundAttemptRepo } from '../src/renderer/android-pos/shim/db/refund-attempt-repo';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const tables = ['product_variants', 'categories', 'orders', 'order_items', 'shifts', 'staff',
  'sequence_counters', 'sync_meta', 'pos_refund_attempts', 'pos_refund_events', 'pos_device_identity'];
const snapshot = (db: AndroidDatabase) => Object.fromEntries(tables.map(table => [table, db.all(`SELECT * FROM ${table}`)]));
const eventColumns = ['request_id', 'server_url', 'salon_id', 'local_order_id', 'backend_order_id',
  'local_shift_id', 'backend_shift_id', 'machine_id', 'operator_id', 'occurred_at', 'delta_amount_minor', 'event_json'];
const insertEvent = (db: AndroidDatabase, delta: any = 123, id = 'confirmed') => db.run(
  `INSERT INTO pos_refund_events (${eventColumns.join(',')}) VALUES (${eventColumns.map(() => '?').join(',')})`,
  [id, 'https://server.test', 'salon', 'paid', 'backend-order', 'shift', 'backend-shift', 'device',
    'owner', '2026-09-08T08:01:00Z', delta, '{ "canonical": "exact bytes" }']);
function prepare(db: AndroidDatabase, id = 'original') {
  return createRefundAttemptRepo(db).prepare({ request_id: id, scope_key: '["https://legacy.test","salon","owner"]',
    local_order_id: 'paid', backend_order_id: 'backend-order', shift_id: 'shift',
    payload_json: '{ "refundRequestId": "original", "amount": 1.23, "items": [] }',
    expected_json: '{ "protocolVersion": 0, "inputJson": "frozen original bytes" }' });
}
function seed(db: AndroidDatabase) {
  db.run(`INSERT INTO orders (id,status,total,payment_tenders,refund_amount,refund_lines,synced,sync_payload_json,shift_id)
    VALUES ('paid','PARTIAL_REFUND',1234,'[ { "method": "CASH", "amount": 1234 } ]',123,'[ { "legacy": true } ]',1,'{ "frozen": true }','shift')`);
  db.run(`INSERT INTO shifts (id,backend_id,backend_binding_json,close_report_json,opening_cash,closing_cash,closed_at)
    VALUES ('shift','backend-shift','{ "binding": true }','{ "historical": true }',123,234,'2026-09-08T09:00:00Z')`);
  db.run("INSERT INTO pos_device_identity (singleton,id) VALUES (1,'00000000-0000-4000-8000-000000000001')");
  db.run("INSERT INTO categories (id,name) VALUES ('category','Category')");
  db.run("INSERT INTO product_variants (id,name) VALUES ('product','Product')");
  db.run("INSERT INTO order_items (id,order_id,notes,course) VALUES ('line','paid','Original note',2)");
  db.run("INSERT INTO staff (id,name) VALUES ('owner','Owner')");
  db.run("INSERT INTO sequence_counters (name,current_value) VALUES ('order',42)");
  db.run("INSERT INTO sync_meta (key,value) VALUES ('cursor','original')");
}

describe('Android v13 canonical refund storage migration', () => {
  it('creates an empty event ledger, scoped indexes and nullable context without synthesizing history', async () => {
    const db = await initAndroidDb({ locateFile: null, persistence: new MemoryAndroidPersistence() });
    expect(db.getRawHandle().exec('PRAGMA user_version')[0].values).toEqual([[13]]);
    expect(db.all<any>('PRAGMA table_info(orders)').find(row => row.name === 'refund_event_context_json'))
      .toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    const columns = db.all<any>('PRAGMA table_info(pos_refund_events)');
    expect(columns.map(row => row.name)).toEqual(eventColumns);
    expect(columns.find(row => row.name === 'request_id')).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(columns.filter(row => row.name !== 'request_id').every(row => row.notnull === 1)).toBe(true);
    expect(columns.find(row => row.name === 'delta_amount_minor')?.type).toBe('INTEGER');
    expect(db.all('PRAGMA foreign_key_list(pos_refund_events)')).toEqual([]);
    const indexes = db.all<any>('PRAGMA index_list(pos_refund_events)').map(index =>
      db.all<any>(`PRAGMA index_info(${index.name})`).map(column => column.name));
    expect(indexes).toContainEqual(['server_url', 'salon_id', 'local_order_id']);
    expect(indexes).toContainEqual(['local_shift_id']);
    seed(db);
    expect(db.get('SELECT refund_event_context_json FROM orders')).toEqual({ refund_event_context_json: null });
    expect(db.all('SELECT * FROM pos_refund_events')).toEqual([]);
    await db.flush();
  });

  it('upgrades a v12 image without changing money, snapshots or UNKNOWN journal bytes; repeats safely', async () => {
    const persistence = new MemoryAndroidPersistence();
    const db = await initAndroidDb({ locateFile: null, persistence });
    db.run('DROP TABLE IF EXISTS pos_refund_events');
    if (db.all<any>('PRAGMA table_info(orders)').some(row => row.name === 'refund_event_context_json')) {
      db.run('ALTER TABLE orders DROP COLUMN refund_event_context_json');
    }
    db.run('PRAGMA user_version = 12');
    seed(db);
    prepare(db);
    createRefundAttemptRepo(db).markUnknown('original', 'Network outcome unknown');
    const before = Object.fromEntries(tables.filter(table => table !== 'pos_refund_events')
      .map(table => [table, db.all<any>(`SELECT * FROM ${table}`)]));
    await db.flush();
    const upgraded = await initAndroidDb({ locateFile: null, persistence });
    expect(upgraded.getRawHandle().exec('PRAGMA user_version')[0].values).toEqual([[13]]);
    expect(snapshot(upgraded)).toEqual({ ...before, pos_refund_events: [],
      orders: before.orders.map(row => ({ ...row, refund_event_context_json: null })) });
    applyAndroidSchema(upgraded.getRawHandle());
    applyAndroidSchema(upgraded.getRawHandle());
    await upgraded.flush();
    const reopened = await initAndroidDb({ locateFile: null, persistence });
    expect(snapshot(reopened)).toEqual(snapshot(upgraded));
  });

  it('preserves exact stored event/context bytes on repeated migration and durable reopen', async () => {
    const persistence = new MemoryAndroidPersistence();
    const db = await initAndroidDb({ locateFile: null, persistence });
    seed(db); insertEvent(db);
    db.run('UPDATE orders SET refund_event_context_json = ?', ['{ "serverUrl": "https://server.test", "original": true }']);
    const before = snapshot(db);
    applyAndroidSchema(db.getRawHandle());
    applyAndroidSchema(db.getRawHandle());
    expect(snapshot(db)).toEqual(before);
    await db.flush();
    const reopened = await initAndroidDb({ locateFile: null, persistence });
    expect(snapshot(reopened)).toEqual(before);
    expect(() => insertEvent(reopened)).toThrow(/UNIQUE/);
  });

  it.each([0, -1, 1.5, null, 'invalid'])('rejects invalid stored minor amount %s without inserting a row', async delta => {
    const db = await initAndroidDb({ locateFile: null, persistence: new MemoryAndroidPersistence() });
    expect(() => insertEvent(db, delta)).toThrow();
    expect(db.all('SELECT * FROM pos_refund_events')).toEqual([]);
    insertEvent(db, 1);
    expect(db.get('SELECT delta_amount_minor,typeof(delta_amount_minor) AS storage_type FROM pos_refund_events'))
      .toEqual({ delta_amount_minor: 1, storage_type: 'integer' });
    await db.flush();
  });

  it('clears terminal journal/event rows with salon data but preserves device identity durably', async () => {
    const persistence = new MemoryAndroidPersistence();
    const db = await initAndroidDb({ locateFile: null, persistence });
    seed(db); prepare(db, 'confirmed'); insertEvent(db);
    createRefundAttemptRepo(db).confirmAndApply('confirmed', '{ "success": true }', () => {});
    const identity = db.all('SELECT * FROM pos_device_identity');
    db.clearSalonData();
    for (const table of tables.filter(table => table !== 'pos_device_identity')) expect(db.all(`SELECT * FROM ${table}`)).toEqual([]);
    expect(db.all('SELECT * FROM pos_device_identity')).toEqual(identity);
    await db.flush();
    const reopened = await initAndroidDb({ locateFile: null, persistence });
    expect(snapshot(reopened)).toEqual(snapshot(db));
  });

  it.each(['PREPARED', 'UNKNOWN'] as const)('%s blocks every salon deletion including existing event rows', async status => {
    const persistence = new MemoryAndroidPersistence();
    const db = await initAndroidDb({ locateFile: null, persistence });
    seed(db); insertEvent(db); prepare(db);
    if (status === 'UNKNOWN') createRefundAttemptRepo(db).markUnknown('original', 'Outcome unknown');
    const before = snapshot(db);
    expect(() => db.clearSalonData()).toThrow('ANDROID_REFUND_ATTEMPT_UNRESOLVED');
    expect(snapshot(db)).toEqual(before);
    await db.flush();
    const reopened = await initAndroidDb({ locateFile: null, persistence });
    expect(snapshot(reopened)).toEqual(before);
  });
});
