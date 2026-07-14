import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbState,
  testDatabase,
  loggerInfoMock,
  loggerWarnMock,
  loggerDebugMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  ...(() => {
    const state = { db: null as SqlJsDatabase | null };
    return {
      dbState: state,
      testDatabase: {
    run(sql: string, params?: unknown[]): void {
      if (!state.db) throw new Error('test db not initialized');
      state.db.run(sql, params as any[] | undefined);
    },
    get<T = any>(sql: string, params?: unknown[]): T | null {
      if (!state.db) throw new Error('test db not initialized');
      const stmt = state.db.prepare(sql);
      try {
        if (params) stmt.bind(params as any[]);
        return stmt.step() ? (stmt.getAsObject() as T) : null;
      } finally {
        stmt.free();
      }
    },
    all<T = any>(sql: string, params?: unknown[]): T[] {
      if (!state.db) throw new Error('test db not initialized');
      const stmt = state.db.prepare(sql);
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
      if (!state.db) throw new Error('test db not initialized');
      state.db.run('BEGIN');
      try {
        const result = fn();
        state.db.run('COMMIT');
        return result;
      } catch (err) {
        state.db.run('ROLLBACK');
        throw err;
      }
    },
      },
    };
  })(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

let db: SqlJsDatabase;

vi.mock('../src/main/database/database', () => ({
  database: testDatabase,
}));

vi.mock('../src/main/logger', () => ({
  default: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    debug: loggerDebugMock,
    error: loggerErrorMock,
  },
}));

import { productRepo } from '../src/main/database/repos/product-repo';

function all<T = any>(sql: string, params?: unknown[]): T[] {
  return testDatabase.all<T>(sql, params);
}

function get<T = any>(sql: string, params?: unknown[]): T | null {
  return testDatabase.get<T>(sql, params);
}

describe('productRepo.deleteCategoriesExcept', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const SQL = await initSqlJs();
    db = new SQL.Database();
    dbState.db = db;
    db.run('PRAGMA foreign_keys = ON');
    db.run(`
      CREATE TABLE categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE product_variants (
        id TEXT PRIMARY KEY,
        category_id TEXT,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      );
      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        category_id TEXT
      );
      CREATE TABLE kitchen_self_order_category_prefs (
        category_id TEXT PRIMARY KEY
      );
      CREATE TABLE forecast_recommendations (
        id TEXT PRIMARY KEY,
        category_id TEXT
      );
    `);
  });

  it('nullifies product variant category ids before deleting backend-missing categories', () => {
    expect(get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    db.run(`
      INSERT INTO categories (id, name) VALUES
        ('keep-cat', 'Keep'),
        ('ghost-cat', 'Ghost'),
        ('unused-ghost-cat', 'Unused Ghost');
      INSERT INTO product_variants (id, category_id, is_active) VALUES
        ('variant-1', 'ghost-cat', 0),
        ('variant-2', 'keep-cat', 1);
    `);

    const result = productRepo.deleteCategoriesExcept(new Set(['keep-cat']));

    expect(result.removed).toBe(2);
    expect(result.categories.map((category) => category.id).sort()).toEqual([
      'ghost-cat',
      'unused-ghost-cat',
    ]);
    expect(all<{ id: string }>('SELECT id FROM categories ORDER BY id')).toEqual([
      { id: 'keep-cat' },
    ]);
    expect(get<{ category_id: string | null }>(
      "SELECT category_id FROM product_variants WHERE id = 'variant-1'",
    )?.category_id).toBeNull();
    expect(get<{ category_id: string | null }>(
      "SELECT category_id FROM product_variants WHERE id = 'variant-2'",
    )?.category_id).toBe('keep-cat');
  });

  it('warns when non-FK category_id tables still point at categories being pruned', () => {
    db.run(`
      INSERT INTO categories (id, name) VALUES
        ('keep-cat', 'Keep'),
        ('ghost-cat', 'Ghost');
      INSERT INTO services (id, category_id) VALUES ('service-1', 'ghost-cat');
      INSERT INTO kitchen_self_order_category_prefs (category_id) VALUES ('ghost-cat');
      INSERT INTO forecast_recommendations (id, category_id) VALUES ('forecast-1', 'ghost-cat');
    `);

    productRepo.deleteCategoriesExcept(new Set(['keep-cat']));

    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('services'),
      expect.objectContaining({ rows: 1 }),
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('kitchen_self_order_category_prefs'),
      expect.objectContaining({ rows: 1 }),
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('forecast_recommendations'),
      expect.objectContaining({ rows: 1 }),
    );
  });

  it('deletes every category and nullifies references for an authoritative empty snapshot', () => {
    db.run(`
      INSERT INTO categories (id, name) VALUES
        ('cat-1', 'One'),
        ('cat-2', 'Two');
      INSERT INTO product_variants (id, category_id, is_active) VALUES
        ('variant-1', 'cat-1', 1),
        ('variant-2', 'cat-2', 0);
    `);

    const result = productRepo.deleteCategoriesExcept(new Set());

    expect(result).toEqual({
      removed: 2,
      categories: [
        { id: 'cat-1', name: 'One' },
        { id: 'cat-2', name: 'Two' },
      ],
    });
    expect(all<{ id: string }>('SELECT id FROM categories ORDER BY id')).toEqual([]);
    expect(all<{ id: string; category_id: string | null }>(
      'SELECT id, category_id FROM product_variants ORDER BY id',
    )).toEqual([
      { id: 'variant-1', category_id: null },
      { id: 'variant-2', category_id: null },
    ]);
  });
});
