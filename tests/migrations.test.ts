import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { migrations } from '../src/main/database/migrations';

describe('database migrations', () => {
  it('keeps pos_staff_user_id compatible with the semicolon-based runner', () => {
    const migration = migrations.find((m) => m.name === 'pos_staff_user_id');

    expect(migration).toBeDefined();
    const statements = migration!.up
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('ALTER TABLE pos_staff ADD COLUMN user_id TEXT');
    expect(statements[1]).toBe('CREATE INDEX IF NOT EXISTS idx_pos_staff_user_id ON pos_staff(user_id)');
  });

  it('adds paper_height to local_printers in a separate migration', () => {
    const migration = migrations.find((m) => m.name === 'local_printers_paper_height');

    expect(migration).toBeDefined();
    const statements = migration!.up
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    expect(statements).toEqual([
      'ALTER TABLE local_printers ADD COLUMN paper_height INTEGER',
    ]);
  });

  it('creates the fiscal_attempts journal with idempotency and status indexes', () => {
    const migration = migrations.find((m) => m.name === 'fiscal_attempts');

    expect(migration).toBeDefined();
    const statements = migration!.up
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS fiscal_attempts');
    expect(statements[0]).toContain('idempotency_key TEXT NOT NULL UNIQUE');
    expect(statements[0]).toContain('status TEXT NOT NULL');
    expect(statements[1]).toBe('CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_order_payment ON fiscal_attempts(order_id, payment_id)');
    expect(statements[2]).toBe('CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_status ON fiscal_attempts(status)');
  });

  it('changes fiscal daily report runs from one-per-date guard to run history', () => {
    const migration = migrations.find((m) => m.name === 'fiscal_daily_report_run_history');

    expect(migration).toBeDefined();
    expect(migration!.version).toBe(44);
    const statements = migration!.up
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    expect(statements).toContain('DROP INDEX IF EXISTS idx_fiscal_daily_report_date');
    expect(statements).toContain("ALTER TABLE fiscal_daily_report_runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'auto'");
    expect(statements).toContain('ALTER TABLE fiscal_daily_report_runs ADD COLUMN report_no_before INTEGER');
    expect(statements).toContain('ALTER TABLE fiscal_daily_report_runs ADD COLUMN report_no_after INTEGER');
    expect(statements).toContain('ALTER TABLE fiscal_daily_report_runs ADD COLUMN confirmation_unknown INTEGER NOT NULL DEFAULT 0');
    expect(statements).toContain('CREATE INDEX IF NOT EXISTS idx_fiscal_daily_report_date\n        ON fiscal_daily_report_runs(report_date, created_at)');
    expect(statements).not.toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_daily_report_date\n        ON fiscal_daily_report_runs(report_date)');
  });

  it('repairs only mirrored server cash payment amounts that stored applied paidAmount', () => {
    const migration = migrations.find((m) => m.name === 'repair_server_cash_received_amount');

    expect(migration).toBeDefined();
    expect(migration!.version).toBe(37);
    expect(migration!.up).toContain('UPDATE orders');
    expect(migration!.up).toContain('SET payment_amount = total + change_amount');
    expect(migration!.up).toContain("source = 'SERVER'");
    expect(migration!.up).toContain("payment_method = 'CASH'");
    expect(migration!.up).toContain('change_amount > 0');
    expect(migration!.up).toContain('payment_amount <= total');
  });

  it('adds a dedicated category image column and migrates only legacy URL icons', () => {
    const migration = migrations.find((m) => m.name === 'category_image_url');

    expect(migration).toBeDefined();
    expect(migration!.version).toBe(56);
    expect(migration!.up).toContain('ALTER TABLE categories ADD COLUMN image_url TEXT');
    expect(migration!.up).toContain('SET image_url = TRIM(icon)');
    expect(migration!.up).toContain("LOWER(TRIM(icon)) LIKE 'https://%'");
    expect(migration!.up).toContain("LOWER(TRIM(icon)) LIKE '/uploads/%'");
  });

  it('adds durable product tombstone state and invalidates the old product cursor', () => {
    const migration = migrations.find((m) => m.name === 'product_sync_tombstone_state');

    expect(migration).toBeDefined();
    expect(migration!.version).toBe(57);
    expect(migration!.up).toContain('ADD COLUMN sync_tombstone_reason TEXT');
    expect(migration!.up).toContain('ADD COLUMN sync_tombstoned_at TEXT');
    expect(migration!.up).toContain("'products_sync_cursor_v2'");
    expect(migration!.up).toContain("'products_last_full_sync'");
  });

  it('indexes the retained refund journal by event time and local order', () => {
    const migration = migrations.find((m) => m.name === 'pos_refund_cashflow_indexes');

    expect(migration).toBeDefined();
    expect(migration!.version).toBe(58);
    expect(migration!.up).toContain('ON pos_event_outbox(event_type, occurred_at)');
    expect(migration!.up).toContain('ON pos_event_outbox(event_type, local_order_id)');
    expect(migration!.up).toContain('ON pos_event_outbox(event_type, shift_id)');
  });

  it('rebuilds the Billiard handoff CHECK constraint for tender crash states without dropping rows', () => {
    const migration = migrations.find((m) => m.name === 'billiard_pos_tender_boundary');
    expect(migration).toBeDefined();
    expect(migration!.version).toBe(61);
    expect(migration!.up).toContain("'POS_TENDER_COMMITTING'");
    expect(migration!.up).toContain("'POS_TENDER_UNCERTAIN'");
    expect(migration!.up).toContain('INSERT INTO pos_billiard_handoffs_v61');
    expect(migration!.up).toContain('FROM pos_billiard_handoffs');
    expect(migration!.up).toContain('ALTER TABLE pos_billiard_handoffs_v61 RENAME TO pos_billiard_handoffs');
  });

  it('applies the tender-boundary rebuild to an existing v60 row', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE pos_billiard_handoffs (
        checkout_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        order_id TEXT NOT NULL UNIQUE,
        client_attempt_id TEXT NOT NULL UNIQUE,
        salon_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        register_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('POS_READY', 'POS_PAYMENT_OPEN', 'POS_PAID_SYNC_PENDING', 'SETTLED')),
        snapshot_json TEXT NOT NULL,
        interrupted_hold_id TEXT,
        auto_open_consumed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO pos_billiard_handoffs (
        checkout_id, session_id, order_id, client_attempt_id, salon_id,
        user_id, register_id, state, snapshot_json
      ) VALUES ('checkout-1', 'session-1', 'order-1', 'attempt-1', 'salon-1', 'owner-1', 'register-1', 'POS_PAYMENT_OPEN', '{}');
    `);

    const migration = migrations.find((m) => m.name === 'billiard_pos_tender_boundary')!;
    for (const statement of migration.up.split(';').map((part) => part.trim()).filter(Boolean)) {
      db.run(statement);
    }
    db.run("UPDATE pos_billiard_handoffs SET state = 'POS_TENDER_COMMITTING' WHERE checkout_id = 'checkout-1'");
    const rows = db.exec("SELECT checkout_id, state FROM pos_billiard_handoffs WHERE checkout_id = 'checkout-1'");
    expect(rows[0].values).toEqual([['checkout-1', 'POS_TENDER_COMMITTING']]);
    expect(() => db.run("UPDATE pos_billiard_handoffs SET state = 'BAD_STATE' WHERE checkout_id = 'checkout-1'"))
      .toThrow(/CHECK constraint failed/i);
    db.close();
  });
});
