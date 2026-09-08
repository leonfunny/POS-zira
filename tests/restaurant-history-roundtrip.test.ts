import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, testDatabase } = vi.hoisted(() => {
  const state = { db: null as SqlJsDatabase | null };
  const all = (sql: string, params?: any[]): any[] => {
    const stmt = state.db!.prepare(sql);
    try {
      if (params) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  };
  return { state, testDatabase: {
    all,
    get: (sql: string, params?: any[]) => all(sql, params)[0] ?? null,
    run: (sql: string, params?: any[]) => { state.db!.run(sql, params); },
    markDirty: vi.fn(),
    transaction: (fn: () => any) => {
      state.db!.run('BEGIN');
      try { const result = fn(); state.db!.run('COMMIT'); return result; }
      catch (error) { state.db!.run('ROLLBACK'); throw error; }
    },
  } };
});
vi.mock('electron', () => ({ app: { getPath: () => 'unused-in-history-test' } }));
vi.mock('../src/main/database/database', () => ({ database: testDatabase }));
vi.mock('../src/main/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/main/events/pos-event-emitter', () => ({ posEventEmitter: { emitOrderFinalized: vi.fn() } }));

import { migrations } from '../src/main/database/migrations';
import { orderRepo } from '../src/main/database/repos/order-repo';
import { adaptServerOrder, adaptServerOrderItem } from '../src/main/sync/pos-order-adapter';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
let applyMigrations: (db: SqlJsDatabase, list: typeof migrations) => unknown;
beforeAll(async () => {
  SQL = await initSqlJs();
  const actual = await vi.importActual<typeof import('../src/main/database/database')>('../src/main/database/database');
  applyMigrations = (actual.database.constructor as any).applyMigrations;
});
beforeEach(() => {
  state.db = new SQL.Database();
  applyMigrations(state.db, migrations);
});
afterEach(() => { state.db?.close(); vi.restoreAllMocks(); });

function payload(linked = true): any {
  const line = (suffix: string, notes: string, course: number, lineIndex: number) => ({
    localLineId: `local-${suffix}`, ...(linked ? { orderItemId: `server-${suffix}` } : {}),
    productId: 'tea', lineIndex, notes, course,
  });
  const product = (suffix: string) => ({ id: `server-${suffix}`, productId: 'tea', productName: 'Tea',
    quantity: 1, totalUnits: 1, unitPrice: '10.00', totalPrice: '10.00', grossUnitPrice: '10.00', grossTotalPrice: '10.00', taxRate: 0 });
  return { id: 'order-1', orderNumber: 'POS-1', status: 'COMPLETED', posMode: 'restaurant', posOrderType: 'dine_in',
    subtotal: '20.00', discountAmount: '0.00', taxAmount: '0.00', total: '20.00', paidAmount: '20.00', paymentMethod: 'CASH',
    externalMetadata: { meta: { restaurant: { schemaVersion: 1, tableId: 'table-1', covers: 2,
      lines: [line('a', 'No sugar', 2, 0), line('b', 'Extra ice', 4, 1)] } } },
    items: [product('b'), product('a')], // Deliberately reversed relative to input snapshot.
  };
}
function ingest(p: any) {
  return orderRepo.upsertFromServer(adaptServerOrder(p), p.items.map((item: any) => adaptServerOrderItem(item, p.id, p)));
}
function lines() {
  return testDatabase.all('SELECT id, notes, course, restaurant_line_id, price, total FROM order_items ORDER BY id');
}

describe('restaurant history actual SQLite round-trip', () => {
  it('stores exact line links through reversed duplicate-product import and DB reopen', () => {
    expect(ingest(payload()).inserted).toBe(true);
    const expected = [
      { id: 'server-a', notes: 'No sugar', course: 2, restaurant_line_id: 'local-a', price: 1000, total: 1000 },
      { id: 'server-b', notes: 'Extra ice', course: 4, restaurant_line_id: 'local-b', price: 1000, total: 1000 },
    ];
    expect(lines()).toEqual(expected);
    const bytes = state.db!.export(); state.db!.close(); state.db = new SQL.Database(bytes);
    applyMigrations(state.db, migrations);
    expect(lines()).toEqual(expected);
    expect(orderRepo.getById('order-1')).toMatchObject({ table_id: 'table-1', covers: 2, total: 2000, source: 'SERVER' });
    expect(ingest(payload()).inserted).toBe(false);
    expect(lines()).toEqual(expected);
  });
  it('repairs an old unlinked server mirror without replacing its item IDs or money', () => {
    ingest(payload(false));
    expect(lines().every(line => line.restaurant_line_id === null && line.notes === null)).toBe(true);
    testDatabase.run('UPDATE order_items SET course = 1'); // Historical import default, not trusted provenance.
    ingest(payload());
    expect(lines()).toEqual([
      { id: 'server-a', notes: 'No sugar', course: 2, restaurant_line_id: 'local-a', price: 1000, total: 1000 },
      { id: 'server-b', notes: 'Extra ice', course: 4, restaurant_line_id: 'local-b', price: 1000, total: 1000 },
    ]);
  });
  it('never replaces local sale notes or its frozen upload with server history', () => {
    ingest(payload(false));
    testDatabase.run("UPDATE orders SET source = 'POS', sync_payload_json = 'frozen-upload', table_id = 'local-table'");
    testDatabase.run("UPDATE order_items SET notes = 'local-only', course = 9");
    const before = lines();
    ingest(payload());
    expect(lines()).toEqual(before);
    expect(orderRepo.getById('order-1')).toMatchObject({ sync_payload_json: 'frozen-upload', table_id: 'local-table', total: 2000 });
  });
  it('does not attach notes from an ambiguous server link set', () => {
    const p = payload();
    p.externalMetadata.meta.restaurant.lines[1].orderItemId = 'server-a';
    ingest(p);
    expect(lines().every(line => line.restaurant_line_id === null && line.notes === null)).toBe(true);
  });
  it('rolls back the entire header/line repair when a later SQLite write fails', () => {
    ingest(payload(false));
    const before = lines();
    const originalRun = testDatabase.run;
    vi.spyOn(testDatabase, 'run').mockImplementation((sql, params) => {
      if (sql.includes('UPDATE order_items SET notes') && params?.includes('server-a')) throw new Error('disk write fixture');
      originalRun(sql, params);
    });
    const p = payload(); p.externalMetadata.meta.restaurant.covers = 9;
    expect(() => ingest(p)).toThrow('disk write fixture');
    expect(lines()).toEqual(before);
    expect(orderRepo.getById('order-1')?.covers).toBe(2);
  });
  it('does not rebind an existing proven line or partially apply its companion lines', () => {
    ingest(payload());
    const before = lines();
    const p = payload();
    p.externalMetadata.meta.restaurant.lines[0].localLineId = 'different-original-line';
    p.externalMetadata.meta.restaurant.lines[1].notes = 'Do not partially apply';
    ingest(p);
    expect(lines()).toEqual(before);
  });
});
