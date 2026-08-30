import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
    transaction: vi.fn((fn: () => void) => fn()),
    markDirty: vi.fn(),
  },
}));

vi.mock('../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/main/events/pos-event-emitter', () => ({
  posEventEmitter: {
    emitOrderFinalized: vi.fn(),
  },
}));

import { database } from '../src/main/database/database';
import { orderRepo } from '../src/main/database/repos/order-repo';

describe('orderRepo fiscal visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds has_fiscal to local history rows without filtering the count', () => {
    vi.mocked(database.get).mockReturnValue({ cnt: 2 } as any);
    vi.mocked(database.all).mockReturnValue([
      { id: 'fiscal-order', has_fiscal: 1 },
      { id: 'non-fiscal-order', has_fiscal: 0 },
    ] as any);

    const result = orderRepo.getByDateRange('2026-06-03', '2026-06-03', 20, 0);

    expect(result.total).toBe(2);
    expect(result.orders.map((o) => o.has_fiscal)).toEqual([1, 0]);
    const countSql = vi.mocked(database.get).mock.calls[0][0] as string;
    const rowsSql = vi.mocked(database.all).mock.calls[0][0] as string;
    expect(countSql).not.toContain('fiscal_attempts');
    expect(rowsSql).toContain('has_fiscal');
    expect(rowsSql).toContain('fiscal_attempts');
    expect(rowsSql).toContain('SUCCESS_CONFIRMED');
    expect(rowsSql).toContain('ORDER BY julianday(orders.created_at) DESC, orders.created_at DESC');
    expect(rowsSql).not.toContain('ORDER BY created_at DESC');
  });

  it('filters history count and rows to successful fiscal prints when fiscalOnly is requested', () => {
    vi.mocked(database.get).mockReturnValue({ cnt: 1 } as any);
    vi.mocked(database.all).mockReturnValue([
      { id: 'fiscal-order', has_fiscal: 1 },
    ] as any);

    const result = orderRepo.getByDateRange('2026-06-03', '2026-06-03', 20, 0, { fiscalOnly: true });

    expect(result.total).toBe(1);
    expect(result.orders.map((o) => o.has_fiscal)).toEqual([1]);
    const countSql = vi.mocked(database.get).mock.calls[0][0] as string;
    const rowsSql = vi.mocked(database.all).mock.calls[0][0] as string;
    expect(countSql).toContain('fiscal_attempts');
    expect(countSql).toContain('SUCCESS_CONFIRMED');
    expect(rowsSql).toContain('fiscal_attempts');
    expect(rowsSql).toContain('SUCCESS_CONFIRMED');
    expect(rowsSql).toContain('ORDER BY julianday(orders.created_at) DESC, orders.created_at DESC');
    expect(rowsSql).not.toContain('ORDER BY created_at DESC');
  });

  it('applies payment and staff filters in SQL before pagination', () => {
    vi.mocked(database.get).mockReturnValue({ cnt: 1 } as any);
    vi.mocked(database.all).mockReturnValue([
      { id: 'filtered-fiscal-order', has_fiscal: 1 },
    ] as any);

    orderRepo.getByDateRange('2026-06-03', '2026-06-03', 20, 0, {
      fiscalOnly: true,
      paymentMethod: 'TRANSFER',
      staffName: 'Ann',
    });

    const countSql = vi.mocked(database.get).mock.calls[0][0] as string;
    const countParams = vi.mocked(database.get).mock.calls[0][1] as any[];
    const rowsSql = vi.mocked(database.all).mock.calls[0][0] as string;
    const rowsParams = vi.mocked(database.all).mock.calls[0][1] as any[];

    expect(countSql).toContain('orders.payment_method IN (?, ?)');
    expect(countSql).toContain("LOWER(COALESCE(orders.staff_name, '')) LIKE ?");
    expect(rowsSql).toContain('orders.payment_method IN (?, ?)');
    expect(rowsSql).toContain("LOWER(COALESCE(orders.staff_name, '')) LIKE ?");
    expect(countParams).toEqual(['2026-06-03', '2026-06-03', 'BANK_TRANSFER', 'TRANSFER', '%ann%']);
    expect(rowsParams).toEqual(['2026-06-03', '2026-06-03', 'BANK_TRANSFER', 'TRANSFER', '%ann%', 20, 0]);
  });

  it('filters daily stats to successful fiscal prints when fiscalOnly is requested', () => {
    vi.mocked(database.all)
      .mockReturnValueOnce([
        { total: 10000, payment_method: 'CARD', payment_tenders: null },
      ] as any)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);

    const stats = orderRepo.getDailyStats('2026-06-03', true);

    expect(stats.order_count).toBe(1);
    const sql = vi.mocked(database.all).mock.calls[0][0] as string;
    expect(sql).toContain('fiscal_attempts');
    expect(sql).toContain('SUCCESS_CONFIRMED');
    expect(sql).toContain("date(orders.created_at, 'localtime') = date(?)");
  });

  it('nets RefundIssued from the refund day, including an order sold on an older shift', () => {
    vi.mocked(database.all)
      .mockReturnValueOnce([
        { total: 8000, payment_method: 'CASH', payment_tenders: null },
        { total: 2000, payment_method: 'CARD', payment_tenders: null },
      ] as any)
      .mockReturnValueOnce([
        {
          event_id: 'refund-event-0008',
          local_order_id: 'order-0008',
          payload_json: JSON.stringify({ amountMinor: 1461, method: 'cash' }),
        },
      ] as any)
      .mockReturnValueOnce([]);

    const stats = orderRepo.getDailyStats('2026-07-17');

    expect(stats).toMatchObject({
      order_count: 2,
      total_sales: 8539,
      cash_total: 6539,
      card_total: 2000,
      refund_count: 1,
      refund_total: 1461,
    });
    const eventSql = vi.mocked(database.all).mock.calls[1][0] as string;
    expect(eventSql).toContain("e.event_type = 'RefundIssued'");
    expect(eventSql).toContain("date(e.occurred_at, 'localtime') = date(?)");
    expect(eventSql).not.toContain('e.status');
  });

  it('nets split-tender gross sales and refunds by the same payment allocation', () => {
    vi.mocked(database.all)
      .mockReturnValueOnce([
        {
          total: 1000,
          payment_method: 'SPLIT',
          payment_tenders: JSON.stringify([
            { method: 'CASH', amount: 600 },
            { method: 'CARD', amount: 400 },
          ]),
        },
      ] as any)
      .mockReturnValueOnce([
        {
          event_id: 'split-refund-event',
          local_order_id: 'split-order',
          payload_json: JSON.stringify({
            amountMinor: 500,
            method: 'SPLIT',
            tenderAllocations: [
              { method: 'CASH', amountMinor: 300 },
              { method: 'CARD', amountMinor: 200 },
            ],
          }),
        },
      ] as any)
      .mockReturnValueOnce([]);

    expect(orderRepo.getDailyStats('2026-07-18')).toMatchObject({
      order_count: 1,
      total_sales: 500,
      cash_total: 300,
      card_total: 200,
      refund_count: 1,
      refund_total: 500,
    });
  });

  it('SQLite localtime buckets a 00:30 Warsaw refund into the local calendar day', async () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'Europe/Warsaw';
    try {
      const initSqlJs = (await import('sql.js')).default;
      const SQL = await initSqlJs();
      const db = new SQL.Database();
      db.run('CREATE TABLE refunds (occurred_at TEXT NOT NULL)');
      db.run('INSERT INTO refunds (occurred_at) VALUES (?)', ['2026-07-17T22:30:00.000Z']);

      const result = db.exec(`
        SELECT
          SUM(date(occurred_at) = date('2026-07-18')) AS utc_bucket,
          SUM(date(occurred_at, 'localtime') = date('2026-07-18')) AS local_bucket
        FROM refunds
      `)[0];

      expect(result.values[0]).toEqual([0, 1]);
      db.close();
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });

  it('uses exact split tender allocations from the event journal', () => {
    vi.mocked(database.all)
      .mockReturnValueOnce([
        {
          event_id: 'split-refund-event',
          local_order_id: 'split-order',
          payload_json: JSON.stringify({
            amountMinor: 1000,
            method: 'mixed',
            tenderAllocations: [
              { method: 'cash', amountMinor: 600 },
              { method: 'card', amountMinor: 400 },
            ],
          }),
        },
      ] as any)
      .mockReturnValueOnce([]);

    const refunds = orderRepo.getRefundCashflowForDate('2026-07-17');

    expect(refunds).toEqual({
      refund_count: 1,
      refund_total: 1000,
      cash_refund_total: 600,
      card_refund_total: 400,
      blik_refund_total: 0,
      transfer_refund_total: 0,
    });
  });

  it('deduplicates replayed legacy events by refundRequestId', () => {
    const payload = (refundId: string) => JSON.stringify({
      refundId,
      amountMinor: 700,
      method: 'cash',
      items: [{ refundRequestId: 'same-refund-request' }],
    });
    vi.mocked(database.all)
      .mockReturnValueOnce([
        { event_id: 'event-a', local_order_id: 'order-a', payload_json: payload('timestamp-a') },
        { event_id: 'event-b', local_order_id: 'order-a', payload_json: payload('timestamp-b') },
      ] as any)
      .mockReturnValueOnce([]);

    const refunds = orderRepo.getRefundCashflowForDate('2026-07-17');

    expect(refunds.refund_count).toBe(1);
    expect(refunds.refund_total).toBe(700);
  });

  it('adds only the residual legacy refund_amount after journaled refund deltas', () => {
    vi.mocked(database.all)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        {
          id: 'legacy-order',
          refund_amount: 1000,
          payment_method: 'SPLIT',
          payment_tenders: JSON.stringify([
            { method: 'CASH', amount: 600 },
            { method: 'BANK_TRANSFER', amount: 400 },
          ]),
        },
      ] as any)
      .mockReturnValueOnce([
        {
          event_id: 'legacy-journal-event',
          local_order_id: 'legacy-order',
          payload_json: JSON.stringify({ amountMinor: 400, method: 'cash' }),
        },
      ] as any);

    const refunds = orderRepo.getRefundCashflowForDate('2026-07-17');

    expect(refunds.refund_total).toBe(600);
    expect(refunds.cash_refund_total).toBe(360);
    expect(refunds.transfer_refund_total).toBe(240);
    const journalSql = vi.mocked(database.all).mock.calls[2][0] as string;
    const journalParams = vi.mocked(database.all).mock.calls[2][1] as string[];
    expect(journalSql).toContain('e.local_order_id IN (?)');
    expect(journalParams).toEqual(['legacy-order']);
  });

  it('uses tagged shift refunds first and half-open time fallback only for untagged events', () => {
    vi.mocked(database.all)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);

    orderRepo.getRefundCashflowBetween(
      '2026-07-17T08:00:00.000Z',
      '2026-07-17T16:00:00.000Z',
      false,
      'local-shift-1',
    );

    const eventSql = vi.mocked(database.all).mock.calls[0][0] as string;
    const eventParams = vi.mocked(database.all).mock.calls[0][1] as string[];
    const legacySql = vi.mocked(database.all).mock.calls[1][0] as string;
    expect(eventSql).toContain('e.shift_id = ?');
    expect(eventSql).toContain('e.shift_id IS NULL');
    expect(eventSql).toContain('julianday(e.occurred_at) < julianday(?)');
    expect(eventSql).not.toContain('julianday(e.occurred_at) <= julianday(?)');
    expect(eventParams).toEqual([
      'local-shift-1',
      '2026-07-17T08:00:00.000Z',
      '2026-07-17T16:00:00.000Z',
    ]);
    expect(legacySql).toContain('julianday(orders.refunded_at) < julianday(?)');
  });

  it('limits fiscal-only refunds to orders with a confirmed fiscal attempt', () => {
    vi.mocked(database.all)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);

    orderRepo.getRefundCashflowBetween(
      '2026-07-17T08:00:00.000Z',
      '2026-07-17T16:00:00.000Z',
      true,
    );

    const eventSql = vi.mocked(database.all).mock.calls[0][0] as string;
    const legacySql = vi.mocked(database.all).mock.calls[1][0] as string;
    expect(eventSql).toContain('fa.order_id = e.local_order_id');
    expect(eventSql).toContain("fa.status = 'SUCCESS_CONFIRMED'");
    expect(legacySql).toContain('fa.order_id = orders.id');
    expect(legacySql).toContain("fa.status = 'SUCCESS_CONFIRMED'");
  });
});
