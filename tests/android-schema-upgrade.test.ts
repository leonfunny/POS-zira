/**
 * Upgrading a REAL installed database, v4 → v8.
 *
 * Every schema test so far has run against a database created fresh by the
 * current code, which is the one case that cannot go wrong. The case that can
 * is the one every salon tablet will actually hit: an image written by the last
 * released APK (schema v4, `zira-pos-android-debug-dff711a.apk`) opened by this
 * build, with a shift open and a paid order not yet synced.
 *
 * `applyAndroidSchema` runs on every boot and is supposed to be additive, so
 * this asserts the two things that matter: the new shape arrives, and NOTHING
 * that was already on disk is lost. A migration that drops a paid order is a
 * salon losing money, and it would surface as "the order just isn't there".
 *
 * The v4 DDL is extracted from git rather than hand-written — see
 * tests/fixtures/android/schema-v4.ddl.sql.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';
import initSqlJs from 'sql.js';

import { ANDROID_SCHEMA_VERSION, applyAndroidSchema } from '../src/renderer/android-pos/shim/db/schema';

const V4_DDL = readFileSync(join(__dirname, 'fixtures/android/schema-v4.ddl.sql'), 'utf8');

/** A tablet that has been selling: catalog, an open shift, a paid unsynced order. */
async function tabletOnSchemaV4() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const statement of V4_DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
    db.run(statement);
  }
  db.run('PRAGMA user_version = 4');

  db.run(
    `INSERT INTO product_variants (id, name, sku, retail_price, vat_rate, is_active)
     VALUES ('v1', 'Tiger', 'TG', 900, 23, 1)`,
  );
  db.run(
    `INSERT INTO shifts (id, staff_id, staff_name, opening_cash, opened_at)
     VALUES ('shift-old', 'u1', 'Anna', 20000, '2026-07-30T08:00:00.000Z')`,
  );
  db.run(
    `INSERT INTO orders (id, order_number, status, subtotal, total, payment_method, shift_id, synced, created_at)
     VALUES ('order-old', 'POS-20260730-0001', 'COMPLETED', 1800, 1800, 'CASH', 'shift-old', 0, '2026-07-30T09:15:00.000Z')`,
  );
  db.run(
    `INSERT INTO order_items (id, order_id, variant_id, name, price, quantity, total, vat_rate)
     VALUES ('item-old', 'order-old', 'v1', 'Tiger', 900, 2, 1800, 23)`,
  );
  return db;
}

function columnsOf(db: any, table: string): Set<string> {
  const names = new Set<string>();
  for (const row of db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []) names.add(String(row[1]));
  return names;
}

function tablesOf(db: any): Set<string> {
  const names = new Set<string>();
  for (const row of db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? []) {
    names.add(String(row[0]));
  }
  return names;
}

describe('schema upgrade v4 → v8 over an installed image', () => {
  test('the paid order, its lines, the open shift and the catalog all survive', async () => {
    const db = await tabletOnSchemaV4();

    applyAndroidSchema(db);

    // The money first: an unsynced paid order is the thing a salon cannot lose.
    const order = db.exec("SELECT order_number, total, payment_method, shift_id, synced FROM orders WHERE id = 'order-old'");
    expect(order[0]?.values[0]).toEqual(['POS-20260730-0001', 1800, 'CASH', 'shift-old', 0]);
    const item = db.exec("SELECT name, price, quantity, total FROM order_items WHERE id = 'item-old'");
    expect(item[0]?.values[0]).toEqual(['Tiger', 900, 2, 1800]);
    // The shift it belongs to is still open, so the Z-report still adds up.
    const shift = db.exec("SELECT staff_name, opening_cash, closed_at FROM shifts WHERE id = 'shift-old'");
    expect(shift[0]?.values[0]).toEqual(['Anna', 20000, null]);
    const product = db.exec("SELECT name, retail_price FROM product_variants WHERE id = 'v1'");
    expect(product[0]?.values[0]).toEqual(['Tiger', 900]);
  });

  test('the new tables and columns all arrive', async () => {
    const db = await tabletOnSchemaV4();
    applyAndroidSchema(db);

    const tables = tablesOf(db);
    for (const table of ['pos_billiard_handoffs', 'pos_hold_orders', 'pos_snapshot']) {
      expect(tables, `missing table ${table}`).toContain(table);
    }
    // v7 billiard identity, which the shared PaymentModal has always sent.
    expect(columnsOf(db, 'orders')).toContain('client_attempt_id');
    expect(columnsOf(db, 'orders')).toContain('billiard_origin_json');
    for (const column of ['billiard_json', 'inventory_policy', 'refund_policy', 'allocated_discount', 'payable_total']) {
      expect(columnsOf(db, 'order_items'), `missing order_items.${column}`).toContain(column);
    }
    // v6, which the shared open-shift assertion selects — its absence made every
    // preflight throw "no such column".
    expect(columnsOf(db, 'shifts')).toContain('backend_id');

    const version = db.exec('PRAGMA user_version')[0].values[0][0];
    expect(version).toBe(ANDROID_SCHEMA_VERSION);
  });

  test('the upgraded database is immediately usable by the new code paths', async () => {
    const db = await tabletOnSchemaV4();
    applyAndroidSchema(db);

    // The exact SELECT the shared open-shift assertion runs (open-shift-recovery.ts).
    const openShift = db.exec(
      'SELECT id, staff_id, staff_name, opened_at, backend_id FROM shifts WHERE closed_at IS NULL',
    );
    expect(openShift[0]?.values[0]?.[0]).toBe('shift-old');

    // A billiard journal row can be written on the upgraded image.
    db.run(
      `INSERT INTO pos_billiard_handoffs
       (checkout_id, session_id, order_id, client_attempt_id, salon_id, user_id, register_id, state, snapshot_json)
       VALUES ('co1', 'sess1', 'ord1', 'billiard:co1', 's1', 'u1', 'agent-1', 'POS_READY', '{}')`,
    );
    expect(db.exec("SELECT state FROM pos_billiard_handoffs WHERE checkout_id = 'co1'")[0].values[0][0])
      .toBe('POS_READY');
  });

  test('re-applying on an already-upgraded image is a no-op, not an error', async () => {
    const db = await tabletOnSchemaV4();
    applyAndroidSchema(db);
    // Every boot runs this. A second pass must not throw on the ALTERs or the
    // partial unique index, and must not duplicate anything.
    expect(() => applyAndroidSchema(db)).not.toThrow();
    expect(() => applyAndroidSchema(db)).not.toThrow();

    const orders = db.exec("SELECT COUNT(*) FROM orders");
    expect(orders[0].values[0][0]).toBe(1);
    const tableRows = db.exec("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='pos_snapshot'");
    expect(tableRows[0].values[0][0]).toBe(1);
  });

  test('the v7 unique index does not trip over pre-existing rows', async () => {
    // Every v4 order has client_attempt_id NULL. A non-partial unique index
    // would refuse to build on the second such row — the partial WHERE clause
    // is what makes the upgrade possible at all.
    const db = await tabletOnSchemaV4();
    db.run(
      `INSERT INTO orders (id, order_number, status, subtotal, total, payment_method, shift_id, synced)
       VALUES ('order-old-2', 'POS-20260730-0002', 'COMPLETED', 500, 500, 'CASH', 'shift-old', 0)`,
    );
    expect(() => applyAndroidSchema(db)).not.toThrow();
    expect(db.exec('SELECT COUNT(*) FROM orders')[0].values[0][0]).toBe(2);
  });
});
