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
  {
    version: 17,
    name: 'sync_log_path_b',
    up: `
      -- =====================================================
      -- LOCAL SYNC LOG — mirrors server sync_log shape
      -- Outbound entries start as 'pending', pushed in batches.
      -- Inbound entries inserted as 'accepted' with server_seq.
      -- =====================================================
      CREATE TABLE IF NOT EXISTS local_sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_tx TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        server_seq INTEGER,
        rejection_code TEXT,
        rejection_detail TEXT,
        attempts INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        pushed_at TEXT,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lsl_status ON local_sync_log(status);
      CREATE INDEX IF NOT EXISTS idx_lsl_source_tx ON local_sync_log(source_tx);
      CREATE INDEX IF NOT EXISTS idx_lsl_entity ON local_sync_log(entity_type, entity_id);

      -- =====================================================
      -- SYNC STATE — cursor + mode tracking
      -- =====================================================
      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- =====================================================
      -- SYNC CONFLICTS — unresolved conflicts for cashier
      -- =====================================================
      CREATE TABLE IF NOT EXISTS sync_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_entry_id INTEGER NOT NULL,
        conflict_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        detail TEXT,
        resolution TEXT,
        resolved_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 18,
    name: 'sync_retry_tracking',
    up: `
      -- Track sync attempts + last error on orders (caps infinite retry)
      ALTER TABLE orders ADD COLUMN sync_attempts INTEGER DEFAULT 0;
      ALTER TABLE orders ADD COLUMN sync_error TEXT;

      -- Track sync attempts on shifts
      ALTER TABLE shifts ADD COLUMN sync_attempts INTEGER DEFAULT 0;
      ALTER TABLE shifts ADD COLUMN sync_error TEXT;
    `,
  },
  {
    version: 19,
    name: 'order_refund_tracking',
    up: `
      ALTER TABLE orders ADD COLUMN refunded_at TEXT;
    `,
  },
  {
    version: 20,
    name: 'split_payment_tenders',
    up: `
      -- JSON array of tenders: [{"method":"CASH","amount":5000},{"method":"CARD","amount":3000}]
      -- Amounts stored in grosze (same as all prices). Null = single payment (use payment_method).
      ALTER TABLE orders ADD COLUMN payment_tenders TEXT;
    `,
  },
  {
    version: 21,
    name: 'order_refund_lines',
    up: `
      ALTER TABLE orders ADD COLUMN refund_lines TEXT;
    `,
  },
  {
    version: 22,
    name: 'bookings',
    up: `
      -- Nail-salon appointments pulled from the dashboard via sync_log.
      -- Phase 1: read-only cache (dashboard is authoritative). Prices in
      -- grosze (INT) to match orders/products. Names denormalized so the
      -- calendar renders without joins when offline.
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        owner_full_name TEXT,
        owner_phone TEXT,
        staff_user_id TEXT,
        staff_full_name TEXT,
        service_id TEXT,
        service_name TEXT,
        rule_id TEXT,
        resource_id TEXT,
        resource_name TEXT,
        status TEXT DEFAULT 'BOOKED',
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        duration_minutes INTEGER,
        processing_start TEXT,
        processing_end TEXT,
        base_price_pln INTEGER DEFAULT 0,
        extras_price_pln INTEGER DEFAULT 0,
        total_price_pln INTEGER DEFAULT 0,
        deposit_paid INTEGER DEFAULT 0,
        customer_notes TEXT,
        internal_notes TEXT,
        confirmed_at TEXT,
        cancelled_at TEXT,
        cancel_reason TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT,
        server_updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bookings_starts_at ON bookings(starts_at);
      CREATE INDEX IF NOT EXISTS idx_bookings_staff_starts ON bookings(staff_user_id, starts_at);
      CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    `,
  },
  {
    version: 23,
    name: 'services_service_rules',
    up: `
      -- Salon services + pricing tiers, pulled from dashboard via sync_log.
      -- POS reads these when composing a walk-in booking (service picker +
      -- rule picker). Prices stored in grosze to match other price columns.
      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        icon_url TEXT,
        is_active INTEGER DEFAULT 1,
        base_price_pln INTEGER DEFAULT 0,
        price_net_pln INTEGER,
        tax_rate_id TEXT,
        base_duration_minutes INTEGER DEFAULT 60,
        processing_time_minutes INTEGER DEFAULT 0,
        processing_start_after INTEGER DEFAULT 0,
        buffer_before INTEGER DEFAULT 0,
        buffer_after INTEGER DEFAULT 0,
        display_order INTEGER DEFAULT 0,
        category_id TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_services_active ON services(is_active);
      CREATE INDEX IF NOT EXISTS idx_services_category ON services(category_id);

      CREATE TABLE IF NOT EXISTS service_rules (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        size_category TEXT,
        duration_min INTEGER NOT NULL DEFAULT 60,
        base_price_pln INTEGER NOT NULL DEFAULT 0,
        deposit_pln INTEGER DEFAULT 0,
        name TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_service_rules_service ON service_rules(service_id);
    `,
  },
  {
    version: 24,
    name: 'pos_staff_user_id',
    up: `
      -- Backend booksy/booking pipeline writes bookings.staff_user_id as
      -- users.id (canonical FK). Until v24, pos_staff.id was the only id we
      -- kept locally and we sent it through as staff_user_id, relying on
      -- the server's tolerant resolveStaffUserId to normalize from
      -- staff_profiles.id. Add a nullable user_id column so the staff sync
      -- can persist the canonical id once the backend exposes it. Existing
      -- rows stay valid (user_id NULL = "fall back to id" for outbound writes).
      ALTER TABLE pos_staff ADD COLUMN user_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_pos_staff_user_id ON pos_staff(user_id);
    `,
  },
  {
    version: 25,
    name: 'local_printers',
    up: `
      -- Mirror of eNail print_agent_printers. The id is the canonical
      -- backend printer UUID, cached locally so print jobs can route by
      -- printerId even when multiple local printers share one printer_type.
      CREATE TABLE IF NOT EXISTS local_printers (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        printer_type TEXT,
        display_name TEXT,
        name TEXT,
        protocol TEXT NOT NULL DEFAULT 'WINDOWS',
        windows_printer_name TEXT,
        address TEXT,
        port TEXT,
        baud_rate INTEGER DEFAULT 9600,
        paper_width INTEGER DEFAULT 80,
        chars_per_line INTEGER DEFAULT 48,
        supports_cut INTEGER DEFAULT 1,
        supports_cash_drawer INTEGER DEFAULT 0,
        is_enabled INTEGER DEFAULT 0,
        is_online INTEGER DEFAULT 0,
        last_seen_at TEXT,
        last_used_at TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_local_printers_agent ON local_printers(agent_id);
      CREATE INDEX IF NOT EXISTS idx_local_printers_type ON local_printers(printer_type);
      CREATE INDEX IF NOT EXISTS idx_local_printers_enabled ON local_printers(is_enabled);
    `,
  },
  {
    version: 26,
    name: 'local_printers_paper_height',
    up: `
      ALTER TABLE local_printers ADD COLUMN paper_height INTEGER;
    `,
  },
  {
    version: 27,
    name: 'fiscal_attempts',
    up: `
      CREATE TABLE IF NOT EXISTS fiscal_attempts (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        payment_id TEXT,
        attempt_no INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        printer_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        sent_at TEXT,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_order_payment ON fiscal_attempts(order_id, payment_id);
      CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_status ON fiscal_attempts(status);
    `,
  },
  {
    version: 28,
    name: 'catalog_name_translations',
    up: `
      ALTER TABLE categories ADD COLUMN name_translations TEXT;
      ALTER TABLE product_variants ADD COLUMN name_translations TEXT;
    `,
  },
  {
    version: 29,
    name: 'draft_products',
    up: `
      CREATE TABLE IF NOT EXISTS draft_products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sku TEXT,
        barcode TEXT,
        retail_price INTEGER NOT NULL DEFAULT 0,
        category_id TEXT,
        image_url TEXT,
        in_stock INTEGER DEFAULT 0,
        vat_rate INTEGER DEFAULT 23,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dp_barcode ON draft_products(barcode);
      CREATE INDEX IF NOT EXISTS idx_dp_status ON draft_products(status);
      CREATE INDEX IF NOT EXISTS idx_dp_category ON draft_products(category_id);
      CREATE INDEX IF NOT EXISTS idx_dp_updated_at ON draft_products(updated_at);
    `,
  },
  {
    version: 30,
    name: 'local_variant_imports',
    up: `
      CREATE TABLE IF NOT EXISTS local_variant_imports (
        variant_id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        ean TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        synced_at TEXT,
        server_variant_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lvi_status ON local_variant_imports(status);
      CREATE INDEX IF NOT EXISTS idx_lvi_ean ON local_variant_imports(ean);
      CREATE INDEX IF NOT EXISTS idx_lvi_draft_id ON local_variant_imports(draft_id);
    `,
  },
  {
    version: 31,
    name: 'sales_forecast_ordering',
    up: `
      CREATE TABLE IF NOT EXISTS replenishment_policies (
        variant_id TEXT PRIMARY KEY,
        lead_time_days INTEGER NOT NULL DEFAULT 1,
        safety_stock_days INTEGER NOT NULL DEFAULT 1,
        min_display_qty INTEGER NOT NULL DEFAULT 0,
        pack_size INTEGER NOT NULL DEFAULT 1,
        max_stock INTEGER,
        supplier_name TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (variant_id) REFERENCES product_variants(id)
      );

      CREATE TABLE IF NOT EXISTS forecast_runs (
        id TEXT PRIMARY KEY,
        generated_at TEXT NOT NULL,
        as_of_date TEXT NOT NULL,
        horizon_days INTEGER NOT NULL,
        history_days INTEGER NOT NULL,
        item_count INTEGER NOT NULL DEFAULT 0,
        total_suggested_qty INTEGER NOT NULL DEFAULT 0,
        total_estimated_retail_value INTEGER NOT NULL DEFAULT 0,
        warnings_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_forecast_runs_generated_at ON forecast_runs(generated_at);

      CREATE TABLE IF NOT EXISTS forecast_recommendations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sku TEXT,
        barcode TEXT,
        category_id TEXT,
        category_name TEXT,
        stock_on_hand INTEGER NOT NULL DEFAULT 0,
        avg_daily_demand REAL NOT NULL DEFAULT 0,
        velocity_7d REAL NOT NULL DEFAULT 0,
        velocity_30d REAL NOT NULL DEFAULT 0,
        forecast_units REAL NOT NULL DEFAULT 0,
        forecast_daily_json TEXT NOT NULL,
        lead_time_days INTEGER NOT NULL DEFAULT 1,
        safety_stock_days INTEGER NOT NULL DEFAULT 1,
        min_display_qty INTEGER NOT NULL DEFAULT 0,
        max_stock INTEGER,
        reorder_point REAL NOT NULL DEFAULT 0,
        target_stock REAL NOT NULL DEFAULT 0,
        suggested_order_qty INTEGER NOT NULL DEFAULT 0,
        pack_size INTEGER NOT NULL DEFAULT 1,
        estimated_retail_value INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'ok',
        confidence REAL NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        warnings_json TEXT,
        supplier_name TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES forecast_runs(id),
        FOREIGN KEY (variant_id) REFERENCES product_variants(id)
      );
      CREATE INDEX IF NOT EXISTS idx_forecast_recommendations_run ON forecast_recommendations(run_id);
      CREATE INDEX IF NOT EXISTS idx_forecast_recommendations_variant ON forecast_recommendations(variant_id);
      CREATE INDEX IF NOT EXISTS idx_forecast_recommendations_risk ON forecast_recommendations(risk_level);
    `,
  },
  {
    version: 32,
    name: 'forecast_order_drafts',
    up: `
      CREATE TABLE IF NOT EXISTS forecast_order_drafts (
        id TEXT PRIMARY KEY,
        source_run_id TEXT,
        as_of_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        notes TEXT,
        item_count INTEGER NOT NULL DEFAULT 0,
        total_qty INTEGER NOT NULL DEFAULT 0,
        total_estimated_retail_value INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_run_id) REFERENCES forecast_runs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_forecast_order_drafts_created_at ON forecast_order_drafts(created_at);
      CREATE INDEX IF NOT EXISTS idx_forecast_order_drafts_status ON forecast_order_drafts(status);

      CREATE TABLE IF NOT EXISTS forecast_order_draft_lines (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sku TEXT,
        barcode TEXT,
        supplier_name TEXT,
        stock_on_hand INTEGER NOT NULL DEFAULT 0,
        velocity_7d REAL NOT NULL DEFAULT 0,
        velocity_30d REAL NOT NULL DEFAULT 0,
        suggested_order_qty INTEGER NOT NULL DEFAULT 0,
        order_qty INTEGER NOT NULL DEFAULT 0,
        unit_value INTEGER NOT NULL DEFAULT 0,
        estimated_retail_value INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (draft_id) REFERENCES forecast_order_drafts(id),
        FOREIGN KEY (variant_id) REFERENCES product_variants(id)
      );
      CREATE INDEX IF NOT EXISTS idx_forecast_order_draft_lines_draft ON forecast_order_draft_lines(draft_id);
      CREATE INDEX IF NOT EXISTS idx_forecast_order_draft_lines_variant ON forecast_order_draft_lines(variant_id);
    `,
  },
  {
    version: 33,
    name: 'invoices_compound_order_index',
    up: `
      -- Invoice list query orders by (issue_date DESC, created_at DESC). The
      -- existing single-column idx_inv_date forces a temp B-tree for the second
      -- sort key. A compound index lets SQLite walk both keys without sorting.
      CREATE INDEX IF NOT EXISTS idx_inv_date_created ON invoices(issue_date DESC, created_at DESC);
    `,
  },
  {
    version: 34,
    name: 'customer_display_catalog_metadata',
    up: `
      ALTER TABLE categories ADD COLUMN customer_display_enabled INTEGER DEFAULT 1;
      ALTER TABLE categories ADD COLUMN customer_display_section TEXT;
      ALTER TABLE categories ADD COLUMN customer_display_sort_order INTEGER;
      ALTER TABLE product_variants ADD COLUMN customer_display_enabled INTEGER DEFAULT 1;
      ALTER TABLE product_variants ADD COLUMN customer_display_sort_order INTEGER;
    `,
  },
  {
    version: 35,
    name: 'weighted_fresh_food_pos_contract',
    up: `
      ALTER TABLE product_variants ADD COLUMN sell_by TEXT NOT NULL DEFAULT 'PIECE';
      ALTER TABLE order_items ADD COLUMN sale_quantity REAL;
      ALTER TABLE order_items ADD COLUMN sale_unit TEXT;
      ALTER TABLE order_items ADD COLUMN sell_by TEXT NOT NULL DEFAULT 'PIECE';
    `,
  },
  {
    version: 36,
    name: 'pos_schedule_cache',
    up: `
      CREATE TABLE IF NOT EXISTS pos_schedule_cache (
        cache_key TEXT PRIMARY KEY,
        salon_id TEXT,
        business_date TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        server_version INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pos_schedule_cache_date
        ON pos_schedule_cache(business_date, updated_at);
    `,
  },
  {
    version: 37,
    name: 'repair_server_cash_received_amount',
    up: `
      UPDATE orders
      SET payment_amount = total + change_amount
      WHERE source = 'SERVER'
        AND payment_method = 'CASH'
        AND change_amount > 0
        AND payment_amount <= total
        AND total > 0;
    `,
  },
  {
    version: 38,
    name: 'print_attempts',
    up: `
      CREATE TABLE IF NOT EXISTS print_attempts (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        document_type TEXT NOT NULL,   -- ORDER | REPRINT | REFUND
        printer_type TEXT NOT NULL,    -- RECEIPT | FISCAL | A4 | LABEL
        printer_name TEXT,             -- e.g. "Xprinter XP-80T"
        printer_target TEXT,           -- COM port / shared printerId / windows printer
        route TEXT,                    -- LOCAL | SHARED_NETWORK
        status TEXT NOT NULL,          -- PRINTED | FAILED | NO_PRINTER
        error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_print_attempts_order ON print_attempts(order_id, created_at);
    `,
  },
  {
    version: 39,
    name: 'categories_kitchen_print',
    // Kitchen ticket printing: categories flagged kitchen_print=1 have their
    // items printed as a kitchen ticket when an order is created. This flag is
    // local-only until the backend has an official category field.
    up: `
      ALTER TABLE categories ADD COLUMN kitchen_print INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 40,
    name: 'orders_kitchen_number',
    // Daily pickup number (0001, 0002, ...) assigned when an order contains
    // kitchen items. Printed on the kitchen ticket AND on a customer pickup
    // slip so the kitchen hands food to the matching number.
    up: `
      ALTER TABLE orders ADD COLUMN kitchen_number TEXT;
    `,
  },
  {
    version: 41,
    name: 'kitchen_self_orders',
    up: `
      CREATE TABLE IF NOT EXISTS kitchen_self_orders (
        id TEXT PRIMARY KEY,
        order_number TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        business_date TEXT NOT NULL,
        fulfillment_type TEXT NOT NULL,
        customer_language TEXT NOT NULL,
        status TEXT NOT NULL,
        source_machine_id TEXT,
        source_label TEXT,
        created_at TEXT NOT NULL,
        printed_at TEXT,
        kitchen_printed INTEGER NOT NULL DEFAULT 0,
        customer_slip_printed INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_kso_business_sequence
        ON kitchen_self_orders(business_date, sequence_number);
      CREATE INDEX IF NOT EXISTS idx_kso_created_at
        ON kitchen_self_orders(created_at);
      CREATE INDEX IF NOT EXISTS idx_kso_status
        ON kitchen_self_orders(status);

      CREATE TABLE IF NOT EXISTS kitchen_self_order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        variant_id TEXT,
        product_id TEXT,
        name_snapshot TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        options_json TEXT,
        note TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(order_id) REFERENCES kitchen_self_orders(id)
      );
      CREATE INDEX IF NOT EXISTS idx_kso_items_order
        ON kitchen_self_order_items(order_id, sort_order);
    `,
  },
  {
    version: 42,
    name: 'fiscal_receipt_sync_queue',
    // Durable outbox for backend fiscal receipt telemetry. Fiscal printing is
    // already guarded by fiscal_attempts; this queue only makes backend report
    // sync survive missing auth, network drops, and app restarts.
    up: `
      CREATE TABLE IF NOT EXISTS fiscal_receipt_sync_queue (
        id TEXT PRIMARY KEY,
        local_order_id TEXT NOT NULL,
        backend_order_id TEXT NOT NULL,
        event_status TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        event_body_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        synced_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_receipt_sync_backend_status
        ON fiscal_receipt_sync_queue(backend_order_id, event_status);
      CREATE INDEX IF NOT EXISTS idx_fiscal_receipt_sync_status
        ON fiscal_receipt_sync_queue(status, created_at);
    `,
  },
  {
    version: 43,
    name: 'fiscal_daily_report_runs',
    // Local guard/outbox for automatic ELZAB fiscal daily reports. This is
    // intentionally local to the POS master device so POS2 cannot duplicate the
    // fiscal zeroing report after pulling the same source code.
    up: `
      CREATE TABLE IF NOT EXISTS fiscal_daily_report_runs (
        id TEXT PRIMARY KEY,
        report_date TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        printed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_daily_report_date
        ON fiscal_daily_report_runs(report_date);
      CREATE INDEX IF NOT EXISTS idx_fiscal_daily_report_status
        ON fiscal_daily_report_runs(status, report_date);
    `,
  },
  {
    version: 44,
    name: 'fiscal_daily_report_run_history',
    // Allow several ELZAB fiscal daily reports in one business day. The
    // scheduler now guards on fiscal receipts printed after the latest
    // successful report instead of a unique report_date row.
    up: `
      DROP INDEX IF EXISTS idx_fiscal_daily_report_date;
      ALTER TABLE fiscal_daily_report_runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'auto';
      ALTER TABLE fiscal_daily_report_runs ADD COLUMN report_no_before INTEGER;
      ALTER TABLE fiscal_daily_report_runs ADD COLUMN report_no_after INTEGER;
      ALTER TABLE fiscal_daily_report_runs ADD COLUMN confirmation_unknown INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_fiscal_daily_report_date
        ON fiscal_daily_report_runs(report_date, created_at);
      CREATE INDEX IF NOT EXISTS idx_fiscal_daily_report_schedule
        ON fiscal_daily_report_runs(scheduled_for, trigger, created_at);
      CREATE INDEX IF NOT EXISTS idx_fiscal_daily_report_success
        ON fiscal_daily_report_runs(status, printed_at);
    `,
  },
  {
    version: 45,
    name: 'kitchen_self_order_catalog_metadata',
    // Nullable server-owned customer kiosk metadata. Existing catalogs keep
    // legacy CONTAIN images, no modifiers, and notes disabled.
    up: `
      ALTER TABLE product_variants ADD COLUMN kiosk_media_json TEXT;
      ALTER TABLE product_variants ADD COLUMN kiosk_modifier_groups_json TEXT;
      ALTER TABLE product_variants ADD COLUMN kiosk_note_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE categories ADD COLUMN kiosk_modifier_groups_json TEXT;
    `,
  },
  {
    version: 46,
    name: 'kitchen_self_order_payment_slip_metadata',
    // Kitchen self-order remains separate from paid POS orders. These columns
    // snapshot customer-facing payment-slip totals and print routing diagnostics.
    up: `
      ALTER TABLE kitchen_self_orders ADD COLUMN total_grosze INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE kitchen_self_orders ADD COLUMN kitchen_route TEXT;
      ALTER TABLE kitchen_self_orders ADD COLUMN kitchen_printer_id TEXT;
      ALTER TABLE kitchen_self_orders ADD COLUMN kitchen_job_id TEXT;
      ALTER TABLE kitchen_self_orders ADD COLUMN customer_slip_route TEXT;

      ALTER TABLE kitchen_self_order_items ADD COLUMN unit_price_grosze INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE kitchen_self_order_items ADD COLUMN line_total_grosze INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 47,
    name: 'pos_event_outbox',
    // Durable offline-first event outbox. Every business fact is written here
    // BEFORE any network attempt, so the POS keeps selling offline; an uploader
    // drains pending rows to POST /api/v1/pos-events/batch (idempotent by
    // eventId). dedupe_key is the deterministic local idempotency guard: the
    // same business fact never produces two outbox rows (so the backend never
    // double-counts even if an emitter fires twice). status: pending | acked |
    // dead_letter. Money in payload is integer minor units (grosze).
    up: `
      CREATE TABLE IF NOT EXISTS pos_event_outbox (
        event_id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        salon_id TEXT,
        device_id TEXT,
        local_order_id TEXT,
        shift_id TEXT,
        correlation_id TEXT,
        causation_id TEXT,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        reliability_class TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_attempt_at TEXT,
        last_error TEXT,
        server_event_id TEXT,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pos_event_outbox_ready ON pos_event_outbox(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_pos_event_outbox_local_order ON pos_event_outbox(local_order_id);
    `,
  },
  {
    version: 48,
    name: 'lan_first_print_attempts',
    // Receiver-side LAN_FIRST guard. The idempotency key is the hard barrier
    // against duplicate physical kitchen-ticket prints.
    up: `
      CREATE TABLE IF NOT EXISTS lan_first_print_attempts (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        job_id TEXT NOT NULL,
        printer_id TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_class TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lan_first_print_attempts_status
        ON lan_first_print_attempts(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_lan_first_print_attempts_job
        ON lan_first_print_attempts(job_id);
    `,
  },
  {
    version: 49,
    name: 'kitchen_self_order_category_prefs',
    // Device-local kiosk category preferences. The categories table remains a
    // backend catalog mirror; Kitchen Self Order visibility/order is owned by
    // this POS machine so product sync cannot reset operator choices.
    up: `
      CREATE TABLE IF NOT EXISTS kitchen_self_order_category_prefs (
        category_id TEXT PRIMARY KEY,
        visible INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_kso_category_prefs_visible_order
        ON kitchen_self_order_category_prefs(visible, sort_order);

      INSERT OR IGNORE INTO kitchen_self_order_category_prefs (category_id, visible, sort_order, updated_at)
      SELECT id, 1, sort_order, datetime('now')
      FROM categories
      WHERE kitchen_print = 1;
    `,
  },
  {
    version: 50,
    name: 'fiskal_projection_columns_and_view',
    up: `
      ALTER TABLE fiscal_attempts ADD COLUMN fiskal_number TEXT;
      ALTER TABLE fiscal_attempts ADD COLUMN gross_total INTEGER;
      ALTER TABLE fiscal_attempts ADD COLUMN fiscalized_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_fiscalized_at ON fiscal_attempts(fiscalized_at);
      CREATE VIEW IF NOT EXISTS fiskal AS
        SELECT id, order_id, fiskal_number, gross_total, fiscalized_at, printer_type, payload_json
        FROM fiscal_attempts
        WHERE status = 'SUCCESS_CONFIRMED';
    `,
  },
  {
    version: 51,
    name: 'local_variant_import_category_id',
    up: `
      ALTER TABLE local_variant_imports ADD COLUMN category_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_lvi_category_id ON local_variant_imports(category_id);
    `,
  },
];
