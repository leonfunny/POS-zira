import { describe, expect, it } from 'vitest';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { applyAndroidSchema } from '../src/renderer/android-pos/shim/db/schema';
import { createRefundAttemptRepo } from '../src/renderer/android-pos/shim/db/refund-attempt-repo';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

describe('Android v12 report snapshot migration', () => {
  it('adds a nullable report column without reconstructing old closed reports or changing journal bytes', async () => {
    const persistence = new MemoryAndroidPersistence();
    const db = await initAndroidDb({ locateFile: null, persistence });
    db.run('ALTER TABLE shifts DROP COLUMN close_report_json');
    db.run('PRAGMA user_version = 11');
    db.run(`INSERT INTO shifts (id,opening_cash,closing_cash,closed_at,backend_binding_json)
      VALUES ('closed',100,125,'2026-09-08 20:00:00','{ "original": true }'), ('open',0,NULL,NULL,NULL)`);
    const repo = createRefundAttemptRepo(db);
    repo.prepare({ request_id: 'original', scope_key: '["server","salon","owner"]', local_order_id: 'order',
      backend_order_id: 'server-order', shift_id: 'open', payload_json: '{ "amount": 1.00 }', expected_json: '{ "unchanged": true }' });
    repo.markUnknown('original');
    const shifts = db.all<any>('SELECT * FROM shifts ORDER BY id');
    const attempts = db.all('SELECT * FROM pos_refund_attempts');
    await db.flush();
    const upgraded = await initAndroidDb({ locateFile: null, persistence });
    expect(upgraded.all('SELECT * FROM shifts ORDER BY id')).toEqual(shifts.map(row => ({ ...row, close_report_json: null })));
    expect(upgraded.all('SELECT * FROM pos_refund_attempts')).toEqual(attempts);
    expect(upgraded.getRawHandle().exec('PRAGMA user_version')[0].values).toEqual([[13]]);
    expect(upgraded.all<any>('PRAGMA table_info(shifts)').find(row => row.name === 'close_report_json'))
      .toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    applyAndroidSchema(upgraded.getRawHandle());
    applyAndroidSchema(upgraded.getRawHandle());
    expect(upgraded.all('SELECT * FROM pos_refund_attempts')).toEqual(attempts);
    expect(upgraded.all('SELECT * FROM shifts ORDER BY id')).toEqual(shifts.map(row => ({ ...row, close_report_json: null })));
    await upgraded.flush();
  });
});
