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

describe('product admin inactive catalog', () => {
  beforeEach(async () => {
    const SQL = await initSqlJs();
    dbState.db = new SQL.Database();
    dbState.db.run(`
      CREATE TABLE product_variants (
        id TEXT PRIMARY KEY,
        template_id TEXT,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL
      );
      INSERT INTO product_variants (id, template_id, name, is_active) VALUES
        ('active', NULL, 'Active product', 1),
        ('inactive', NULL, 'Inactive product', 0);
    `);
  });

  it('keeps the sales catalog active-only', () => {
    expect(productRepo.getAll().map((row) => row.id)).toEqual(['active']);
  });

  it('returns inactive products only through the admin catalog read', () => {
    expect(productRepo.getAllIncludingInactive().map((row) => row.id)).toEqual([
      'active',
      'inactive',
    ]);
  });
});
