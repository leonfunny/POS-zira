import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { migrations } from '../src/main/database/migrations';

describe('invoice handoff migration', () => {
  it('creates the v68 durable state machine with unique stable identities', async () => {
    const migration = migrations.find((candidate) => candidate.version === 68);
    expect(migration).toMatchObject({ name: 'invoice_handoff_outbox' });

    const SQL = await initSqlJs();
    const db = new SQL.Database();
    for (const statement of migration!.up.split(';').map((sql) => sql.trim()).filter(Boolean)) {
      db.run(statement);
    }

    const columns = db.exec('PRAGMA table_info(invoice_handoffs)')[0].values
      .map((row) => String(row[1]));
    expect(columns).toEqual(expect.arrayContaining([
      'order_id',
      'idempotency_key',
      'salon_id',
      'tenant_generation',
      'company_nip',
      'document_intent',
      'status',
      'attempts',
      'next_attempt_at',
      'last_request_id',
      'last_error_code',
      'last_error',
      'response_json',
      'dispatched_at',
      'completed_at',
    ]));

    const insert = (orderId: string, key: string, status = 'WAITING_ELIGIBILITY') => db.run(
      `INSERT INTO invoice_handoffs (
         order_id, idempotency_key, salon_id, tenant_generation,
         document_intent, status, created_at, updated_at
       ) VALUES (?, ?, 'salon-1', 1, 'FISCALISED_RETAIL', ?, 'now', 'now')`,
      [orderId, key, status],
    );
    insert('order-1', 'pos-invoice:order-1:v1');
    expect(() => insert('order-1', 'other-key')).toThrow();
    expect(() => insert('order-2', 'pos-invoice:order-1:v1')).toThrow();
    expect(() => insert('order-3', 'pos-invoice:order-3:v1', 'UNKNOWN')).toThrow();
    insert('order-4', 'pos-invoice:order-4:v1', 'NOT_APPLICABLE');
  });

  it('adds retained backend identity and typed review evidence in v69', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE fiscal_attempts (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT
      )
    `);
    for (const version of [68, 69]) {
      const migration = migrations.find((candidate) => candidate.version === version)!;
      for (const statement of migration.up.split(';').map((sql) => sql.trim()).filter(Boolean)) {
        db.run(statement);
      }
    }

    const columns = db.exec('PRAGMA table_info(invoice_handoffs)')[0].values
      .map((row) => String(row[1]));
    expect(columns).toEqual(expect.arrayContaining([
      'backend_order_id',
      'review_kind',
      'review_request_id',
    ]));
    const indexes = db.exec('PRAGMA index_list(invoice_handoffs)')[0].values
      .map((row) => String(row[1]));
    expect(indexes).toContain('idx_invoice_handoffs_backend_order');
    const fiscalIndexes = db.exec('PRAGMA index_list(fiscal_attempts)')[0].values
      .map((row) => String(row[1]));
    expect(fiscalIndexes).toContain('idx_fiscal_attempts_invoice_backfill');
    expect(migrations.find((candidate) => candidate.version === 69)?.up)
      .toContain('ON fiscal_attempts(status, order_id ASC, attempt_no DESC, id DESC)');
    expect(migrations.find((candidate) => candidate.version === 69)?.up)
      .toContain("'REFUND_INTENT'");

    db.run(`
      INSERT INTO invoice_handoffs (
        order_id, idempotency_key, salon_id, tenant_generation,
        document_intent, status, review_kind, created_at, updated_at
      ) VALUES (
        'order-review', 'pos-invoice:order-review:v1', 'salon-1', 1,
        'FISCALISED_RETAIL', 'NEEDS_REVIEW',
        'POST_COMPLETION_CORRECTION', 'now', 'now'
      )
    `);
    expect(() => db.run(`
      INSERT INTO invoice_handoffs (
        order_id, idempotency_key, salon_id, tenant_generation,
        document_intent, status, review_kind, created_at, updated_at
      ) VALUES (
        'order-invalid', 'pos-invoice:order-invalid:v1', 'salon-1', 1,
        'FISCALISED_RETAIL', 'NEEDS_REVIEW', 'UNKNOWN', 'now', 'now'
      )
    `)).toThrow();
  });
});
