import { database } from '../database';
import logger from '../../logger';
import { parseTranslations } from '../../../shared/catalog-names';

/** Strip diacritics/accents for search matching (bánh → banh, łódź → lodz) */
function normalizeSearch(str: string): string {
  return str
    .replace(/[\u0110\u0111]/g, (ch) => (ch === '\u0110' ? 'D' : 'd'))
    .replace(/[\u0141\u0142]/g, (ch) => (ch === '\u0141' ? 'L' : 'l'))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeLiteralSearch(str: string): string {
  return str
    .normalize('NFC')
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeCodeSearch(str: string): string {
  return String(str || '')
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function isCodeLikeSearch(query: string): boolean {
  return /\d|[-_./\\]/.test(query);
}

function searchTokens(query: string): string[] {
  return normalizeSearch(query).split(/[^a-z0-9]+/).filter(Boolean);
}

function editDistanceWithin(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  if (a.length === 0) return b.length <= maxDistance ? b.length : maxDistance + 1;
  if (b.length === 0) return a.length <= maxDistance ? a.length : maxDistance + 1;

  const previousPrevious = new Array<number>(b.length + 1).fill(0);
  let previous = new Array<number>(b.length + 1).fill(0).map((_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );

      if (
        i > 1
        && j > 1
        && a[i - 1] === b[j - 2]
        && a[i - 2] === b[j - 1]
      ) {
        best = Math.min(best, previousPrevious[j - 2] + 1);
      }

      current[j] = best;
      if (best < rowMin) rowMin = best;
    }

    if (rowMin > maxDistance) return maxDistance + 1;
    previousPrevious.splice(0, previousPrevious.length, ...previous);
    previous = current;
  }

  return previous[b.length];
}

function maxFuzzyDistance(token: string): number {
  if (token.length < 3 || /\d/.test(token)) return 0;
  return token.length >= 6 ? 2 : 1;
}

function fuzzyWordScore(word: string, token: string): number | null {
  const maxDistance = maxFuzzyDistance(token);
  if (maxDistance <= 0 || word.length < 2 || /\d/.test(word)) return null;

  const distance = editDistanceWithin(token, word, maxDistance);
  if (distance > maxDistance) return null;
  const lengthPenalty = Math.min(Math.abs(word.length - token.length) * 2, 8);
  return Math.max(24, 48 - distance * 10 - lengthPenalty);
}

function tokenPositionScore(text: string, token: string): { index: number; score: number } | null {
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  const exactIndex = words.findIndex((word) => word === token);
  if (exactIndex >= 0) return { index: exactIndex, score: 80 };

  const prefixIndex = words.findIndex((word) => word.startsWith(token));
  if (prefixIndex >= 0) return { index: prefixIndex, score: 55 };

  let fuzzyMatch: { index: number; score: number } | null = null;
  words.forEach((word, index) => {
    const score = fuzzyWordScore(word, token);
    if (score == null) return;
    if (!fuzzyMatch || score > fuzzyMatch.score) {
      fuzzyMatch = { index, score };
    }
  });
  if (fuzzyMatch) return fuzzyMatch;

  if (token.length >= 3) {
    const substringIndex = text.indexOf(token);
    if (substringIndex >= 0) return { index: words.length + substringIndex, score: 20 };
  }

  return null;
}

function tokenMatchScore(text: string, tokens: string[]): number | null {
  if (tokens.length === 0) return null;
  const matches = tokens.map((token) => tokenPositionScore(text, token));
  if (matches.some((match) => !match)) return null;
  const indexes = matches.map((match) => match!.index);
  const spread = Math.max(...indexes) - Math.min(...indexes);
  const duplicateWordPenalty = (tokens.length - new Set(indexes).size) * 35;
  return matches.reduce((sum, match) => sum + match!.score, 0)
    - Math.min(spread, 50)
    - duplicateWordPenalty;
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
  /** Server-owned customer kiosk media presentation metadata. */
  kiosk_media_json?: string | null;
  /** Server-owned modifier groups attached directly to this product. */
  kiosk_modifier_groups_json?: string | null;
  kiosk_note_enabled?: number | null;
  // Item kind + tracking (migration v53). NULL item_type = stockable (old rows).
  item_type?: string | null;
  track_inventory?: number | null;
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
  /** 1 = items in this category print a kitchen ticket on sale (migration v39). */
  kitchen_print?: number | null;
  /** Server-owned modifier groups inherited by products in this category. */
  kiosk_modifier_groups_json?: string | null;
}

export interface CategoryPruneResult {
  removed: number;
  categories: Array<Pick<CategoryRow, 'id' | 'name'>>;
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

const CATEGORY_PRUNE_BELT_CHECK_TABLES = [
  'services',
  'kitchen_self_order_category_prefs',
  'forecast_recommendations',
] as const;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function productSearchNames(product: ProductVariantRow): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return;
    const key = normalizeLiteralSearch(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    names.push(trimmed);
  };

  add(product.name);
  for (const translated of Object.values(parseTranslations(product.name_translations))) {
    add(translated);
  }
  return names;
}

function literalNameMatchScore(name: string, literalQuery: string): number {
  if (!literalQuery) return 0;
  const literalName = normalizeLiteralSearch(name);
  if (literalName === literalQuery) return 8300;
  if (literalName.startsWith(literalQuery)) return 7900;
  const phraseIndex = literalName.indexOf(literalQuery);
  if (phraseIndex >= 0) return 7600 - Math.min(phraseIndex, 500);
  return 0;
}

function nameMatchScore(name: string, normalizedQuery: string, tokens: string[], literalQuery: string): number {
  const literalScore = literalNameMatchScore(name, literalQuery);
  const normalizedName = normalizeSearch(name);

  if (normalizedName === normalizedQuery) return Math.max(literalScore, 8000);
  if (normalizedName.startsWith(normalizedQuery)) return Math.max(literalScore, 7400);
  const phraseIndex = normalizedName.indexOf(normalizedQuery);
  if (phraseIndex >= 0) return Math.max(literalScore, 6800 - Math.min(phraseIndex, 500));

  const tokenScore = tokenMatchScore(normalizedName, tokens);
  if (tokenScore != null) return Math.max(literalScore, 5600 + tokenScore);

  return literalScore;
}

function codeMatchScore(codeFields: string[], codeQuery: string, highPriority: boolean): number {
  if (!codeQuery) return 0;
  if (codeFields.some((field) => field === codeQuery)) return highPriority ? 10000 : 6200;
  if (codeFields.some((field) => field.startsWith(codeQuery))) return highPriority ? 9200 : 5400;
  if (codeFields.some((field) => field.includes(codeQuery))) return highPriority ? 8600 : 5000;
  return 0;
}

function scoreSearchMatch(product: ProductVariantRow, query: string, normalizedQuery: string, tokens: string[]): number {
  const names = productSearchNames(product);
  const sku = normalizeCodeSearch(product.sku || '');
  const barcode = normalizeCodeSearch(product.barcode || '');
  const codeFields = [barcode, sku].filter(Boolean);
  const literalQuery = normalizeLiteralSearch(query);
  const codeQuery = normalizeCodeSearch(query);
  const codeLike = isCodeLikeSearch(codeQuery);

  const highPriorityCodeScore = codeMatchScore(codeFields, codeQuery, true);
  if (codeLike && highPriorityCodeScore > 0) return highPriorityCodeScore;

  const bestNameScore = names.reduce(
    (best, name) => Math.max(best, nameMatchScore(name, normalizedQuery, tokens, literalQuery)),
    0,
  );
  if (bestNameScore > 0) return bestNameScore;

  if (!codeLike) {
    const fallbackCodeScore = codeMatchScore(codeFields, codeQuery, false);
    if (fallbackCodeScore > 0) return fallbackCodeScore;
  }

  const haystack = normalizeSearch([...names, product.sku, product.barcode].filter(Boolean).join(' '));
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

  getAllIncludingInactive(): ProductVariantRow[] {
    return database.all<ProductVariantRow>(
      `SELECT * FROM product_variants WHERE 1 = 1 ${HIDE_TEMPLATES_WITH_VARIANTS} ORDER BY name`,
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
    if (!trimmed || normalizeSearch(trimmed).length < 2) return [];

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
      .slice(0, 30)
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
        `INSERT OR REPLACE INTO product_variants (
          id, template_id, name, sku, barcode, retail_price, category_id, image_url,
          in_stock, vat_rate, is_active, updated_at, available_qty, price_gross,
          price_net, vat_amount, is_on_sale, thumbnail_url, sale_unit, sell_by,
          name_translations, customer_display_enabled, customer_display_sort_order,
          kiosk_media_json, kiosk_modifier_groups_json, kiosk_note_enabled,
          item_type, track_inventory
        )
         VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          COALESCE(?, (SELECT kiosk_media_json FROM product_variants WHERE id = ?)),
          COALESCE(?, (SELECT kiosk_modifier_groups_json FROM product_variants WHERE id = ?)),
          COALESCE(?, (SELECT kiosk_note_enabled FROM product_variants WHERE id = ?), 0),
          COALESCE(?, (SELECT item_type FROM product_variants WHERE id = ?)),
          COALESCE(?, (SELECT track_inventory FROM product_variants WHERE id = ?), 1)
        )`,
        [
          p.id, p.template_id, p.name, p.sku, p.barcode, p.retail_price ?? 0,
          p.category_id, p.image_url, p.in_stock ?? 0, p.vat_rate ?? 23,
          p.is_active ?? 1, p.updated_at, p.available_qty ?? 0,
          p.price_gross ?? 0, p.price_net ?? 0, p.vat_amount ?? 0,
          p.is_on_sale ?? 0, p.thumbnail_url, p.sale_unit, p.sell_by ?? 'PIECE',
          p.name_translations ?? null, p.customer_display_enabled ?? 1,
          p.customer_display_sort_order ?? null,
          p.kiosk_media_json ?? null, p.id,
          p.kiosk_modifier_groups_json ?? null, p.id,
          p.kiosk_note_enabled ?? null, p.id,
          p.item_type ?? null, p.id,
          p.track_inventory ?? null, p.id,
        ],
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

  getAllCategories(): CategoryRow[] {
    return database.all<CategoryRow>(
      `SELECT *
       FROM categories
       ORDER BY sort_order, name`,
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

  /** True when items of this category must print a kitchen ticket on sale. */
  isKitchenPrintCategory(categoryId: string): boolean {
    const row = database.get<{ kitchen_print: number }>(
      'SELECT kitchen_print FROM categories WHERE id = ?',
      [categoryId],
    );
    return (row?.kitchen_print ?? 0) === 1;
  },

  /** Local-only kitchen menu visibility flag until backend owns this field. */
  setCategoryKitchenPrint(categoryId: string, enabled: boolean): void {
    database.run(
      'UPDATE categories SET kitchen_print = ? WHERE id = ?',
      [enabled ? 1 : 0, categoryId],
    );
  },

  /** Local mirror of the backend category display_order used by POS and KSO menus. */
  setCategorySortOrder(categoryId: string, sortOrder: number): void {
    database.run(
      'UPDATE categories SET sort_order = ? WHERE id = ?',
      [sortOrder, categoryId],
    );
  },

  /** Batch local mirror update for backend category display_order. */
  setCategorySortOrders(updates: Array<{ id: string; sortOrder: number }>): void {
    if (updates.length === 0) return;
    database.transaction(() => {
      for (const update of updates) {
        database.run(
          'UPDATE categories SET sort_order = ? WHERE id = ?',
          [update.sortOrder, update.id],
        );
      }
    });
  },

  decrementStock(variantId: string, quantity: number, options?: { allowNegative?: boolean }): void {
    database.run(
      options?.allowNegative
        ? 'UPDATE product_variants SET in_stock = in_stock - ?, available_qty = available_qty - ? WHERE id = ?'
        : 'UPDATE product_variants SET in_stock = MAX(0, in_stock - ?), available_qty = MAX(0, available_qty - ?) WHERE id = ?',
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

  updateLocalImportIdentity(
    variantId: string,
    input: { ean: string; previousEan?: string | null; categoryId?: string | null },
  ): void {
    const ean = String(input.ean ?? '').trim();
    if (!ean) return;

    const current = this.getById(variantId);
    if (!current) return;

    const previousEan = String(input.previousEan ?? '').trim();
    const previousEanSku = previousEan ? `EAN-${previousEan}` : null;
    const nextSku = !current.sku || current.sku === previousEanSku || current.sku === current.barcode
      ? `EAN-${ean}`
      : current.sku;
    const categoryId = String(input.categoryId ?? '').trim() || null;

    database.run(
      `UPDATE product_variants
       SET barcode = ?,
           sku = ?,
           category_id = ?,
           is_active = 1,
           updated_at = datetime('now')
       WHERE id = ?`,
      [ean, nextSku, categoryId, variantId],
    );
  },

  deleteCategoriesExcept(keepIds: Set<string>): CategoryPruneResult {
    const keep = [...keepIds].filter(Boolean);
    if (keep.length === 0) return { removed: 0, categories: [] };

    const categories = database.all<Pick<CategoryRow, 'id' | 'name'>>(
      `SELECT id, name
       FROM categories
       WHERE id NOT IN (${placeholders(keep.length)})
       ORDER BY name, id`,
      keep,
    );
    if (categories.length === 0) return { removed: 0, categories: [] };

    const ids = categories.map((category) => category.id);
    const idPlaceholders = placeholders(ids.length);

    database.run(
      `UPDATE product_variants
       SET category_id = NULL
       WHERE category_id IN (${idPlaceholders})`,
      ids,
    );

    for (const table of CATEGORY_PRUNE_BELT_CHECK_TABLES) {
      const row = database.get<{ count: number }>(
        `SELECT COUNT(*) as count
         FROM ${table}
         WHERE category_id IN (${idPlaceholders})`,
        ids,
      );
      const rows = row?.count ?? 0;
      if (rows > 0) {
        logger.warn(
          `[ProductRepo] ${table} has ${rows} row(s) referencing categories deleted on backend`,
          { rows, categories },
        );
      }
    }

    database.run(
      `DELETE FROM categories
       WHERE id IN (${idPlaceholders})`,
      ids,
    );

    return { removed: categories.length, categories };
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
        // kitchen_print: COALESCE keeps the locally-known flag when an older
        // backend payload omits it (NULL), instead of silently resetting it.
        `INSERT OR REPLACE INTO categories (
          id, name, icon, color, sort_order, updated_at, name_translations,
          customer_display_enabled, customer_display_section,
          customer_display_sort_order, kitchen_print, kiosk_modifier_groups_json
        )
         VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          COALESCE(?, (SELECT kitchen_print FROM categories WHERE id = ?), 0),
          COALESCE(?, (SELECT kiosk_modifier_groups_json FROM categories WHERE id = ?))
        )`,
        [
          c.id, c.name, c.icon, c.color, c.sort_order ?? 0, c.updated_at,
          c.name_translations ?? null, c.customer_display_enabled ?? 1,
          c.customer_display_section ?? null, c.customer_display_sort_order ?? null,
          c.kitchen_print ?? null, c.id,
          c.kiosk_modifier_groups_json ?? null, c.id,
        ],
      );
    }
  },
};
