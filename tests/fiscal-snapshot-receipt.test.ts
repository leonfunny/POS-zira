import { beforeEach, describe, expect, it, vi } from 'vitest';

const { databaseMock } = vi.hoisted(() => ({
  databaseMock: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
    save: vi.fn(),
    markDirty: vi.fn(),
  },
}));

vi.mock('../src/main/database/database', () => ({
  database: databaseMock,
}));

import { database } from '../src/main/database/database';
import { fiscalAttemptRepo } from '../src/main/database/repos/fiscal-attempt-repo';

describe('fiscalAttemptRepo snapshot projections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('projects order number and gross total when creating a pending attempt', () => {
    const payloadJson = JSON.stringify({ orderNumber: 'POS-42', total: 1234 });
    vi.mocked(database.get).mockReturnValueOnce({ id: 'attempt-1' } as any);

    fiscalAttemptRepo.createPending({
      orderId: 'order-1',
      paymentId: null,
      attemptNo: 1,
      idempotencyKey: 'idem-1',
      printerType: 'ELZAB_STX',
      payloadJson,
      payloadHash: 'hash-1',
    });

    const [sql, params] = vi.mocked(database.run).mock.calls[0];
    expect(sql).toContain('fiskal_number, gross_total, fiscalized_at');
    expect(sql).toContain("datetime('now')");
    expect(params).toEqual([
      expect.any(String),
      'order-1',
      null,
      1,
      'idem-1',
      'ELZAB_STX',
      payloadJson,
      'hash-1',
      'PENDING',
      'POS-42',
      1234,
    ]);
    expect(database.markDirty).toHaveBeenCalledTimes(1);
  });

  it('returns the latest confirmed fiscal receipt snapshot', () => {
    const snapshot = { orderNumber: 'POS-99', total: 900, items: [] };
    vi.mocked(database.get).mockReturnValueOnce({ payload_json: JSON.stringify(snapshot) } as any);

    expect(fiscalAttemptRepo.getReceiptSnapshot('order-99')).toEqual(snapshot);

    const [sql, params] = vi.mocked(database.get).mock.calls[0];
    expect(sql).toContain("status = 'SUCCESS_CONFIRMED'");
    expect(sql).toContain('ORDER BY attempt_no DESC');
    expect(params).toEqual(['order-99']);
  });

  it('returns null for malformed snapshot JSON', () => {
    vi.mocked(database.get).mockReturnValueOnce({ payload_json: '{bad' } as any);

    expect(fiscalAttemptRepo.getReceiptSnapshot('order-bad')).toBeNull();
  });

  it('backfills fiskal projection columns by parsing payload JSON in JS', () => {
    vi.mocked(database.all).mockReturnValueOnce([
      {
        id: 'attempt-a',
        payload_json: JSON.stringify({ orderNumber: 'POS-A', total: 999.6 }),
        resolved_at: '2026-07-01 12:00:00',
        created_at: '2026-07-01 11:59:00',
      },
      {
        id: 'attempt-b',
        payload_json: '{bad',
        resolved_at: null,
        created_at: '2026-07-01 13:00:00',
      },
    ] as any);

    expect(fiscalAttemptRepo.backfillFiskalColumns()).toBe(2);

    const calls = vi.mocked(database.run).mock.calls;
    expect(calls[0][0]).toContain('UPDATE fiscal_attempts');
    expect(calls[0][1]).toEqual(['POS-A', 1000, '2026-07-01 12:00:00', 'attempt-a']);
    expect(calls[1][1]).toEqual([null, null, '2026-07-01 13:00:00', 'attempt-b']);
    expect(database.markDirty).toHaveBeenCalledTimes(1);
  });
});
