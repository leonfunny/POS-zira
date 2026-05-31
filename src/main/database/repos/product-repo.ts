import { database } from '../database';

/** Strip diacritics/accents for search matching (bánh → banh, łódź → lodz) */
function normalizeSearch(str: string): string {
  return str
    .replace(/[\u0110\u0111]/g, (ch) => (ch === '\u0110' ? 'D' : 'd'))
    .replace(/[\u0141\u0142]/g, (ch) => (ch === '\u0141' ? 'L' : 'l'))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function searchTokens(query: string): string[] {
  return normalizeSearch(query).split(/\s+/).filter(Boolean);
}

function tokenPositionScore(text: string, token: string): { index: number; score: number } | null {
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  const exactIndex = words.findIndex((word) => word === token);
  if (exactIndex >= 0) return { index: exactIndex, score: 80 };

  const prefixIndex = words.findIndex((word) => word.startsWith(token));
  if (prefixIndex >= 0) return { index: prefixIndex, score: 55 };

  const substringIndex = text.indexOf(token);
  if (substringIndex >= 0) return { index: words.length + substringIndex, score: 20 };

  return null;
}

function tokenMatchScore(text: string, tokens: string[]): number | null {
  if (tokens.length === 0) return null;
  const matches = tokens.map((token) => tokenPositionScore(text, token));
  if (matches.some((match) => !match)) return null;
  const indexes = matches.map((match) => match!.index);
  const spread = Math.max(...indexes) - Math.min(...indexes);
  return matches.reduce((sum, match) => sum + match!.score, 0) - Math.min(spread, 50);
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
  sell_by?: 'PIECE' | 'WEIGHT' | string | null;
  // UI localization (migration v28). JSON-encoded `{lang: name}`.
  // Optional: legacy seeds, old backend payloads, and tests can omit it —
  // renderer's resolveName falls back to canonical `name`.
  // Orders / fiscal payloads keep canonical `name`; local customer receipts
  // may resolve Polish at print time.
  name_translations?: string | null;
  customer_display_enabled?: number | null;
  customer_display_sort_order?: number | null;
}

export interface CategoryRow {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sort_order: number;
  updated_at: string | null;
  // Display-only localization (migration v28). Same contract as products.
  name_translations?: string | null;
  customer_display_enabled?: number | null;
  customer_display_section?: string | null;
  customer_display_sort_order?: number | null;
}

// Hide template rows that have variant children. The sync layer mirrors
// both the product (template) and its variants into product_variants —
// for a 1-product/1-variant tạp hóa item that surfaces as two rows
// with the same name and SKU, the template row carrying stock=0 and
// price=0. POS should only ever sell the leaf rows, otherwise we
// get phantom "out of stock" duplicates next to the real variant.
const HIDE_TEMPLATES_WITH_VARIANTS = `
  AND id NOT IN (
    SELECT DISTINCT template_id
    FROM product_variants
    WHERE template_id IS NOT NULL AND is_active = 1
  )
`;

function scoreSearchMatch(product: ProductVariantRow, query: string, normalizedQuery: string, tokens: string[]): number {
  const name = normalizeSearch(product.name || '');
  const sku = normalizeSearch(product.sku || '');
  const barcode = normalizeSearch(product.barcode || '');
  const codeFields = [barcode, sku].filter(Boolean);

  if (codeFields.some((field) => field === normalizedQuery)) return 10000;
  if (codeFields.some((field) => field.startsWith(normalizedQuery))) return 9200;
  if (codeFields.some((field) => field.includes(normalizedQuery))) return 8600;

  if (name === normalizedQuery) return 8000;
  if (name.startsWith(normalizedQuery)) return 7400;
  const phraseIndex = name.indexOf(normalizedQuery);
  if (phraseIndex >= 0) return 6800 - Math.min(phraseIndex, 500);

  const nameTokenScore = tokenMatchScore(name, tokens);
  if (nameTokenScore != null) return 5600 + nameTokenScore;

  const haystack = normalizeSearch([product.name, product.sku, product.barcode].filter(Boolean).join(' '));
  const haystackTokenScore = tokenMatchScore(haystack, tokens);
  if (haystackTokenScore != null) return 3600 + haystackTokenScore;

  const lowerQuery = query.toLowerCase();
  if (product.sku && product.sku.toLowerCase().includes(lowerQuery)) return 2500;
  if (product.barcode && product.barcode.toLowerCase().includes(lowerQuery)) return 2500;

  return 0;
}

export const productRepo = {
  getAll(): ProductVariantRow[] {
    return database.all<ProductVariantRow>(
      `SELECT * FROM product_variants WHERE is_active = 1 ${HIDE_TEMPLATES_WITH_VARIANTS} ORDER BY name`,
    );
  },

  getByCategory(categoryId: string): ProductVariantRow[] {
    return database.all<ProductVariantRow>(
      `SELECT * FROM product_variants WHERE category_id = ? AND is_active = 1 ${HIDE_TEMPLATES_WITH_VARIANTS} ORDER BY name`,
      [categoryId],
    );
  },

  getById(id: string): ProductVariantRow | null {
    return database.get<ProductVariantRow>('SELECT * FROM product_variants WHERE id = ?', [id]);
  },

  getBySku(sku: string): ProductVariantRow | null {
    return database.get<ProductVariantRow>(
      `SELECT * FROM product_variants WHERE sku = ? AND is_active = 1 ${HIDE_TEMPLATES_WITH_VARIANTS}`,
      [sku],
    );
  },

  getByBarcode(barcode: string): ProductVariantRow | null {
    // 1. Exact match (fastest — indexed). Template + variant share the
    //    same barcode in tạp hóa, so exclude templates so the cashier
    //    always lands on the sellable variant with the right stock.
    const exact = database.get<ProductVariantRow>(
      `SELECT * FROM product_variants WHERE barcode = ? AND is_active = 1 ${HIDE_TEMPLATES_WITH_VARIANTS}`,
      [barcode],
    );
    if (exact) return exact;

    // 2. Strip leading zeros — some scanners prepend padding
    const stripped = barcode.replace(/^0+/, '');
    if (stripped !== barcode && stripped.length >= 4) {
      const m = database.get<ProductVariantRow>(
        `SELECT * FROM product_variants WHERE barcode = ? AND is_active = 1 ${HIDE_TEMPLATES_WITH_VARIANTS}`,
        [stripped],
      );
      if (m) return m;
    }

    // 3. Substring match — scanned data contains the stored barcode verbatim
    const sub = database.get<ProductVariantRow>(
      `SELECT * FROM product_variants WHERE is_active = 1 AND barcode IS NOT NULL AND length(barcode) >= 4 AND INSTR(?, barcode) > 0 ${HIDE_TEMPLATES_WITH_VARIANTS}`,
      [barcode],
    );
    if (sub) return sub;

    // 4. Alphanumeric-only match — QR track data often rearranges special chars
    //    (e.g. stored "9A30110=211106000006" → alphanumeric "9A30110211106000006"
    //     scanned "0269A30110211106000006=..." → alphanumeric contains the same digits)
    const scanAlnum = barcode.replace(/[^A-Za-z0-9]/g, '');
    if (scanAlnum.length >= 8) {
      const allActive = database.all<ProductVariantRow>(
        `SELECT * FROM product_variants WHERE is_active = 1 AND barcode IS NOT NULL AND length(barcode) >= 4 ${HIDE_TEMPLATES_WITH_VARIANTS}`,
      );
      for (const row of allActive) {
        const rowAlnum = (row.barcode || '').replace(/[^A-Za-z0-9]/g, '');
        if (rowAlnum.length >= 4 && scanAlnum.includes(rowAlnum)) return row;
      }
    }

    // 5. Also try by SKU
    return database.get<ProductVariantRow>(
      `SELECT * FROM product_variants WHERE sku = ? AND is_active = 1 ${HIDE_TEMPLATES_WITH_VARIANTS}`,
      [barcode],
    );
  },

  // Code-only search: match the EAN barcode and the SKU but NOT the product
  // name. The retail till uses this so cashiers typing into the search bar
  // are scanning/keying a code, not browsing by name.
  searchByCode(query: string): ProductVariantRow[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const like = `%${trimmed}%`;
    return database.all<ProductVariantRow>(
      `SELECT * FROM product_variants WHERE is_active = 1 AND (barcode LIKE ? OR sku LIKE ?) ${HIDE_TEMPLATES_WITH_VARIANTS} ORDER BY name`,
      [like, like],
    );
  },

  search(query: string): ProductVariantRow[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // One full scan — sku/barcode/name filtering happens in JS on the same
    // dataset. The previous version ran two SELECT * queries per keystroke
    // (sku/barcode LIKE, then a full diacritics-aware scan) and then merged;
    // for a 5000-row catalog that was ~2× the work for no extra hits.
    const normalizedQuery = normalizeSearch(trimmed);
    const tokens = searchTokens(trimmed);
    const allActive = database.all<ProductVariantRow>(
      `SELECT * FROM product_variants WHERE is_active = 1 ${HIDE_TEMPLATES_WITH_VARIANTS} ORDER BY name`,
    );
    return allActive
      .map((product) => ({ product, score: scoreSearchMatch(product, trimmed, normalizedQuery, tokens) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.product.name || '').localeCompare(b.product.name || '');
      })
      .map((entry) => entry.product);
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
        `INSERT OR REPLACE INTO product_variants (id, template_id, name, sku, barcode, retail_price, category_id, image_url, in_stock, vat_rate, is_active, updated_at, available_qty, price_gross, price_net, vat_amount, is_on_sale, thumbnail_url, sale_unit, sell_by, name_translations, customer_display_enabled, customer_display_sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.template_id, p.name, p.sku, p.barcode, p.retail_price ?? 0, p.category_id, p.image_url, p.in_stock ?? 0, p.vat_rate ?? 23, p.is_active ?? 1, p.updated_at, p.available_qty ?? 0, p.price_gross ?? 0, p.price_net ?? 0, p.vat_amount ?? 0, p.is_on_sale ?? 0, p.thumbnail_url, p.sale_unit, p.sell_by ?? 'PIECE', p.name_translations ?? null, p.customer_display_enabled ?? 1, p.customer_display_sort_order ?? null],
      );
    }
  },

  getCategories(): CategoryRow[] {
    return database.all<CategoryRow>(
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

  decrementStock(variantId: string, quantity: number): void {
    database.run(
      'UPDATE product_variants SET in_stock = MAX(0, in_stock - ?), available_qty = MAX(0, available_qty - ?) WHERE id = ?',
      [quantity, quantity, variantId],
    );
  },

  incrementStock(variantId: string, quantity: number): void {
    database.run(
      'UPDATE product_variants SET in_stock = in_stock + ?, available_qty = available_qty + ? WHERE id = ?',
      [quantity, quantity, variantId],
    );
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
        'INSERT OR REPLACE INTO categories (id, name, icon, color, sort_order, updated_at, name_translations, customer_display_enabled, customer_display_section, customer_display_sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [c.id, c.name, c.icon, c.color, c.sort_order ?? 0, c.updated_at, c.name_translations ?? null, c.customer_display_enabled ?? 1, c.customer_display_section ?? null, c.customer_display_sort_order ?? null],
      );
    }
  },
};
