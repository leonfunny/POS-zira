import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\test' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../src/main/logger', () => ({
  default: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { database } from '../src/main/database/database';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
let db: SqlJsDatabase;
let saveSyncSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function createClearSchema(target: SqlJsDatabase): void {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/main/database/database.ts'),
    'utf8',
  );
  const block = source.match(/const\s+tablesToClear\s*=\s*\[([\s\S]+?)\];/)?.[1] ?? '';
  const tables = Array.from(block.matchAll(/'([a-z_]+)'/g), (match) => match[1]);
  for (const table of tables) {
    if (table === 'receipt_print_outbox') {
      target.run(`
        CREATE TABLE receipt_print_outbox (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL,
          salon_id TEXT NOT NULL,
          status TEXT NOT NULL,
          failure_class TEXT,
          next_attempt_at TEXT,
          last_error TEXT,
          updated_at TEXT,
          printer_id TEXT,
          remote_job_id TEXT,
          payload_json TEXT
        )
      `);
    } else {
      target.run(`CREATE TABLE ${table} (id TEXT)`);
    }
  }
  target.run('CREATE TABLE sync_metadata (id TEXT)');
}

beforeEach(() => {
  db = new SQL.Database();
  createClearSchema(db);
  (database as any).db = db;
  (database as any).saving = false;
  saveSyncSpy = vi.spyOn(database, 'saveSync').mockReturnValue({
    success: true,
    dbPath: 'memory',
  });
});

afterEach(() => {
  saveSyncSpy.mockRestore();
  (database as any).db = null;
  db.close();
});

function insertReceipt(status: string): void {
  db.run(
    `INSERT INTO receipt_print_outbox (
       job_id, salon_id, status, updated_at, printer_id, remote_job_id,
       payload_json
     ) VALUES ('job-old', 'salon-old', ?, '2026-07-29T10:00:00.000Z',
       'printer-old', 'remote-old', '{"customer":"old tenant"}')`,
    [status],
  );
  db.run("INSERT INTO orders (id) VALUES ('order-old')");
}

describe('database receipt outbox tenant exit', () => {
  it('blocks an unarchived clear when review evidence would be destroyed', () => {
    insertReceipt('NEEDS_REVIEW');

    expect(() => database.clearSalonData('salon-old')).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_PRINT_OUTCOME_UNCERTAIN' }),
    );
    expect(database.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM receipt_print_outbox',
    )?.count).toBe(1);
    expect(database.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM orders',
    )?.count).toBe(1);
  });

  it('removes old-tenant live payload only after archived-review allowance', () => {
    insertReceipt('NEEDS_REVIEW');

    database.clearSalonData('salon-old', { archivedReviewEvidence: true });

    expect(database.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM receipt_print_outbox',
    )?.count).toBe(0);
    expect(database.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM orders',
    )?.count).toBe(0);
    expect(saveSyncSpy).toHaveBeenCalledOnce();
  });

  it('retries the disk barrier after an in-memory cancellation save fails', () => {
    insertReceipt('PENDING');
    saveSyncSpy
      .mockReturnValueOnce({ success: false, error: 'disk busy' })
      .mockReturnValueOnce({ success: true, dbPath: 'memory' });

    expect(() => database.prepareReceiptPrintOutboxForTenantExit(
      'salon-old',
      'logout',
      { allowNeedsReview: true },
    )).toThrow(/disk busy/);
    expect(database.get<{ status: string }>(
      "SELECT status FROM receipt_print_outbox WHERE job_id = 'job-old'",
    )?.status).toBe('CANCELLED');

    expect(() => database.prepareReceiptPrintOutboxForTenantExit(
      'salon-old',
      'logout retry',
      { allowNeedsReview: true },
    )).not.toThrow();
    expect(saveSyncSpy).toHaveBeenCalledTimes(2);
  });

  it('does not cancel or enter a transaction while an async writer is active', () => {
    insertReceipt('PENDING');
    (database as any).saving = true;
    const transactionSpy = vi.spyOn(database, 'transaction');

    expect(() => database.prepareReceiptPrintOutboxForTenantExit(
      'salon-old',
      'logout',
      { allowNeedsReview: true },
    )).toThrowError(expect.objectContaining({
      code: 'DATABASE_SAVE_IN_PROGRESS',
    }));
    expect(database.get<{ status: string }>(
      "SELECT status FROM receipt_print_outbox WHERE job_id = 'job-old'",
    )?.status).toBe('PENDING');
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(saveSyncSpy).not.toHaveBeenCalled();

    transactionSpy.mockRestore();
    (database as any).saving = false;
  });

  it('does not clear any tenant table while an async writer is active', () => {
    insertReceipt('PENDING');
    (database as any).saving = true;
    const transactionSpy = vi.spyOn(database, 'transaction');

    expect(() => database.clearSalonData(
      'salon-old',
      { archivedReviewEvidence: true },
    )).toThrowError(expect.objectContaining({
      code: 'DATABASE_SAVE_IN_PROGRESS',
    }));
    expect(database.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM receipt_print_outbox',
    )?.count).toBe(1);
    expect(database.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM orders',
    )?.count).toBe(1);
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(saveSyncSpy).not.toHaveBeenCalled();

    transactionSpy.mockRestore();
    (database as any).saving = false;
  });
});
