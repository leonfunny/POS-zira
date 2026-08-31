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
    getOrder?: () => { status: string; created_at: string } | null;
  } = {},
) {
  return new InvoiceHandoffWorker({
    getScope: () => ({ salonId: 'salon-1', tenantGeneration: 4 }),
    client,
    repo: invoiceHandoffRepo,
    eligibility: {
      getOrder: options.getOrder ?? (() => ({
        status: options.orderStatus ?? 'COMPLETED',
        created_at: options.orderCreatedAt ?? '2026-08-30T11:59:00.000Z',
      })),
      hasConfirmedFiscalReceipt: () => options.confirmed ?? true,
    },
    flush: vi.fn(async () => ({ success: true })),
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
