import { apiClient } from '../network/api-client';
import { productRepo } from '../database/repos/product-repo';
import { localVariantImportsRepo } from '../database/repos/local-variant-imports-repo';
import { orderRepo } from '../database/repos/order-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';

/** Retry an async fn with exponential backoff (1s, 3s, 9s). */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = Math.pow(3, attempt - 1) * 1000; // 1s, 3s, 9s
        logger.warn(`[ProductSync] Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export class ProductSync {
  /** Remember if delta sync is unsupported — avoids 7s retry waste each connect. */
  private deltaUnsupported = false;

  /**
   * Full sync — download all products + categories from backend
   */
  async fullSync(): Promise<{ productsCount: number; categoriesCount: number }> {
    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    const data = await withRetry(() => apiClient.getPosProducts(token));

    database.transaction(() => {
      if (data.categories.length > 0) {
        productRepo.upsertCategories(data.categories);
      }
      if (data.products.length > 0) {
        productRepo.upsertMany(data.products);
      }

      // Mark products not in the sync response as inactive (handles deletions on backend)
      if (data.products.length > 0) {
        const syncedIds = new Set(data.products.map((p: any) => p.id));
        // Locally-imported variants (from draft scan, not yet pushed to
        // server) aren't in the server's response. Keep them alive so the
        // cashier doesn't lose stock they just rang up.
        for (const localId of localVariantImportsRepo.getPendingVariantIds()) {
          syncedIds.add(localId);
        }
        for (const row of localVariantImportsRepo.getSyncedAliases()) {
          const serverVisible = !!row.server_variant_id && syncedIds.has(row.server_variant_id);
          if (!serverVisible || orderRepo.hasUnsyncedOrdersForVariant(row.variant_id)) {
            syncedIds.add(row.variant_id);
          }
        }
        productRepo.deactivateExcept(syncedIds);
      }
      this.cleanupSyncedLocalAliases();

      const syncTimestamp = data.nextSince ?? new Date().toISOString();
      database.run(
        "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES ('products_last_sync', ?, datetime('now'))",
        [syncTimestamp],
      );
    });
    database.save();

    logger.info(
      `[ProductSync] Full sync: ${data.products.length} products, ${data.categories.length} categories (nextSince=${data.nextSince ?? 'local'})`,
    );
    return { productsCount: data.products.length, categoriesCount: data.categories.length };
  }

  /**
   * Delta sync — only changed products since last sync.
   * Falls back to full sync if no cursor or if backend rejects 'since' param.
   */
  async deltaSync(): Promise<number> {
    const lastSync = database.get<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = 'products_last_sync'",
    );
    if (!lastSync?.value) {
      const result = await this.fullSync();
      return result.productsCount;
    }

    // Skip delta if we already know backend doesn't support it
    if (this.deltaUnsupported) {
      const result = await this.fullSync();
      return result.productsCount;
    }

    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    let data;
    try {
      data = await withRetry(() => apiClient.getPosProducts(token, lastSync.value));
    } catch (err: any) {
      // Backend rejects 'since' param — remember and fall back to full sync
      if (err.message?.includes('since') || err.message?.includes('should not exist')) {
        this.deltaUnsupported = true;
        logger.info('[ProductSync] Delta sync not supported by backend, using full sync (remembered for this session)');
        const result = await this.fullSync();
        return result.productsCount;
      }
      throw err;
    }

    database.transaction(() => {
      if (data.products.length > 0) {
        productRepo.upsertMany(data.products);
      }
      if (data.categories.length > 0) {
        productRepo.upsertCategories(data.categories);
      }
      if (data.deletedIds && data.deletedIds.length > 0) {
        productRepo.deactivateByIds(data.deletedIds);
      }
      this.cleanupSyncedLocalAliases();
      const syncTimestamp = data.nextSince ?? new Date().toISOString();
      database.run(
        "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES ('products_last_sync', ?, datetime('now'))",
        [syncTimestamp],
      );
    });
    database.save();

    // Delta succeeded — reset the flag (backend may have been updated)
    this.deltaUnsupported = false;

    const deletedCount = data.deletedIds?.length ?? 0;
    logger.info(`[ProductSync] Delta sync: ${data.products.length} updated, ${deletedCount} deleted (nextSince=${data.nextSince ?? 'local'})`);
    return data.products.length;
  }

  /**
   * Materialize variants that were created from draft_products while offline.
   * Until this succeeds, orders containing those local-only variant ids are
   * deliberately held back by OrderSync / SyncLogService.
   */
  async reconcileLocalVariantImports(maxRows = 10): Promise<number> {
    const token = getSecureAuthToken();

    const pending = localVariantImportsRepo.getPending().slice(0, maxRows);
    let reconciled = 0;
    let changed = false;

    for (const row of pending) {
      try {
        const localVariant = productRepo.getById(row.variant_id);
        if (!localVariant) {
          localVariantImportsRepo.markAttempt(row.variant_id, 'local variant row not found');
          changed = true;
          continue;
        }

        const retailPrice = localVariant.retail_price / 100;
        const stockQty = localVariant.in_stock > 0
          ? localVariant.in_stock
          : localVariant.available_qty;
        if (!(retailPrice >= 0.01) || !(stockQty >= 0.001)) {
          localVariantImportsRepo.markFailed(
            row.variant_id,
            `scan-create requires retailPrice >= 0.01 and stockQty >= 0.001 (retailPrice=${retailPrice}, stockQty=${stockQty})`,
          );
          changed = true;
          continue;
        }

        const result = await apiClient.scanCreate(token, {
          ean: row.ean,
          purchasePrice: 0,
          retailPrice,
          stockQty,
          taxRate: localVariant.vat_rate,
          idempotencyKey: `local-import-${row.variant_id}`,
        });
        const serverVariantId = extractServerVariantId(result);
        if (!serverVariantId) {
          localVariantImportsRepo.markAttempt(row.variant_id, 'scan-create returned no server variant id');
          changed = true;
          continue;
        }

        localVariantImportsRepo.markSynced(row.variant_id, serverVariantId);
        changed = true;
        reconciled++;
        logger.info(
          `[ProductSync] Reconciled local draft variant ${row.variant_id} -> server variant ${serverVariantId} (ean=${row.ean})`,
        );
      } catch (err: any) {
        const message = err?.message ?? String(err);
        localVariantImportsRepo.markAttempt(row.variant_id, message);
        changed = true;
        logger.warn(`[ProductSync] Local variant reconcile failed for ${row.variant_id}: ${message}`);
      }
    }

    if (changed) database.save();
    return reconciled;
  }

  /**
   * Once the real server variant has arrived in the local product mirror and
   * every order that used the temporary local id has synced, hide the local
   * alias. Keep local_variant_imports as the durable id map for history and
   * any late retry paths.
   */
  private cleanupSyncedLocalAliases(): void {
    for (const row of localVariantImportsRepo.getSyncedAliases()) {
      if (!row.server_variant_id) continue;
      if (!productRepo.getById(row.server_variant_id)) continue;
      if (orderRepo.hasUnsyncedOrdersForVariant(row.variant_id)) continue;
      productRepo.deactivateByIds([row.variant_id]);
    }
  }
}

function extractServerVariantId(result: any): string | null {
  const direct = result?.variantId ?? result?.variant_id;
  if (direct) return String(direct);

  const candidates = [
    result?.variant,
    result?.product?.variant,
    Array.isArray(result?.product?.variants) ? result.product.variants[0] : null,
    result?.product,
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const id = candidate.id ?? candidate.variantId ?? candidate.variant_id;
    const looksLikeVariant =
      candidate.barcode != null ||
      candidate.sku != null ||
      candidate.templateId != null ||
      candidate.template_id != null ||
      candidate.totalStockQty != null ||
      candidate.availableQty != null;
    if (id && looksLikeVariant) return String(id);
  }

  return null;
}
