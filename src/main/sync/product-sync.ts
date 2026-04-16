import { apiClient } from '../network/api-client';
import { productRepo } from '../database/repos/product-repo';
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
        productRepo.deactivateExcept(syncedIds);
      }

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
   * Delta sync — only changed products since last sync
   */
  async deltaSync(): Promise<number> {
    const lastSync = database.get<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = 'products_last_sync'",
    );
    if (!lastSync?.value) {
      const result = await this.fullSync();
      return result.productsCount;
    }

    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    const data = await withRetry(() => apiClient.getPosProducts(token, lastSync.value));

    database.transaction(() => {
      if (data.products.length > 0) {
        productRepo.upsertMany(data.products);
      }
      if (data.categories.length > 0) {
        productRepo.upsertCategories(data.categories);
      }
      // Deactivate products deleted on backend (delta sync only)
      if (data.deletedIds && data.deletedIds.length > 0) {
        productRepo.deactivateByIds(data.deletedIds);
      }
      const syncTimestamp = data.nextSince ?? new Date().toISOString();
      database.run(
        "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES ('products_last_sync', ?, datetime('now'))",
        [syncTimestamp],
      );
    });
    database.save();

    const deletedCount = data.deletedIds?.length ?? 0;
    logger.info(`[ProductSync] Delta sync: ${data.products.length} updated, ${deletedCount} deleted (nextSince=${data.nextSince ?? 'local'})`);
    return data.products.length;
  }
}
