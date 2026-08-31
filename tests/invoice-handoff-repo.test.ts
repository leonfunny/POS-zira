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
  CREATE TABLE invoice_handoffs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    salon_id TEXT NOT NULL,
    tenant_generation INTEGER NOT NULL,
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
    completed_at TEXT
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
  });
});
