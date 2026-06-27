import { apiClient } from '../network/api-client';
import { draftProductRepo, DraftProductRow } from '../database/repos/draft-product-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';
import { fullSyncOnCooldown, markFullSync } from './full-sync-cooldown';

/**
 * DraftProductSync — mirrors the master catalog draft_products table into
 * local SQLite. Server endpoint: GET /api/v1/master-catalog/draft-products
 * Socket events: draft-products:updated, draft-products:deleted
 */

/** Map server payload (typically camelCase) to local snake_case row. */
function toRow(p: any): DraftProductRow {
  const num = (v: unknown, fallback = 0) =>
    typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || fallback;
  return {
    id: String(p.id),
    name: String(p.name ?? ''),
    sku: p.sku ?? null,
    barcode: p.barcode ?? null,
    retail_price: num(p.retail_price ?? p.retailPrice ?? p.purchasePrice ?? p.purchase_price, 0),
    category_id: p.category_id ?? p.categoryId ?? null,
    image_url: p.image_url ?? p.imageUrl ?? null,
    in_stock: num(p.in_stock ?? p.inStock, 0),
    vat_rate: num(p.vat_rate ?? p.vatRate, 23),
    status: String(p.status ?? 'DRAFT'),
    created_by: p.created_by ?? p.createdBy ?? null,
    created_at: p.created_at ?? p.createdAt ?? null,
    updated_at: p.updated_at ?? p.updatedAt ?? null,
    deleted_at: p.deleted_at ?? p.deletedAt ?? null,
  };
}

/** Drop drafts the repo would reject (missing id or name). Logs a count
 *  so the sync isn't silently swallowing dirty rows. */
function sanitizeDrafts(drafts: any[]): DraftProductRow[] {
  const rows: DraftProductRow[] = [];
  let skipped = 0;
  for (const d of drafts) {
    const row = toRow(d);
    if (!row.id || !row.name || !row.name.trim()) {
      skipped++;
      continue;
    }
    rows.push(row);
  }
  if (skipped > 0) {
    logger.warn(`[DraftProductSync] Skipped ${skipped} draft(s) with missing id/name`);
  }
  return rows;
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = Math.pow(3, attempt - 1) * 1000;
        logger.warn(`[DraftProductSync] Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms: ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export class DraftProductSync {
  private deltaUnsupported = false;

  /** Full sync — wipes local mirror and reloads from server. */
  async fullSync(): Promise<{ count: number }> {
    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    const data = await withRetry(() => apiClient.getDraftProducts(token));
    const rows = sanitizeDrafts(data.drafts);

    database.transaction(() => {
      draftProductRepo.clearAll();
      if (rows.length > 0) {
        draftProductRepo.upsertMany(rows);
      }
      const cursor = data.nextSince ?? new Date().toISOString();
      database.run(
        "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES ('draft_products_last_sync', ?, datetime('now'))",
        [cursor],
      );
    });
    database.markDirty();
    markFullSync('draft_products');

    logger.info(`[DraftProductSync] Full sync: ${rows.length}/${data.drafts.length} drafts accepted (nextSince=${data.nextSince ?? 'local'})`);
    return { count: rows.length };
  }

  /** Local mirror size — used to keep the cooldown from stranding an empty mirror. */
  private getLocalDraftCount(): number {
    return database.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM draft_product',
    )?.n ?? 0;
  }

  /** Delta sync — only changes since the last cursor. Falls back to full sync if no cursor. */
  async deltaSync(): Promise<number> {
    const lastSync = database.get<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = 'draft_products_last_sync'",
    );
    if (!lastSync?.value || this.deltaUnsupported) {
      // Cursor missing → would re-pull every draft. On a flapping socket this
      // repeats each reconnect. Skip the sweep when we full-synced recently AND
      // the mirror still has data (delta-unsupported backends must still full).
      if (
        !this.deltaUnsupported &&
        this.getLocalDraftCount() > 0 &&
        fullSyncOnCooldown('draft_products')
      ) {
        logger.debug(
          '[DraftProductSync] Full sweep on cooldown and mirror non-empty — skipping',
        );
        return this.getLocalDraftCount();
      }
      const result = await this.fullSync();
      return result.count;
    }

    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    let data;
    try {
      data = await withRetry(() => apiClient.getDraftProducts(token, lastSync.value));
    } catch (err: any) {
      if (err.message?.includes('since') || err.message?.includes('should not exist')) {
        this.deltaUnsupported = true;
        logger.info('[DraftProductSync] Delta not supported by backend, falling back to full sync');
        const result = await this.fullSync();
        return result.count;
      }
      throw err;
    }

    const rows = sanitizeDrafts(data.drafts);

    database.transaction(() => {
      if (rows.length > 0) {
        draftProductRepo.upsertMany(rows);
      }
      if (data.deletedIds.length > 0) {
        draftProductRepo.softDeleteByIds(data.deletedIds);
      }
      const cursor = data.nextSince ?? new Date().toISOString();
      database.run(
        "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES ('draft_products_last_sync', ?, datetime('now'))",
        [cursor],
      );
    });
    database.markDirty();

    this.deltaUnsupported = false;
    logger.info(`[DraftProductSync] Delta sync: ${rows.length}/${data.drafts.length} updated accepted, ${data.deletedIds.length} deleted (nextSince=${data.nextSince ?? 'local'})`);
    return rows.length;
  }

  /** Apply a single live update received over Socket.IO. */
  applyUpdate(draft: any): void {
    const [row] = sanitizeDrafts([draft]);
    if (!row) return;
    database.transaction(() => {
      draftProductRepo.upsertMany([row]);
      database.run(
        "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES ('draft_products_last_sync', ?, datetime('now'))",
        [row.updated_at ?? new Date().toISOString()],
      );
    });
    database.markDirty();
    logger.info(`[DraftProductSync] Applied socket update for draft ${row.id}`);
  }

  applyDelete(id: string): void {
    draftProductRepo.softDeleteByIds([id]);
    database.markDirty();
    logger.info(`[DraftProductSync] Socket-deleted draft ${id}`);
  }
}

export const draftProductSync = new DraftProductSync();
