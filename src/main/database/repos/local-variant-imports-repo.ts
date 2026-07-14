import { database } from '../database';

/**
 * Tracks variants that were materialized from `draft_products` locally
 * (without a server `scan-create` roundtrip). The cashier-visible POS keeps
 * working offline; a background worker — or a future delta sync that brings
 * the same product down naturally — flips these rows to SYNCED.
 *
 * Statuses:
 *   PENDING — unresolved and queued; a saved intent may already have been dispatched
 *   SYNCED  — server has a real variant for this row (server_variant_id set)
 *   FAILED  — repeated attempts to materialize on server were rejected
 */
export interface LocalVariantImportRow {
  variant_id: string;
  draft_id: string;
  ean: string;
  status: 'PENDING' | 'SYNCED' | 'FAILED';
  attempts: number;
  last_error: string | null;
  created_at: string;
  synced_at: string | null;
  server_variant_id: string | null;
  category_id: string | null;
  intent_payload_json: string | null;
  intent_idempotency_key: string | null;
  intent_dispatched_at: string | null;
}

export interface FailedLocalVariantImportRow extends LocalVariantImportRow {
  product_name: string | null;
  product_barcode: string | null;
  product_category_id: string | null;
  retail_price: number | null;
  in_stock: number | null;
  available_qty: number | null;
}

export class LocalVariantImportOutcomeUncertainError extends Error {
  readonly code = 'LOCAL_VARIANT_IMPORT_OUTCOME_UNCERTAIN';
  readonly status = 409;

  constructor(message = 'local-import-outcome-uncertain') {
    super(message);
    this.name = 'LocalVariantImportOutcomeUncertainError';
  }
}

export interface LocalVariantImportIntentIdentity {
  ean: string;
  categoryId: string | null;
}

const LOCAL_IMPORT_INTENT_KEY_RE = /^local-import-v2-[a-f0-9]{64}$/i;
const BACKEND_CATEGORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getSavedLocalVariantImportIntentIdentity(
  row: Pick<LocalVariantImportRow,
    'intent_payload_json' | 'intent_idempotency_key' | 'intent_dispatched_at'>,
): LocalVariantImportIntentIdentity | null {
  if (!row.intent_dispatched_at || !row.intent_payload_json) return null;
  if (!LOCAL_IMPORT_INTENT_KEY_RE.test(String(row.intent_idempotency_key ?? '').trim())) return null;
  try {
    const payload = JSON.parse(row.intent_payload_json);
    if (!payload || typeof payload !== 'object') return null;
    const ean = String(payload.ean ?? '').trim();
    if (!/^\d{4,14}$/.test(ean)) return null;
    const rawCategoryId = String(payload.categoryId ?? '').trim();
    if (rawCategoryId && !BACKEND_CATEGORY_ID_RE.test(rawCategoryId)) return null;
    return {
      ean,
      categoryId: rawCategoryId || null,
    };
  } catch {
    return null;
  }
}

/** The v54 migration could only record that a legacy request may have been
 * dispatched; it could not reconstruct its request bytes. Such a row may be
 * re-opened only to verify the exact old identity with a read-only lookup. */
export function isExactLegacyUncertainImportRetry(
  row: Pick<LocalVariantImportRow,
    'ean' | 'category_id' | 'intent_payload_json' | 'intent_idempotency_key' | 'intent_dispatched_at'>,
  ean: string,
  categoryId?: string | null,
): boolean {
  const normalizedEan = String(ean ?? '').trim();
  const normalizedCategoryId = String(categoryId ?? '').trim() || null;
  return !!row.intent_dispatched_at
    && row.intent_payload_json == null
    && row.intent_idempotency_key == null
    && String(row.ean ?? '').trim() === normalizedEan
    && (String(row.category_id ?? '').trim() || null) === normalizedCategoryId;
}

export const localVariantImportsRepo = {
  /** Create a local-import marker without overwriting an existing intent ledger. */
  create(variantId: string, draftId: string, ean: string, categoryId?: string | null): void {
    const normalizedCategoryId = String(categoryId ?? '').trim() || null;
    database.run(
      `INSERT OR IGNORE INTO local_variant_imports
         (variant_id, draft_id, ean, status, attempts, last_error, created_at, synced_at, server_variant_id, category_id)
       VALUES (?, ?, ?, 'PENDING', 0, NULL, datetime('now'), NULL, NULL, ?)`,
      [variantId, draftId, ean, normalizedCategoryId],
    );
  },

  getByVariantId(variantId: string): LocalVariantImportRow | null {
    return database.get<LocalVariantImportRow>(
      'SELECT * FROM local_variant_imports WHERE variant_id = ?',
      [variantId],
    );
  },

  getServerVariantId(variantId: string): string | null {
    const row = database.get<{ server_variant_id: string | null }>(
      "SELECT server_variant_id FROM local_variant_imports WHERE variant_id = ? AND status = 'SYNCED'",
      [variantId],
    );
    return row?.server_variant_id ?? null;
  },

  getPending(): LocalVariantImportRow[] {
    return database.all<LocalVariantImportRow>(
      "SELECT * FROM local_variant_imports WHERE status = 'PENDING' ORDER BY created_at",
    );
  },

  getPendingByVariantId(variantId: string): LocalVariantImportRow | null {
    return database.get<LocalVariantImportRow>(
      "SELECT * FROM local_variant_imports WHERE variant_id = ? AND status = 'PENDING'",
      [variantId],
    );
  },

  getFailed(): FailedLocalVariantImportRow[] {
    return database.all<FailedLocalVariantImportRow>(
      `SELECT lvi.*,
              pv.name AS product_name,
              pv.barcode AS product_barcode,
              pv.category_id AS product_category_id,
              pv.retail_price AS retail_price,
              pv.in_stock AS in_stock,
              pv.available_qty AS available_qty
       FROM local_variant_imports lvi
       LEFT JOIN product_variants pv ON pv.id = lvi.variant_id
       WHERE lvi.status = 'FAILED'
       ORDER BY lvi.created_at`,
    );
  },

  getFailedCount(): number {
    const row = database.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM local_variant_imports WHERE status = 'FAILED'",
    );
    return row?.c ?? 0;
  },

  getSyncedAliases(): LocalVariantImportRow[] {
    return database.all<LocalVariantImportRow>(
      `SELECT * FROM local_variant_imports
       WHERE status = 'SYNCED'
         AND server_variant_id IS NOT NULL
         AND server_variant_id != variant_id
       ORDER BY synced_at`,
    );
  },

  /** Variant IDs that the server doesn't know about yet — used by ProductSync
   *  to keep these rows alive across full-syncs. */
  getPendingVariantIds(): Set<string> {
    const rows = database.all<{ variant_id: string }>(
      "SELECT variant_id FROM local_variant_imports WHERE status = 'PENDING'",
    );
    return new Set(rows.map((r) => r.variant_id));
  },

  /** Local import rows are not canonical product-admin revisions. This includes
   *  SYNCED aliases: forwarding their local timestamp to the canonical server
   *  row would corrupt optimistic-concurrency semantics. */
  getAdminMutationBlockedVariantIds(): Set<string> {
    const rows = database.all<{ variant_id: string }>(
      'SELECT variant_id FROM local_variant_imports',
    );
    return new Set(rows.map((row) => String(row.variant_id ?? '').trim()).filter(Boolean));
  },

  /** Has at least one PENDING row referencing this variant_id? Used by
   *  OrderSync to defer pushing orders that depend on unresolved variants. */
  isPendingVariant(variantId: string): boolean {
    const row = database.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM local_variant_imports WHERE variant_id = ? AND status = 'PENDING'",
      [variantId],
    );
    return (row?.c ?? 0) > 0;
  },

  /** True for any locally-imported variant that still has no server id.
   *  Includes FAILED rows so orders never upload with client-local ids. */
  isUnresolvedVariant(variantId: string): boolean {
    const row = database.get<{ c: number }>(
      `SELECT COUNT(*) AS c
       FROM local_variant_imports
       WHERE variant_id = ?
         AND server_variant_id IS NULL
         AND status IN ('PENDING', 'FAILED')`,
      [variantId],
    );
    return (row?.c ?? 0) > 0;
  },

  markAttempt(variantId: string, error: string | null): void {
    database.run(
      `UPDATE local_variant_imports
       SET attempts = attempts + 1, last_error = ?
       WHERE variant_id = ? AND status = 'PENDING'`,
      [error, variantId],
    );
  },

  /** Save the immutable scan-create request before its first dispatch. */
  storeIntent(variantId: string, payloadJson: string, idempotencyKey: string): void {
    const existing = this.getByVariantId(variantId);
    if (!existing || existing.status !== 'PENDING') {
      throw new Error('local-import-pending-row-not-found');
    }
    if (existing.intent_payload_json != null || existing.intent_idempotency_key != null) {
      if (existing.intent_payload_json === payloadJson
        && existing.intent_idempotency_key === idempotencyKey) return;
      throw new Error('local-import-intent-already-stored');
    }
    if (existing.intent_dispatched_at) {
      throw new LocalVariantImportOutcomeUncertainError();
    }

    database.run(
      `UPDATE local_variant_imports
       SET intent_payload_json = ?, intent_idempotency_key = ?
       WHERE variant_id = ?
         AND status = 'PENDING'
         AND intent_payload_json IS NULL
         AND intent_idempotency_key IS NULL
         AND intent_dispatched_at IS NULL`,
      [payloadJson, idempotencyKey, variantId],
    );

    const stored = this.getByVariantId(variantId);
    if (stored?.intent_payload_json !== payloadJson
      || stored.intent_idempotency_key !== idempotencyKey) {
      throw new Error('local-import-intent-store-failed');
    }
  },

  /** Record potential dispatch before the network call; the caller must flush
   *  the database to disk and fail closed if that flush does not succeed. */
  markIntentDispatched(variantId: string): void {
    database.run(
      `UPDATE local_variant_imports
       SET intent_dispatched_at = COALESCE(intent_dispatched_at, datetime('now'))
       WHERE variant_id = ?
         AND status = 'PENDING'
         AND intent_payload_json IS NOT NULL
         AND intent_idempotency_key IS NOT NULL`,
      [variantId],
    );
  },

  /** Release a pre-v54 quarantine only after the caller has made a fresh
   *  read-only server lookup proving that the EAN has no ambiguous or active
   *  salon variant. Never use this for a row that already has replay bytes. */
  resetLegacyUncertainIntent(variantId: string): void {
    database.run(
      `UPDATE local_variant_imports
       SET intent_dispatched_at = NULL
       WHERE variant_id = ?
         AND status = 'PENDING'
         AND intent_payload_json IS NULL
         AND intent_idempotency_key IS NULL
         AND intent_dispatched_at IS NOT NULL`,
      [variantId],
    );

    const reset = this.getByVariantId(variantId);
    if (!reset || reset.status !== 'PENDING'
      || reset.intent_payload_json !== null
      || reset.intent_idempotency_key !== null
      || reset.intent_dispatched_at !== null) {
      throw new LocalVariantImportOutcomeUncertainError();
    }
  },

  markSynced(variantId: string, serverVariantId: string): void {
    database.run(
      `UPDATE local_variant_imports
       SET status = 'SYNCED',
           server_variant_id = ?,
           synced_at = datetime('now'),
           last_error = NULL
       WHERE variant_id = ? AND status = 'PENDING'`,
      [serverVariantId, variantId],
    );
    const current = this.getByVariantId(variantId);
    if (current?.status === 'SYNCED' && current.server_variant_id === serverVariantId) return;
    throw new LocalVariantImportOutcomeUncertainError('local-import-sync-transition-conflict');
  },

  markFailed(variantId: string, error: string): void {
    database.run(
      `UPDATE local_variant_imports
       SET status = 'FAILED', attempts = attempts + 1, last_error = ?
       WHERE variant_id = ? AND status = 'PENDING'`,
      [error, variantId],
    );
    const current = this.getByVariantId(variantId);
    if (current?.status === 'FAILED' || current?.status === 'SYNCED') return;
    throw new LocalVariantImportOutcomeUncertainError('local-import-failed-transition-conflict');
  },

  /** A confirmed no-commit rejection releases the old request ledger so the
   *  operator can correct its payload and create a fresh intent. */
  markDefinitivelyRejected(variantId: string, error: string): void {
    database.run(
      `UPDATE local_variant_imports
       SET status = 'FAILED',
           attempts = attempts + 1,
           last_error = ?,
           intent_payload_json = NULL,
           intent_idempotency_key = NULL,
           intent_dispatched_at = NULL
       WHERE variant_id = ? AND status = 'PENDING'`,
      [error, variantId],
    );
    const current = this.getByVariantId(variantId);
    if (current?.status === 'FAILED' || current?.status === 'SYNCED') return;
    throw new LocalVariantImportOutcomeUncertainError('local-import-rejection-transition-conflict');
  },

  requeue(variantId: string, ean: string, categoryId?: string | null): void {
    const normalizedEan = String(ean ?? '').trim();
    const normalizedCategoryId = String(categoryId ?? '').trim() || null;
    const existing = this.getByVariantId(variantId);
    if (!existing || existing.status !== 'FAILED') return;

    if (existing.intent_dispatched_at) {
      const legacySnapshotMissing = existing.intent_payload_json == null
        && existing.intent_idempotency_key == null;
      const savedIntent = legacySnapshotMissing
        ? null
        : getSavedLocalVariantImportIntentIdentity(existing);
      const canResumeLegacyLookup = isExactLegacyUncertainImportRetry(
        existing,
        normalizedEan,
        normalizedCategoryId,
      );
      const canReplayExactIntent = !!savedIntent
        && savedIntent.ean === normalizedEan
        && savedIntent.categoryId === normalizedCategoryId;
      if (!canResumeLegacyLookup && !canReplayExactIntent) {
        throw new LocalVariantImportOutcomeUncertainError();
      }

      database.run(
        `UPDATE local_variant_imports
         SET status = 'PENDING',
             attempts = 0,
             last_error = NULL,
             synced_at = NULL,
             server_variant_id = NULL
         WHERE variant_id = ?
           AND status = 'FAILED'`,
        [variantId],
      );
      return;
    }

    database.run(
      `UPDATE local_variant_imports
       SET ean = ?,
           category_id = ?,
           status = 'PENDING',
           attempts = 0,
           last_error = NULL,
           synced_at = NULL,
           server_variant_id = NULL,
           intent_payload_json = NULL,
           intent_idempotency_key = NULL,
           intent_dispatched_at = NULL
       WHERE variant_id = ?
         AND status = 'FAILED'`,
      [normalizedEan, normalizedCategoryId, variantId],
    );
  },
};
