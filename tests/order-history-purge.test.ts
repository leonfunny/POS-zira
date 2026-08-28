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
  CREATE TABLE fiscal_attempts (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT);
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

  it('deletes synced orders from earlier days with their child rows, keeps today', async () => {
    insertOrder('a');
    insertOrder('b', { created_at: OLD_ISO });
    insertOrder('today', { created_at: TODAY });
    db.run("INSERT INTO fiscal_attempts VALUES ('fa1','a','SUCCESS_CONFIRMED',NULL)");
    db.run("INSERT INTO print_attempts VALUES ('pa1','a')");
    db.run("INSERT INTO receipt_print_outbox VALUES ('job1','a','COMPLETED')");
    db.run("INSERT INTO pos_billiard_handoffs VALUES ('co1','a')");
    db.run("INSERT INTO fiscal_receipt_sync_queue VALUES ('q1','a','SYNCED')");
    db.run("INSERT INTO pos_event_outbox VALUES ('e1','a','acked')");
    db.run("INSERT INTO local_sync_log VALUES ('l1','order','a','synced')");

    const result = await purgeLocalOrderHistoryBefore(db, CUTOFF);

    expect(result).toEqual({ purged: 2, remaining: 0, kept: 0, cutoff: CUTOFF });
    expect(ids()).toEqual(['today']);
    for (const t of ['order_items', 'fiscal_attempts', 'print_attempts', 'receipt_print_outbox', 'pos_billiard_handoffs', 'fiscal_receipt_sync_queue', 'pos_event_outbox', 'local_sync_log']) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n, t).toBe(t === 'order_items' ? 1 : 0);
    }
    expect(db.markDirty).toHaveBeenCalled();
  });

  it('keeps unsynced orders and orders without backend id', async () => {
    insertOrder('unsynced', { synced: 0, backend_id: null });
    insertOrder('inflight', { synced: 2, backend_id: 'be-inflight' }); // backend id known but push not confirmed
    insertOrder('nobackend', { synced: 1, backend_id: '' });
    insertOrder('ok');

    const result = await purgeLocalOrderHistoryBefore(db, CUTOFF);

    expect(result).toEqual({ purged: 1, remaining: 0, kept: 3, cutoff: CUTOFF });
    expect(ids()).toEqual(['inflight', 'nobackend', 'unsynced']);
  });

  it('keeps orders whose shift is still open', async () => {
    db.run("INSERT INTO shifts VALUES ('open', NULL)");
    db.run("INSERT INTO shifts VALUES ('closed', '2026-08-20 22:00:00')");
    insertOrder('in-open', { shift_id: 'open' });
    insertOrder('in-closed', { shift_id: 'closed' });
    insertOrder('shift-missing', { shift_id: 'gone' });

    await purgeLocalOrderHistoryBefore(db, CUTOFF);

    expect(ids()).toEqual(['in-open']);
  });

  it('keeps orders with pending work: fiscal unknown, sync queue, event outbox, print outbox, sync log', async () => {
    insertOrder('fiscal-unknown');
    db.run("INSERT INTO fiscal_attempts VALUES ('fa','fiscal-unknown','UNKNOWN_NEEDS_RECONCILIATION',NULL)");
    insertOrder('fiscal-queue');
    db.run("INSERT INTO fiscal_receipt_sync_queue VALUES ('q','fiscal-queue','PENDING')");
    insertOrder('event-pending');
    db.run("INSERT INTO pos_event_outbox VALUES ('e','event-pending','pending')");
    insertOrder('print-inflight');
    db.run("INSERT INTO receipt_print_outbox VALUES ('j','print-inflight','REMOTE_ACCEPTED')");
    insertOrder('log-pending');
    db.run("INSERT INTO local_sync_log VALUES ('l','order','log-pending','pending')");
    insertOrder('log-rejected-mirror'); // rejected mirror entries are not a keep reason
    db.run("INSERT INTO local_sync_log VALUES ('l2','order','log-rejected-mirror','rejected')");
    insertOrder('clean');

    const result = await purgeLocalOrderHistoryBefore(db, CUTOFF);

    expect(result.purged).toBe(2);
    expect(result.kept).toBe(5);
    expect(ids()).toEqual(['event-pending', 'fiscal-queue', 'fiscal-unknown', 'log-pending', 'print-inflight']);
  });

  it('stale fiscal UNKNOWN attempts stop blocking once older than the threshold', async () => {
    insertOrder('old-unknown');
    db.run("INSERT INTO fiscal_attempts VALUES ('fa1','old-unknown','UNKNOWN_NEEDS_RECONCILIATION','2026-06-20 10:00:00')");
    insertOrder('fresh-unknown');
    db.run("INSERT INTO fiscal_attempts VALUES ('fa2','fresh-unknown','UNKNOWN_NEEDS_RECONCILIATION','2026-08-26 10:00:00')");

    await purgeLocalOrderHistoryBefore(db, CUTOFF, { staleFiscalUnknownBeforeIso: '2026-08-25T00:00:00.000Z' });

    expect(ids()).toEqual(['fresh-unknown']);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM fiscal_attempts')?.n).toBe(1);
  });

  it('purges shelved never-synced orders older than the threshold only after exporting them', async () => {
    insertOrder('shelved-old', { synced: -1, backend_id: null, created_at: '2026-08-04 12:00:00' });
    insertOrder('shelved-recent', { synced: -1, backend_id: null, created_at: '2026-08-25 12:00:00' });
    const exported: any[] = [];

    const withoutExportDir = await purgeLocalOrderHistoryBefore(db, CUTOFF);
    expect(withoutExportDir.purged).toBe(0); // option absent → shelved orders are never touched

    const result = await purgeLocalOrderHistoryBefore(db, CUTOFF, {
      unsyncedOlderThanIso: '2026-08-20T00:00:00.000Z',
      exportUnsynced: (rows) => { exported.push(...rows); },
    });

    expect(result.purged).toBe(1);
    expect(ids()).toEqual(['shelved-recent']);
    expect(exported).toHaveLength(1);
    expect(exported[0].order.id).toBe('shelved-old');
    expect(exported[0].items.map((i: any) => i.id)).toEqual(['it-shelved-old']);
  });

  it('keeps shelved orders when the exporter fails', async () => {
    insertOrder('shelved-old', { synced: -1, backend_id: null, created_at: '2026-08-04 12:00:00' });
    await expect(purgeLocalOrderHistoryBefore(db, CUTOFF, {
      unsyncedOlderThanIso: '2026-08-20T00:00:00.000Z',
      exportUnsynced: () => { throw new Error('disk full'); },
    })).rejects.toThrow('disk full');
    expect(ids()).toEqual(['shelved-old']);
  });

  it('is a no-op without older rows', async () => {
    insertOrder('today', { created_at: TODAY });
    expect(await purgeLocalOrderHistoryBefore(db, CUTOFF)).toEqual({ purged: 0, remaining: 0, kept: 0, cutoff: CUTOFF });
    expect(db.markDirty).not.toHaveBeenCalled();
  });

  it('deletes in batches, yields between them and caps per run, leaving the rest for the next run', async () => {
    for (let i = 0; i < 7; i += 1) insertOrder(`o${i}`);
    insertOrder('unsynced', { synced: 0, backend_id: null });
    const yields: number[] = [];
    const yieldBetweenBatches = async () => { yields.push(ids().length); };

    const first = await purgeLocalOrderHistoryBefore(db, CUTOFF, { batchSize: 2, maxPerRun: 5, yieldBetweenBatches });

    expect(first).toEqual({ purged: 5, remaining: 2, kept: 1, cutoff: CUTOFF });
    // yielded after batch 1 (6 left) and batch 2 (4 left); not after the last batch
    expect(yields).toEqual([6, 4]);
    expect(ids()).toHaveLength(3);

    const second = await purgeLocalOrderHistoryBefore(db, CUTOFF, { batchSize: 2, maxPerRun: 5, yieldBetweenBatches });
    expect(second).toEqual({ purged: 2, remaining: 0, kept: 1, cutoff: CUTOFF });
    expect(ids()).toEqual(['unsynced']);
  });

  it('vacuums only after the final batch so the exported file actually shrinks', async () => {
    const ran: string[] = [];
    const origRun = db.run;
    db.run = (sql, params) => { ran.push(sql); origRun(sql, params); };
    for (let i = 0; i < 3; i += 1) insertOrder(`o${i}`);
    ran.length = 0;

    await purgeLocalOrderHistoryBefore(db, CUTOFF, { batchSize: 2, maxPerRun: 2, yieldBetweenBatches: async () => {} });
    expect(ran.filter((s) => s === 'VACUUM')).toHaveLength(0);

    await purgeLocalOrderHistoryBefore(db, CUTOFF, { batchSize: 2, maxPerRun: 2, yieldBetweenBatches: async () => {} });
    expect(ran.filter((s) => s === 'VACUUM')).toHaveLength(1);
    expect(db.get<{ n: number }>('SELECT freelist_count AS n FROM pragma_freelist_count')?.n).toBe(0);
  });

  it('startOfLocalDayIso returns local midnight', () => {
    const iso = startOfLocalDayIso(new Date(2026, 7, 27, 15, 30));
    const back = new Date(iso);
    expect(back.getHours()).toBe(0);
    expect(back.getDate()).toBe(27);
  });
});
