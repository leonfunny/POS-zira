/**
 * Android catalog DB schema (v1).
 *
 * Packet S5 of the Android parity port — see
 * docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md (§5, S5) and the catalog
 * table/column contract in docs/android-pos/SHIM_CONTRACT_S1.md §2.D.
 *
 * This is a FRESH Android schema, NOT a port of all 56 Windows migrations
 * (src/main/database/migrations.ts). It carries ONLY the tables the retail
 * cashier flow needs — `product_variants` + `categories` (the SQL.js mirror the
 * Windows repos read) and a `sync_meta` cursor table for S6 — and ONLY the
 * columns those rows expose to the renderer (`PosProduct` / `PosCategory`,
 * S1 §2.D). Prices are integer grosze, matching Windows.
 *
 * Column sources (Windows migrations.ts):
 *  - `product_variants` base CREATE: lines 21-35 (id, template_id, name, sku,
 *    barcode, retail_price, category_id, image_url, in_stock, vat_rate,
 *    is_active, updated_at) + indexes 36-38.
 *  - enriched PosProduct columns added by later migrations: `available_qty`,
 *    `is_on_sale`, `thumbnail_url`, `sale_unit`, `sell_by` (sell_by defaults to
 *    'PIECE', matching Windows upsertMany: `product-repo.ts:464`).
 *  - `categories` base CREATE: lines 12-19 (id, name, icon, color, sort_order,
 *    updated_at) + `image_url` (migration at migrations.ts:1664) +
 *    `kitchen_print` (migration at migrations.ts:1310).
 *  - `sync_meta` is Android-new (Windows `sync_metadata` is migrations.ts:104-
 *    108); renamed to match the getSyncMeta/setSyncMeta method names.
 *
 * Deliberately NOT ported (admin/fiscal columns the retail cashier does not
 * expose, per the S5 §2 schema constraint): price_gross/price_net/vat_amount,
 * name_translations, customer_display_*, kiosk_*, item_type, track_inventory.
 * Search over translated names is therefore name-only (see product-repo.ts).
 */

import type { Database as SqlJsDatabase } from 'sql.js';

/** Single multi-statement DDL block. Split + run per statement (see below). */
export const ANDROID_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS product_variants (
    id TEXT PRIMARY KEY,
    template_id TEXT,
    name TEXT NOT NULL,
    sku TEXT,
    barcode TEXT,
    retail_price INTEGER NOT NULL DEFAULT 0,
    category_id TEXT,
    image_url TEXT,
    in_stock INTEGER DEFAULT 0,
    available_qty INTEGER DEFAULT 0,
    vat_rate INTEGER DEFAULT 23,
    is_active INTEGER DEFAULT 1,
    is_on_sale INTEGER DEFAULT 0,
    thumbnail_url TEXT,
    sale_unit TEXT,
    sell_by TEXT DEFAULT 'PIECE',
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pv_barcode ON product_variants(barcode);
  CREATE INDEX IF NOT EXISTS idx_pv_category ON product_variants(category_id);
  CREATE INDEX IF NOT EXISTS idx_pv_sku ON product_variants(sku);

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image_url TEXT,
    icon TEXT,
    color TEXT,
    sort_order INTEGER DEFAULT 0,
    updated_at TEXT,
    kitchen_print INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  );
`;

/**
 * Apply the Android schema to a sql.js database. Idempotent (`IF NOT EXISTS`),
 * so it is safe to run on a fresh DB (first run) and on an already-initialized
 * persisted image (subsequent boots). Splits the DDL by `;` and runs each
 * statement individually — mirrors the Windows migration runner
 * (`database.ts:548-571` `runStatements`); sql.js `Database.run` executes a
 * single statement, so multi-statement DDL must be split.
 */
export function applyAndroidSchema(db: SqlJsDatabase): void {
  const statements = ANDROID_SCHEMA_DDL
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const sql of statements) {
    db.run(sql);
  }
  db.run(`PRAGMA user_version = ${ANDROID_SCHEMA_VERSION}`);
}

/** Bumped only on an incompatible schema change (none yet — fresh v1). */
export const ANDROID_SCHEMA_VERSION = 1;
