import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbState, testDatabase } = vi.hoisted(() => {
  const state = { db: null as SqlJsDatabase | null };
  return {
    dbState: state,
    testDatabase: {
      run(sql: string, params?: unknown[]): void {
        state.db!.run(sql, params as any[] | undefined);
      },
      get<T = any>(sql: string, params?: unknown[]): T | null {
        const stmt = state.db!.prepare(sql);
        try {
          if (params) stmt.bind(params as any[]);
          return stmt.step() ? stmt.getAsObject() as T : null;
        } finally {
          stmt.free();
        }
      },
      all<T = any>(sql: string, params?: unknown[]): T[] {
        const stmt = state.db!.prepare(sql);
        try {
          if (params) stmt.bind(params as any[]);
          const rows: T[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as T);
          return rows;
        } finally {
          stmt.free();
        }
      },
    },
  };
});

vi.mock('../src/main/database/database', () => ({ database: testDatabase }));

import {
  getSavedLocalVariantImportIntentIdentity,
  LocalVariantImportOutcomeUncertainError,
  localVariantImportsRepo,
} from '../src/main/database/repos/local-variant-imports-repo';

describe('localVariantImportsRepo durable intent', () => {
  beforeEach(async () => {
    const SQL = await initSqlJs();
    dbState.db = new SQL.Database();
    dbState.db.run(`
      CREATE TABLE local_variant_imports (
        variant_id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        ean TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        synced_at TEXT,
        server_variant_id TEXT,
        category_id TEXT,
        intent_payload_json TEXT,
        intent_idempotency_key TEXT,
        intent_dispatched_at TEXT
      );
    `);
  });

  it('creates the marker and exact scan-create intent in one insert', () => {
    const payloadJson = JSON.stringify({
      ean: '8935039500400',
      retailPrice: 17.64,
      stockQty: 0,
      taxRate: 5,
      categoryId: null,
    });
    const intentKey = `local-import-v2-${'c'.repeat(64)}`;

    localVariantImportsRepo.create(
      'variant-atomic',
      'draft-atomic',
      '8935039500400',
      null,
      { payloadJson, idempotencyKey: intentKey },
    );

    expect(localVariantImportsRepo.getByVariantId('variant-atomic')).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      category_id: null,
      intent_payload_json: payloadJson,
      intent_idempotency_key: intentKey,
      intent_dispatched_at: null,
    });
  });

  it('preserves the first intent and rejects a payload-changing requeue after dispatch', () => {
    const categoryId = '11111111-1111-1111-1111-111111111111';
    const payloadJson = JSON.stringify({
      ean: '8935039500400',
      purchasePrice: 0,
      retailPrice: 17.64,
      stockQty: 24,
      taxRate: 5,
      categoryId,
    });
    const intentKey = `local-import-v2-${'b'.repeat(64)}`;
    localVariantImportsRepo.create('variant-1', 'draft-1', '8935039500400', categoryId);
    localVariantImportsRepo.storeIntent('variant-1', payloadJson, intentKey);
    localVariantImportsRepo.markIntentDispatched('variant-1');
    localVariantImportsRepo.markFailed('variant-1', 'response lost');

    expect(() => localVariantImportsRepo.requeue(
      'variant-1',
      '8935039500499',
      categoryId,
    )).toThrow(LocalVariantImportOutcomeUncertainError);

    expect(localVariantImportsRepo.getByVariantId('variant-1')).toMatchObject({
      ean: '8935039500400',
      category_id: categoryId,
      status: 'FAILED',
      intent_payload_json: payloadJson,
      intent_idempotency_key: intentKey,
    });
  });

  it('requeues the exact uncertain intent without changing its saved bytes or key', () => {
    const retiredCategoryId = '11111111-1111-1111-1111-111111111111';
    const payloadJson = JSON.stringify({
      ean: '8935039500400',
      purchasePrice: 0,
      retailPrice: 17.64,
      stockQty: 24,
      taxRate: 5,
      categoryId: retiredCategoryId,
    });
    const intentKey = `local-import-v2-${'a'.repeat(64)}`;
    localVariantImportsRepo.create('variant-1', 'draft-1', '8935039500400', retiredCategoryId);
    localVariantImportsRepo.storeIntent('variant-1', payloadJson, intentKey);
    localVariantImportsRepo.markIntentDispatched('variant-1');
    localVariantImportsRepo.markFailed('variant-1', 'response lost');

    const failed = localVariantImportsRepo.getByVariantId('variant-1')!;
    expect(getSavedLocalVariantImportIntentIdentity(failed)).toEqual({
      ean: '8935039500400',
      categoryId: retiredCategoryId,
    });
    localVariantImportsRepo.requeue('variant-1', '8935039500400', retiredCategoryId);

    expect(localVariantImportsRepo.getByVariantId('variant-1')).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      intent_payload_json: payloadJson,
      intent_idempotency_key: intentKey,
    });
  });

  it('does not trust a saved identity with an invalid immutable key', () => {
    localVariantImportsRepo.create('invalid-key', 'draft-1', '8935039500400');
    localVariantImportsRepo.storeIntent(
      'invalid-key',
      JSON.stringify({ ean: '8935039500400', categoryId: null }),
      'not-a-valid-intent-key',
    );
    localVariantImportsRepo.markIntentDispatched('invalid-key');

    expect(getSavedLocalVariantImportIntentIdentity(
      localVariantImportsRepo.getByVariantId('invalid-key')!,
    )).toBeNull();
    localVariantImportsRepo.markFailed('invalid-key', 'response lost');
    expect(() => localVariantImportsRepo.requeue(
      'invalid-key',
      '8935039500400',
      null,
    )).toThrow(LocalVariantImportOutcomeUncertainError);
  });

  it('allows a changed requeue only when no request may have been dispatched', () => {
    localVariantImportsRepo.create('variant-1', 'draft-1', '8935039500400');
    localVariantImportsRepo.markFailed('variant-1', 'local price is invalid');

    localVariantImportsRepo.requeue('variant-1', '8935039500499', null);

    expect(localVariantImportsRepo.getByVariantId('variant-1')).toMatchObject({
      ean: '8935039500499',
      status: 'PENDING',
      attempts: 0,
      intent_payload_json: null,
      intent_idempotency_key: null,
      intent_dispatched_at: null,
    });
  });

  it('releases a definitively rejected intent so a corrected payload gets a new ledger', () => {
    localVariantImportsRepo.create('variant-1', 'draft-1', '8935039500400');
    localVariantImportsRepo.storeIntent(
      'variant-1',
      JSON.stringify({
        ean: '8935039500400',
        purchasePrice: 0,
        retailPrice: 17.64,
        stockQty: 24,
        taxRate: 5,
        categoryId: null,
      }),
      'intent-key-1',
    );
    localVariantImportsRepo.markIntentDispatched('variant-1');

    localVariantImportsRepo.markDefinitivelyRejected('variant-1', 'invalid category');
    localVariantImportsRepo.requeue('variant-1', '8935039500499', null);

    expect(localVariantImportsRepo.getByVariantId('variant-1')).toMatchObject({
      ean: '8935039500499',
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      intent_payload_json: null,
      intent_idempotency_key: null,
      intent_dispatched_at: null,
    });
  });

  it('requeues an exact legacy intent for mandatory read-only reconciliation', () => {
    const retiredCategoryId = '11111111-1111-1111-1111-111111111111';
    localVariantImportsRepo.create('legacy-1', 'draft-1', '8935039500400', retiredCategoryId);
    dbState.db!.run(
      "UPDATE local_variant_imports SET status = 'FAILED', intent_dispatched_at = created_at WHERE variant_id = 'legacy-1'",
    );

    localVariantImportsRepo.requeue('legacy-1', '8935039500400', retiredCategoryId);

    expect(localVariantImportsRepo.getByVariantId('legacy-1')).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      ean: '8935039500400',
      category_id: retiredCategoryId,
      intent_payload_json: null,
      intent_idempotency_key: null,
    });
    expect(localVariantImportsRepo.getByVariantId('legacy-1')?.intent_dispatched_at)
      .not.toBeNull();
  });

  it('keeps a payload-changing legacy requeue fail-closed', () => {
    const originalCategoryId = '11111111-1111-1111-1111-111111111111';
    localVariantImportsRepo.create('legacy-1', 'draft-1', '8935039500400', originalCategoryId);
    dbState.db!.run(
      "UPDATE local_variant_imports SET status = 'FAILED', intent_dispatched_at = created_at WHERE variant_id = 'legacy-1'",
    );

    expect(() => localVariantImportsRepo.requeue(
      'legacy-1',
      '8935039500400',
      '22222222-2222-2222-2222-222222222222',
    )).toThrow(LocalVariantImportOutcomeUncertainError);
  });

  it('releases only a legacy snapshot-less quarantine after server lookup proves retry is safe', () => {
    localVariantImportsRepo.create('legacy-safe', 'draft-1', '8935039500400');
    dbState.db!.run(
      "UPDATE local_variant_imports SET intent_dispatched_at = created_at WHERE variant_id = 'legacy-safe'",
    );

    localVariantImportsRepo.resetLegacyUncertainIntent('legacy-safe');

    expect(localVariantImportsRepo.getByVariantId('legacy-safe')).toMatchObject({
      status: 'PENDING',
      intent_payload_json: null,
      intent_idempotency_key: null,
      intent_dispatched_at: null,
    });
  });

  it('never releases a quarantine that already has replay bytes', () => {
    localVariantImportsRepo.create('durable-1', 'draft-1', '8935039500400');
    localVariantImportsRepo.storeIntent('durable-1', JSON.stringify({ ean: '8935039500400' }), 'key-1');
    localVariantImportsRepo.markIntentDispatched('durable-1');

    expect(() => localVariantImportsRepo.resetLegacyUncertainIntent('durable-1'))
      .toThrow(LocalVariantImportOutcomeUncertainError);
  });

  it('keeps SYNCED terminal state when a stale reconcile loser reports failure', () => {
    const payloadJson = JSON.stringify({
      ean: '8935039500400',
      purchasePrice: 0,
      retailPrice: 17.64,
      stockQty: 24,
      taxRate: 5,
      categoryId: null,
    });
    localVariantImportsRepo.create('cas-synced', 'draft-1', '8935039500400');
    localVariantImportsRepo.storeIntent('cas-synced', payloadJson, 'intent-key-1');
    localVariantImportsRepo.markIntentDispatched('cas-synced');
    localVariantImportsRepo.markSynced('cas-synced', 'server-variant-1');

    localVariantImportsRepo.markFailed('cas-synced', 'stale timeout');
    localVariantImportsRepo.markDefinitivelyRejected('cas-synced', 'stale 422');
    localVariantImportsRepo.markAttempt('cas-synced', 'stale retry');

    expect(localVariantImportsRepo.getByVariantId('cas-synced')).toMatchObject({
      status: 'SYNCED',
      server_variant_id: 'server-variant-1',
      attempts: 0,
      last_error: null,
      intent_payload_json: payloadJson,
      intent_idempotency_key: 'intent-key-1',
    });
  });

  it('does not let a stale success overwrite an already terminal FAILED row', () => {
    localVariantImportsRepo.create('cas-failed', 'draft-1', '8935039500400');
    localVariantImportsRepo.markFailed('cas-failed', 'manual audit required');

    expect(() => localVariantImportsRepo.markSynced('cas-failed', 'server-variant-1'))
      .toThrow(LocalVariantImportOutcomeUncertainError);
    expect(localVariantImportsRepo.getByVariantId('cas-failed')).toMatchObject({
      status: 'FAILED',
      server_variant_id: null,
      last_error: 'manual audit required',
    });
  });
});
