import { describe, expect, it } from 'vitest';
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
});
