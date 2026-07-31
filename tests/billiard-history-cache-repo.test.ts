import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    all: vi.fn(),
    run: vi.fn(),
    transaction: vi.fn((fn: () => void) => fn()),
  },
}));

import { database } from '../src/main/database/database';
import { billiardHistoryCacheRepo } from '../src/main/database/repos/billiard-history-cache-repo';
import type { HistorySessionRow } from '../src/shared/billiard-history-contract';

function row(overrides: Partial<HistorySessionRow> = {}): HistorySessionRow {
  return {
    id: 's1',
    resource_id: 'r1',
    status: 'COMPLETED',
    payment_status: 'PAID',
    billing_mode: 'PER_MINUTE',
    guest_count: 2,
    started_at: '2026-07-31T12:00:00.000Z',
    ended_at: '2026-07-31T13:00:00.000Z',
    total_minutes: 60,
    total_charge: 60,
    time_charge: 50,
    fnb_charge: 10,
    package_mode: 0,
    package_price: null,
    customer_name: 'Anh Minh',
    tableName: 'Bàn #1',
    items: [{ id: 'i1', name: 'Cola', quantity: 1, unit_price: 10, total_price: 10 }],
    payments: [{ id: 'p1', method: 'CASH', amount: 60, createdAt: '2026-07-31T13:00:00.000Z' }],
    ...overrides,
  };
}

describe('billiardHistoryCacheRepo', () => {
  beforeEach(() => {
    vi.mocked(database.run).mockReset();
    vi.mocked(database.all).mockReset();
  });

  it('upserts rows with a lowercase search blob of table, customer and items', () => {
    billiardHistoryCacheRepo.upsertMany([row()]);
    expect(database.run).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(database.run).mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO billiard_history_cache');
    expect(params?.[0]).toBe('s1');
    expect(params?.[6]).toContain('bàn #1');
    expect(params?.[6]).toContain('anh minh');
    expect(params?.[6]).toContain('cola');
    // Payload round-trips the full row.
    expect(JSON.parse(String(params?.[7])).items[0].name).toBe('Cola');
  });

  it('queries a half-open day range with filters and parses payloads', () => {
    vi.mocked(database.all)
      .mockReturnValueOnce([{ n: 1 }] as any)
      .mockReturnValueOnce([{ payload: JSON.stringify(row()) }] as any);

    const result = billiardHistoryCacheRepo.query({
      dateFrom: '2026-07-30',
      dateTo: '2026-07-31',
      status: 'COMPLETED',
      resourceId: 'r1',
      search: 'cola',
      limit: 20,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.sessions[0].tableName).toBe('Bàn #1');
    const [, countParams] = vi.mocked(database.all).mock.calls[0];
    expect(countParams?.[0]).toBe('2026-07-30T00:00:00.000Z');
    expect(countParams?.[1]).toBe('2026-08-01T00:00:00.000Z');
    expect(countParams).toContain('COMPLETED');
    expect(countParams).toContain('r1');
    expect(countParams).toContain('%cola%');
  });

  it('skips corrupt payload rows instead of crashing the tab', () => {
    vi.mocked(database.all)
      .mockReturnValueOnce([{ n: 2 }] as any)
      .mockReturnValueOnce([
        { payload: '{broken json' },
        { payload: JSON.stringify(row({ id: 's2' })) },
      ] as any);

    const result = billiardHistoryCacheRepo.query({
      dateFrom: '2026-07-30',
      dateTo: '2026-07-31',
      limit: 20,
      offset: 0,
    });
    expect(result.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(result.total).toBe(2);
  });

  it('prunes rows older than the retention window', () => {
    billiardHistoryCacheRepo.pruneOlderThan(30);
    const [sql, params] = vi.mocked(database.run).mock.calls[0];
    expect(String(sql)).toContain('DELETE FROM billiard_history_cache');
    expect(params?.[0]).toBe('-30 days');
  });
});
