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
    } else if (table === 'invoice_handoffs') {
      target.run(`
        CREATE TABLE invoice_handoffs (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id TEXT NOT NULL,
          salon_id TEXT NOT NULL,
          tenant_generation INTEGER NOT NULL DEFAULT 0,
          backend_order_id TEXT,
          status TEXT NOT NULL,
          last_request_id TEXT,
          review_kind TEXT,
          review_request_id TEXT
        )
      `);
    } else if (table === 'orders') {
      target.run('CREATE TABLE orders (id TEXT, backend_id TEXT, status TEXT)');
    } else if (table === 'pos_event_outbox') {
      target.run(`
        CREATE TABLE pos_event_outbox (
          event_id TEXT PRIMARY KEY,
          local_order_id TEXT,
          event_type TEXT NOT NULL
        )
      `);
    } else {
      target.run(`CREATE TABLE ${table} (id TEXT)`);
    }
  }
  target.run(`
    CREATE TABLE sync_metadata (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )
  `);
}

beforeEach(() => {
  db = new SQL.Database();
  createClearSchema(db);
  (database as any).db = db;
  (database as any).saving = false;
  (database as any).tenantGeneration = 0;
  (database as any).tenantGenerationReliable = true;
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

function insertInvoiceHandoff(status: string): void {
  db.run(
    `INSERT INTO invoice_handoffs (
       order_id, salon_id, status, last_request_id
     ) VALUES ('invoice-order-old', 'salon-old', ?, 'request-old')`,
    [status],
  );
}

function insertCompletedCorrectedInvoiceHandoff(status: 'REFUNDED' | 'PARTIAL_REFUND' | 'CANCELLED'): void {
  db.run("INSERT INTO orders (id, status) VALUES ('invoice-order-old', ?)", [status]);
  insertInvoiceHandoff('COMPLETED');
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

  it('persists the tenant generation fence and restores it after a restart', () => {
    (database as any).tenantGeneration = 4;

    database.clearSalonData('salon-old', { archivedReviewEvidence: true });

    expect(database.getTenantGeneration()).toBe(5);
    expect(database.get<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = '__tenant_generation'",
    )?.value).toBe('5');

    (database as any).tenantGeneration = 0;
    (database as any).restoreTenantGeneration();
    expect(database.getTenantGeneration()).toBe(5);
  });

  it('adopts one legacy handoff generation when the metadata key is absent', () => {
    db.run(`
      INSERT INTO invoice_handoffs (
        order_id, salon_id, tenant_generation, status, last_request_id
      ) VALUES ('legacy-order', 'salon-old', 7, 'PENDING', NULL)
    `);

    (database as any).restoreTenantGeneration();

    expect(database.getTenantGeneration()).toBe(7);
    expect(database.get<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = '__tenant_generation'",
    )?.value).toBe('7');
    expect(database.isTenantGenerationReliable()).toBe(true);
  });

  it('fails the invoice gateway closed for invalid or mixed generation evidence', () => {
    db.run(`
      INSERT INTO sync_metadata (key, value, updated_at)
      VALUES ('__tenant_generation', 'broken', 'now')
    `);
    (database as any).restoreTenantGeneration();
    expect(database.getTenantGeneration()).toBe(0);
    expect(database.isTenantGenerationReliable()).toBe(false);

    db.run("DELETE FROM sync_metadata WHERE key = '__tenant_generation'");
    db.run(`
      INSERT INTO invoice_handoffs (
        order_id, salon_id, tenant_generation, status, last_request_id
      ) VALUES
        ('mixed-1', 'salon-old', 1, 'PENDING', NULL),
        ('mixed-2', 'salon-old', 2, 'PENDING', NULL)
    `);
    (database as any).restoreTenantGeneration();
    expect(database.isTenantGenerationReliable()).toBe(false);
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

  it('blocks tenant exit while an invoice handoff is DISPATCHING', () => {
    insertInvoiceHandoff('DISPATCHING');

    expect(() => database.assertNoActiveReceiptPrintOutcomes('salon-old'))
      .toThrowError(expect.objectContaining({
        code: 'INVOICE_HANDOFF_OUTCOME_UNCERTAIN',
        invoiceHandoffOrderId: 'invoice-order-old',
      }));
    expect(() => database.clearSalonData(
      'salon-old',
      { archivedReviewEvidence: true },
    )).toThrowError(expect.objectContaining({
      code: 'INVOICE_HANDOFF_OUTCOME_UNCERTAIN',
    }));
  });

  it('blocks tenant exit when a completed handoff has a later refund not yet reviewed', () => {
    insertCompletedCorrectedInvoiceHandoff('REFUNDED');

    expect(() => database.assertNoActiveReceiptPrintOutcomes('salon-old'))
      .toThrowError(expect.objectContaining({
        code: 'INVOICE_HANDOFF_OUTCOME_UNCERTAIN',
        invoiceHandoffOrderId: 'invoice-order-old',
      }));
  });

  it('blocks tenant exit on immutable refund evidence even when order status is stale', () => {
    db.run("INSERT INTO orders (id, status) VALUES ('invoice-order-old', 'COMPLETED')");
    insertInvoiceHandoff('COMPLETED');
    db.run(`
      INSERT INTO pos_event_outbox (event_id, local_order_id, event_type)
      VALUES ('refund-event', 'invoice-order-old', 'RefundIssued')
    `);

    expect(() => database.assertNoActiveReceiptPrintOutcomes('salon-old'))
      .toThrowError(expect.objectContaining({
        code: 'INVOICE_HANDOFF_OUTCOME_UNCERTAIN',
        invoiceHandoffOrderId: 'invoice-order-old',
      }));
  });

  it('retains NEEDS_REVIEW until archive allowance, then clears old-tenant evidence', () => {
    insertInvoiceHandoff('NEEDS_REVIEW');

    expect(() => database.clearSalonData('salon-old')).toThrowError(
      expect.objectContaining({ code: 'INVOICE_HANDOFF_OUTCOME_UNCERTAIN' }),
    );
    expect(() => database.prepareReceiptPrintOutboxForTenantExit(
      'salon-old',
      'archived switch',
      { allowNeedsReview: true },
    )).not.toThrow();

    database.clearSalonData('salon-old', { archivedReviewEvidence: true });
    expect(database.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM invoice_handoffs',
    )?.count).toBe(0);
  });
});
