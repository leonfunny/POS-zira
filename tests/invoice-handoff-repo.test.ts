import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
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
  invoiceHandoffIdempotencyKey,
  invoiceHandoffRepo,
} from '../src/main/database/repos/invoice-handoff-repo';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

const SCHEMA = `
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    backend_id TEXT,
    status TEXT NOT NULL
  );
  CREATE TABLE pos_event_outbox (
    event_id TEXT PRIMARY KEY,
    local_order_id TEXT,
    event_type TEXT NOT NULL
  );
  CREATE TABLE invoice_handoffs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    salon_id TEXT NOT NULL,
    tenant_generation INTEGER NOT NULL,
    backend_order_id TEXT,
    company_nip TEXT,
    document_intent TEXT NOT NULL,
    channel_id TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_request_id TEXT,
    last_error_code TEXT,
    last_error TEXT,
    response_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    dispatched_at TEXT,
    completed_at TEXT,
    review_kind TEXT,
    review_request_id TEXT
  );
`;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  dbState.db = new SQL.Database();
  dbState.db.run(SCHEMA);
  vi.clearAllMocks();
});

describe('invoiceHandoffRepo', () => {
  it('enqueues one stable, tenant-fenced handoff idempotently', () => {
    const first = invoiceHandoffRepo.enqueue({
      orderId: 'order-1',
      salonId: 'salon-1',
      tenantGeneration: 7,
      companyNip: '522-005-23-49',
      createdAt: '2026-08-30T10:00:00.000Z',
    });
    const duplicate = invoiceHandoffRepo.enqueue({
      orderId: 'order-1',
      salonId: 'salon-1',
      tenantGeneration: 7,
      companyNip: '5220052349',
    });

    expect(first).toMatchObject({
      order_id: 'order-1',
      idempotency_key: 'pos-invoice:order-1:v1',
      salon_id: 'salon-1',
      tenant_generation: 7,
      company_nip: '5220052349',
      document_intent: 'FISCALISED_RETAIL',
      status: 'WAITING_ELIGIBILITY',
      attempts: 0,
    });
    expect(duplicate.seq).toBe(first.seq);
    expect(invoiceHandoffIdempotencyKey('order-1')).toBe(first.idempotency_key);
    expect(testDatabase.all('SELECT * FROM invoice_handoffs')).toHaveLength(1);
    expect(() => invoiceHandoffRepo.enqueue({
      orderId: 'order-1',
      salonId: 'salon-2',
      tenantGeneration: 7,
      companyNip: '5220052349',
    })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));
  });

  it('persists dispatch ambiguity and retries with a fresh request identity', () => {
    invoiceHandoffRepo.enqueue({
      orderId: 'order-1',
      salonId: 'salon-1',
      tenantGeneration: 3,
      companyNip: '5220052349',
    });
    invoiceHandoffRepo.markPending('order-1', 'channel-1', '2026-08-30T10:00:01.000Z');
    const dispatch = invoiceHandoffRepo.markDispatching(
      'order-1',
      'channel-1',
      'request-1',
      '2026-08-30T10:00:02.000Z',
    );
    expect(dispatch).toMatchObject({
      status: 'DISPATCHING',
      attempts: 1,
      last_request_id: 'request-1',
    });

    invoiceHandoffRepo.markAmbiguous(
      'order-1',
      'BRIDGE_TIMEOUT',
      'handler timed out',
      '2026-08-30T10:00:30.000Z',
      '2026-08-30T10:00:03.000Z',
    );
    expect(invoiceHandoffRepo.listDue(
      'salon-1',
      3,
      '2026-08-30T10:00:29.000Z',
    )).toEqual([]);
    expect(invoiceHandoffRepo.listDue(
      'salon-1',
      3,
      '2026-08-30T10:00:31.000Z',
    )).toEqual([expect.objectContaining({
      status: 'DISPATCHING',
      last_error_code: 'BRIDGE_TIMEOUT',
    })]);

    invoiceHandoffRepo.markRetryPending(
      'order-1',
      'NOT_FOUND',
      'authoritative status says not imported',
      '2026-08-30T10:01:00.000Z',
    );
    invoiceHandoffRepo.markDispatching(
      'order-1',
      'channel-1',
      'request-2',
      '2026-08-30T10:01:01.000Z',
    );
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'DISPATCHING',
      attempts: 2,
      last_request_id: 'request-2',
    });
  });

  it('supports review/retry and finite terminal outcomes', () => {
    invoiceHandoffRepo.enqueue({
      orderId: 'order-review',
      salonId: 'salon-1',
      tenantGeneration: 1,
    });
    invoiceHandoffRepo.markNeedsReview(
      'order-review',
      'SELLER_NIP_MISSING',
      'seller NIP is required',
    );
    expect(invoiceHandoffRepo.retry('order-review')).toMatchObject({
      status: 'WAITING_ELIGIBILITY',
      last_error: null,
    });
    expect(invoiceHandoffRepo.markNotApplicable(
      'order-review',
      'order never entered the fiscal receipt flow',
    )).toMatchObject({
      status: 'NOT_APPLICABLE',
      last_error_code: 'NOT_APPLICABLE',
    });

    invoiceHandoffRepo.enqueue({
      orderId: 'order-complete',
      salonId: 'salon-1',
      tenantGeneration: 1,
      companyNip: '5220052349',
    });
    invoiceHandoffRepo.markPending('order-complete', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-complete', 'channel-1', 'request-1');
    expect(invoiceHandoffRepo.markCompleted(
      'order-complete',
      '{"importResult":"IMPORTED"}',
      '2026-08-30T11:00:00.000Z',
    )).toMatchObject({
      status: 'COMPLETED',
      response_json: '{"importResult":"IMPORTED"}',
      completed_at: '2026-08-30T11:00:00.000Z',
    });

    testDatabase.run("INSERT INTO orders (id, status) VALUES ('order-complete', 'PARTIAL_REFUND')");
    expect(invoiceHandoffRepo.listCompletedCorrections('salon-1', 1)).toEqual([
      expect.objectContaining({ order_id: 'order-complete', status: 'COMPLETED' }),
    ]);
    expect(invoiceHandoffRepo.markCompletedNeedsReview(
      'order-complete',
      'REFUND_CORRECTION_REQUIRED',
      'manual correction required',
      '2026-08-30T11:01:00.000Z',
    )).toMatchObject({
      status: 'NEEDS_REVIEW',
      response_json: '{"importResult":"IMPORTED"}',
      completed_at: '2026-08-30T11:00:00.000Z',
      last_error_code: 'REFUND_CORRECTION_REQUIRED',
      review_kind: 'POST_COMPLETION_CORRECTION',
    });

    // A correction review preserves the successful import forever and cannot
    // use the generic original-handoff retry lane.
    expect(() => invoiceHandoffRepo.retry('order-complete')).toThrowError(
      expect.objectContaining({ code: 'INVOICE_HANDOFF_RETRY_BLOCKED' }),
    );
    expect(invoiceHandoffRepo.getByOrderId('order-complete')).toMatchObject({
      status: 'NEEDS_REVIEW',
      response_json: '{"importResult":"IMPORTED"}',
      completed_at: '2026-08-30T11:00:00.000Z',
      review_kind: 'POST_COMPLETION_CORRECTION',
    });
  });

  it('reconnects a retained completed handoff to a later backend mirror', () => {
    testDatabase.run(
      "INSERT INTO orders (id, backend_id, status) VALUES ('local-order', 'server-order', 'COMPLETED')",
    );
    expect(invoiceHandoffRepo.enqueue({
      orderId: 'local-order',
      salonId: 'salon-1',
      tenantGeneration: 2,
      companyNip: '5220052349',
    })).toMatchObject({ backend_order_id: 'server-order' });
    invoiceHandoffRepo.markPending('local-order', 'channel-1');
    invoiceHandoffRepo.markDispatching('local-order', 'channel-1', 'request-1');
    invoiceHandoffRepo.markCompleted('local-order', '{"importResult":"IMPORTED"}');

    testDatabase.run("DELETE FROM orders WHERE id = 'local-order'");
    testDatabase.run(
      "INSERT INTO orders (id, backend_id, status) VALUES ('server-order', 'server-order', 'REFUNDED')",
    );

    expect(invoiceHandoffRepo.listCompletedCorrections('salon-1', 2)).toEqual([
      expect.objectContaining({
        order_id: 'local-order',
        backend_order_id: 'server-order',
      }),
    ]);
    expect(invoiceHandoffRepo.flagCompletedCorrections('salon-1', 2)).toBe(1);
    expect(invoiceHandoffRepo.getByOrderId('local-order')).toMatchObject({
      status: 'NEEDS_REVIEW',
      review_kind: 'POST_COMPLETION_CORRECTION',
      last_error_code: 'REFUND_CORRECTION_REQUIRED',
    });
  });

  it('persists a cancellation intent before the server call and finalizes safely', () => {
    testDatabase.run(
      "INSERT INTO orders (id, backend_id, status) VALUES ('order-cancel', 'server-cancel', 'COMPLETED')",
    );
    invoiceHandoffRepo.enqueue({
      orderId: 'order-cancel',
      salonId: 'salon-1',
      tenantGeneration: 1,
      companyNip: '5220052349',
    });

    expect(invoiceHandoffRepo.prepareForCancellation(
      'order-cancel',
      'server-cancel',
    )).toMatchObject({
      status: 'NEEDS_REVIEW',
      review_kind: 'CANCELLATION_INTENT',
      last_error_code: 'CANCELLATION_CONFIRMATION_PENDING',
    });
    expect(invoiceHandoffRepo.prepareForCancellation(
      'order-cancel',
      'server-cancel',
    )).toMatchObject({
      status: 'NEEDS_REVIEW',
      review_kind: 'CANCELLATION_INTENT',
    });
    expect(invoiceHandoffRepo.confirmCancellation(
      'order-cancel',
      'server-cancel',
    )).toMatchObject({
      status: 'NOT_APPLICABLE',
      review_kind: null,
    });

    invoiceHandoffRepo.enqueue({
      orderId: 'order-completed-cancel',
      salonId: 'salon-1',
      tenantGeneration: 1,
      companyNip: '5220052349',
    });
    invoiceHandoffRepo.markPending('order-completed-cancel', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-completed-cancel', 'channel-1', 'request-2');
    invoiceHandoffRepo.markCompleted(
      'order-completed-cancel',
      '{"importResult":"IMPORTED"}',
      '2026-08-30T12:00:00.000Z',
    );
    invoiceHandoffRepo.prepareForCancellation('order-completed-cancel', 'server-completed');
    expect(invoiceHandoffRepo.confirmCancellation(
      'order-completed-cancel',
      'server-completed',
    )).toMatchObject({
      status: 'NEEDS_REVIEW',
      review_kind: 'POST_COMPLETION_CORRECTION',
      last_error_code: 'CANCELLATION_CORRECTION_REQUIRED',
      response_json: '{"importResult":"IMPORTED"}',
      completed_at: '2026-08-30T12:00:00.000Z',
    });
  });

  it('persists a stable refund intent and never loses original import evidence', () => {
    const requestId = '11111111-1111-4111-8111-111111111111';
    const differentId = '22222222-2222-4222-8222-222222222222';
    invoiceHandoffRepo.enqueue({
      orderId: 'order-refund-before-import',
      salonId: 'salon-1',
      tenantGeneration: 1,
      backendOrderId: 'server-refund-before-import',
      companyNip: '5220052349',
    });

    expect(invoiceHandoffRepo.prepareForRefund(
      'order-refund-before-import',
      'server-refund-before-import',
      requestId,
    )).toMatchObject({
      status: 'NEEDS_REVIEW',
      review_kind: 'REFUND_INTENT',
      review_request_id: requestId,
      last_error_code: 'REFUND_CONFIRMATION_PENDING',
    });
    expect(() => invoiceHandoffRepo.prepareForRefund(
      'order-refund-before-import',
      'server-refund-before-import',
      differentId,
    )).toThrowError(expect.objectContaining({ code: 'INVOICE_HANDOFF_REFUND_BLOCKED' }));
    expect(invoiceHandoffRepo.confirmRefund(
      'order-refund-before-import',
      'server-refund-before-import',
      requestId,
    )).toMatchObject({
      status: 'NOT_APPLICABLE',
      review_kind: null,
      review_request_id: requestId,
    });

    invoiceHandoffRepo.enqueue({
      orderId: 'order-refund-after-import',
      salonId: 'salon-1',
      tenantGeneration: 1,
      backendOrderId: 'server-refund-after-import',
      companyNip: '5220052349',
    });
    invoiceHandoffRepo.markPending('order-refund-after-import', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-refund-after-import', 'channel-1', 'request-import');
    invoiceHandoffRepo.markCompleted(
      'order-refund-after-import',
      '{"importResult":"IMPORTED"}',
      '2026-08-30T13:00:00.000Z',
    );
    invoiceHandoffRepo.prepareForRefund(
      'order-refund-after-import',
      'server-refund-after-import',
      requestId,
    );
    expect(invoiceHandoffRepo.confirmRefund(
      'order-refund-after-import',
      'server-refund-after-import',
      requestId,
    )).toMatchObject({
      status: 'NEEDS_REVIEW',
      review_kind: 'POST_COMPLETION_CORRECTION',
      review_request_id: requestId,
      last_error_code: 'REFUND_CORRECTION_REQUIRED',
      response_json: '{"importResult":"IMPORTED"}',
      completed_at: '2026-08-30T13:00:00.000Z',
    });
  });

  it('creates a blocking handoff from trusted fallback evidence when none existed', () => {
    const fallback = {
      orderId: 'order-fallback',
      salonId: 'salon-1',
      tenantGeneration: 3,
      backendOrderId: 'server-fallback',
      companyNip: '5220052349',
    };

    expect(invoiceHandoffRepo.prepareForCancellation(
      'order-fallback',
      'server-fallback',
      undefined,
      fallback,
    )).toMatchObject({
      order_id: 'order-fallback',
      backend_order_id: 'server-fallback',
      status: 'NEEDS_REVIEW',
      review_kind: 'CANCELLATION_INTENT',
    });
    expect(testDatabase.all('SELECT * FROM invoice_handoffs')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ order_id: 'order-fallback' }),
      ]),
    );
  });

  it('rejects a backend identity change before cancellation or refund intent is written', () => {
    invoiceHandoffRepo.enqueue({
      orderId: 'order-cancel-identity',
      backendOrderId: 'server-a',
      salonId: 'salon-1',
      tenantGeneration: 1,
      companyNip: '5220052349',
    });
    expect(() => invoiceHandoffRepo.prepareForCancellation(
      'order-cancel-identity',
      'server-b',
    )).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));
    expect(invoiceHandoffRepo.getByOrderId('order-cancel-identity')).toMatchObject({
      backend_order_id: 'server-a',
      status: 'WAITING_ELIGIBILITY',
      review_kind: null,
    });

    invoiceHandoffRepo.enqueue({
      orderId: 'order-refund-identity',
      backendOrderId: 'server-a',
      salonId: 'salon-1',
      tenantGeneration: 1,
      companyNip: '5220052349',
    });
    expect(() => invoiceHandoffRepo.prepareForRefund(
      'order-refund-identity',
      'server-b',
      '11111111-1111-4111-8111-111111111111',
    )).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));
    expect(invoiceHandoffRepo.getByOrderId('order-refund-identity')).toMatchObject({
      backend_order_id: 'server-a',
      status: 'WAITING_ELIGIBILITY',
      review_kind: null,
    });

    invoiceHandoffRepo.prepareForCancellation('order-cancel-identity', 'server-a');
    expect(() => invoiceHandoffRepo.confirmCancellation(
      'order-cancel-identity',
      'server-b',
    )).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));
    expect(invoiceHandoffRepo.getByOrderId('order-cancel-identity')).toMatchObject({
      backend_order_id: 'server-a',
      status: 'NEEDS_REVIEW',
      review_kind: 'CANCELLATION_INTENT',
    });

    const requestId = '11111111-1111-4111-8111-111111111111';
    invoiceHandoffRepo.prepareForRefund('order-refund-identity', 'server-a', requestId);
    expect(() => invoiceHandoffRepo.confirmRefund(
      'order-refund-identity',
      'server-b',
      requestId,
    )).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));
    expect(invoiceHandoffRepo.getByOrderId('order-refund-identity')).toMatchObject({
      backend_order_id: 'server-a',
      status: 'NEEDS_REVIEW',
      review_kind: 'REFUND_INTENT',
      review_request_id: requestId,
    });
  });

  it('prepares and confirms through a retained backend alias without creating a second row', () => {
    invoiceHandoffRepo.enqueue({
      orderId: 'local-order-alias',
      backendOrderId: 'server-order-alias',
      salonId: 'salon-1',
      tenantGeneration: 1,
      companyNip: '5220052349',
    });

    expect(invoiceHandoffRepo.prepareForCancellation(
      'server-order-alias',
      'server-order-alias',
    )).toMatchObject({
      order_id: 'local-order-alias',
      backend_order_id: 'server-order-alias',
      review_kind: 'CANCELLATION_INTENT',
    });
    expect(invoiceHandoffRepo.confirmCancellation(
      'server-order-alias',
      'server-order-alias',
    )).toMatchObject({
      order_id: 'local-order-alias',
      status: 'NOT_APPLICABLE',
    });
    expect(testDatabase.all('SELECT * FROM invoice_handoffs')).toHaveLength(1);
  });
});
