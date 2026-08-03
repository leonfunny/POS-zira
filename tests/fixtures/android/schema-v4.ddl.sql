-- The Android schema EXACTLY as v4 shipped, extracted from git
-- (`git show 6c55952^:src/renderer/android-pos/shim/db/schema.ts`) rather than
-- hand-written, so the upgrade test runs against the real installed shape and
-- not a convenient fiction.
--
-- v4 is what a tablet carrying the last released debug APK
-- (zira-pos-android-debug-dff711a.apk) has on disk today.
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
    refund_lines TEXT
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
    course INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

  CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
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
