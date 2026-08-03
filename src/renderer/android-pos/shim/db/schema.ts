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
    -- v7: the shared PaymentModal already sends both of these on every create
    -- (PaymentModal.tsx:673-677) and Android used to drop them silently.
    -- client_attempt_id is the payment-attempt identity the billiard journal is
    -- verified against. NB this DDL block is split statement-by-statement on the
    -- semicolon character, so never write one inside a comment here — it cuts
    -- the surrounding statement in half.
    client_attempt_id TEXT,
    billiard_origin_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_shift ON orders(shift_id);
  CREATE INDEX IF NOT EXISTS idx_orders_synced ON orders(synced);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_attempt_id
    ON orders(client_attempt_id) WHERE client_attempt_id IS NOT NULL;

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
    -- v7: frozen billiard line metadata, sent by PaymentModal.tsx:701-705.
    billiard_json TEXT,
    inventory_policy TEXT,
    refund_policy TEXT,
    allocated_discount INTEGER NOT NULL DEFAULT 0,
    payable_total INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

  CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    staff_id TEXT,
    staff_name TEXT,
    opening_cash INTEGER DEFAULT 0,
    closing_cash INTEGER,
    opened_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT,
    -- v6: the server's shift id. The shared open-shift assertion selects it
    -- (open-shift-recovery.ts getSingleLocalOpenShift), and the tablet's
    -- best-effort backend shift sync has somewhere to record it.
    backend_id TEXT
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

  -- ── Billiard POS-handoff journal (v5) ──────────────────────────────────────
  -- Durable record of a frozen billiard checkout while the cashier tenders it
  -- in POS. Column set + CHECK are the FINAL Windows shape (migrations.ts:1761-
  -- 1791, the v61 tender-boundary rebuild) — Android starts there, so the
  -- SQLite table-rebuild migration chain Windows needed is not replayed here.
  CREATE TABLE IF NOT EXISTS pos_billiard_handoffs (
    checkout_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    order_id TEXT NOT NULL UNIQUE,
    client_attempt_id TEXT NOT NULL UNIQUE,
    salon_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    register_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('POS_READY', 'POS_PAYMENT_OPEN', 'POS_TENDER_COMMITTING', 'POS_TENDER_UNCERTAIN', 'POS_PAID_SYNC_PENDING', 'SETTLED')),
    snapshot_json TEXT NOT NULL,
    interrupted_hold_id TEXT,
    auto_open_consumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pos_billiard_handoffs_recovery
    ON pos_billiard_handoffs(salon_id, user_id, register_id, state, updated_at);
  CREATE INDEX IF NOT EXISTS idx_pos_billiard_handoffs_session
    ON pos_billiard_handoffs(session_id, created_at);

  -- ── Held carts (v5) ───────────────────────────────────────────────────────
  -- The handoff parks an in-progress ordinary cart in a PROTECTED hold before
  -- it freezes the billiard cart, and restores it after the session is paid.
  -- Windows shape: migrations.ts:445-453.
  CREATE TABLE IF NOT EXISTS pos_hold_orders (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    items_count INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    staff_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
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
  // v7: billiard identity/metadata columns on orders + order_items.
  for (const [table, column, ddl] of [
    ['orders', 'client_attempt_id', 'ALTER TABLE orders ADD COLUMN client_attempt_id TEXT'],
    ['orders', 'billiard_origin_json', 'ALTER TABLE orders ADD COLUMN billiard_origin_json TEXT'],
    ['order_items', 'billiard_json', 'ALTER TABLE order_items ADD COLUMN billiard_json TEXT'],
    ['order_items', 'inventory_policy', 'ALTER TABLE order_items ADD COLUMN inventory_policy TEXT'],
    ['order_items', 'refund_policy', 'ALTER TABLE order_items ADD COLUMN refund_policy TEXT'],
    ['order_items', 'allocated_discount', 'ALTER TABLE order_items ADD COLUMN allocated_discount INTEGER NOT NULL DEFAULT 0'],
    ['order_items', 'payable_total', 'ALTER TABLE order_items ADD COLUMN payable_total INTEGER'],
  ] as const) {
    const existing = new Set<string>();
    for (const row of db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []) existing.add(String(row[1]));
    if (!existing.has(column)) db.run(ddl);
  }
  db.run(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_attempt_id ON orders(client_attempt_id) WHERE client_attempt_id IS NOT NULL',
  );

  // v6: shifts.backend_id (the shared open-shift assertion selects it).
  const shiftColumns = new Set<string>();
  const shiftInfo = db.exec('PRAGMA table_info(shifts)');
  for (const row of shiftInfo[0]?.values ?? []) shiftColumns.add(String(row[1]));
  if (!shiftColumns.has('backend_id')) {
    db.run('ALTER TABLE shifts ADD COLUMN backend_id TEXT');
  }
  db.run(`PRAGMA user_version = ${ANDROID_SCHEMA_VERSION}`);
}

/** v3 = product_variants.track_inventory (stock-guard parity).
 *  v4 = orders.{refund_amount,refund_reason,refunded_at,refund_lines} (E1b refund).
 *  v5 = pos_billiard_handoffs + pos_hold_orders (billiard POS-handoff port).
 *  v6 = shifts.backend_id (shared open-shift assertion + backend shift sync).
 *  v7 = orders.{client_attempt_id,billiard_origin_json} +
 *       order_items.{billiard_json,inventory_policy,refund_policy,
 *       allocated_discount,payable_total} — the billiard identity the shared
 *       PaymentModal already sends and Android used to drop. */
export const ANDROID_SCHEMA_VERSION = 7;
