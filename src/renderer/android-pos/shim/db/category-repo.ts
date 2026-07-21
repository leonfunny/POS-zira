/**
 * Android catalog category repo — port of the Windows category query/upsert
 * logic over the local SQL.js mirror.
 *
 * Packet S5 (S1 §2.D). `getCategories` (Windows product-repo.ts:477-494) and
 * `upsertCategories` (product-repo.ts:719-749) are copied verbatim — the EXISTS
 * subquery that drops empty categories, the template-with-variants exclusion,
 * and the COALESCE that preserves a locally-known `kitchen_print` flag when a
 * backend payload omits it. Only the DB handle changes (factory over an injected
 * `AndroidDatabase`); the column set is the PosCategory subset the Android
 * schema stores (omits customer_display, name_translations, kiosk fields — S5 §2).
 */

import type { AndroidDatabase } from './db';

/** A category row. Columns = what `PosCategory` exposes (S1 §2.D). */
export interface AndroidCategoryRow {
  id: string;
  name: string;
  image_url: string | null;
  icon: string | null;
  color: string | null;
  sort_order: number;
  updated_at: string | null;
  kitchen_print: number | null;
}

export interface AndroidCategoryRepo {
  /** Categories that have at least one active, sellable product. */
  getCategories(): AndroidCategoryRow[];
  /** Bulk upsert for the catalog sync worker (S6). */
  upsertCategories(categories: AndroidCategoryRow[]): void;
}

export function createCategoryRepo(db: AndroidDatabase): AndroidCategoryRepo {
  return {
    getCategories(): AndroidCategoryRow[] { // (product-repo.ts:477-494)
      return db.all<AndroidCategoryRow>(
        `SELECT c.*
         FROM categories c
         WHERE EXISTS (
           SELECT 1
           FROM product_variants p
           WHERE p.category_id = c.id
             AND p.is_active = 1
             AND p.id NOT IN (
               SELECT DISTINCT pv.template_id
               FROM product_variants pv
               WHERE pv.template_id IS NOT NULL AND pv.is_active = 1
             )
         )
         ORDER BY c.sort_order, c.name`,
      );
    },

    upsertCategories(cats: AndroidCategoryRow[]): void { // (product-repo.ts:719-749, column subset)
      if (cats.length === 0) return;
      // NOTE: caller wraps in a transaction for atomicity (mirrors Windows
      // product-repo.ts:721-722). Not wrapped here to avoid nested transactions.
      for (const c of cats) {
        if (!c.id || !c.name) {
          throw new Error(`Invalid category: missing id or name (id=${c.id})`);
        }
        // kitchen_print: COALESCE keeps the locally-known flag when an older
        // backend payload omits it (NULL), instead of silently resetting it
        // (product-repo.ts:729-738).
        db.run(
          `INSERT OR REPLACE INTO categories (
            id, name, image_url, icon, color, sort_order, updated_at, kitchen_print
          )
           VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT kitchen_print FROM categories WHERE id = ?), 0))`,
          [
            c.id, c.name, c.image_url, c.icon, c.color, c.sort_order ?? 0, c.updated_at,
            c.kitchen_print ?? null, c.id,
          ],
        );
      }
    },
  };
}
