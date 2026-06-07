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
    vi.mocked(database.get).mockReturnValue({
      order_count: 1,
      total_sales: 10000,
      cash_total: 0,
      card_total: 10000,
    } as any);

    const stats = orderRepo.getDailyStats('2026-06-03', true);

    expect(stats.order_count).toBe(1);
    const sql = vi.mocked(database.get).mock.calls[0][0] as string;
    expect(sql).toContain('fiscal_attempts');
    expect(sql).toContain('SUCCESS_CONFIRMED');
  });
});
