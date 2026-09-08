import { RESTAURANT_CHECK_SCHEMA } from '../../../../shared/restaurant-check';
import { ANDROID_RESTAURANT_SCHEMA } from './restaurant-table-repo';

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
    track_inventory INTEGER DEFAULT 1,
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

  -- S8+S9: order/shift tables — column set ported from the Windows INSERTs
  -- (order-repo.ts:218-243) plus the sync/backend columns the sync loop and
  -- history read (synced tri-state 0/1/2/-1, sync_attempts, sync_error,
  -- backend_id, synced_at, created_at). sequence_counters ports the atomic
  -- order-number counter (order-repo.ts generateOrderNumber). shifts ports the
  -- shift-controller row (id, staff, opening/closing cash, opened/closed).
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    order_number TEXT,
    status TEXT,
    subtotal INTEGER DEFAULT 0,
    discount INTEGER DEFAULT 0,
    tax INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    payment_method TEXT,
    payment_amount INTEGER DEFAULT 0,
    change_amount INTEGER DEFAULT 0,
    staff_id TEXT,
    staff_name TEXT,
    customer_id TEXT,
    customer_name TEXT,
    customer_nip TEXT,
    shift_id TEXT,
    source TEXT DEFAULT 'POS',
    table_id TEXT,
    covers INTEGER,
    order_type TEXT DEFAULT 'standard',
    tip INTEGER DEFAULT 0,
    mode TEXT DEFAULT 'retail',
    payment_tenders TEXT,
    kitchen_number TEXT,
    synced INTEGER DEFAULT 0,
    sync_attempts INTEGER DEFAULT 0,
    sync_error TEXT,
    backend_id TEXT,
    synced_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    refund_amount INTEGER DEFAULT 0,
    refund_reason TEXT,
    refunded_at TEXT,
    refund_lines TEXT,
    refund_event_context_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_shift ON orders(shift_id);
  CREATE INDEX IF NOT EXISTS idx_orders_synced ON orders(synced);

  CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    variant_id TEXT,
    name TEXT,
    sku TEXT,
    price INTEGER DEFAULT 0,
    quantity REAL DEFAULT 1,
    sale_quantity REAL,
    sale_unit TEXT,
    sell_by TEXT DEFAULT 'PIECE',
    total INTEGER DEFAULT 0,
    vat_rate INTEGER DEFAULT 23,
    staff_id TEXT,
    staff_name TEXT,
    notes TEXT,
    course INTEGER DEFAULT 1,
    allocated_discount INTEGER DEFAULT 0,
    payable_total INTEGER,
    restaurant_line_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

  CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    backend_id TEXT,
    backend_binding_json TEXT,
    close_report_json TEXT,
    staff_id TEXT,
    staff_name TEXT,
    opening_cash INTEGER DEFAULT 0,
    closing_cash INTEGER,
    opened_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    commission_rate REAL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    role TEXT
  );

  CREATE TABLE IF NOT EXISTS sequence_counters (
    name TEXT PRIMARY KEY,
    current_value INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pos_refund_attempts (
    request_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    local_order_id TEXT NOT NULL,
    backend_order_id TEXT NOT NULL,
    shift_id TEXT,
    payload_json TEXT NOT NULL,
    expected_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PREPARED', 'UNKNOWN', 'CONFIRMED', 'REJECTED')),
    response_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_attempt_unresolved_local
    ON pos_refund_attempts(local_order_id) WHERE status IN ('PREPARED', 'UNKNOWN');
  CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_attempt_unresolved_backend
    ON pos_refund_attempts(backend_order_id) WHERE status IN ('PREPARED', 'UNKNOWN');

  CREATE TABLE IF NOT EXISTS pos_refund_events (
    request_id TEXT PRIMARY KEY,
    server_url TEXT NOT NULL,
    salon_id TEXT NOT NULL,
    local_order_id TEXT NOT NULL,
    backend_order_id TEXT NOT NULL,
    local_shift_id TEXT NOT NULL,
    backend_shift_id TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    delta_amount_minor INTEGER NOT NULL CHECK (typeof(delta_amount_minor) = 'integer' AND delta_amount_minor > 0),
    event_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_refund_events_order ON pos_refund_events(server_url, salon_id, local_order_id);
  CREATE INDEX IF NOT EXISTS idx_refund_events_shift ON pos_refund_events(local_shift_id);
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
  const statements = (ANDROID_SCHEMA_DDL + RESTAURANT_CHECK_SCHEMA + ANDROID_RESTAURANT_SCHEMA)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const sql of statements) {
    db.run(sql);
  }
  // Additive migrations for DBs created before a column existed (CREATE IF NOT
  // EXISTS won't add columns to an existing table). Guarded by table_info so
  // re-runs are safe.
  const productColumns = new Set<string>();
  const productInfo = db.exec('PRAGMA table_info(product_variants)');
  for (const row of productInfo[0]?.values ?? []) productColumns.add(String(row[1]));
  if (!productColumns.has('track_inventory')) {
    db.run('ALTER TABLE product_variants ADD COLUMN track_inventory INTEGER DEFAULT 1');
  }
  // v4: refund columns on orders (E1b markRefunded). Additive, guarded per-column
  // so a partially-migrated DB (e.g. refunded_at added in a future hotfix) converges.
  const orderColumns = new Set<string>();
  const orderInfo = db.exec('PRAGMA table_info(orders)');
  for (const row of orderInfo[0]?.values ?? []) orderColumns.add(String(row[1]));
  if (!orderColumns.has('refund_amount')) {
    db.run('ALTER TABLE orders ADD COLUMN refund_amount INTEGER DEFAULT 0');
  }
  if (!orderColumns.has('refund_reason')) {
    db.run('ALTER TABLE orders ADD COLUMN refund_reason TEXT');
  }
  if (!orderColumns.has('refunded_at')) {
    db.run('ALTER TABLE orders ADD COLUMN refunded_at TEXT');
  }
  if (!orderColumns.has('refund_lines')) {
    db.run('ALTER TABLE orders ADD COLUMN refund_lines TEXT');
  }
  // Canonical event provenance only; never infer it from legacy cumulative refunds.
  if (!orderColumns.has('refund_event_context_json')) db.run('ALTER TABLE orders ADD COLUMN refund_event_context_json TEXT');
  if (!orderColumns.has('sync_payload_json')) db.run('ALTER TABLE orders ADD COLUMN sync_payload_json TEXT');
  if (!orderColumns.has('sync_metadata_eligible')) db.run('ALTER TABLE orders ADD COLUMN sync_metadata_eligible INTEGER NOT NULL DEFAULT 0');
  const itemColumns = new Set((db.exec('PRAGMA table_info(order_items)')[0]?.values ?? []).map(row => String(row[1])));
  if (!itemColumns.has('allocated_discount')) db.run('ALTER TABLE order_items ADD COLUMN allocated_discount INTEGER DEFAULT 0');
  if (!itemColumns.has('payable_total')) db.run('ALTER TABLE order_items ADD COLUMN payable_total INTEGER');
  // Verified server snapshot provenance only; legacy/local rows stay unknown.
  if (!itemColumns.has('restaurant_line_id')) db.run('ALTER TABLE order_items ADD COLUMN restaurant_line_id TEXT');
  const shiftColumns = new Set((db.exec('PRAGMA table_info(shifts)')[0]?.values ?? []).map(row => String(row[1])));
  if (!shiftColumns.has('backend_id')) db.run('ALTER TABLE shifts ADD COLUMN backend_id TEXT');
  // Explicit server/device evidence only; an old backend_id proves no binding.
  if (!shiftColumns.has('backend_binding_json')) db.run('ALTER TABLE shifts ADD COLUMN backend_binding_json TEXT');
  if (!shiftColumns.has('close_report_json')) db.run('ALTER TABLE shifts ADD COLUMN close_report_json TEXT');
  db.run(`PRAGMA user_version = ${ANDROID_SCHEMA_VERSION}`);
}

/** v3 = product_variants.track_inventory (stock-guard parity).
 *  v4 = orders.{refund_amount,refund_reason,refunded_at,refund_lines} (E1b refund).
 *  v5 = restaurant checks, local tables/device ID and per-line discount allocation.
 *  v6 = tenant-scoped validated restaurant layout sync marker (additive).
 *  v7 = immutable upload snapshot and new-sale metadata provenance (additive).
 *  v8 = nullable verified server restaurant line provenance (no backfill).
 *  v9 = durable immutable refund attempts with unresolved per-order locks.
 *  v10 = nullable verified backend shift identity; no legacy ID guessing.
 *  v11 = nullable declared backend shift/device binding evidence; no backfill.
 *  v12 = immutable local close-report snapshot; no historical backfill.
 *  v13 = canonical refund event storage and nullable context; no legacy backfill. */
export const ANDROID_SCHEMA_VERSION = 13;
