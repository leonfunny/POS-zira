import { database } from '../database';
import type { ProductVariantRow } from './product-repo';

export interface UpsellItemRow {
  product_id: string;
  score: number;
  updated_at: string;
}

export const upsellRepo = {
  replace(items: Array<{ productId: string; score: number }>): void {
    database.transaction(() => {
      database.run('DELETE FROM pos_recommended_items');
      for (const item of items) {
        database.run(
          `INSERT INTO pos_recommended_items (product_id, score, updated_at) VALUES (?, ?, datetime('now'))`,
          [item.productId, item.score],
        );
      }
    });
  },

  list(limit = 12): Array<ProductVariantRow & { score: number }> {
    return database.all<ProductVariantRow & { score: number }>(
      `SELECT pv.*, ri.score
       FROM pos_recommended_items ri
       JOIN product_variants pv ON pv.id = ri.product_id
       WHERE pv.is_active = 1
       ORDER BY ri.score DESC
       LIMIT ?`,
      [limit],
    );
  },
};
