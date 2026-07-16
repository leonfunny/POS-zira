import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { migrations, type Migration } from '../src/main/database/migrations';

// Mock electron + logger before importing the module under test so the
// app.getPath call never fires and we capture log lines.
vi.mock('electron', () => ({
  app: { getPath: () => 'unused-in-static-tests' },
}));

const { logger } = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../src/main/logger', () => ({ default: logger }));

import { database } from '../src/main/database/database';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DatabaseClass = (database.constructor as any) as {
  applyMigrations(
    db: SqlJsDatabase,
    migrationList: Migration[],
  ): { applied: number; repaired: number };
};

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function tableExists(db: SqlJsDatabase, name: string): boolean {
  const res = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`);
  return res.length > 0 && res[0].values.length > 0;
}

function columnExists(db: SqlJsDatabase, table: string, column: string): boolean {
  const res = db.exec(`PRAGMA table_info(${table})`);
  if (res.length === 0) return false;
  return res[0].values.some((row) => row[1] === column);
}

function versionName(db: SqlJsDatabase, version: number): string | null {
  const res = db.exec(`SELECT name FROM _schema_version WHERE version=${version}`);
  if (res.length === 0 || res[0].values.length === 0) return null;
  return String(res[0].values[0][0]);
}

const V1: Migration = {
  version: 1,
  name: 'base_tables',
  up: `
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT
    );
  `,
};

describe('Database.applyMigrations', () => {
  let db: SqlJsDatabase;

  beforeEach(() => {
    db = new SQL.Database();
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  it('quarantines pre-snapshot unresolved imports as potentially dispatched during the intent migration', () => {
    DatabaseClass.applyMigrations(db, migrations.filter((migration) => migration.version <= 53));
    db.run(`
      INSERT INTO local_variant_imports (variant_id, draft_id, ean, status)
      VALUES
        ('pending-legacy', 'draft-1', '8935039500400', 'PENDING'),
        ('failed-legacy', 'draft-2', '8935039500401', 'FAILED'),
        ('synced-legacy', 'draft-3', '8935039500402', 'SYNCED');
    `);

    DatabaseClass.applyMigrations(db, migrations);

    const rows = db.exec(`
      SELECT variant_id, intent_payload_json, intent_idempotency_key, intent_dispatched_at
      FROM local_variant_imports
      ORDER BY variant_id
    `)[0].values;
    expect(rows).toEqual([
      ['failed-legacy', null, null, expect.any(String)],
      ['pending-legacy', null, null, expect.any(String)],
      ['synced-legacy', null, null, null],
    ]);
  });

  it('moves legacy category image URLs out of icon without touching glyph icons', () => {
    DatabaseClass.applyMigrations(db, migrations.filter((migration) => migration.version <= 55));
    db.run(`
      INSERT INTO categories (id, name, icon, color, sort_order) VALUES
        ('url-cat', 'URL', 'https://img.test/category.jpg', NULL, 0),
        ('relative-cat', 'Relative', '/uploads/category.webp', NULL, 1),
        ('glyph-cat', 'Glyph', '🥬', NULL, 2);
    `);

    DatabaseClass.applyMigrations(db, migrations);

    expect(columnExists(db, 'categories', 'image_url')).toBe(true);
    expect(db.exec(`
      SELECT id, image_url, icon
      FROM categories
      WHERE id IN ('url-cat', 'relative-cat', 'glyph-cat')
      ORDER BY id
    `)[0].values).toEqual([
      ['glyph-cat', null, '🥬'],
      ['relative-cat', '/uploads/category.webp', null],
      ['url-cat', 'https://img.test/category.jpg', null],
    ]);
  });

  it('applies pending migrations on a fresh DB and stamps (version, name)', () => {
    const v2: Migration = {
      version: 2,
      name: 'add_phone',
      up: `ALTER TABLE customers ADD COLUMN phone TEXT;`,
    };
    const result = DatabaseClass.applyMigrations(db, [V1, v2]);
    expect(result).toEqual({ applied: 2, repaired: 0 });
    expect(tableExists(db, 'customers')).toBe(true);
    expect(columnExists(db, 'customers', 'phone')).toBe(true);
    expect(versionName(db, 1)).toBe('base_tables');
    expect(versionName(db, 2)).toBe('add_phone');
  });

  it('is a no-op when every migration is already applied with a matching name', () => {
    DatabaseClass.applyMigrations(db, [V1]);
    const result = DatabaseClass.applyMigrations(db, [V1]);
    expect(result).toEqual({ applied: 0, repaired: 0 });
  });

  it('repairs lineage divergence: same version number applied under a different name', () => {
    // Simulate a DB created on a divergent branch: v2 there was a billiard
    // migration; main's v2 creates checkin tables. The old version-only
    // runner skipped main's v2 forever ("no such table" incident).
    DatabaseClass.applyMigrations(db, [V1]);
    db.run("INSERT INTO _schema_version (version, name) VALUES (2, 'billiard_tables')");

    const mainV2: Migration = {
      version: 2,
      name: 'checkin_wizard',
      up: `
        CREATE TABLE IF NOT EXISTS customer_service_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_csh_customer ON customer_service_history(customer_id);
      `,
    };

    const result = DatabaseClass.applyMigrations(db, [V1, mainV2]);
    expect(result).toEqual({ applied: 0, repaired: 1 });
    expect(tableExists(db, 'customer_service_history')).toBe(true);
    expect(versionName(db, 2)).toBe('checkin_wizard');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('lineage divergence at v2'),
    );
  });

  it('repair tolerates statements that already took effect (duplicate column)', () => {
    DatabaseClass.applyMigrations(db, [V1]);
    // Column already exists from the divergent lineage…
    db.run('ALTER TABLE customers ADD COLUMN email TEXT');
    db.run("INSERT INTO _schema_version (version, name) VALUES (2, 'other_lineage')");

    const mainV2: Migration = {
      version: 2,
      name: 'customer_contact_fields',
      up: `
        ALTER TABLE customers ADD COLUMN email TEXT;
        CREATE TABLE IF NOT EXISTS contact_log (id INTEGER PRIMARY KEY);
      `,
    };

    const result = DatabaseClass.applyMigrations(db, [V1, mainV2]);
    expect(result.repaired).toBe(1);
    // The duplicate ALTER was skipped, the rest of the migration still ran.
    expect(tableExists(db, 'contact_log')).toBe(true);
    expect(versionName(db, 2)).toBe('customer_contact_fields');
  });

  it('rolls back a failing migration atomically so a retry starts clean', () => {
    const badV2: Migration = {
      version: 2,
      name: 'contact_fields',
      up: `
        ALTER TABLE customers ADD COLUMN email TEXT;
        THIS IS NOT SQL;
      `,
    };

    DatabaseClass.applyMigrations(db, [V1]);
    expect(() => DatabaseClass.applyMigrations(db, [V1, badV2])).toThrow();

    // The half-applied ALTER must have been rolled back — this is the exact
    // condition that used to brick boot: column left behind, no version row,
    // retry dies on "duplicate column name" forever.
    expect(columnExists(db, 'customers', 'email')).toBe(false);
    expect(versionName(db, 2)).toBeNull();

    // A fixed migration with the same version now applies cleanly.
    const fixedV2: Migration = {
      version: 2,
      name: 'contact_fields',
      up: `ALTER TABLE customers ADD COLUMN email TEXT;`,
    };
    const result = DatabaseClass.applyMigrations(db, [V1, fixedV2]);
    expect(result).toEqual({ applied: 1, repaired: 0 });
    expect(columnExists(db, 'customers', 'email')).toBe(true);
  });

  it('throws (after rollback) when repair hits a genuinely unexpected error', () => {
    DatabaseClass.applyMigrations(db, [V1]);
    db.run("INSERT INTO _schema_version (version, name) VALUES (2, 'other_lineage')");

    const brokenRepair: Migration = {
      version: 2,
      name: 'broken_repair',
      up: `SELECT * FROM table_that_never_existed;`,
    };

    expect(() => DatabaseClass.applyMigrations(db, [V1, brokenRepair])).toThrow();
    // Name must NOT have been re-stamped.
    expect(versionName(db, 2)).toBe('other_lineage');
  });
});
