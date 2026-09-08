import { describe, expect, it } from 'vitest';
import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { applyAndroidSchema } from '../src/renderer/android-pos/shim/db/schema';
import { createRefundAttemptRepo } from '../src/renderer/android-pos/shim/db/refund-attempt-repo';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const columns = (db: AndroidDatabase) => db.all<any>('PRAGMA table_info(shifts)');
async function v10Fixture() {
  const persistence = new MemoryAndroidPersistence();
  const db = await initAndroidDb({ locateFile: null, persistence });
  if (columns(db).some(row => row.name === 'backend_binding_json')) {
    db.run('ALTER TABLE shifts DROP COLUMN backend_binding_json');
  }
  db.run('PRAGMA user_version = 10');
  db.run(`INSERT INTO shifts (id,backend_id,staff_id,staff_name,opening_cash,closing_cash,opened_at,closed_at) VALUES
    ('open-linked','legacy-server-id','staff','Staff',1234,NULL,'2026-09-08T08:00:00Z',NULL),
    ('closed-linked','older-server-id','staff','Staff',4321,4567,'2026-09-07T08:00:00Z','2026-09-07T17:00:00Z'),
    ('unlinked',NULL,'staff','Staff',0,NULL,'2026-09-08T09:00:00Z',NULL)`);
  db.run(`INSERT INTO orders (id,shift_id,status,synced,total,refund_amount,refund_lines,sync_payload_json)
    VALUES ('paid','open-linked','PARTIAL_REFUND',1,2000,500,'[{ "old": true }]','{ "frozen": true }')`);
  return { db, persistence };
}

describe('Android v11 shift binding evidence migration', () => {
  it('creates a nullable TEXT binding column with no inferred/default evidence on fresh databases', async () => {
    const db = await initAndroidDb({ locateFile: null, persistence: new MemoryAndroidPersistence() });
    expect(columns(db).find(row => row.name === 'backend_binding_json')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    expect(db.getRawHandle().exec('PRAGMA user_version')[0].values).toEqual([[13]]);
    db.run("INSERT INTO shifts (id,backend_id) VALUES ('new','server-id')");
    expect(db.get('SELECT backend_binding_json FROM shifts')).toEqual({ backend_binding_json: null });
    await db.flush();
  });

  it('upgrades v10 open/closed/unlinked shifts and money without backfilling old backend IDs', async () => {
    const { db, persistence } = await v10Fixture();
    const before = db.all<any>('SELECT * FROM shifts ORDER BY id');
    const orders = db.all('SELECT * FROM orders');
    await db.flush();
    const upgraded = await initAndroidDb({ locateFile: null, persistence });
    expect(upgraded.getRawHandle().exec('PRAGMA user_version')[0].values).toEqual([[13]]);
    expect(upgraded.all('SELECT * FROM shifts ORDER BY id')).toEqual(before.map(row => ({ ...row, backend_binding_json: null })));
    expect(upgraded.all('SELECT * FROM orders')).toEqual(orders);
    await upgraded.flush();
  });

  it.each(['PREPARED', 'UNKNOWN'] as const)('preserves every %s journal field and exact original JSON bytes across upgrade/reopen', async status => {
    const { db, persistence } = await v10Fixture();
    const repo = createRefundAttemptRepo(db);
    repo.prepare({ request_id: 'original-request', scope_key: '["https://legacy.test","salon","owner"]',
      local_order_id: 'paid', backend_order_id: 'original-server-order', shift_id: 'open-linked',
      payload_json: '{ "refundRequestId": "original-request", "shiftId": "legacy-server-id", "amount": 5.00 }',
      expected_json: '{ "authority": { "alreadyRefundedGrosze": 500 }, "inputJson": "original bytes" }' });
    if (status === 'UNKNOWN') repo.markUnknown('original-request', 'HTTP outcome unknown');
    const journal = db.all('SELECT * FROM pos_refund_attempts');
    await db.flush();
    const upgraded = await initAndroidDb({ locateFile: null, persistence });
    expect(upgraded.all('SELECT * FROM pos_refund_attempts')).toEqual(journal);
    expect(upgraded.get("SELECT backend_id,backend_binding_json FROM shifts WHERE id='open-linked'"))
      .toEqual({ backend_id: 'legacy-server-id', backend_binding_json: null });
    expect(() => upgraded.clearSalonData()).toThrow('ANDROID_REFUND_ATTEMPT_UNRESOLVED');
    await upgraded.flush();
    const reopened = await initAndroidDb({ locateFile: null, persistence });
    expect(reopened.all('SELECT * FROM pos_refund_attempts')).toEqual(journal);
    expect(reopened.getRawHandle().exec('PRAGMA user_version')[0].values).toEqual([[13]]);
  });

  it('repeated application and reopening preserve binding bytes already written by the owning transport', async () => {
    const persistence = new MemoryAndroidPersistence();
    const db = await initAndroidDb({ locateFile: null, persistence });
    const binding = '{ "serverUrl":"https://server.test", "salonId":"salon", "machineId":"device", "closedAt":null }';
    db.run('INSERT INTO shifts (id,backend_id,backend_binding_json) VALUES (?,?,?)', ['bound', 'server-shift', binding]);
    const before = db.all('SELECT * FROM shifts');
    applyAndroidSchema(db.getRawHandle());
    applyAndroidSchema(db.getRawHandle());
    expect(db.all('SELECT * FROM shifts')).toEqual(before);
    expect(columns(db).filter(row => row.name === 'backend_binding_json')).toHaveLength(1);
    await db.flush();
    const reopened = await initAndroidDb({ locateFile: null, persistence });
    expect(reopened.all('SELECT * FROM shifts')).toEqual(before);
  });
});
