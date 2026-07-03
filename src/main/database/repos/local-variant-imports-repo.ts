import { database } from '../database';

/**
 * Tracks variants that were materialized from `draft_products` locally
 * (without a server `scan-create` roundtrip). The cashier-visible POS keeps
 * working offline; a background worker — or a future delta sync that brings
 * the same product down naturally — flips these rows to SYNCED.
 *
 * Statuses:
 *   PENDING — local-only, hasn't reached the server yet
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
}

export interface FailedLocalVariantImportRow extends LocalVariantImportRow {
  product_name: string | null;
  product_barcode: string | null;
  product_category_id: string | null;
  retail_price: number | null;
  in_stock: number | null;
  available_qty: number | null;
}

export const localVariantImportsRepo = {
  /** Upsert a local-import marker for a freshly-created variant. */
  create(variantId: string, draftId: string, ean: string, categoryId?: string | null): void {
    const normalizedCategoryId = String(categoryId ?? '').trim() || null;
    database.run(
      `INSERT OR REPLACE INTO local_variant_imports
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
      'UPDATE local_variant_imports SET attempts = attempts + 1, last_error = ? WHERE variant_id = ?',
      [error, variantId],
    );
  },

  markSynced(variantId: string, serverVariantId: string): void {
    database.run(
      "UPDATE local_variant_imports SET status = 'SYNCED', server_variant_id = ?, synced_at = datetime('now'), last_error = NULL WHERE variant_id = ?",
      [serverVariantId, variantId],
    );
  },

  markFailed(variantId: string, error: string): void {
    database.run(
      "UPDATE local_variant_imports SET status = 'FAILED', attempts = attempts + 1, last_error = ? WHERE variant_id = ?",
      [error, variantId],
    );
  },

  requeue(variantId: string, ean: string, categoryId?: string | null): void {
    const normalizedEan = String(ean ?? '').trim();
    const normalizedCategoryId = String(categoryId ?? '').trim() || null;
    database.run(
      `UPDATE local_variant_imports
       SET ean = ?,
           category_id = ?,
           status = 'PENDING',
           attempts = 0,
           last_error = NULL,
           synced_at = NULL,
           server_variant_id = NULL
       WHERE variant_id = ?
         AND status = 'FAILED'`,
      [normalizedEan, normalizedCategoryId, variantId],
    );
  },
};
