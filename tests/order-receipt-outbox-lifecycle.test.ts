import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbState, testDatabase } = vi.hoisted(() => {
  const state = { db: null as SqlJsDatabase | null };
  return {
    dbState: state,
    testDatabase: {
      run(sql: string, params?: unknown[]): void {
        state.db!.run(sql, params as any[] | undefined);
      },
      get<T = any>(sql: string, params?: unknown[]): T | null {
        const statement = state.db!.prepare(sql);
        try {
          if (params) statement.bind(params as any[]);
          return statement.step() ? statement.getAsObject() as T : null;
        } finally {
          statement.free();
        }
      },
      all<T = any>(sql: string, params?: unknown[]): T[] {
        const statement = state.db!.prepare(sql);
        try {
          if (params) statement.bind(params as any[]);
          const rows: T[] = [];
          while (statement.step()) rows.push(statement.getAsObject() as T);
          return rows;
        } finally {
          statement.free();
        }
      },
      transaction<T>(fn: () => T): T {
        state.db!.run('BEGIN');
        try {
          const result = fn();
          state.db!.run('COMMIT');
          return result;
        } catch (error) {
          state.db!.run('ROLLBACK');
          throw error;
        }
      },
      markDirty: vi.fn(),
    },
  };
});

vi.mock('../src/main/database/database', () => ({ database: testDatabase }));
vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/main/events/pos-event-emitter', () => ({
  posEventEmitter: { emitOrderFinalized: vi.fn() },
}));
vi.mock('../src/main/database/repos/product-repo', () => ({
  STOCK_TRACKED_GUARD_SQL: '',
}));

import { orderRepo } from '../src/main/database/repos/order-repo';
import { receiptPrintOutboxRepo } from '../src/main/database/repos/receipt-print-outbox-repo';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  dbState.db = new SQL.Database();
  dbState.db.run(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      order_number TEXT,
      status TEXT,
      subtotal INTEGER,
      discount INTEGER,
      tax INTEGER,
      total INTEGER,
      payment_method TEXT,
      payment_amount INTEGER,
      change_amount INTEGER,
      payment_tenders TEXT,
      staff_id TEXT,
      staff_name TEXT,
      customer_id TEXT,
      customer_name TEXT,
      customer_nip TEXT,
      shift_id TEXT,
      source TEXT,
      order_type TEXT,
      mode TEXT,
      tip INTEGER,
      synced INTEGER,
      backend_id TEXT,
      billiard_origin_json TEXT
    );
    CREATE TABLE order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      variant_id TEXT,
      name TEXT,
      sku TEXT,
      price INTEGER,
      quantity REAL,
      sale_quantity REAL,
      sale_unit TEXT,
      sell_by TEXT,
      total INTEGER,
      vat_rate REAL,
      staff_id TEXT,
      staff_name TEXT,
      notes TEXT,
      course INTEGER,
      inventory_policy TEXT
    );
    CREATE TABLE local_sync_log (
      id TEXT PRIMARY KEY,
      entity_type TEXT,
      entity_id TEXT,
      event TEXT,
      payload TEXT,
      status TEXT,
      rejection_code TEXT,
      rejection_detail TEXT
    );
    CREATE TABLE sync_conflicts (log_entry_id TEXT);
    CREATE TABLE product_variants (
      id TEXT PRIMARY KEY,
      in_stock REAL,
      available_qty REAL
    );
    CREATE TABLE receipt_print_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      order_id TEXT NOT NULL,
      salon_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      shift_id TEXT,
      document_type TEXT NOT NULL,
      open_drawer INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      route TEXT,
      printer_id TEXT,
      remote_job_id TEXT,
      status TEXT NOT NULL,
      failure_class TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dispatched_at TEXT,
      completed_at TEXT,
      UNIQUE (order_id, document_type)
    );
    CREATE TABLE fiscal_attempts (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `);
  vi.clearAllMocks();
});

function seedCashOrder(id: string): void {
  dbState.db!.run(
    `INSERT INTO orders (
       id, order_number, status, subtotal, discount, tax, total,
       payment_method, payment_amount, change_amount, payment_tenders,
       source, mode, synced
     ) VALUES (?, ?, 'COMPLETED', 1000, 0, 187, 1000, 'CASH', 1000, 0, ?, 'POS', 'retail', 0)`,
    [id, `LOCAL-${id}`, JSON.stringify([{ method: 'CASH', amount: 1000 }])],
  );
  dbState.db!.run(
    `INSERT INTO order_items (
       id, order_id, name, price, quantity, sale_quantity, sale_unit,
       sell_by, total, vat_rate, course
     ) VALUES (?, ?, 'Herbata', 1000, 1, 1, 'szt', 'PIECE', 1000, 23, 1)`,
    [`item-${id}`, id],
  );
  dbState.db!.run(
    `INSERT INTO local_sync_log (
       id, entity_type, entity_id, event, payload, status
     ) VALUES (?, 'order', ?, 'created', '{}', 'pending')`,
    [`sync-${id}`, id],
  );
}

function enqueueCashReceipt(orderId: string) {
  return receiptPrintOutboxRepo.enqueue({
    jobId: `job-${orderId}`,
    orderId,
    salonId: 'salon-1',
    deviceId: 'pos-1',
    shiftId: 'shift-1',
    openDrawer: true,
    payload: {
      orderId,
      payment: { method: 'CASH', amount: 1000 },
      items: [{ name: 'Herbata', quantity: 1 }],
    },
    createdAt: '2026-07-29T10:00:00.000Z',
  });
}

describe('order mutation receipt-outbox lifecycle', () => {
  it('atomically cancels a stale CASH/drawer intent before CARD and item mutation', () => {
    seedCashOrder('order-card-edit');
    const queued = enqueueCashReceipt('order-card-edit');

    const result = orderRepo.updateLocalUnsynced('order-card-edit', {
      paymentMethod: 'CARD',
      paymentAmount: 1500,
      changeAmount: 0,
      items: [{
        id: 'item-card-edit',
        name: 'Kawa',
        price: 1500,
        quantity: 1,
        vat_rate: 23,
      }],
    });

    expect(result).toEqual({ updated: true, stockChanged: false });
    expect(receiptPrintOutboxRepo.getByJobId(queued.job_id)).toMatchObject({
      status: 'CANCELLED',
      failure_class: 'SAFE_BEFORE_PRINT',
      open_drawer: 1,
      payload_json: expect.stringContaining('"method":"CASH"'),
    });
    expect(orderRepo.getById('order-card-edit')).toMatchObject({
      payment_method: 'CARD',
      payment_amount: 1500,
      change_amount: 0,
    });
    expect(orderRepo.getItemsByOrderId('order-card-edit')).toEqual([
      expect.objectContaining({ name: 'Kawa', total: 1500 }),
    ]);
  });

  it('blocks delete and mutation after remote acceptance and retains exact identity', () => {
    seedCashOrder('order-remote');
    const queued = enqueueCashReceipt('order-remote');
    receiptPrintOutboxRepo.markDispatching(queued.job_id);
    receiptPrintOutboxRepo.markRemoteAccepted(queued.job_id, {
      printerId: 'printer-pos1',
      remoteJobId: 'remote-job-locked',
      nextAttemptAt: '2026-07-29T10:00:03.000Z',
    });

    expect(() => orderRepo.updateLocalUnsynced('order-remote', {
      paymentMethod: 'CARD',
      paymentAmount: 1000,
    })).toThrowError(expect.objectContaining({
      code: 'RECEIPT_PRINT_OUTCOME_UNCERTAIN',
    }));
    expect(() => orderRepo.deleteLocalUnsynced('order-remote')).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_PRINT_OUTCOME_UNCERTAIN' }),
    );

    expect(orderRepo.getById('order-remote')).toMatchObject({
      payment_method: 'CASH',
    });
    expect(receiptPrintOutboxRepo.getByJobId(queued.job_id)).toMatchObject({
      status: 'REMOTE_ACCEPTED',
      route: 'SHARED_NETWORK',
      printer_id: 'printer-pos1',
      remote_job_id: 'remote-job-locked',
    });
  });

  it.each([
    'SENT',
    'SUCCESS_CONFIRMED',
    'UNKNOWN_NEEDS_RECONCILIATION',
  ])('blocks edit/delete when fiscal evidence is %s', (status) => {
    const orderId = `order-fiscal-${status}`;
    seedCashOrder(orderId);
    dbState.db!.run(
      `INSERT INTO fiscal_attempts (id, order_id, attempt_no, status)
       VALUES (?, ?, 1, ?)`,
      [`attempt-${status}`, orderId, status],
    );

    expect(() => orderRepo.updateLocalUnsynced(orderId, {
      paymentMethod: 'CARD',
      paymentAmount: 1000,
    })).toThrowError(expect.objectContaining({ code: 'FISCAL_ORDER_IMMUTABLE' }));
    expect(() => orderRepo.deleteLocalUnsynced(orderId)).toThrowError(
      expect.objectContaining({ code: 'FISCAL_ORDER_IMMUTABLE' }),
    );
    expect(orderRepo.getById(orderId)).toMatchObject({ payment_method: 'CASH' });
    expect(orderRepo.getItemsByOrderId(orderId)).toHaveLength(1);
  });

  it('retains cancelled evidence after deleting a safe unsynced order', () => {
    seedCashOrder('order-delete');
    const queued = enqueueCashReceipt('order-delete');

    expect(orderRepo.deleteLocalUnsynced('order-delete')).toEqual({
      deleted: true,
      restocked: 0,
    });
    expect(orderRepo.getById('order-delete')).toBeNull();
    expect(receiptPrintOutboxRepo.getByJobId(queued.job_id)).toMatchObject({
      order_id: 'order-delete',
      status: 'CANCELLED',
      payload_json: expect.stringContaining('"method":"CASH"'),
    });
  });

  it('allows delete/restock while retaining immutable review evidence exactly', () => {
    seedCashOrder('order-review');
    const queued = enqueueCashReceipt('order-review');
    dbState.db!.run(
      "INSERT INTO product_variants (id, in_stock, available_qty) VALUES ('variant-review', 5, 5)",
    );
    dbState.db!.run(
      "UPDATE order_items SET variant_id = 'variant-review' WHERE order_id = 'order-review'",
    );
    receiptPrintOutboxRepo.markNeedsReview(queued.job_id, {
      error: 'operator must check paper',
      failureClass: 'UNCERTAIN_AFTER_PRINT',
      route: 'SHARED_NETWORK',
      printerId: 'printer-review',
      remoteJobId: 'remote-review',
    });
    const evidenceBefore = receiptPrintOutboxRepo.getByJobId(queued.job_id);

    expect(orderRepo.updateLocalUnsynced('order-review', {
      paymentMethod: 'CARD',
      paymentAmount: 1000,
      changeAmount: 0,
    })).toEqual({ updated: true, stockChanged: false });
    expect(receiptPrintOutboxRepo.getByJobId(queued.job_id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error: 'operator must check paper',
      payload_json: expect.stringContaining('"method":"CASH"'),
    });
    expect(orderRepo.deleteLocalUnsynced('order-review')).toEqual({
      deleted: true,
      restocked: 1,
    });
    expect(orderRepo.getById('order-review')).toBeNull();
    expect(testDatabase.get<{ in_stock: number; available_qty: number }>(
      "SELECT in_stock, available_qty FROM product_variants WHERE id = 'variant-review'",
    )).toEqual({ in_stock: 6, available_qty: 6 });

    const evidenceAfter = receiptPrintOutboxRepo.getByJobId(queued.job_id);
    expect(evidenceAfter).toEqual(evidenceBefore);
    expect(evidenceAfter).toMatchObject({
      job_id: queued.job_id,
      order_id: 'order-review',
      status: 'NEEDS_REVIEW',
      route: 'SHARED_NETWORK',
      printer_id: 'printer-review',
      remote_job_id: 'remote-review',
      last_error: 'operator must check paper',
      payload_json: expect.stringContaining('"method":"CASH"'),
      payload_hash: expect.stringMatching(/^sha256:/),
    });
  });
});
