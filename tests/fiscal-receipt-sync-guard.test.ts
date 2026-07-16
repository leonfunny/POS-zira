import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMock = vi.hoisted(() => ({
  get: vi.fn(),
  all: vi.fn(),
  run: vi.fn(),
  markDirty: vi.fn(),
}));

vi.mock('../src/main/database/database', () => ({
  database: databaseMock,
}));

import {
  FiscalReceiptOrderPendingSyncError,
  fiscalReceiptSyncRepo,
  prepareFiscalReceiptSyncBody,
  type FiscalReceiptSyncRow,
} from '../src/main/database/repos/fiscal-receipt-sync-repo';

function row(overrides: Partial<FiscalReceiptSyncRow> = {}): FiscalReceiptSyncRow {
  return {
    id: 'event-1',
    local_order_id: 'c542aff6-5ea3-4f22-b62b-f111a59dfd8d',
    backend_order_id: 'c542aff6-5ea3-4f22-b62b-f111a59dfd8d',
    event_status: 'PRINTED',
    status: 'PENDING',
    event_body_json: JSON.stringify({
      b2bOrderId: 'c542aff6-5ea3-4f22-b62b-f111a59dfd8d',
      status: 'PRINTED',
      metadata: { fiscalReceiptSyncId: 'event-1' },
    }),
    attempts: 0,
    last_error: null,
    created_at: null,
    updated_at: null,
    synced_at: null,
    ...overrides,
  };
}

describe('fiscal receipt sync backend-order guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defers instead of sending a local UUID before the order has synced', () => {
    expect(() => prepareFiscalReceiptSyncBody(row(), null))
      .toThrow(FiscalReceiptOrderPendingSyncError);
  });

  it('replaces a queued local UUID with the confirmed backend order id', () => {
    const backendOrderId = '33333333-3333-4333-8333-333333333333';

    expect(prepareFiscalReceiptSyncBody(row(), backendOrderId)).toEqual({
      b2bOrderId: backendOrderId,
      status: 'PRINTED',
      metadata: { fiscalReceiptSyncId: 'event-1' },
    });
  });

  it('normalizes harmless backend-id whitespace before sending', () => {
    expect(prepareFiscalReceiptSyncBody(
      row(),
      ' 33333333-3333-4333-8333-333333333333 ',
    )).toMatchObject({
      b2bOrderId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('keeps the integration guard in the POS sender and does not count deferred rows as failures', () => {
    const source = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('prepareFiscalReceiptSyncBody(');
    expect(source).toContain('order?.backend_id,');
    expect(source).toContain('err instanceof FiscalReceiptOrderPendingSyncError');
    expect(source).toContain("if (reason !== 'timer')");
    expect(source).toContain('if (!auth.apiKey && !auth.token)');
    expect(source).toContain('fiscalReceiptSyncRepo.listReady(25)');
    expect(source).not.toContain('const backendOrderId = order?.backend_id || input.orderId;');
  });

  it('selects only backend-ready rows and backs off real failures up to hourly retries', () => {
    databaseMock.all.mockReturnValue([]);

    fiscalReceiptSyncRepo.listReady(25);

    const [sql, params] = databaseMock.all.mock.calls[0];
    expect(sql).toContain('JOIN orders o ON o.id = q.local_order_id');
    expect(sql).toContain("q.status = 'PENDING'");
    expect(sql).toContain("o.backend_id IS NOT NULL");
    expect(sql).toContain("lower(trim(o.backend_id)) NOT GLOB '*[^0-9a-f-]*'");
    expect(sql).toContain("WHEN q.attempts = 1 THEN '+1 minute'");
    expect(sql).toContain("WHEN q.attempts = 5 THEN '+30 minutes'");
    expect(sql).toContain("ELSE '+60 minutes'");
    expect(sql).toContain("<= datetime('now')");
    expect(params).toEqual([25]);
  });

  it('deduplicates by local order and event status while the backend id is unknown', () => {
    databaseMock.get
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(row());

    fiscalReceiptSyncRepo.enqueue({
      localOrderId: row().local_order_id,
      backendOrderId: row().backend_order_id,
      status: 'PRINTED',
      body: JSON.parse(row().event_body_json),
    });

    const [sql, params] = databaseMock.get.mock.calls[0];
    expect(sql).toContain('WHERE local_order_id = ? AND event_status = ?');
    expect(params).toEqual([row().local_order_id, 'PRINTED']);
  });
});
