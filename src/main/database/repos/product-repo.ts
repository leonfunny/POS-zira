import { database } from '../database';

/** Strip diacritics/accents for search matching (bánh → banh, łódź → lodz) */
function normalizeSearch(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

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
  // Enriched fields (migration v14)
  available_qty: number;
  price_gross: number;
  price_net: number;
  vat_amount: number;
  is_on_sale: number;
  thumbnail_url: string | null;
  sale_unit: string | null;
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

  getById(id: string): ProductVariantRow | null {
    return database.get<ProductVariantRow>('SELECT * FROM product_variants WHERE id = ?', [id]);
  },

  getByBarcode(barcode: string): ProductVariantRow | null {
    return database.get<ProductVariantRow>(
      'SELECT * FROM product_variants WHERE barcode = ? AND is_active = 1',
      [barcode],
    );
  },

  search(query: string): ProductVariantRow[] {
    // Try exact SQL LIKE first (fast path for SKU/barcode)
    const like = `%${query}%`;
    const sqlResults = database.all<ProductVariantRow>(
      'SELECT * FROM product_variants WHERE is_active = 1 AND (sku LIKE ? OR barcode LIKE ?) ORDER BY name',
      [like, like],
    );
    // Diacritics-aware search on name (bánh bao ↔ banh bao, łódź ↔ lodz)
    const normalizedQuery = normalizeSearch(query);
    const allActive = database.all<ProductVariantRow>(
      'SELECT * FROM product_variants WHERE is_active = 1 ORDER BY name',
    );
    const nameMatches = allActive.filter(p =>
      normalizeSearch(p.name).includes(normalizedQuery),
    );
    // Merge results, deduplicate by id
    const seen = new Set<string>();
    const merged: ProductVariantRow[] = [];
    for (const r of [...sqlResults, ...nameMatches]) {
      if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
    }
    return merged;
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
        `INSERT OR REPLACE INTO product_variants (id, template_id, name, sku, barcode, retail_price, category_id, image_url, in_stock, vat_rate, is_active, updated_at, available_qty, price_gross, price_net, vat_amount, is_on_sale, thumbnail_url, sale_unit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.template_id, p.name, p.sku, p.barcode, p.retail_price ?? 0, p.category_id, p.image_url, p.in_stock ?? 0, p.vat_rate ?? 23, p.is_active ?? 1, p.updated_at, p.available_qty ?? 0, p.price_gross ?? 0, p.price_net ?? 0, p.vat_amount ?? 0, p.is_on_sale ?? 0, p.thumbnail_url, p.sale_unit],
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

  deactivateByIds(ids: string[]): void {
    for (const id of ids) {
      database.run('UPDATE product_variants SET is_active = 0 WHERE id = ?', [id]);
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
