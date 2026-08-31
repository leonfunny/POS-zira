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

import { invoiceHandoffRepo } from '../src/main/database/repos/invoice-handoff-repo';
import {
  InvoiceGatewayBridgeError,
  type ZiraInvoiceBridgeClientLike,
} from '../src/main/invoice-gateway/client';
import { InvoiceHandoffWorker } from '../src/main/invoice-gateway/worker';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const NOW = new Date('2026-08-30T12:00:00.000Z');

const SCHEMA = `
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    backend_id TEXT,
    created_at TEXT
  );
  CREATE TABLE pos_event_outbox (
    event_id TEXT PRIMARY KEY,
    local_order_id TEXT,
    event_type TEXT NOT NULL
  );
  CREATE TABLE invoice_handoffs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL UNIQUE,
    backend_order_id TEXT,
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

function enqueue(orderId = 'order-1', createdAt = '2026-08-30T11:59:00.000Z') {
  return invoiceHandoffRepo.enqueue({
    orderId,
    salonId: 'salon-1',
    tenantGeneration: 4,
    companyNip: '5220052349',
    createdAt,
  });
}

function makeClient(overrides: Partial<ZiraInvoiceBridgeClientLike> = {}) {
  let id = 0;
  const calls: string[] = [];
  const client: ZiraInvoiceBridgeClientLike = {
    newRequestId: () => `request-${++id}`,
    capabilities: vi.fn(async () => {
      calls.push('capabilities');
      return {
        contractVersion: 1,
        ready: true,
        companyNip: '5220052349',
        supportedIntents: ['FISCALISED_RETAIL'],
        channels: [{ id: 'channel-1', name: 'POS', enabled: true }],
      };
    }),
    syncPosOrder: vi.fn(async () => {
      calls.push('sync');
      return {
        importResult: 'IMPORTED',
        localOrderId: 'local-order-1',
        orderState: 'READY_TO_INVOICE',
        document: null,
      };
    }),
    getDocumentStatus: vi.fn(async () => {
      calls.push('status');
      return { found: false, document: null };
    }),
    ...overrides,
  };
  return { client, calls };
}

function makeWorker(
  client: ZiraInvoiceBridgeClientLike,
  options: {
    confirmed?: boolean;
    orderStatus?: string;
    orderCreatedAt?: string;
    onError?: (error: unknown) => void;
    getOrder?: (
      orderId: string,
      backendOrderId?: string | null,
    ) => { status: string; created_at: string } | null;
    getScope?: () => {
      salonId: string;
      tenantGeneration: number;
      channelId: string;
      active?: boolean;
    };
    flush?: () => Promise<{ success: boolean; error?: string }>;
    refundEvidence?: boolean;
    useDatabaseEligibility?: boolean;
  } = {},
) {
  return new InvoiceHandoffWorker({
    getScope: options.getScope ?? (() => ({
      salonId: 'salon-1',
      tenantGeneration: 4,
      channelId: 'channel-1',
    })),
    client,
    repo: invoiceHandoffRepo,
    eligibility: options.useDatabaseEligibility ? undefined : {
      getOrder: options.getOrder ?? (() => ({
        status: options.orderStatus ?? 'COMPLETED',
        created_at: options.orderCreatedAt ?? '2026-08-30T11:59:00.000Z',
      })),
      hasConfirmedFiscalReceipt: () => options.confirmed ?? true,
      hasRefundEvidence: () => options.refundEvidence ?? false,
    },
    flush: options.flush ?? vi.fn(async () => ({ success: true })),
    now: () => NOW,
    retryDelayMs: () => 30_000,
    onError: options.onError ? (error) => options.onError!(error) : undefined,
  });
}

describe('InvoiceHandoffWorker', () => {
  it('dispatches only after fiscal eligibility and a durable DISPATCHING transition', async () => {
    enqueue();
    const { client, calls } = makeClient();
    vi.mocked(client.syncPosOrder).mockImplementation(async (_input, requestId) => {
      calls.push('sync');
      expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
        status: 'DISPATCHING',
        last_request_id: requestId,
        attempts: 1,
      });
      return {
        importResult: 'IMPORTED',
        localOrderId: 'local-order-1',
        orderState: 'READY_TO_INVOICE',
        document: null,
      };
    });

    await makeWorker(client).wake();

    expect(calls).toEqual(['capabilities', 'sync']);
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'COMPLETED',
      attempts: 1,
      channel_id: 'channel-1',
    });
  });

  it.each([
    ['REFUNDED', 'REFUND_CORRECTION_REQUIRED'],
    ['CANCELLED', 'CANCELLATION_CORRECTION_REQUIRED'],
  ])(
    'stops remote fan-out after an outage but still fences a later %s row locally',
    async (laterStatus, correctionCode) => {
      enqueue('order-1');
      enqueue('order-2');
      invoiceHandoffRepo.markPending('order-1', 'channel-1');
      invoiceHandoffRepo.markPending('order-2', 'channel-1');
      const { client, calls } = makeClient();
      vi.mocked(client.capabilities).mockImplementation(async () => {
        calls.push('capabilities');
        throw new InvoiceGatewayBridgeError('bridge timed out', 'BRIDGE_TIMEOUT', true);
      });

      await makeWorker(client, {
        getOrder: (orderId) => ({
          status: orderId === 'order-2' ? laterStatus : 'COMPLETED',
          created_at: '2026-08-30T11:59:00.000Z',
        }),
      }).wake();

      expect(calls).toEqual(['capabilities']);
      expect(client.syncPosOrder).not.toHaveBeenCalled();
      expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
        status: 'PENDING',
        last_error_code: 'BRIDGE_TIMEOUT',
        next_attempt_at: '2026-08-30T12:00:30.000Z',
      });
      expect(invoiceHandoffRepo.getByOrderId('order-2')).toMatchObject({
        status: 'NEEDS_REVIEW',
        last_error_code: correctionCode,
        next_attempt_at: null,
      });
    },
  );

  it('continues past a local manual-review transition to process later rows', async () => {
    enqueue('refunded-order');
    enqueue('eligible-order');
    const { client, calls } = makeClient();

    await makeWorker(client, {
      getOrder: (orderId) => ({
        status: orderId === 'refunded-order' ? 'REFUNDED' : 'COMPLETED',
        created_at: '2026-08-30T11:59:00.000Z',
      }),
    }).wake();

    expect(calls).toEqual(['capabilities', 'sync']);
    expect(invoiceHandoffRepo.getByOrderId('refunded-order')).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error_code: 'REFUND_CORRECTION_REQUIRED',
    });
    expect(invoiceHandoffRepo.getByOrderId('eligible-order')).toMatchObject({
      status: 'COMPLETED',
    });
  });

  it('does not mutate remotely when the session expires during capabilities preflight', async () => {
    enqueue();
    let active = true;
    let release!: (value: Awaited<ReturnType<ZiraInvoiceBridgeClientLike['capabilities']>>) => void;
    const { client } = makeClient();
    vi.mocked(client.capabilities).mockImplementation(() => new Promise((resolve) => {
      release = resolve;
    }));
    const worker = makeWorker(client, {
      getScope: () => ({
        salonId: 'salon-1',
        tenantGeneration: 4,
        channelId: 'channel-1',
        active,
      }),
    });

    const run = worker.wake();
    await vi.waitFor(() => expect(client.capabilities).toHaveBeenCalledOnce());
    active = false;
    release({
      contractVersion: 1,
      ready: true,
      companyNip: '5220052349',
      supportedIntents: ['FISCALISED_RETAIL'],
      channels: [{ id: 'channel-1', name: 'POS', enabled: true }],
    });
    await run;

    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({ status: 'PENDING' });
  });

  it('does not write a retry transition when ordinary capabilities rejects after scope invalidation', async () => {
    enqueue();
    let active = true;
    let rejectCapabilities!: (error: unknown) => void;
    const { client } = makeClient();
    vi.mocked(client.capabilities).mockImplementation(() => new Promise((_, reject) => {
      rejectCapabilities = reject;
    }));
    const worker = makeWorker(client, {
      getScope: () => ({
        salonId: 'salon-1',
        tenantGeneration: 4,
        channelId: 'channel-1',
        active,
      }),
    });

    const run = worker.wake();
    await vi.waitFor(() => expect(client.capabilities).toHaveBeenCalledOnce());
    const writesBeforeInvalidation = vi.mocked(testDatabase.markDirty).mock.calls.length;
    active = false;
    rejectCapabilities(new InvoiceGatewayBridgeError('bridge timed out', 'BRIDGE_TIMEOUT', true));
    await run;

    expect(vi.mocked(testDatabase.markDirty)).toHaveBeenCalledTimes(writesBeforeInvalidation);
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'PENDING',
      last_error_code: null,
      next_attempt_at: null,
    });
  });

  it('does not write an ambiguity transition when recovery capabilities rejects after scope invalidation', async () => {
    enqueue();
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'old-request');
    let active = true;
    let rejectCapabilities!: (error: unknown) => void;
    const { client } = makeClient();
    vi.mocked(client.capabilities).mockImplementation(() => new Promise((_, reject) => {
      rejectCapabilities = reject;
    }));
    const worker = makeWorker(client, {
      getScope: () => ({
        salonId: 'salon-1',
        tenantGeneration: 4,
        channelId: 'channel-1',
        active,
      }),
    });

    const run = worker.recoverDispatchingOnly();
    await vi.waitFor(() => expect(client.capabilities).toHaveBeenCalledOnce());
    const writesBeforeInvalidation = vi.mocked(testDatabase.markDirty).mock.calls.length;
    active = false;
    rejectCapabilities(new InvoiceGatewayBridgeError('bridge timed out', 'BRIDGE_TIMEOUT', true));
    await run;

    expect(vi.mocked(testDatabase.markDirty)).toHaveBeenCalledTimes(writesBeforeInvalidation);
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'DISPATCHING',
      last_error_code: null,
      next_attempt_at: null,
    });
  });

  it.each(['ordinary', 'recovery'] as const)(
    'does not write after a deferred %s status rejection crosses scope invalidation',
    async (mode) => {
      enqueue();
      invoiceHandoffRepo.markPending('order-1', 'channel-1');
      invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'old-request');
      let active = true;
      let rejectStatus!: (error: unknown) => void;
      const { client } = makeClient();
      vi.mocked(client.getDocumentStatus).mockImplementation(() => new Promise((_, reject) => {
        rejectStatus = reject;
      }));
      const worker = makeWorker(client, {
        getScope: () => ({
          salonId: 'salon-1',
          tenantGeneration: 4,
          channelId: 'channel-1',
          active,
        }),
      });

      const run = mode === 'ordinary' ? worker.wake() : worker.recoverDispatchingOnly();
      await vi.waitFor(() => expect(client.getDocumentStatus).toHaveBeenCalledOnce());
      const writesBeforeInvalidation = vi.mocked(testDatabase.markDirty).mock.calls.length;
      active = false;
      rejectStatus(new InvoiceGatewayBridgeError('status timed out', 'BRIDGE_TIMEOUT', true));
      await run;

      expect(vi.mocked(testDatabase.markDirty)).toHaveBeenCalledTimes(writesBeforeInvalidation);
      expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
        status: 'DISPATCHING',
        last_error_code: null,
        next_attempt_at: null,
      });
    },
  );

  it('keeps DISPATCHING and performs zero rollback writes when its durable flush rejects after invalidation', async () => {
    enqueue();
    let active = true;
    let flushCalls = 0;
    let rejectDispatchFlush!: (error: unknown) => void;
    const { client } = makeClient();
    const worker = makeWorker(client, {
      getScope: () => ({
        salonId: 'salon-1',
        tenantGeneration: 4,
        channelId: 'channel-1',
        active,
      }),
      flush: vi.fn(() => {
        flushCalls += 1;
        if (flushCalls === 3) {
          return new Promise<{ success: boolean }>((_resolve, reject) => {
            rejectDispatchFlush = reject;
          });
        }
        return Promise.resolve({ success: true });
      }),
    });

    const run = worker.wake();
    await vi.waitFor(() => expect(flushCalls).toBe(3));
    const writesBeforeInvalidation = vi.mocked(testDatabase.markDirty).mock.calls.length;
    active = false;
    rejectDispatchFlush(new Error('disk flush failed'));
    await run;

    expect(vi.mocked(testDatabase.markDirty)).toHaveBeenCalledTimes(writesBeforeInvalidation);
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'DISPATCHING',
      attempts: 1,
      last_error_code: null,
      next_attempt_at: null,
    });
  });

  it.each(['resolve', 'reject'] as const)(
    'keeps durable DISPATCHING when an already-open sync settles by %s after invalidation',
    async (settlement) => {
      enqueue();
      let active = true;
      let resolveSync!: (
        value: Awaited<ReturnType<ZiraInvoiceBridgeClientLike['syncPosOrder']>>,
      ) => void;
      let rejectSync!: (error: unknown) => void;
      const { client } = makeClient();
      vi.mocked(client.syncPosOrder).mockImplementation(() => new Promise((resolve, reject) => {
        resolveSync = resolve;
        rejectSync = reject;
      }));
      const worker = makeWorker(client, {
        getScope: () => ({
          salonId: 'salon-1',
          tenantGeneration: 4,
          channelId: 'channel-1',
          active,
        }),
      });

      const run = worker.wake();
      await vi.waitFor(() => expect(client.syncPosOrder).toHaveBeenCalledOnce());
      expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
        status: 'DISPATCHING',
        attempts: 1,
      });
      const writesBeforeInvalidation = vi.mocked(testDatabase.markDirty).mock.calls.length;
      active = false;
      if (settlement === 'resolve') {
        resolveSync({
          importResult: 'IMPORTED',
          localOrderId: 'late-local-order',
          orderState: 'READY_TO_INVOICE',
          document: null,
        });
      } else {
        rejectSync(new InvoiceGatewayBridgeError('late timeout', 'BRIDGE_TIMEOUT', true));
      }
      await run;

      expect(vi.mocked(testDatabase.markDirty)).toHaveBeenCalledTimes(writesBeforeInvalidation);
      expect(client.getDocumentStatus).not.toHaveBeenCalled();
      expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
        status: 'DISPATCHING',
        attempts: 1,
        last_error_code: null,
        next_attempt_at: null,
        response_json: null,
      });
    },
  );

  it('leaves durable DISPATCHING evidence and opens no socket when scope changes during its flush', async () => {
    enqueue();
    let active = true;
    let flushCount = 0;
    const { client } = makeClient();
    const worker = makeWorker(client, {
      getScope: () => ({
        salonId: 'salon-1',
        tenantGeneration: 4,
        channelId: 'channel-1',
        active,
      }),
      flush: vi.fn(async () => {
        flushCount += 1;
        if (flushCount === 3) active = false;
        return { success: true };
      }),
    });

    await worker.wake();

    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(client.getDocumentStatus).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'DISPATCHING',
      attempts: 1,
    });
  });

  it('reopens a completed handoff when the source is later refunded and preserves import evidence', async () => {
    enqueue();
    testDatabase.run("INSERT INTO orders (id, status) VALUES ('order-1', 'COMPLETED')");
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'request-original');
    const originalEvidence = JSON.stringify({
      importResult: 'IMPORTED',
      localOrderId: 'local-order-1',
      orderState: 'READY_TO_INVOICE',
      document: null,
    });
    invoiceHandoffRepo.markCompleted(
      'order-1',
      originalEvidence,
      '2026-08-30T11:59:30.000Z',
    );
    testDatabase.run("UPDATE orders SET status = 'REFUNDED' WHERE id = 'order-1'");
    const { client } = makeClient();

    await makeWorker(client, { orderStatus: 'REFUNDED' }).auditCompletedCorrections();

    expect(client.capabilities).not.toHaveBeenCalled();
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error_code: 'REFUND_CORRECTION_REQUIRED',
      response_json: originalEvidence,
      completed_at: '2026-08-30T11:59:30.000Z',
    });
  });

  it('reopens a completed handoff from immutable RefundIssued evidence even if mutable status lags', async () => {
    enqueue();
    testDatabase.run("INSERT INTO orders (id, status) VALUES ('order-1', 'COMPLETED')");
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'request-original');
    invoiceHandoffRepo.markCompleted('order-1', '{"importResult":"IMPORTED"}');
    testDatabase.run(`
      INSERT INTO pos_event_outbox (event_id, local_order_id, event_type)
      VALUES ('refund-event-1', 'order-1', 'RefundIssued')
    `);
    const { client } = makeClient();

    await makeWorker(client, {
      orderStatus: 'COMPLETED',
      refundEvidence: true,
    }).auditCompletedCorrections();

    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error_code: 'REFUND_CORRECTION_REQUIRED',
    });
  });

  it('detects a correction from a pulled mirror after the local source order was purged', async () => {
    enqueue();
    testDatabase.run(
      'UPDATE invoice_handoffs SET backend_order_id = ? WHERE order_id = ?',
      ['backend-order-1', 'order-1'],
    );
    testDatabase.run(
      `INSERT INTO orders (id, backend_id, status, created_at)
       VALUES (?, ?, 'REFUNDED', ?)`,
      ['backend-order-1', null, '2026-08-30T11:59:00.000Z'],
    );
    const { client } = makeClient();

    await makeWorker(client, { useDatabaseEligibility: true }).wake();

    expect(client.capabilities).not.toHaveBeenCalled();
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error_code: 'REFUND_CORRECTION_REQUIRED',
    });
  });

  it('detects RefundIssued keyed by backend id when the pulled mirror status still lags', async () => {
    enqueue();
    testDatabase.run(
      'UPDATE invoice_handoffs SET backend_order_id = ? WHERE order_id = ?',
      ['backend-order-1', 'order-1'],
    );
    testDatabase.run(
      `INSERT INTO orders (id, backend_id, status, created_at)
       VALUES (?, ?, 'COMPLETED', ?)`,
      ['backend-order-1', 'backend-order-1', '2026-08-30T11:59:00.000Z'],
    );
    testDatabase.run(
      `INSERT INTO pos_event_outbox (event_id, local_order_id, event_type)
       VALUES ('refund-event-1', 'backend-order-1', 'RefundIssued')`,
    );
    const { client } = makeClient();

    await makeWorker(client, { useDatabaseEligibility: true }).wake();

    expect(client.capabilities).not.toHaveBeenCalled();
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error_code: 'REFUND_CORRECTION_REQUIRED',
    });
  });

  it('reconciles a timeout by idempotency status instead of blindly retrying sync', async () => {
    enqueue();
    const { client, calls } = makeClient();
    vi.mocked(client.syncPosOrder).mockImplementation(async () => {
      calls.push('sync');
      throw new InvoiceGatewayBridgeError('handler timed out', 'BRIDGE_TIMEOUT', true);
    });
    vi.mocked(client.getDocumentStatus).mockImplementation(async () => {
      calls.push('status');
      return {
        found: true,
        localOrderId: 'local-order-1',
        orderState: 'READY_TO_INVOICE',
        document: null,
      };
    });

    await makeWorker(client).wake();

    expect(calls).toEqual(['capabilities', 'sync', 'status']);
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'COMPLETED',
      attempts: 1,
    });
  });

  it('queries status before retrying a row recovered in DISPATCHING', async () => {
    enqueue();
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'old-request');
    const { client, calls } = makeClient();

    await makeWorker(client).wake();

    expect(calls).toEqual(['capabilities', 'status', 'sync']);
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'COMPLETED',
      attempts: 2,
    });
  });

  it('recovery-only ignores WAITING rows and never syncs after authoritative not-found', async () => {
    enqueue('waiting-order');
    enqueue('dispatching-order');
    invoiceHandoffRepo.markPending('dispatching-order', 'channel-1');
    invoiceHandoffRepo.markDispatching('dispatching-order', 'channel-1', 'old-request');
    const { client, calls } = makeClient();

    await makeWorker(client).recoverDispatchingOnly();

    expect(calls).toEqual(['capabilities', 'status']);
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(client.getDocumentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'channel-1' }),
      expect.any(String),
    );
    expect(invoiceHandoffRepo.getByOrderId('waiting-order')).toMatchObject({
      status: 'WAITING_ELIGIBILITY',
    });
    expect(invoiceHandoffRepo.getByOrderId('dispatching-order')).toMatchObject({
      status: 'PENDING',
      last_error_code: 'REMOTE_NOT_FOUND',
    });
  });

  it('recovery-only completes a remotely found DISPATCHING row without sync', async () => {
    enqueue();
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'old-request');
    const { client, calls } = makeClient();
    vi.mocked(client.getDocumentStatus).mockImplementation(async () => {
      calls.push('status');
      return {
        found: true,
        localOrderId: 'local-order-1',
        orderState: 'READY_TO_INVOICE',
        document: null,
      };
    });

    await makeWorker(client).recoverDispatchingOnly();

    expect(calls).toEqual(['capabilities', 'status']);
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'COMPLETED',
    });
  });

  it('recovery-only keeps an unknown status outcome DISPATCHING with backoff', async () => {
    enqueue();
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'old-request');
    const { client, calls } = makeClient();
    vi.mocked(client.getDocumentStatus).mockImplementation(async () => {
      calls.push('status');
      throw new InvoiceGatewayBridgeError('status timed out', 'BRIDGE_TIMEOUT', true);
    });

    await makeWorker(client).recoverDispatchingOnly();

    expect(calls).toEqual(['capabilities', 'status']);
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'DISPATCHING',
      last_error_code: 'BRIDGE_TIMEOUT',
      next_attempt_at: '2026-08-30T12:00:30.000Z',
    });
  });

  it('stops the recovery batch after the first retryable status outage', async () => {
    enqueue('order-1');
    enqueue('order-2');
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    invoiceHandoffRepo.markPending('order-2', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'old-request-1');
    invoiceHandoffRepo.markDispatching('order-2', 'channel-1', 'old-request-2');
    const { client, calls } = makeClient();
    vi.mocked(client.getDocumentStatus).mockImplementation(async () => {
      calls.push('status');
      throw new InvoiceGatewayBridgeError('status timed out', 'BRIDGE_TIMEOUT', true);
    });

    await makeWorker(client).recoverDispatchingOnly();

    expect(calls).toEqual(['capabilities', 'status']);
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'DISPATCHING',
      last_error_code: 'BRIDGE_TIMEOUT',
      next_attempt_at: '2026-08-30T12:00:30.000Z',
    });
    expect(invoiceHandoffRepo.getByOrderId('order-2')).toMatchObject({
      status: 'DISPATCHING',
      last_error_code: null,
      next_attempt_at: null,
    });
  });

  it('stops recovery network fan-out but still fences a later cancelled row locally', async () => {
    enqueue('order-1');
    enqueue('order-2');
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    invoiceHandoffRepo.markPending('order-2', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'old-request-1');
    invoiceHandoffRepo.markDispatching('order-2', 'channel-1', 'old-request-2');
    const { client, calls } = makeClient();
    vi.mocked(client.getDocumentStatus).mockImplementation(async () => {
      calls.push('status');
      throw new InvoiceGatewayBridgeError('status timed out', 'BRIDGE_TIMEOUT', true);
    });

    await makeWorker(client, {
      getOrder: (orderId) => ({
        status: orderId === 'order-2' ? 'CANCELLED' : 'COMPLETED',
        created_at: '2026-08-30T11:59:00.000Z',
      }),
    }).recoverDispatchingOnly();

    expect(calls).toEqual(['capabilities', 'status']);
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'DISPATCHING',
      last_error_code: 'BRIDGE_TIMEOUT',
    });
    expect(invoiceHandoffRepo.getByOrderId('order-2')).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error_code: 'CANCELLATION_CORRECTION_REQUIRED',
    });
  });

  it('rechecks a PENDING row and blocks a refund that landed before mutation', async () => {
    enqueue();
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    const { client, calls } = makeClient();

    await makeWorker(client, { orderStatus: 'REFUNDED' }).wake();

    expect(calls).toEqual(['capabilities']);
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(client.getDocumentStatus).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error_code: 'REFUND_CORRECTION_REQUIRED',
    });
  });

  it('preserves sync evidence and routes a refund that lands while mutation is in flight to review', async () => {
    enqueue();
    const { client, calls } = makeClient();
    let orderStatus = 'COMPLETED';
    const syncResult = {
      importResult: 'IMPORTED',
      localOrderId: 'local-order-1',
      orderState: 'READY_TO_INVOICE',
      document: null,
    } as const;
    vi.mocked(client.syncPosOrder).mockImplementation(async () => {
      calls.push('sync');
      orderStatus = 'REFUNDED';
      return syncResult;
    });

    await makeWorker(client, {
      getOrder: () => ({
        status: orderStatus,
        created_at: '2026-08-30T11:59:00.000Z',
      }),
    }).wake();

    expect(calls).toEqual(['capabilities', 'sync']);
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error_code: 'REFUND_CORRECTION_REQUIRED',
      response_json: JSON.stringify(syncResult),
    });
  });

  it('reconciles a DISPATCHING refund, preserves found evidence, and never dispatches again', async () => {
    enqueue();
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'old-request');
    const { client, calls } = makeClient();
    const statusResult = {
      found: true,
      localOrderId: 'local-order-1',
      orderState: 'READY_TO_INVOICE',
      document: null,
    } as const;
    vi.mocked(client.getDocumentStatus).mockImplementation(async () => {
      calls.push('status');
      return statusResult;
    });

    await makeWorker(client, { orderStatus: 'PARTIAL_REFUND' }).wake();

    expect(calls).toEqual(['capabilities', 'status']);
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error_code: 'REFUND_CORRECTION_REQUIRED',
      response_json: JSON.stringify(statusResult),
    });
  });

  it('reconciles a DISPATCHING cancellation, preserves not-found evidence, and never dispatches again', async () => {
    enqueue();
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'old-request');
    const { client, calls } = makeClient();
    const statusResult = { found: false, document: null } as const;
    vi.mocked(client.getDocumentStatus).mockImplementation(async () => {
      calls.push('status');
      return statusResult;
    });

    await makeWorker(client, { orderStatus: 'CANCELLED' }).wake();

    expect(calls).toEqual(['capabilities', 'status']);
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error_code: 'CANCELLATION_CORRECTION_REQUIRED',
      response_json: JSON.stringify(statusResult),
    });
  });

  it('routes a deterministic status conflict to NEEDS_REVIEW instead of retrying forever', async () => {
    enqueue();
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'old-request');
    const { client, calls } = makeClient();
    vi.mocked(client.getDocumentStatus).mockImplementation(async () => {
      calls.push('status');
      throw new InvoiceGatewayBridgeError(
        'An older unverified import already uses this POS order id',
        'IMPORT_CONFLICT',
        false,
      );
    });

    await makeWorker(client).wake();

    expect(calls).toEqual(['capabilities', 'status']);
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error_code: 'IMPORT_CONFLICT',
      next_attempt_at: null,
    });
  });

  it.each(['BRIDGE_PROTOCOL_ERROR', 'RESPONSE_ID_MISMATCH'])(
    'keeps %s status failures ambiguous because the remote mutation outcome is unknown',
    async (code) => {
      enqueue();
      invoiceHandoffRepo.markPending('order-1', 'channel-1');
      invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'old-request');
      const { client, calls } = makeClient();
      vi.mocked(client.getDocumentStatus).mockImplementation(async () => {
        calls.push('status');
        throw new InvoiceGatewayBridgeError('Malformed status response', code, false);
      });

      await makeWorker(client).wake();

      expect(calls).toEqual(['capabilities', 'status']);
      expect(client.syncPosOrder).not.toHaveBeenCalled();
      expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
        status: 'DISPATCHING',
        last_error_code: code,
        next_attempt_at: '2026-08-30T12:00:30.000Z',
      });
    },
  );

  it('moves deterministic channel ambiguity to NEEDS_REVIEW without mutation', async () => {
    enqueue();
    const { client } = makeClient();
    vi.mocked(client.capabilities).mockResolvedValue({
      contractVersion: 1,
      ready: true,
      companyNip: '5220052349',
      supportedIntents: ['FISCALISED_RETAIL'],
      channels: [
        { id: 'channel-1', name: 'POS 1', enabled: true },
        { id: 'channel-2', name: 'POS 2', enabled: true },
      ],
    });

    await makeWorker(client).wake();

    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      last_error_code: 'POS_CHANNEL_AMBIGUOUS',
    });
  });

  it('does not adopt a different sole enabled channel after activation preflight', async () => {
    enqueue();
    const { client, calls } = makeClient();
    vi.mocked(client.capabilities).mockImplementation(async () => {
      calls.push('capabilities');
      return {
        contractVersion: 1,
        ready: true,
        companyNip: '5220052349',
        supportedIntents: ['FISCALISED_RETAIL'],
        channels: [{ id: 'channel-2', name: 'Replacement POS', enabled: true }],
      };
    });

    await makeWorker(client).wake();

    expect(calls).toEqual(['capabilities']);
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(client.getDocumentStatus).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      channel_id: null,
      last_error_code: 'POS_CHANNEL_BINDING_CHANGED',
    });
  });

  it('does not query status or retry DISPATCHING under a replacement channel', async () => {
    enqueue();
    invoiceHandoffRepo.markPending('order-1', 'channel-1');
    invoiceHandoffRepo.markDispatching('order-1', 'channel-1', 'old-request');
    const { client, calls } = makeClient();
    vi.mocked(client.capabilities).mockImplementation(async () => {
      calls.push('capabilities');
      return {
        contractVersion: 1,
        ready: true,
        companyNip: '5220052349',
        supportedIntents: ['FISCALISED_RETAIL'],
        channels: [{ id: 'channel-2', name: 'Replacement POS', enabled: true }],
      };
    });

    await makeWorker(client).wake();

    expect(calls).toEqual(['capabilities']);
    expect(client.getDocumentStatus).not.toHaveBeenCalled();
    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      channel_id: 'channel-1',
      last_error_code: 'POS_CHANNEL_BINDING_CHANGED',
    });
  });

  it('keeps no-fiscal rows waiting because absence is not proof of no print', async () => {
    enqueue('order-old', '2026-08-20T10:00:00.000Z');
    const { client } = makeClient();

    await makeWorker(client, {
      confirmed: false,
      orderCreatedAt: '2026-08-20T10:00:00.000Z',
    }).wake();

    expect(client.capabilities).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-old')).toMatchObject({
      status: 'WAITING_ELIGIBILITY',
      next_attempt_at: '2026-08-30T12:01:00.000Z',
    });
  });

  it.each(['CANCELLED', 'VOIDED'])(
    'routes an explicitly %s fiscal sale to correction review',
    async (orderStatus) => {
      const orderId = `order-${orderStatus.toLowerCase()}`;
      enqueue(orderId);
      const { client } = makeClient();

      await makeWorker(client, { orderStatus }).wake();

      expect(client.capabilities).not.toHaveBeenCalled();
      expect(invoiceHandoffRepo.getByOrderId(orderId)).toMatchObject({
        status: 'NEEDS_REVIEW',
        last_error_code: 'CANCELLATION_CORRECTION_REQUIRED',
      });
    },
  );

  it.each(['REFUNDED', 'PARTIAL_REFUND'])(
    'routes a %s sale to review instead of importing the uncorrected original',
    async (orderStatus) => {
      enqueue(`order-${orderStatus.toLowerCase()}`);
      const { client } = makeClient();

      await makeWorker(client, { orderStatus }).wake();

      expect(client.capabilities).not.toHaveBeenCalled();
      expect(invoiceHandoffRepo.getByOrderId(`order-${orderStatus.toLowerCase()}`)).toMatchObject({
        status: 'NEEDS_REVIEW',
        last_error_code: 'REFUND_CORRECTION_REQUIRED',
      });
    },
  );

  it('backs off while Zira Invoice reports ready=false', async () => {
    enqueue();
    const { client } = makeClient();
    vi.mocked(client.capabilities).mockResolvedValue({
      contractVersion: 1,
      ready: false,
      companyNip: '5220052349',
      supportedIntents: ['FISCALISED_RETAIL'],
      channels: [{ id: 'channel-1', name: 'POS', enabled: true }],
    });

    await makeWorker(client).wake();

    expect(client.syncPosOrder).not.toHaveBeenCalled();
    expect(invoiceHandoffRepo.getByOrderId('order-1')).toMatchObject({
      status: 'PENDING',
      last_error_code: 'ZIRA_INVOICE_NOT_READY',
      next_attempt_at: '2026-08-30T12:00:30.000Z',
    });
  });
});
