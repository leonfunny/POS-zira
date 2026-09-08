import { describe, expect, it, vi } from 'vitest';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { createRefundAttemptRepo, type PrepareRefundAttempt } from '../src/renderer/android-pos/shim/db/refund-attempt-repo';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

function attempt(patch: Partial<PrepareRefundAttempt> = {}): PrepareRefundAttempt {
  return { request_id: 'request-1', scope_key: 'https://server.test|salon-1|user-1', local_order_id: 'local-1',
    backend_order_id: 'server-1', shift_id: 'shift-1',
    payload_json: '{"requestId":"request-1","items":[{"orderItemId":"line-1","quantity":1}]}',
    expected_json: '{"originalTotal":2000,"priorRefund":0,"requestAmount":1000}', ...patch };
}
async function setup() {
  const persistence = new MemoryAndroidPersistence();
  const db = await initAndroidDb({ locateFile: null, persistence });
  return { db, persistence, repo: createRefundAttemptRepo(db) };
}

describe('Android durable refund attempts', () => {
  it('prepares immutable evidence once without flushing automatically', async () => {
    const { db, persistence, repo } = await setup();
    const flush = vi.spyOn(db, 'flush');
    expect(repo.prepare(attempt())).toMatchObject({ ...attempt(), status: 'PREPARED', response_json: null, error: null });
    expect(repo.prepare(attempt())).toEqual(repo.get('request-1'));
    expect(db.all('SELECT * FROM pos_refund_attempts')).toHaveLength(1);
    expect(repo.findUnresolved('local-1')?.request_id).toBe('request-1');
    expect(flush).not.toHaveBeenCalled(); expect(persistence.image).toBeNull();
    await db.flush();
  });

  it.each([
    { scope_key: 'different' }, { local_order_id: 'different' }, { backend_order_id: 'different' },
    { shift_id: null }, { payload_json: '{"different":true}' }, { expected_json: '{"different":true}' },
  ])('rejects immutable field mismatch %j', async patch => {
    const { db, repo } = await setup(); repo.prepare(attempt());
    expect(() => repo.prepare(attempt(patch))).toThrow('ANDROID_REFUND_ATTEMPT_IMMUTABLE_MISMATCH');
    expect(repo.get('request-1')).toMatchObject(attempt()); await db.flush();
  });

  it('blocks another request under another user or local alias until terminal', async () => {
    const { db, repo } = await setup(); repo.prepare(attempt());
    expect(() => repo.prepare(attempt({ request_id: 'request-2', scope_key: 'another-user' }))).toThrow('ANDROID_REFUND_ATTEMPT_UNRESOLVED');
    repo.markUnknown('request-1', 'timeout');
    expect(() => createRefundAttemptRepo(db).prepare(attempt({ request_id: 'request-2', local_order_id: 'alias' })))
      .toThrow('ANDROID_REFUND_ATTEMPT_UNRESOLVED');
    repo.markRejected('request-1', 'authoritative rejection', '{"rejected":true}');
    expect(repo.findUnresolved('local-1')).toBeNull();
    expect(repo.prepare(attempt({ request_id: 'request-2' })).status).toBe('PREPARED'); await db.flush();
  });

  it('applies the confirmed projection once and retains immutable response bytes', async () => {
    const { db, repo } = await setup();
    db.run("INSERT INTO orders (id, total, refund_amount) VALUES ('local-1', 2000, 0)");
    repo.prepare(attempt()); repo.markUnknown('request-1', 'timeout');
    const apply = vi.fn(() => db.run("UPDATE orders SET refund_amount = refund_amount + 1000 WHERE id = 'local-1'"));
    expect(repo.confirmAndApply('request-1', '{"refundAmount":10}', apply)).toEqual({ applied: true });
    expect(repo.confirmAndApply('request-1', '{"refundAmount":10}', apply)).toEqual({ applied: false });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(db.get('SELECT refund_amount FROM orders')).toEqual({ refund_amount: 1000 });
    expect(() => repo.confirmAndApply('request-1', '{"refundAmount":20}', apply)).toThrow('ANDROID_REFUND_ATTEMPT_RESPONSE_MISMATCH');
    expect(() => repo.markUnknown('request-1')).toThrow('ANDROID_REFUND_ATTEMPT_INVALID_TRANSITION');
    expect(() => repo.markRejected('request-1')).toThrow('ANDROID_REFUND_ATTEMPT_INVALID_TRANSITION');
    await db.flush();
  });

  it('rolls back financial projection and journal when callback throws', async () => {
    const { db, repo } = await setup();
    db.run("INSERT INTO orders (id, total, refund_amount) VALUES ('local-1', 2000, 0)"); repo.prepare(attempt());
    expect(() => repo.confirmAndApply('request-1', '{"ok":true}', () => {
      db.run("UPDATE orders SET refund_amount = 1000 WHERE id = 'local-1'"); throw new Error('projection failed');
    })).toThrow('projection failed');
    expect(db.get('SELECT refund_amount FROM orders')).toEqual({ refund_amount: 0 });
    expect(repo.get('request-1')).toMatchObject({ status: 'PREPARED', response_json: null }); await db.flush();
  });

  it('preserves prepared evidence across a failed confirmation flush and applies once after reload', async () => {
    const { db, repo, persistence } = await setup();
    db.run("INSERT INTO orders (id, total, refund_amount) VALUES ('local-1', 2000, 0)");
    repo.prepare(attempt()); await db.flush();
    persistence.failSave = true;
    repo.confirmAndApply('request-1', '{"ok":true}', () => db.run("UPDATE orders SET refund_amount = 1000 WHERE id = 'local-1'"));
    await expect(db.flush()).rejects.toThrow('Test storage write failed');
    const restored = await initAndroidDb({ locateFile: null, persistence });
    const recovered = createRefundAttemptRepo(restored);
    expect(recovered.get('request-1')?.status).toBe('PREPARED');
    expect(restored.get('SELECT refund_amount FROM orders')).toEqual({ refund_amount: 0 });
    persistence.failSave = false;
    expect(recovered.confirmAndApply('request-1', '{"ok":true}', () => restored.run("UPDATE orders SET refund_amount = 1000 WHERE id = 'local-1'")))
      .toEqual({ applied: true });
    await restored.flush();
    const reopened = await initAndroidDb({ locateFile: null, persistence });
    expect(createRefundAttemptRepo(reopened).get('request-1')?.status).toBe('CONFIRMED');
    expect(reopened.get('SELECT refund_amount FROM orders')).toEqual({ refund_amount: 1000 });
  });

  it.each(['PREPARED', 'UNKNOWN'])('refuses tenant clear with %s evidence and preserves all rows', async status => {
    const { db, repo } = await setup();
    db.run("INSERT INTO orders (id, total) VALUES ('local-1', 2000)"); repo.prepare(attempt());
    if (status === 'UNKNOWN') repo.markUnknown('request-1', 'timeout');
    const before = db.all('SELECT * FROM pos_refund_attempts');
    expect(() => db.clearSalonData()).toThrow('ANDROID_REFUND_ATTEMPT_UNRESOLVED');
    expect(db.all('SELECT * FROM pos_refund_attempts')).toEqual(before);
    expect(db.get('SELECT total FROM orders')).toEqual({ total: 2000 }); await db.flush();
  });

  it('clears only terminal journal records together with the old tenant data', async () => {
    const { db, repo } = await setup();
    db.run("INSERT INTO orders (id, total) VALUES ('local-1', 2000)"); repo.prepare(attempt());
    repo.markRejected('request-1', 'denied');
    repo.prepare(attempt({ request_id: 'request-2' })); repo.confirmAndApply('request-2', '{"ok":true}', () => {});
    db.clearSalonData();
    expect(db.all('SELECT * FROM pos_refund_attempts')).toEqual([]);
    expect(db.all('SELECT * FROM orders')).toEqual([]); await db.flush();
  });

  it('upgrades an isolated v8 image additively, preserving paid/pending orders and immutable upload data', async () => {
    const { db, persistence } = await setup();
    db.run('DROP TABLE pos_refund_attempts'); db.run('PRAGMA user_version = 8');
    for (const [id, synced] of [['pending', 0], ['paid', 1]] as const) {
      db.run(`INSERT INTO orders (id, synced, total, refund_amount, refund_lines, sync_payload_json, table_id, covers, order_type)
        VALUES (?, ?, 2000, 500, '[{"line":"old"}]', '{"frozen":true}', 'A', 2, 'dine_in')`, [id, synced]);
      db.run(`INSERT INTO order_items (id, order_id, name, notes, course, total, restaurant_line_id)
        VALUES (?, ?, 'Meal', 'Keep note', 2, 2000, 'proven-origin')`, [`${id}-line`, id]);
    }
    const orders = db.all('SELECT * FROM orders ORDER BY id');
    const items = db.all('SELECT * FROM order_items ORDER BY id'); await db.flush();
    const upgraded = await initAndroidDb({ locateFile: null, persistence });
    expect(upgraded.getRawHandle().exec('PRAGMA user_version')[0].values).toEqual([[13]]);
    expect(upgraded.all('SELECT * FROM orders ORDER BY id')).toEqual(orders);
    expect(upgraded.all('SELECT * FROM order_items ORDER BY id')).toEqual(items);
    expect(upgraded.all('SELECT * FROM pos_refund_attempts')).toEqual([]);
    const repo = createRefundAttemptRepo(upgraded); repo.prepare(attempt()); repo.markUnknown('request-1', 'response lost');
    await upgraded.flush();
    const reopened = await initAndroidDb({ locateFile: null, persistence });
    expect(createRefundAttemptRepo(reopened).get('request-1')).toMatchObject({ ...attempt(), status: 'UNKNOWN', error: 'response lost' });
    expect(reopened.all('SELECT * FROM orders ORDER BY id')).toEqual(orders);
    expect(reopened.all('SELECT * FROM order_items ORDER BY id')).toEqual(items);
    expect(() => reopened.clearSalonData()).toThrow('ANDROID_REFUND_ATTEMPT_UNRESOLVED');
    expect(reopened.getRawHandle().exec('PRAGMA foreign_key_list(pos_refund_attempts)')).toEqual([]);
  });

  it('uses database unique constraints to prevent unresolved duplicate orders even outside the repository', async () => {
    const { db, repo } = await setup(); repo.prepare(attempt());
    const copy = (local: string, backend: string) => db.run(`INSERT INTO pos_refund_attempts (
      request_id, scope_key, local_order_id, backend_order_id, shift_id, payload_json, expected_json, status, created_at, updated_at
    ) SELECT 'different-request', 'other-scope', ?, ?, shift_id, payload_json, expected_json, 'UNKNOWN', created_at, updated_at
      FROM pos_refund_attempts WHERE request_id = 'request-1'`, [local, backend]);
    expect(() => copy('local-1', 'different-server')).toThrow(/UNIQUE constraint failed/);
    expect(() => copy('different-local', 'server-1')).toThrow(/UNIQUE constraint failed/);
    expect(() => db.run("UPDATE pos_refund_attempts SET status = 'INVALID' WHERE request_id = 'request-1'"))
      .toThrow(/CHECK constraint failed/);
    await db.flush();
  });

  it('refuses confirmation after rejection and rejects missing request IDs', async () => {
    const { db, repo } = await setup(); repo.prepare(attempt()); repo.markRejected('request-1');
    const apply = vi.fn();
    expect(() => repo.confirmAndApply('request-1', '{"ok":true}', apply)).toThrow('ANDROID_REFUND_ATTEMPT_INVALID_TRANSITION');
    expect(() => repo.markUnknown('missing')).toThrow('ANDROID_REFUND_ATTEMPT_NOT_FOUND');
    expect(() => repo.markRejected('missing')).toThrow('ANDROID_REFUND_ATTEMPT_NOT_FOUND');
    expect(() => repo.confirmAndApply('missing', '{}', apply)).toThrow('ANDROID_REFUND_ATTEMPT_NOT_FOUND');
    expect(apply).not.toHaveBeenCalled(); await db.flush();
  });

  it('refuses asynchronous projection callbacks before executing them', async () => {
    const { db, repo } = await setup(); repo.prepare(attempt());
    let called = false;
    expect(() => repo.confirmAndApply('request-1', '{}', async () => { called = true; }))
      .toThrow('ANDROID_REFUND_ATTEMPT_ASYNC_CALLBACK');
    expect(called).toBe(false); expect(repo.get('request-1')?.status).toBe('PREPARED'); await db.flush();
  });

  it.each([
    { request_id: '' }, { scope_key: ' ' }, { payload_json: 'not-json' },
    { expected_json: '[]' }, { payload_json: 'null' },
  ])('rejects invalid frozen input %j before inserting evidence', async patch => {
    const { db, repo } = await setup();
    expect(() => repo.prepare(attempt(patch))).toThrow(/ANDROID_REFUND_ATTEMPT_INVALID_/);
    expect(db.all('SELECT * FROM pos_refund_attempts')).toEqual([]);
  });

  it('compares frozen JSON bytes rather than reserializing equivalent objects', async () => {
    const { db, repo } = await setup(); repo.prepare(attempt());
    expect(() => repo.prepare(attempt({ expected_json: '{ "originalTotal":2000,"priorRefund":0,"requestAmount":1000}' })))
      .toThrow('ANDROID_REFUND_ATTEMPT_IMMUTABLE_MISMATCH'); await db.flush();
  });
});
