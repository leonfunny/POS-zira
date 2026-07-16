import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbState, testDatabase } = vi.hoisted(() => {
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
      all<T = any>(): T[] {
        return [];
      },
      transaction<T>(fn: () => T): T {
        return fn();
      },
    },
  };
});

vi.mock('../src/main/database/database', () => ({
  database: testDatabase,
}));

vi.mock('../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { productRepo, type CategoryRow } from '../src/main/database/repos/product-repo';

describe('productRepo category image mirror', () => {
  beforeEach(async () => {
    const SQL = await initSqlJs();
    dbState.db = new SQL.Database();
    dbState.db.run(`
      CREATE TABLE categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        image_url TEXT,
        icon TEXT,
        color TEXT,
        sort_order INTEGER DEFAULT 0,
        updated_at TEXT,
        name_translations TEXT,
        customer_display_enabled INTEGER,
        customer_display_section TEXT,
        customer_display_sort_order INTEGER,
        kitchen_print INTEGER DEFAULT 0,
        kiosk_modifier_groups_json TEXT
      );
    `);
  });

  function category(imageUrl: string | null): CategoryRow {
    return {
      id: 'cat-1',
      name: 'Tea',
      image_url: imageUrl,
      icon: null,
      color: null,
      sort_order: 2,
      updated_at: '2026-07-16T20:00:00.000Z',
    };
  }

  it('persists canonical image_url and mirrors an explicit image removal', () => {
    productRepo.upsertCategories([category('https://img.test/categories/tea.webp')]);

    expect(testDatabase.get<{
      image_url: string | null;
      kitchen_print: number;
    }>('SELECT image_url, kitchen_print FROM categories WHERE id = ?', ['cat-1'])).toEqual({
      image_url: 'https://img.test/categories/tea.webp',
      kitchen_print: 0,
    });

    productRepo.upsertCategories([category(null)]);

    expect(testDatabase.get<{ image_url: string | null }>(
      'SELECT image_url FROM categories WHERE id = ?',
      ['cat-1'],
    )?.image_url).toBeNull();
  });
});
