import { beforeAll, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { migrations, type Migration } from '../src/main/database/migrations';
import { applyAndroidSchema } from '../src/renderer/android-pos/shim/db/schema';

vi.mock('electron', () => ({ app: { getPath: () => 'unused-in-migration-tests' } }));
vi.mock('../src/main/logger', () => ({ default: {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
} }));
import { database } from '../src/main/database/database';

const WindowsDatabase = database.constructor as unknown as {
  applyMigrations(db: SqlJsDatabase, list: Migration[]): { applied: number; repaired: number };
};
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => { SQL = await initSqlJs(); });

function assertColumn(db: SqlJsDatabase): void {
  const columns = db.exec('PRAGMA table_info(order_items)')[0].values
    .filter(row => row[1] === 'restaurant_line_id');
  expect(columns).toHaveLength(1);
  expect(columns[0].slice(1)).toEqual(['restaurant_line_id', 'TEXT', 0, null, 0]);
}

function seedLegacyRows(db: SqlJsDatabase): void {
  for (const [id, source, synced] of [
    ['pending', 'POS', 0], ['local-paid', 'POS', 1], ['server-old', 'SERVER', 1],
  ] as const) {
    db.run(`INSERT INTO orders (
      id, status, source, synced, backend_id, total, subtotal, discount, tax,
      payment_method, payment_amount, change_amount, table_id, covers, order_type,
      mode, sync_payload_json, sync_metadata_eligible
    ) VALUES (?, 'COMPLETED', ?, ?, ?, 1800, 2000, 200, 336,
      'CASH', 2000, 200, 'table-A', 2, 'dine_in', 'restaurant', ?, ?)`,
    [id, source, synced, synced ? `backend-${id}` : null,
      JSON.stringify({ frozen: id, restaurant: { localLineId: 'must-not-backfill' } }), source === 'POS' ? 1 : 0]);
    for (const course of [1, 2]) {
      db.run(`INSERT INTO order_items (
        id, order_id, variant_id, name, sku, price, quantity, total, vat_rate,
        notes, course, allocated_discount, payable_total
      ) VALUES (?, ?, 'same-variant', 'Same meal', 'SAME-SKU', 1000, 1, 1000, 23, ?, ?, 100, 900)`,
      [`${id}-${course}`, id, course === 1 ? 'No onion' : 'Extra sauce', course]);
    }
  }
}

function captureRows(db: SqlJsDatabase, table: 'orders' | 'order_items') {
  const columns = db.exec(`PRAGMA table_info(${table})`)[0].values
    .map(row => String(row[1])).filter(name => name !== 'restaurant_line_id');
  const query = `SELECT ${columns.map(name => `"${name}"`).join(', ')} FROM ${table} ORDER BY id`;
  return { query, rows: db.exec(query)[0].values };
}

describe('restaurant line provenance additive migrations', () => {
  it('creates the nullable column through all Windows migrations on a fresh database', () => {
    const db = new SQL.Database();
    try {
      WindowsDatabase.applyMigrations(db, migrations);
      assertColumn(db);
      seedLegacyRows(db);
      expect(db.exec('SELECT restaurant_line_id FROM order_items')[0].values).toEqual(Array(6).fill([null]));
      expect(WindowsDatabase.applyMigrations(db, migrations)).toEqual({ applied: 0, repaired: 0 });
    } finally { db.close(); }
  });

  it('upgrades Windows v68 without changing any old order/item values or guessing a link', () => {
    const db = new SQL.Database();
    try {
      WindowsDatabase.applyMigrations(db, migrations.filter(entry => entry.version <= 68));
      seedLegacyRows(db);
      const orders = captureRows(db, 'orders'); const items = captureRows(db, 'order_items');
      expect(WindowsDatabase.applyMigrations(db, migrations)).toEqual({ applied: 1, repaired: 0 });
      assertColumn(db);
      expect(db.exec(orders.query)[0].values).toEqual(orders.rows);
      expect(db.exec(items.query)[0].values).toEqual(items.rows);
      expect(db.exec('SELECT restaurant_line_id FROM order_items')[0].values).toEqual(Array(6).fill([null]));
      db.run("UPDATE order_items SET restaurant_line_id = 'exact-origin-line' WHERE id = 'server-old-2'");
      const restored = new SQL.Database(db.export());
      try {
        expect(WindowsDatabase.applyMigrations(restored, migrations)).toEqual({ applied: 0, repaired: 0 });
        expect(restored.exec("SELECT restaurant_line_id FROM order_items WHERE id = 'server-old-2'")[0].values)
          .toEqual([['exact-origin-line']]);
      } finally { restored.close(); }
    } finally { db.close(); }
  });

  it('creates the current Android schema with nullable markers and reapplies safely', () => {
    const db = new SQL.Database();
    try {
      applyAndroidSchema(db); applyAndroidSchema(db);
      assertColumn(db);
      expect(db.exec('PRAGMA user_version')[0].values).toEqual([[13]]);
      seedLegacyRows(db);
      expect(db.exec('SELECT restaurant_line_id FROM order_items')[0].values).toEqual(Array(6).fill([null]));
    } finally { db.close(); }
  });

  it('upgrades and reloads an isolated Android v7 image preserving pending/paid rows and exact links', () => {
    const old = new SQL.Database();
    // Synthetic old image only: remove the new column to reproduce the v7 table.
    applyAndroidSchema(old);
    old.run('ALTER TABLE order_items DROP COLUMN restaurant_line_id');
    old.run('PRAGMA user_version = 7');
    seedLegacyRows(old);
    const orders = captureRows(old, 'orders'); const items = captureRows(old, 'order_items');
    const upgraded = new SQL.Database(old.export()); old.close();
    try {
      applyAndroidSchema(upgraded); applyAndroidSchema(upgraded);
      assertColumn(upgraded);
      expect(upgraded.exec('PRAGMA user_version')[0].values).toEqual([[13]]);
      expect(upgraded.exec(orders.query)[0].values).toEqual(orders.rows);
      expect(upgraded.exec(items.query)[0].values).toEqual(items.rows);
      expect(upgraded.exec('SELECT restaurant_line_id FROM order_items')[0].values).toEqual(Array(6).fill([null]));
      upgraded.run("UPDATE order_items SET restaurant_line_id = 'exact-origin-line' WHERE id = 'server-old-2'");
      const restored = new SQL.Database(upgraded.export());
      try {
        applyAndroidSchema(restored);
        expect(restored.exec(orders.query)[0].values).toEqual(orders.rows);
        expect(restored.exec(items.query)[0].values).toEqual(items.rows);
        expect(restored.exec('SELECT id, restaurant_line_id FROM order_items ORDER BY id')[0].values)
          .toEqual([
            ['local-paid-1', null], ['local-paid-2', null], ['pending-1', null], ['pending-2', null],
            ['server-old-1', null], ['server-old-2', 'exact-origin-line'],
          ]);
      } finally { restored.close(); }
    } finally { upgraded.close(); }
  });
});
