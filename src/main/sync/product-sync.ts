import { apiClient } from '../network/api-client';
import { productRepo } from '../database/repos/product-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';

export class ProductSync {
  /**
   * Full sync — download all products + categories from backend
   */
  async fullSync(): Promise<{ productsCount: number; categoriesCount: number }> {
    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    const data = await apiClient.getPosProducts(token);

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

      database.run(
        "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES ('products_last_sync', ?, datetime('now'))",
        [new Date().toISOString()],
      );
    });
    database.save();

    logger.info(
      `[ProductSync] Full sync: ${data.products.length} products, ${data.categories.length} categories`,
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

    const data = await apiClient.getPosProducts(token, lastSync.value);

    database.transaction(() => {
      if (data.products.length > 0) {
        productRepo.upsertMany(data.products);
      }
      if (data.categories.length > 0) {
        productRepo.upsertCategories(data.categories);
      }
      database.run(
        "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES ('products_last_sync', ?, datetime('now'))",
        [new Date().toISOString()],
      );
    });
    database.save();

    logger.info(`[ProductSync] Delta sync: ${data.products.length} products updated`);
    return data.products.length;
  }
}
