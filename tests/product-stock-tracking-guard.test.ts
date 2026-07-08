import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbState, testDatabase } = vi.hoisted(() => {
  const state = { db: null as SqlJsDatabase | null };
  return {
    dbState: state,
    testDatabase: {
      run(sql: string, params?: unknown[]): void {
        state.db?.run(sql, params as any[] | undefined);
      },
      get<T = any>(sql: string, params?: unknown[]): T | null {
        const stmt = state.db!.prepare(sql);
        try {
          if (params) stmt.bind(params as any[]);
          return stmt.step() ? stmt.getAsObject() as T : null;
        } finally {
          stmt.free();
        }
      },
      all<T = any>(sql: string, params?: unknown[]): T[] {
        const stmt = state.db!.prepare(sql);
        try {
          if (params) stmt.bind(params as any[]);
          const rows: T[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as T);
          return rows;
        } finally {
          stmt.free();
        }
      },
      transaction<T>(fn: () => T): T {
        return fn();
      },
    },
  };
});

vi.mock('../src/main/database/database', () => ({ database: testDatabase }));
vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { productRepo } from '../src/main/database/repos/product-repo';

function stockOf(id: string): { in_stock: number; available_qty: number } {
  return testDatabase.get(
    'SELECT in_stock, available_qty FROM product_variants WHERE id = ?',
    [id],
  )!;
}

describe('local stock mutations skip non-tracked items (SQL guard)', () => {
  beforeEach(async () => {
    const SQL = await initSqlJs();
    dbState.db = new SQL.Database();
    dbState.db.run(`
      CREATE TABLE product_variants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        in_stock REAL NOT NULL DEFAULT 0,
        available_qty REAL NOT NULL DEFAULT 0,
        item_type TEXT,
        track_inventory INTEGER
      );
      INSERT INTO product_variants (id, name, in_stock, available_qty, item_type, track_inventory) VALUES
        ('beer',    'Beer bottle',   10, 10, 'stockable', 1),
        ('legacy',  'Pre-v53 row',    7,  7, NULL,        NULL),
        ('fee',     'Service fee',    0,  0, 'service',   0),
        ('untrack', 'No-count item',  5,  5, 'stockable', 0);
    `);
  });

  it('decrements tracked and legacy-NULL rows, never service/untracked rows', () => {
    productRepo.decrementStock('beer', 2, { allowNegative: true });
    productRepo.decrementStock('legacy', 2, { allowNegative: true });
    productRepo.decrementStock('fee', 2, { allowNegative: true });
    productRepo.decrementStock('untrack', 2, { allowNegative: true });

    expect(stockOf('beer').in_stock).toBe(8);
    expect(stockOf('legacy').in_stock).toBe(5); // NULL columns = tracked (pre-migration rows)
    expect(stockOf('fee').in_stock).toBe(0); // service never goes negative
    expect(stockOf('untrack').in_stock).toBe(5); // track_inventory=0 untouched
  });

  it('applies the same guard on the clamped (no-oversell) branch', () => {
    productRepo.decrementStock('beer', 20, {});
    productRepo.decrementStock('fee', 20, {});

    expect(stockOf('beer').in_stock).toBe(0); // clamped at 0
    expect(stockOf('fee').in_stock).toBe(0); // skipped entirely
  });

  it('never restocks non-tracked rows on increment (refund/cancel path)', () => {
    productRepo.incrementStock('beer', 3);
    productRepo.incrementStock('fee', 3);
    productRepo.incrementStock('untrack', 3);

    expect(stockOf('beer').in_stock).toBe(13);
    expect(stockOf('fee').in_stock).toBe(0);
    expect(stockOf('untrack').in_stock).toBe(5);
  });
});
