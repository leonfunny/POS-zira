import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { migrations, type Migration } from '../src/main/database/migrations';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function runMigration(db: SqlJsDatabase, migration: Migration): void {
  for (const sql of migration.up.split(';').map((s) => s.trim()).filter(Boolean)) {
    db.run(sql);
  }
}

function columnNames(db: SqlJsDatabase, table: string): string[] {
  const res = db.exec(`PRAGMA table_info(${table})`);
  if (res.length === 0) return [];
  return res[0].values.map((row) => String(row[1]));
}

function objectRows<T>(db: SqlJsDatabase, sql: string): T[] {
  const stmt = db.prepare(sql);
  try {
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    return rows;
  } finally {
    stmt.free();
  }
}

describe('fiskal projection migration', () => {
  it('appends migration v50 after v49', () => {
    const v49Index = migrations.findIndex((m) => m.version === 49);
    const v50Index = migrations.findIndex((m) => m.version === 50);
    expect(v50Index).toBeGreaterThan(v49Index);
    expect(migrations[v50Index]).toMatchObject({
      version: 50,
      name: 'fiskal_projection_columns_and_view',
    });
  });

  it('adds fiskal projection columns and a SUCCESS_CONFIRMED-only view', () => {
    const db = new SQL.Database();
    const v27 = migrations.find((m) => m.version === 27)!;
    const v50 = migrations.find((m) => m.version === 50)!;

    runMigration(db, v27);
    runMigration(db, v50);

    expect(columnNames(db, 'fiscal_attempts')).toEqual(expect.arrayContaining([
      'fiskal_number',
      'gross_total',
      'fiscalized_at',
    ]));

    db.run(
      `INSERT INTO fiscal_attempts (
        id, order_id, payment_id, attempt_no, idempotency_key, printer_type,
        payload_json, payload_hash, status, fiskal_number, gross_total, fiscalized_at
      ) VALUES
        ('a1', 'o1', NULL, 1, 'idem-1', 'ELZAB_STX', '{}', 'h1', 'SUCCESS_CONFIRMED', 'POS-1', 1234, '2026-07-01 10:00:00'),
        ('a2', 'o2', NULL, 1, 'idem-2', 'ELZAB_STX', '{}', 'h2', 'PENDING', 'POS-2', 555, '2026-07-01 11:00:00')`,
    );

    expect(objectRows<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'fiskal'",
    )).toHaveLength(1);
    expect(objectRows<{ order_id: string; fiskal_number: string; gross_total: number }>(
      db,
      'SELECT order_id, fiskal_number, gross_total FROM fiskal ORDER BY order_id',
    )).toEqual([{ order_id: 'o1', fiskal_number: 'POS-1', gross_total: 1234 }]);
  });
});
