import { beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import {
  purgeLocalOrderHistoryBefore,
  startOfLocalDayIso,
  type PurgeDatabase,
} from '../src/main/database/repos/order-history-purge';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SCHEMA = `
  CREATE TABLE orders (id TEXT PRIMARY KEY, order_number TEXT, shift_id TEXT, synced INTEGER DEFAULT 0, backend_id TEXT, created_at TEXT);
  CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL);
  CREATE TABLE shifts (id TEXT PRIMARY KEY, closed_at TEXT);
  CREATE TABLE fiscal_attempts (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE print_attempts (id TEXT PRIMARY KEY, order_id TEXT NOT NULL);
  CREATE TABLE receipt_print_outbox (job_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE pos_billiard_handoffs (checkout_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE);
  CREATE TABLE fiscal_receipt_sync_queue (id TEXT PRIMARY KEY, local_order_id TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE pos_event_outbox (id TEXT PRIMARY KEY, local_order_id TEXT, status TEXT NOT NULL);
  CREATE TABLE local_sync_log (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, status TEXT NOT NULL);
`;

function wrap(db: SqlJsDatabase): PurgeDatabase & { markDirty: ReturnType<typeof vi.fn> } {
  return {
    markDirty: vi.fn(),
    run: (sql, params = []) => { db.run(sql, params); },
    get: (sql, params = []) => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const row = stmt.step() ? (stmt.getAsObject() as any) : null;
      stmt.free();
      return row;
    },
    all: (sql, params = []) => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    transaction: (fn) => { db.run('BEGIN'); try { const r = fn(); db.run('COMMIT'); return r; } catch (e) { db.run('ROLLBACK'); throw e; } },
  };
}

const CUTOFF = '2026-08-27T00:00:00.000Z';
const OLD = '2026-08-20 10:00:00';      // datetime('now') shape
const OLD_ISO = '2026-08-25T18:30:00.000Z';
const TODAY = '2026-08-27 09:00:00';

describe('purgeLocalOrderHistoryBefore', () => {
  let raw: SqlJsDatabase;
  let db: ReturnType<typeof wrap>;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    raw = new SQL.Database();
    raw.run(SCHEMA);
    db = wrap(raw);
  });

  const insertOrder = (id: string, o: Partial<{ shift_id: string | null; synced: number; backend_id: string | null; created_at: string }> = {}) => {
    db.run('INSERT INTO orders (id, order_number, shift_id, synced, backend_id, created_at) VALUES (?,?,?,?,?,?)',
      [id, `ZAM-${id}`, o.shift_id ?? null, o.synced ?? 1, o.backend_id === undefined ? `be-${id}` : o.backend_id, o.created_at ?? OLD]);
    db.run('INSERT INTO order_items (id, order_id) VALUES (?,?)', [`it-${id}`, id]);
  };
  const ids = () => db.all<{ id: string }>('SELECT id FROM orders ORDER BY id').map((r) => r.id);

  it('deletes synced orders from earlier days with their child rows, keeps today', () => {
    insertOrder('a');
    insertOrder('b', { created_at: OLD_ISO });
    insertOrder('today', { created_at: TODAY });
    db.run("INSERT INTO fiscal_attempts VALUES ('fa1','a','SUCCESS_CONFIRMED')");
    db.run("INSERT INTO print_attempts VALUES ('pa1','a')");
    db.run("INSERT INTO receipt_print_outbox VALUES ('job1','a','COMPLETED')");
    db.run("INSERT INTO pos_billiard_handoffs VALUES ('co1','a')");
    db.run("INSERT INTO fiscal_receipt_sync_queue VALUES ('q1','a','SYNCED')");
    db.run("INSERT INTO pos_event_outbox VALUES ('e1','a','acked')");
    db.run("INSERT INTO local_sync_log VALUES ('l1','order','a','synced')");

    const result = purgeLocalOrderHistoryBefore(db, CUTOFF);

    expect(result).toEqual({ purged: 2, kept: 0, cutoff: CUTOFF });
    expect(ids()).toEqual(['today']);
    for (const t of ['order_items', 'fiscal_attempts', 'print_attempts', 'receipt_print_outbox', 'pos_billiard_handoffs', 'fiscal_receipt_sync_queue', 'pos_event_outbox', 'local_sync_log']) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n, t).toBe(t === 'order_items' ? 1 : 0);
    }
    expect(db.markDirty).toHaveBeenCalled();
  });

  it('keeps unsynced orders and orders without backend id', () => {
    insertOrder('unsynced', { synced: 0, backend_id: null });
    insertOrder('nobackend', { synced: 1, backend_id: '' });
    insertOrder('ok');

    const result = purgeLocalOrderHistoryBefore(db, CUTOFF);

    expect(result).toEqual({ purged: 1, kept: 2, cutoff: CUTOFF });
    expect(ids()).toEqual(['nobackend', 'unsynced']);
  });

  it('keeps orders whose shift is still open', () => {
    db.run("INSERT INTO shifts VALUES ('open', NULL)");
    db.run("INSERT INTO shifts VALUES ('closed', '2026-08-20 22:00:00')");
    insertOrder('in-open', { shift_id: 'open' });
    insertOrder('in-closed', { shift_id: 'closed' });
    insertOrder('shift-missing', { shift_id: 'gone' });

    purgeLocalOrderHistoryBefore(db, CUTOFF);

    expect(ids()).toEqual(['in-open']);
  });

  it('keeps orders with pending work: fiscal unknown, sync queue, event outbox, print outbox, sync log', () => {
    insertOrder('fiscal-unknown');
    db.run("INSERT INTO fiscal_attempts VALUES ('fa','fiscal-unknown','UNKNOWN_NEEDS_RECONCILIATION')");
    insertOrder('fiscal-queue');
    db.run("INSERT INTO fiscal_receipt_sync_queue VALUES ('q','fiscal-queue','PENDING')");
    insertOrder('event-pending');
    db.run("INSERT INTO pos_event_outbox VALUES ('e','event-pending','pending')");
    insertOrder('print-inflight');
    db.run("INSERT INTO receipt_print_outbox VALUES ('j','print-inflight','REMOTE_ACCEPTED')");
    insertOrder('log-pending');
    db.run("INSERT INTO local_sync_log VALUES ('l','order','log-pending','pending')");
    insertOrder('clean');

    const result = purgeLocalOrderHistoryBefore(db, CUTOFF);

    expect(result.purged).toBe(1);
    expect(result.kept).toBe(5);
    expect(ids()).toEqual(['event-pending', 'fiscal-queue', 'fiscal-unknown', 'log-pending', 'print-inflight']);
  });

  it('is a no-op without older rows', () => {
    insertOrder('today', { created_at: TODAY });
    expect(purgeLocalOrderHistoryBefore(db, CUTOFF)).toEqual({ purged: 0, kept: 0, cutoff: CUTOFF });
    expect(db.markDirty).not.toHaveBeenCalled();
  });

  it('startOfLocalDayIso returns local midnight', () => {
    const iso = startOfLocalDayIso(new Date(2026, 7, 27, 15, 30));
    const back = new Date(iso);
    expect(back.getHours()).toBe(0);
    expect(back.getDate()).toBe(27);
  });
});
