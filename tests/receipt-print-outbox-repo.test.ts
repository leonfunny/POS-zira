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
      markDirty: vi.fn(),
    },
  };
});

vi.mock('../src/main/database/database', () => ({ database: testDatabase }));

import {
  initialReceiptPrintIdempotencyKey,
  receiptPrintOutboxRepo,
  receiptPrintPayloadHash,
  stableReceiptPrintPayloadJson,
} from '../src/main/database/repos/receipt-print-outbox-repo';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

const CREATE_OUTBOX_SQL = `
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
    completed_at TEXT
  );
  CREATE UNIQUE INDEX ux_receipt_print_outbox_initial_order
    ON receipt_print_outbox(order_id, document_type);
  CREATE INDEX idx_receipt_print_outbox_fifo
    ON receipt_print_outbox(salon_id, device_id, status, seq);
`;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  dbState.db = new SQL.Database();
  dbState.db.run(CREATE_OUTBOX_SQL);
  vi.clearAllMocks();
});

function crashReload(): void {
  const snapshot = dbState.db!.export();
  dbState.db!.close();
  dbState.db = new SQL.Database(snapshot);
}

function enqueue(
  orderId: string,
  overrides: Partial<Parameters<typeof receiptPrintOutboxRepo.enqueue>[0]> = {},
) {
  return receiptPrintOutboxRepo.enqueue({
    jobId: `job-${orderId}`,
    orderId,
    salonId: 'salon-1',
    deviceId: 'pos-1',
    shiftId: 'shift-1',
    openDrawer: true,
    payload: {
      orderId,
      payment: { amount: 1250, method: 'CASH' },
      items: [{ name: 'Herbata', quantity: 1 }],
    },
    createdAt: '2026-07-29T10:00:00.000Z',
    ...overrides,
  });
}

describe('receiptPrintOutboxRepo', () => {
  it('persists a canonical payload and deterministic initial-receipt identity', () => {
    const row = enqueue('order-1', {
      payload: {
        payment: { method: 'CASH', amount: 1250 },
        orderId: 'order-1',
        items: [{ quantity: 1, name: 'Herbata' }],
      },
    });

    expect(row).toMatchObject({
      job_id: 'job-order-1',
      idempotency_key: 'pos-receipt:pos-1:order-1:order:v1',
      order_id: 'order-1',
      document_type: 'INITIAL_ORDER_COPY',
      open_drawer: 1,
      status: 'PENDING',
      attempts: 0,
    });
    expect(row.payload_hash).toBe(receiptPrintPayloadHash(row.payload_json));
    expect(initialReceiptPrintIdempotencyKey('pos-1', 'order-1'))
      .toBe(row.idempotency_key);

    crashReload();
    expect(receiptPrintOutboxRepo.getByJobId(row.job_id)).toEqual(row);

    // Key order differs, semantic payload does not. Enqueue is idempotent and
    // returns the original job rather than making another physical print.
    const duplicate = receiptPrintOutboxRepo.enqueue({
      orderId: 'order-1',
      salonId: 'salon-1',
      deviceId: 'pos-1',
      shiftId: 'shift-1',
      openDrawer: true,
      payload: {
        items: [{ name: 'Herbata', quantity: 1 }],
        orderId: 'order-1',
        payment: { amount: 1250, method: 'CASH' },
      },
    });
    expect(duplicate.job_id).toBe(row.job_id);
    expect(testDatabase.all('SELECT * FROM receipt_print_outbox')).toHaveLength(1);
  });

  it('rejects reuse of the deterministic key for changed print intent', () => {
    enqueue('order-1');

    expect(() => enqueue('order-1', { openDrawer: false })).toThrowError(
      expect.objectContaining({
        code: 'IDEMPOTENCY_KEY_REUSED',
        status: 409,
      }),
    );
    expect(() => enqueue('order-1', {
      payload: { orderId: 'order-1', items: [{ name: 'Different' }] },
    })).toThrowError(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_REUSED',
    }));
  });

  it('keeps strict FIFO while a remote head is accepted but not terminal', () => {
    const first = enqueue('order-1');
    const second = enqueue('order-2');

    expect(receiptPrintOutboxRepo.getHead('salon-1', 'pos-1')?.job_id)
      .toBe(first.job_id);

    receiptPrintOutboxRepo.markDispatching(first.job_id, '2026-07-29T10:00:01.000Z');
    receiptPrintOutboxRepo.markRemoteAccepted(first.job_id, {
      printerId: 'printer-pos1',
      remoteJobId: 'remote-1',
      nextAttemptAt: '2026-07-29T10:00:03.000Z',
      updatedAt: '2026-07-29T10:00:01.100Z',
    });

    expect(receiptPrintOutboxRepo.getHead('salon-1', 'pos-1')?.job_id)
      .toBe(first.job_id);
    expect(receiptPrintOutboxRepo.listReplayable(
      'salon-1',
      'pos-1',
      '2026-07-29T10:00:02.000Z',
    )).toEqual([]);
    expect(receiptPrintOutboxRepo.listReplayable(
      'salon-1',
      'pos-1',
      '2026-07-29T10:00:04.000Z',
    )).toEqual([expect.objectContaining({ job_id: first.job_id })]);

    receiptPrintOutboxRepo.markCompleted(first.job_id, {
      route: 'SHARED_NETWORK',
      printerId: 'printer-pos1',
      remoteJobId: 'remote-1',
      completedAt: '2026-07-29T10:00:04.000Z',
    });
    expect(receiptPrintOutboxRepo.getHead('salon-1', 'pos-1')?.job_id)
      .toBe(second.job_id);
  });

  it('never allows an accepted remote printer/job identity to be replaced', () => {
    const row = enqueue('order-1');
    receiptPrintOutboxRepo.markDispatching(row.job_id);
    receiptPrintOutboxRepo.markRemoteAccepted(row.job_id, {
      printerId: 'printer-pos1',
      remoteJobId: 'remote-original',
      nextAttemptAt: '2026-07-29T10:00:03.000Z',
    });

    expect(() => receiptPrintOutboxRepo.markRemoteAccepted(row.job_id, {
      printerId: 'printer-pos1',
      remoteJobId: 'remote-different',
      nextAttemptAt: '2026-07-29T10:00:04.000Z',
    })).toThrowError(expect.objectContaining({
      code: 'REMOTE_PRINT_IDENTITY_MISMATCH',
    }));
    expect(() => receiptPrintOutboxRepo.markCompleted(row.job_id, {
      route: 'LOCAL',
      printerId: 'xprinter',
      remoteJobId: 'remote-different',
    })).toThrowError(expect.objectContaining({
      code: 'REMOTE_PRINT_IDENTITY_MISMATCH',
    }));
    expect(receiptPrintOutboxRepo.getByJobId(row.job_id)).toMatchObject({
      status: 'REMOTE_ACCEPTED',
      route: 'SHARED_NETWORK',
      printer_id: 'printer-pos1',
      remote_job_id: 'remote-original',
    });
  });

  it('retains active remote identity and blocks mutation of its source order', () => {
    const row = enqueue('order-remote-mutation');
    receiptPrintOutboxRepo.markDispatching(row.job_id);
    receiptPrintOutboxRepo.markRemoteAccepted(row.job_id, {
      printerId: 'printer-pos1',
      remoteJobId: 'remote-locked',
      nextAttemptAt: '2026-07-29T10:00:03.000Z',
    });

    expect(() => receiptPrintOutboxRepo.prepareInitialForOrderMutation(
      'order-remote-mutation',
      'stale order must not mutate',
    )).toThrowError(expect.objectContaining({
      code: 'RECEIPT_PRINT_OUTCOME_UNCERTAIN',
      receiptPrintJobId: row.job_id,
    }));
    expect(receiptPrintOutboxRepo.getByJobId(row.job_id)).toMatchObject({
      status: 'REMOTE_ACCEPTED',
      route: 'SHARED_NETWORK',
      printer_id: 'printer-pos1',
      remote_job_id: 'remote-locked',
    });
  });

  it('cancels safe pre-dispatch intent before allowing order mutation', () => {
    const row = enqueue('order-safe-mutation');

    expect(receiptPrintOutboxRepo.prepareInitialForOrderMutation(
      'order-safe-mutation',
      'order payment changed',
      '2026-07-29T10:00:02.000Z',
    )).toMatchObject({
      status: 'CANCELLED',
      failure_class: 'SAFE_BEFORE_PRINT',
      last_error: 'order payment changed',
    });
    expect(receiptPrintOutboxRepo.getByJobId(row.job_id)).toMatchObject({
      status: 'CANCELLED',
      open_drawer: 1,
      payload_json: expect.stringContaining('"method":"CASH"'),
    });
  });

  it('allows only safe state transitions and never regresses a terminal row', () => {
    const row = enqueue('order-1');
    expect(receiptPrintOutboxRepo.markDispatching(
      row.job_id,
      '2026-07-29T10:00:01.000Z',
    )).toMatchObject({ status: 'DISPATCHING', attempts: 1 });

    // It is too late to cancel once a physical side effect may have started.
    expect(receiptPrintOutboxRepo.cancel(
      row.job_id,
      'operator cancel',
      '2026-07-29T10:00:02.000Z',
    )?.status).toBe('DISPATCHING');

    receiptPrintOutboxRepo.markCompleted(row.job_id, {
      route: 'LOCAL',
      printerId: 'xprinter',
      completedAt: '2026-07-29T10:00:03.000Z',
    });
    receiptPrintOutboxRepo.markFailedSafe(row.job_id, {
      error: 'late failure',
      nextAttemptAt: '2026-07-29T10:00:04.000Z',
      updatedAt: '2026-07-29T10:00:03.500Z',
    });
    expect(receiptPrintOutboxRepo.getByJobId(row.job_id)).toMatchObject({
      status: 'COMPLETED',
      attempts: 1,
      route: 'LOCAL',
      printer_id: 'xprinter',
    });
  });

  it('quarantines interrupted dispatches but preserves accepted remote jobs for polling', () => {
    const local = enqueue('order-local');
    const remote = enqueue('order-remote');
    receiptPrintOutboxRepo.markDispatching(local.job_id);
    receiptPrintOutboxRepo.markDispatching(remote.job_id);
    receiptPrintOutboxRepo.markRemoteAccepted(remote.job_id, {
      printerId: 'printer-pos1',
      remoteJobId: 'remote-1',
      nextAttemptAt: '2026-07-29T10:00:03.000Z',
    });

    expect(receiptPrintOutboxRepo.recoverInterruptedDispatches(
      'salon-1',
      'pos-1',
      '2026-07-29T10:00:05.000Z',
    )).toBe(1);
    expect(receiptPrintOutboxRepo.getByJobId(local.job_id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      failure_class: 'UNCERTAIN_AFTER_PRINT',
    });
    expect(receiptPrintOutboxRepo.getByJobId(remote.job_id)).toMatchObject({
      status: 'REMOTE_ACCEPTED',
      remote_job_id: 'remote-1',
    });
  });

  it('prunes only old completed or cancelled rows and retains review evidence', () => {
    const completedOld = enqueue('order-completed-old');
    receiptPrintOutboxRepo.markDispatching(
      completedOld.job_id,
      '2026-07-01T10:00:01.000Z',
    );
    receiptPrintOutboxRepo.markCompleted(completedOld.job_id, {
      route: 'LOCAL',
      completedAt: '2026-07-01T10:00:02.000Z',
    });

    const cancelledOld = enqueue('order-cancelled-old');
    receiptPrintOutboxRepo.cancel(
      cancelledOld.job_id,
      'operator cancelled before dispatch',
      '2026-07-01T10:00:02.000Z',
    );

    const reviewOld = enqueue('order-review-old');
    receiptPrintOutboxRepo.markNeedsReview(reviewOld.job_id, {
      error: 'paper outcome is uncertain',
      updatedAt: '2026-07-01T10:00:02.000Z',
    });

    const completedRecent = enqueue('order-completed-recent');
    receiptPrintOutboxRepo.markDispatching(
      completedRecent.job_id,
      '2026-07-28T10:00:01.000Z',
    );
    receiptPrintOutboxRepo.markCompleted(completedRecent.job_id, {
      route: 'LOCAL',
      completedAt: '2026-07-28T10:00:02.000Z',
    });

    vi.mocked(testDatabase.markDirty).mockClear();
    expect(receiptPrintOutboxRepo.pruneTerminalBefore(
      '2026-07-15T00:00:00.000Z',
    )).toBe(2);
    expect(testDatabase.markDirty).toHaveBeenCalledTimes(1);

    expect(receiptPrintOutboxRepo.getByJobId(completedOld.job_id)).toBeNull();
    expect(receiptPrintOutboxRepo.getByJobId(cancelledOld.job_id)).toBeNull();
    expect(receiptPrintOutboxRepo.getByJobId(reviewOld.job_id)).toMatchObject({
      status: 'NEEDS_REVIEW',
    });
    expect(receiptPrintOutboxRepo.getByJobId(completedRecent.job_id)).toMatchObject({
      status: 'COMPLETED',
    });
  });

  it('canonicalizes nested object keys without changing array order', () => {
    expect(stableReceiptPrintPayloadJson({
      z: [{ b: 2, a: 1 }, { c: 3 }],
      a: 'first',
    })).toBe('{"a":"first","z":[{"a":1,"b":2},{"c":3}]}');
  });
});
