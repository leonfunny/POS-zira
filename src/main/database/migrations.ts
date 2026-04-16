export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT,
        color TEXT,
        sort_order INTEGER DEFAULT 0,
        updated_at TEXT
      );

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
        vat_rate INTEGER DEFAULT 23,
        is_active INTEGER DEFAULT 1,
        updated_at TEXT,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      );
      CREATE INDEX IF NOT EXISTS idx_pv_barcode ON product_variants(barcode);
      CREATE INDEX IF NOT EXISTS idx_pv_category ON product_variants(category_id);
      CREATE INDEX IF NOT EXISTS idx_pv_sku ON product_variants(sku);

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        order_number TEXT,
        status TEXT DEFAULT 'COMPLETED',
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
        synced INTEGER DEFAULT 0,
        backend_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        synced_at TEXT
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        variant_id TEXT,
        name TEXT NOT NULL,
        sku TEXT,
        price INTEGER NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        total INTEGER NOT NULL,
        vat_rate INTEGER DEFAULT 23,
        FOREIGN KEY (order_id) REFERENCES orders(id)
      );
      CREATE INDEX IF NOT EXISTS idx_oi_order ON order_items(order_id);

      CREATE TABLE IF NOT EXISTS shifts (
        id TEXT PRIMARY KEY,
        staff_id TEXT,
        staff_name TEXT,
        opened_at TEXT DEFAULT (datetime('now')),
        closed_at TEXT,
        opening_cash INTEGER DEFAULT 0,
        closing_cash INTEGER,
        total_sales INTEGER DEFAULT 0,
        total_orders INTEGER DEFAULT 0,
        synced INTEGER DEFAULT 0,
        backend_id TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT,
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        next_retry_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_metadata (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 2,
    name: 'pos_modes',
    up: `
      ALTER TABLE orders ADD COLUMN table_id TEXT;
      ALTER TABLE orders ADD COLUMN covers INTEGER;
      ALTER TABLE orders ADD COLUMN order_type TEXT DEFAULT 'standard';
      ALTER TABLE orders ADD COLUMN tip INTEGER DEFAULT 0;
      ALTER TABLE orders ADD COLUMN mode TEXT DEFAULT 'retail';

      ALTER TABLE order_items ADD COLUMN staff_id TEXT;
      ALTER TABLE order_items ADD COLUMN staff_name TEXT;
      ALTER TABLE order_items ADD COLUMN notes TEXT;
      ALTER TABLE order_items ADD COLUMN course INTEGER DEFAULT 1;

      CREATE TABLE IF NOT EXISTS pos_tables (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        zone TEXT,
        capacity INTEGER DEFAULT 4,
        sort_order INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        status TEXT DEFAULT 'free',
        current_order_id TEXT,
        covers INTEGER DEFAULT 0,
        opened_at TEXT
      );

      CREATE TABLE IF NOT EXISTS pos_customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        nip TEXT,
        email TEXT,
        phone TEXT,
        credit_limit INTEGER DEFAULT 0,
        current_debt INTEGER DEFAULT 0,
        payment_terms INTEGER DEFAULT 14,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS pos_staff (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        commission_rate INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        updated_at TEXT
      );
    `,
  },
  {
    version: 3,
    name: 'invoicing',
    up: `
      -- =====================================================
      -- SELLER SETTINGS (Thông tin người bán - cấu hình 1 lần)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS seller_settings (
        id TEXT PRIMARY KEY DEFAULT 'default',
        company_name TEXT NOT NULL,
        nip TEXT NOT NULL,
        regon TEXT,
        street TEXT NOT NULL,
        city TEXT NOT NULL,
        postal_code TEXT NOT NULL,
        country TEXT DEFAULT 'PL',
        email TEXT,
        phone TEXT,
        website TEXT,
        bank_account TEXT,
        bank_name TEXT,
        swift_code TEXT,
        is_vat_registered INTEGER DEFAULT 1,
        logo_path TEXT,
        invoice_footer TEXT,
        default_payment_term_days INTEGER DEFAULT 14,
        default_invoice_notes TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- =====================================================
      -- CUSTOMERS (Khách hàng - B2B/B2C)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS invoice_customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        short_name TEXT,
        is_company INTEGER DEFAULT 0,
        nip TEXT,
        regon TEXT,
        street TEXT,
        city TEXT,
        postal_code TEXT,
        country TEXT DEFAULT 'PL',
        email TEXT,
        phone TEXT,
        contact_person TEXT,
        payment_term_days INTEGER DEFAULT 14,
        default_payment_method TEXT DEFAULT 'BANK_TRANSFER',
        bank_account TEXT,
        bank_name TEXT,
        gus_verified INTEGER DEFAULT 0,
        gus_verified_at TEXT,
        notes TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_ic_nip ON invoice_customers(nip);
      CREATE INDEX IF NOT EXISTS idx_ic_name ON invoice_customers(name);

      -- =====================================================
      -- INVOICES (Faktury)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        invoice_number TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL DEFAULT 'RECEIPT',
        status TEXT NOT NULL DEFAULT 'DRAFT',
        issue_date TEXT NOT NULL,
        sale_date TEXT NOT NULL,
        due_date TEXT,
        paid_at TEXT,
        sent_at TEXT,
        cancelled_at TEXT,
        seller_name TEXT NOT NULL,
        seller_nip TEXT NOT NULL,
        seller_regon TEXT,
        seller_address TEXT NOT NULL,
        seller_bank_account TEXT,
        seller_bank_name TEXT,
        customer_id TEXT,
        customer_name TEXT NOT NULL,
        customer_nip TEXT,
        customer_regon TEXT,
        customer_address TEXT,
        customer_country TEXT DEFAULT 'PL',
        total_net INTEGER NOT NULL DEFAULT 0,
        total_vat INTEGER NOT NULL DEFAULT 0,
        total_gross INTEGER NOT NULL DEFAULT 0,
        currency TEXT DEFAULT 'PLN',
        exchange_rate INTEGER,
        vat_summary TEXT,
        payment_method TEXT DEFAULT 'CASH',
        payment_status TEXT DEFAULT 'UNPAID',
        paid_amount INTEGER DEFAULT 0,
        split_payment_marker INTEGER DEFAULT 0,
        is_reverse_charge INTEGER DEFAULT 0,
        reverse_charge_reason TEXT,
        is_margin_scheme INTEGER DEFAULT 0,
        margin_buying_price INTEGER,
        jpk_vat_marker TEXT,
        corrected_invoice_id TEXT,
        correction_reason TEXT,
        correction_data TEXT,
        advance_invoice_id TEXT,
        final_invoice_id TEXT,
        valid_until TEXT,
        converted_invoice_id TEXT,
        converted_at TEXT,
        source_order_type TEXT,
        source_order_id TEXT,
        proforma_id TEXT,
        stock_deducted INTEGER DEFAULT 0,
        sent_to TEXT,
        viewed_count INTEGER DEFAULT 0,
        notes TEXT,
        internal_notes TEXT,
        printed INTEGER DEFAULT 0,
        printed_at TEXT,
        pdf_path TEXT,
        synced INTEGER DEFAULT 0,
        backend_id TEXT,
        cancelled_by TEXT,
        cancellation_reason TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (customer_id) REFERENCES invoice_customers(id),
        FOREIGN KEY (corrected_invoice_id) REFERENCES invoices(id)
      );

      CREATE INDEX IF NOT EXISTS idx_inv_number ON invoices(invoice_number);
      CREATE INDEX IF NOT EXISTS idx_inv_date ON invoices(issue_date);
      CREATE INDEX IF NOT EXISTS idx_inv_customer ON invoices(customer_id);
      CREATE INDEX IF NOT EXISTS idx_inv_status ON invoices(status);
      CREATE INDEX IF NOT EXISTS idx_inv_type ON invoices(type);

      -- =====================================================
      -- INVOICE ITEMS (Line items)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS invoice_items (
        id TEXT PRIMARY KEY,
        invoice_id TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        accounting_product_id TEXT,
        name TEXT NOT NULL,
        sku TEXT,
        unit TEXT DEFAULT 'szt.',
        pkwiu_code TEXT,
        gtu_code TEXT,
        cn_code TEXT,
        quantity INTEGER NOT NULL DEFAULT 1000,
        unit_price_net INTEGER NOT NULL,
        vat_rate INTEGER NOT NULL DEFAULT 23,
        discount_percent INTEGER DEFAULT 0,
        total_net INTEGER NOT NULL DEFAULT 0,
        vat_amount INTEGER NOT NULL DEFAULT 0,
        total_gross INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ii_invoice ON invoice_items(invoice_id);

      -- =====================================================
      -- INVOICE PAYMENTS (Lịch sử thanh toán)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS invoice_payments (
        id TEXT PRIMARY KEY,
        invoice_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        payment_method TEXT,
        paid_at TEXT NOT NULL,
        reference_number TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ip_invoice ON invoice_payments(invoice_id);

      -- =====================================================
      -- INVOICE SEQUENCES (Đánh số hóa đơn)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS invoice_sequences (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        prefix TEXT NOT NULL,
        year INTEGER NOT NULL,
        month INTEGER,
        last_number INTEGER DEFAULT 0,
        format TEXT DEFAULT '{prefix}/{number}/{month}/{year}',
        UNIQUE(type, year, month)
      );

      -- =====================================================
      -- VAT RATES (Stawki VAT)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS vat_rates (
        id TEXT PRIMARY KEY,
        rate INTEGER NOT NULL,
        name TEXT NOT NULL,
        code TEXT NOT NULL,
        description TEXT,
        is_default INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        display_order INTEGER DEFAULT 0
      );

      -- Default VAT rates (Polish)
      INSERT OR IGNORE INTO vat_rates (id, rate, name, code, description, is_default, display_order) VALUES
        ('vat-23', 23, '23%', '23', 'Stawka podstawowa', 1, 1);
      INSERT OR IGNORE INTO vat_rates (id, rate, name, code, description, is_default, display_order) VALUES
        ('vat-8', 8, '8%', '8', 'Stawka obniżona (usługi)', 0, 2);
      INSERT OR IGNORE INTO vat_rates (id, rate, name, code, description, is_default, display_order) VALUES
        ('vat-5', 5, '5%', '5', 'Stawka obniżona (żywność)', 0, 3);
      INSERT OR IGNORE INTO vat_rates (id, rate, name, code, description, is_default, display_order) VALUES
        ('vat-0', 0, '0%', '0', 'Stawka zerowa (eksport)', 0, 4);
      INSERT OR IGNORE INTO vat_rates (id, rate, name, code, description, is_default, display_order) VALUES
        ('vat-zw', -1, 'ZW', 'zw', 'Zwolniony z VAT', 0, 5);

      -- =====================================================
      -- ACCOUNTING PRODUCTS (Sản phẩm kế toán)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS accounting_products (
        id TEXT PRIMARY KEY,
        sku TEXT,
        name TEXT NOT NULL,
        description TEXT,
        price_net INTEGER NOT NULL,
        vat_rate INTEGER DEFAULT 23,
        price_gross INTEGER NOT NULL,
        purchase_price_net INTEGER,
        unit TEXT DEFAULT 'szt.',
        pkwiu_code TEXT,
        gtu_code TEXT,
        cn_code TEXT,
        barcode TEXT,
        type TEXT DEFAULT 'PRODUCT',
        stock_quantity INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_ap_sku ON accounting_products(sku);
      CREATE INDEX IF NOT EXISTS idx_ap_name ON accounting_products(name);
      CREATE INDEX IF NOT EXISTS idx_ap_barcode ON accounting_products(barcode);
    `,
  },
  {
    version: 4,
    name: 'ksef_integration',
    up: `
      -- =====================================================
      -- Add KSeF fields to seller_settings
      -- =====================================================
      ALTER TABLE seller_settings ADD COLUMN ksef_enabled INTEGER DEFAULT 0;
      ALTER TABLE seller_settings ADD COLUMN ksef_auto_send INTEGER DEFAULT 1;
      ALTER TABLE seller_settings ADD COLUMN ksef_environment TEXT DEFAULT 'TEST';
      ALTER TABLE seller_settings ADD COLUMN ksef_auth_token TEXT;
      ALTER TABLE seller_settings ADD COLUMN ksef_last_sync_at TEXT;
      ALTER TABLE seller_settings ADD COLUMN ksef_last_error TEXT;

      -- =====================================================
      -- Add KSeF fields to invoices
      -- =====================================================
      ALTER TABLE invoices ADD COLUMN ksef_number TEXT;
      ALTER TABLE invoices ADD COLUMN ksef_status TEXT;
      ALTER TABLE invoices ADD COLUMN ksef_sent_at TEXT;
      ALTER TABLE invoices ADD COLUMN ksef_error TEXT;
      ALTER TABLE invoices ADD COLUMN ksef_retry_count INTEGER DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_inv_ksef ON invoices(ksef_number);
      CREATE INDEX IF NOT EXISTS idx_inv_ksef_status ON invoices(ksef_status);
    `,
  },
  {
    version: 5,
    name: 'pos_hold_quickkeys_upsell',
    up: `
      -- =====================================================
      -- HOLD ORDERS (parked carts for recall)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS pos_hold_orders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        items_count INTEGER DEFAULT 0,
        total INTEGER DEFAULT 0,
        staff_name TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- =====================================================
      -- QUICK KEY LAYOUTS (customizable POS tile grids)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS pos_quickkey_layouts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'retail',
        cols INTEGER DEFAULT 4,
        tiles TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT
      );

      -- =====================================================
      -- QUICK KEY ASSIGNMENTS (register ↔ layout mapping)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS pos_quickkey_assignments (
        register_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        layout_id TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (register_id, mode),
        FOREIGN KEY (layout_id) REFERENCES pos_quickkey_layouts(id)
      );

      -- =====================================================
      -- RECOMMENDED / UPSELL ITEMS
      -- =====================================================
      CREATE TABLE IF NOT EXISTS pos_recommended_items (
        product_id TEXT PRIMARY KEY,
        score INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (product_id) REFERENCES product_variants(id)
      );

      -- =====================================================
      -- SEQUENCE COUNTERS (atomic number generation)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS sequence_counters (
        name TEXT PRIMARY KEY,
        current_value INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 6,
    name: 'checkins',
    up: `
      CREATE TABLE IF NOT EXISTS checkins (
        id TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL,
        customer_phone TEXT,
        customer_email TEXT,
        service_name TEXT,
        staff_name TEXT,
        booking_id TEXT,
        booking_source TEXT,
        is_walkin INTEGER DEFAULT 0,
        status TEXT DEFAULT 'waiting',
        checked_in_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        upsells_added TEXT,
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_checkin_date ON checkins(checked_in_at);
      CREATE INDEX IF NOT EXISTS idx_checkin_phone ON checkins(customer_phone);
      CREATE INDEX IF NOT EXISTS idx_checkin_status ON checkins(status);
    `,
  },
  {
    version: 7,
    name: 'add_missing_indices',
    up: `
      CREATE INDEX IF NOT EXISTS idx_orders_shift ON orders(shift_id);
      CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
      CREATE INDEX IF NOT EXISTS idx_pc_nip ON pos_customers(nip);
    `,
  },
  {
    version: 8,
    name: 'billiard_local_sync',
    up: `
      -- =====================================================
      -- BILLIARD RESOURCES (pool tables cache)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS billiard_resources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT,
        type_id TEXT,
        type_name TEXT,
        pricing_rules TEXT DEFAULT '[]',
        is_active INTEGER DEFAULT 1,
        updated_at TEXT
      );

      -- =====================================================
      -- BILLIARD FLOOR PLANS
      -- =====================================================
      CREATE TABLE IF NOT EXISTS billiard_floor_plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        floor_number INTEGER DEFAULT 0,
        room_width_m REAL,
        room_height_m REAL,
        background_image TEXT,
        updated_at TEXT
      );

      -- =====================================================
      -- BILLIARD TABLE LAYOUTS (positions on floor plan)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS billiard_table_layouts (
        id TEXT PRIMARY KEY,
        resource_id TEXT NOT NULL,
        floor_plan_id TEXT,
        position_x REAL DEFAULT 50,
        position_y REAL DEFAULT 50,
        rotation REAL DEFAULT 0,
        width_pct REAL DEFAULT 10,
        height_pct REAL DEFAULT 10,
        shape TEXT DEFAULT 'rectangle',
        asset_key TEXT,
        updated_at TEXT,
        FOREIGN KEY (resource_id) REFERENCES billiard_resources(id),
        FOREIGN KEY (floor_plan_id) REFERENCES billiard_floor_plans(id)
      );
      CREATE INDEX IF NOT EXISTS idx_btl_resource ON billiard_table_layouts(resource_id);
      CREATE INDEX IF NOT EXISTS idx_btl_floor ON billiard_table_layouts(floor_plan_id);

      -- =====================================================
      -- BILLIARD COMBOS (package deals)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS billiard_combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        combo_price INTEGER DEFAULT 0,
        combo_type TEXT,
        play_minutes INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        updated_at TEXT
      );

      -- =====================================================
      -- BILLIARD COMBO ITEMS
      -- =====================================================
      CREATE TABLE IF NOT EXISTS billiard_combo_items (
        id TEXT PRIMARY KEY,
        combo_id TEXT NOT NULL,
        variant_id TEXT,
        name TEXT,
        quantity INTEGER DEFAULT 1,
        unit_price INTEGER DEFAULT 0,
        FOREIGN KEY (combo_id) REFERENCES billiard_combos(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_bci_combo ON billiard_combo_items(combo_id);

      -- =====================================================
      -- BILLIARD SESSIONS (active sessions cache)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS billiard_sessions (
        id TEXT PRIMARY KEY,
        resource_id TEXT,
        status TEXT DEFAULT 'active',
        billing_mode TEXT DEFAULT 'per_minute',
        guest_count INTEGER DEFAULT 1,
        started_at TEXT,
        paused_at TEXT,
        ended_at TEXT,
        total_minutes REAL DEFAULT 0,
        total_charges INTEGER DEFAULT 0,
        combo_id TEXT,
        notes TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bs_resource ON billiard_sessions(resource_id);
      CREATE INDEX IF NOT EXISTS idx_bs_status ON billiard_sessions(status);

      -- =====================================================
      -- BILLIARD SESSION ITEMS (F&B items on session tab)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS billiard_session_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        variant_id TEXT,
        name TEXT NOT NULL,
        quantity INTEGER DEFAULT 1,
        unit_price INTEGER DEFAULT 0,
        FOREIGN KEY (session_id) REFERENCES billiard_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_bsi_session ON billiard_session_items(session_id);

      -- =====================================================
      -- BILLIARD MUTATION QUEUE (offline writes)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS billiard_mutation_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        payload TEXT,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_bmq_status ON billiard_mutation_queue(status);
    `,
  },
  {
    version: 9,
    name: 'checkin_wizard',
    up: `
      -- =====================================================
      -- SALON CUSTOMERS (local customer database for check-in)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS salon_customers (
        id TEXT PRIMARY KEY,
        backend_customer_id TEXT,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        birthday TEXT,
        notes TEXT,
        preferred_staff_id TEXT,
        preferred_staff_name TEXT,
        visit_count INTEGER DEFAULT 0,
        last_visit_at TEXT,
        last_service_name TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_phone ON salon_customers(phone) WHERE phone IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sc_name ON salon_customers(name);

      -- =====================================================
      -- CUSTOMER SERVICE HISTORY
      -- =====================================================
      CREATE TABLE IF NOT EXISTS customer_service_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT NOT NULL,
        service_name TEXT NOT NULL,
        service_id TEXT,
        staff_name TEXT,
        staff_id TEXT,
        checkin_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_csh_customer ON customer_service_history(customer_id);

      -- =====================================================
      -- SERVICE POPULARITY (bestseller tracking)
      -- =====================================================
      CREATE TABLE IF NOT EXISTS service_popularity (
        service_id TEXT PRIMARY KEY,
        service_name TEXT NOT NULL,
        total_count INTEGER DEFAULT 0,
        last_30_days_count INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 10,
    name: 'checkin_extend_columns',
    up: `
      ALTER TABLE checkins ADD COLUMN customer_id TEXT;
      ALTER TABLE checkins ADD COLUMN service_id TEXT;
      ALTER TABLE checkins ADD COLUMN staff_id TEXT;
      ALTER TABLE checkins ADD COLUMN estimated_duration INTEGER;
      ALTER TABLE checkins ADD COLUMN services_json TEXT;
    `,
  },
  {
    version: 11,
    name: 'checkin_booking_number',
    up: `
      ALTER TABLE checkins ADD COLUMN booking_number TEXT;
      CREATE INDEX IF NOT EXISTS idx_checkin_booking_number ON checkins(booking_number);
    `,
  },
  {
    version: 12,
    name: 'salon_customer_marketing_consent',
    up: `
      ALTER TABLE salon_customers ADD COLUMN marketing_consent INTEGER DEFAULT 0;
    `,
  },
  {
    version: 13,
    name: 'checkin_sync_fields',
    up: `
      -- Sync tri-state for check-ins: 0=pending, 1=synced, 2=in-flight
      ALTER TABLE checkins ADD COLUMN synced INTEGER DEFAULT 0;
      ALTER TABLE checkins ADD COLUMN backend_id TEXT;
      ALTER TABLE checkins ADD COLUMN synced_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_checkin_synced ON checkins(synced);

      -- Sync tri-state for salon customers (reuses existing backend_customer_id column)
      ALTER TABLE salon_customers ADD COLUMN synced INTEGER DEFAULT 0;
      ALTER TABLE salon_customers ADD COLUMN synced_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_sc_synced ON salon_customers(synced);
    `,
  },
  {
    version: 14,
    name: 'product_enriched_fields',
    up: `
      ALTER TABLE product_variants ADD COLUMN available_qty INTEGER DEFAULT 0;
      ALTER TABLE product_variants ADD COLUMN price_gross INTEGER DEFAULT 0;
      ALTER TABLE product_variants ADD COLUMN price_net INTEGER DEFAULT 0;
      ALTER TABLE product_variants ADD COLUMN vat_amount INTEGER DEFAULT 0;
      ALTER TABLE product_variants ADD COLUMN is_on_sale INTEGER DEFAULT 0;
      ALTER TABLE product_variants ADD COLUMN thumbnail_url TEXT;
    `,
  },
  {
    version: 15,
    name: 'product_sale_unit',
    up: `
      ALTER TABLE product_variants ADD COLUMN sale_unit TEXT;
    `,
  },
  {
    version: 16,
    name: 'sync_change_feed',
    up: `
      -- Change feed cursor: tracks last-consumed server timestamp per entity type
      CREATE TABLE IF NOT EXISTS change_feed_cursor (
        entity_type TEXT PRIMARY KEY,
        last_timestamp TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Invoice sync error tracking (synced + backend_id already exist from v3)
      ALTER TABLE invoices ADD COLUMN sync_error TEXT;

      -- Staff extended fields from backend
      ALTER TABLE pos_staff ADD COLUMN role TEXT;
      ALTER TABLE pos_staff ADD COLUMN backend_synced_at TEXT;

      -- Order server-side status (separate from local status to avoid overwrite)
      ALTER TABLE orders ADD COLUMN server_status TEXT;
      ALTER TABLE orders ADD COLUMN refund_amount INTEGER DEFAULT 0;
      ALTER TABLE orders ADD COLUMN refund_reason TEXT;
      ALTER TABLE orders ADD COLUMN server_updated_at TEXT;
    `,
  },
];
