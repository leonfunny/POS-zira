import { database } from '../database';

export interface ProductVariantRow {
  id: string;
  template_id: string | null;
  name: string;
  sku: string | null;
  barcode: string | null;
  retail_price: number;
  category_id: string | null;
  image_url: string | null;
  in_stock: number;
  vat_rate: number;
  is_active: number;
  updated_at: string | null;
}

export interface CategoryRow {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sort_order: number;
  updated_at: string | null;
}

export const productRepo = {
  getAll(): ProductVariantRow[] {
    return database.all<ProductVariantRow>(
      'SELECT * FROM product_variants WHERE is_active = 1 ORDER BY name',
    );
  },

  getByCategory(categoryId: string): ProductVariantRow[] {
    return database.all<ProductVariantRow>(
      'SELECT * FROM product_variants WHERE category_id = ? AND is_active = 1 ORDER BY name',
      [categoryId],
    );
  },

  getByBarcode(barcode: string): ProductVariantRow | null {
    return database.get<ProductVariantRow>(
      'SELECT * FROM product_variants WHERE barcode = ? AND is_active = 1',
      [barcode],
    );
  },

  search(query: string): ProductVariantRow[] {
    const like = `%${query}%`;
    return database.all<ProductVariantRow>(
      'SELECT * FROM product_variants WHERE is_active = 1 AND (name LIKE ? OR sku LIKE ? OR barcode LIKE ?) ORDER BY name',
      [like, like, like],
    );
  },

  upsertMany(products: ProductVariantRow[]): void {
    if (products.length === 0) return;
    // NOTE: Caller should wrap in transaction for atomicity (e.g., ProductSync)
    for (const p of products) {
      // Validate required fields to prevent SQLite errors
      if (!p.id || !p.name) {
        throw new Error(`Invalid product: missing id or name (id=${p.id})`);
      }
      database.run(
        `INSERT OR REPLACE INTO product_variants (id, template_id, name, sku, barcode, retail_price, category_id, image_url, in_stock, vat_rate, is_active, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.template_id, p.name, p.sku, p.barcode, p.retail_price ?? 0, p.category_id, p.image_url, p.in_stock ?? 0, p.vat_rate ?? 23, p.is_active ?? 1, p.updated_at],
      );
    }
  },

  getCategories(): CategoryRow[] {
    return database.all<CategoryRow>('SELECT * FROM categories ORDER BY sort_order, name');
  },

  /**
   * Mark all products NOT in the given set as inactive.
   * Called during full sync to handle products deleted on backend.
   */
  deactivateExcept(activeIds: Set<string>): void {
    const allProducts = database.all<{ id: string }>(
      'SELECT id FROM product_variants WHERE is_active = 1',
    );
    for (const p of allProducts) {
      if (!activeIds.has(p.id)) {
        database.run(
          'UPDATE product_variants SET is_active = 0 WHERE id = ?',
          [p.id],
        );
      }
    }
  },

  upsertCategories(cats: CategoryRow[]): void {
    if (cats.length === 0) return;
    // NOTE: Caller should wrap in transaction for atomicity (e.g., ProductSync)
    for (const c of cats) {
      // Validate required fields
      if (!c.id || !c.name) {
        throw new Error(`Invalid category: missing id or name (id=${c.id})`);
      }
      database.run(
        'INSERT OR REPLACE INTO categories (id, name, icon, color, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [c.id, c.name, c.icon, c.color, c.sort_order ?? 0, c.updated_at],
      );
    }
  },
};
