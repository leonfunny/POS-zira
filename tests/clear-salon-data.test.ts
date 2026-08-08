import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * tenant-isolation regression: clearSalonData() must wipe bookings,
 * services, service_rules along with the existing list. The 2026-04-30
 * incident left local bookings stranded after a re-login that wiped
 * local_sync_log; the next cancel pushed status_changed for a booking
 * the server had never seen → NOT_FOUND.
 */
describe('database.clearSalonData() table list', () => {
  const source = readFileSync(
    resolve(__dirname, '../src/main/database/database.ts'),
    'utf-8',
  );

  // Pull the array literal between `const tablesToClear = [` and the
  // matching `];`. Brittle but the alternative is loading sql.js into
  // jsdom which adds a lot of test setup for one assertion.
  const block = source.match(/const\s+tablesToClear\s*=\s*\[([\s\S]+?)\];/)?.[1] ?? '';

  it('includes bookings', () => {
    expect(block).toMatch(/'bookings'/);
  });

  it('includes services', () => {
    expect(block).toMatch(/'services'/);
  });

  it('includes service_rules', () => {
    expect(block).toMatch(/'service_rules'/);
  });

  // Keep existing entries — regression guard so the future doesn't
  // silently drop any of the already-wiped tables.
  it('keeps local_sync_log + sync_state', () => {
    expect(block).toMatch(/'local_sync_log'/);
    expect(block).toMatch(/'sync_state'/);
  });

  it('clears the local fiscal_attempts journal on salon switch', () => {
    expect(block).toMatch(/'fiscal_attempts'/);
  });

  it('clears local invoicing/accounting tables that contain tenant data', () => {
    for (const table of [
      'invoice_payments',
      'invoice_items',
      'invoices',
      'invoice_customers',
      'invoice_sequences',
      'accounting_products',
      'seller_settings',
    ]) {
      expect(block).toMatch(new RegExp(`'${table}'`));
    }
  });

  it('clears local draft/import tables that can create tenant-specific product variants', () => {
    expect(block).toMatch(/'draft_products'/);
    expect(block).toMatch(/'local_variant_imports'/);
  });

  it('keeps clearSalonData fail-closed instead of swallowing delete errors', () => {
    expect(source).not.toContain('Could not clear table');
    expect(source).toContain('Failed to persist cleared salon data');
  });

  it('guards receipt outcomes before removing old-tenant live payloads', () => {
    expect(block).toMatch(/'receipt_print_outbox'/);
    expect(source).toContain("\"'DISPATCHING', 'REMOTE_ACCEPTED', 'NEEDS_REVIEW'\"");
    expect(source).toContain('WHERE status IN (${blockedStatuses})');
    expect(source).toContain("status IN ('PENDING', 'FAILED_SAFE')");
    expect(source).toContain("status = 'CANCELLED'");
    expect(source).toContain('prepareReceiptPrintOutboxForTenantExitInTransaction');
    expect(source.indexOf('prepareReceiptPrintOutboxForTenantExitInTransaction'))
      .toBeLessThan(source.indexOf('for (const table of tablesToClear)'));
  });

  it('covers every migration table except shared/system tables', () => {
    const migrations = readFileSync(
      resolve(__dirname, '../src/main/database/migrations.ts'),
      'utf-8',
    );
    const migrationTables = Array.from(
      migrations.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)/gi),
      (match) => match[1],
    );
    const clearTables = new Set(Array.from(block.matchAll(/'([a-z_]+)'/g), (match) => match[1]));
    clearTables.add('sync_metadata');
    const sharedOrSystemTables = new Set(['vat_rates', 'sync_metadata']);
    const missing = migrationTables
      .filter((table) => !sharedOrSystemTables.has(table))
      .filter((table) => !clearTables.has(table));

    expect(missing).toEqual([]);
  });
});

describe('database.clearSalonData() tenant fence', () => {
  const source = readFileSync(
    resolve(__dirname, '../src/main/database/database.ts'),
    'utf-8',
  );

  it('bumps tenantGeneration after a durable clear (sync fence)', () => {
    expect(source).toMatch(/clearSalonData[\s\S]+?tenantGeneration\s*\+=\s*1/);
  });
});
