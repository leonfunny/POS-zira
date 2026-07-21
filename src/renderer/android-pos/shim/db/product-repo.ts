/**
 * Android catalog product repo — a port of the Windows product-repo query +
 * search logic, running over the local SQL.js mirror.
 *
 * Packet S5 of the Android parity port — see docs/android-pos/SHIM_CONTRACT_S1.md
 * §2.D. The methods below (getAll / getById / getByBarcode / search /
 * upsertProducts) are COPIED from src/main/database/repos/product-repo.ts, not
 * reimplemented: the SQL strings, the diacritics/case normalization, the fuzzy
 * token scoring, and the barcode fallback ladder are byte-for-byte the Windows
 * logic (PARITY_PORT_PLAN §2: "Where Windows is quirky, Android is identically
 * quirky"). Windows line ranges are cited at each method. The only seam that
 * changes is the DB handle: Windows imports the `database` singleton; this
 * module is a factory closing over an injected `AndroidDatabase` (db.ts) so it
 * stays testable and is not wired into the shim until S7.
 *
 * Single documented divergence from Windows search: the Android schema stores
 * only the `PosProduct` columns (S5 §2), which do not include `name_translations`.
 * Windows' `productSearchNames` (product-repo.ts:232-249) folds in translated
 * names; the ported version matches the canonical `name` only.
 */

import type { AndroidDatabase } from './db';

/**
 * A product row. Column set = exactly what `PosProduct` exposes (S1 §2.D) and
 * what the Android `product_variants` table stores (schema.ts). Mirrors
 * `ShimPosProduct` (transport.ts). Prices are integer grosze.
 */
export interface AndroidProductRow {
  id: string;
  template_id: string | null;
  name: string;
  sku: string | null;
  barcode: string | null;
  retail_price: number;
  category_id: string | null;
  image_url: string | null;
  in_stock: number;
  available_qty: number;
  vat_rate: number;
  is_active: number;
  is_on_sale: number;
  thumbnail_url: string | null;
  sale_unit: string | null;
  sell_by: string | null;
  /** 0 for services / non-inventory items (never decremented locally). */
  track_inventory?: number;
  updated_at: string | null;
}

// ── Search normalization + scoring — copied from product-repo.ts:5-134,232-316 ─

/** Strip diacritics/accents for search matching (bánh → banh, łódź → lodz). (product-repo.ts:6-15) */
function normalizeSearch(str: string): string {
  return str
    .replace(/[Đđ]/g, (ch) => (ch === 'Đ' ? 'D' : 'd'))
    .replace(/[Łł]/g, (ch) => (ch === 'Ł' ? 'L' : 'l'))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeLiteralSearch(str: string): string { // (product-repo.ts:17-23)
  return str
    .normalize('NFC')
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeCodeSearch(str: string): string { // (product-repo.ts:25-30)
  return String(str || '')
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function isCodeLikeSearch(query: string): boolean { // (product-repo.ts:32-34)
  return /\d|[-_./\\]/.test(query);
}

function searchTokens(query: string): string[] { // (product-repo.ts:36-38)
  return normalizeSearch(query).split(/[^a-z0-9]+/).filter(Boolean);
}

function editDistanceWithin(a: string, b: string, maxDistance: number): number { // (product-repo.ts:40-81)
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

function maxFuzzyDistance(token: string): number { // (product-repo.ts:83-86)
  if (token.length < 3 || /\d/.test(token)) return 0;
  return token.length >= 6 ? 2 : 1;
}

function fuzzyWordScore(word: string, token: string): number | null { // (product-repo.ts:88-96)
  const maxDistance = maxFuzzyDistance(token);
  if (maxDistance <= 0 || word.length < 2 || /\d/.test(word)) return null;

  const distance = editDistanceWithin(token, word, maxDistance);
  if (distance > maxDistance) return null;
  const lengthPenalty = Math.min(Math.abs(word.length - token.length) * 2, 8);
  return Math.max(24, 48 - distance * 10 - lengthPenalty);
}

function tokenPositionScore(text: string, token: string): { index: number; score: number } | null { // (product-repo.ts:98-122)
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  const exactIndex = words.findIndex((word) => word === token);
  if (exactIndex >= 0) return { index: exactIndex, score: 80 };

  const prefixIndex = words.findIndex((word) => word.startsWith(token));
  if (prefixIndex >= 0) return { index: prefixIndex, score: 55 };

  let fuzzyMatch: { index: number; score: number } | null = null;
  words.forEach((word, index) => {
    const score = fuzzyWordScore(word, token);
    if (score == null) return;
    if (!fuzzyMatch || score > fuzzyMatch!.score) {
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

function tokenMatchScore(text: string, tokens: string[]): number | null { // (product-repo.ts:124-134)
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

// DIVERGENCE from Windows (product-repo.ts:232-249): the Android schema has no
// name_translations column (S5 §2), so search matches the canonical name only.
function productSearchNames(product: AndroidProductRow): string[] {
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
  return names;
}

function literalNameMatchScore(name: string, literalQuery: string): number { // (product-repo.ts:251-259)
  if (!literalQuery) return 0;
  const literalName = normalizeLiteralSearch(name);
  if (literalName === literalQuery) return 8300;
  if (literalName.startsWith(literalQuery)) return 7900;
  const phraseIndex = literalName.indexOf(literalQuery);
  if (phraseIndex >= 0) return 7600 - Math.min(phraseIndex, 500);
  return 0;
}

function nameMatchScore(name: string, normalizedQuery: string, tokens: string[], literalQuery: string): number { // (product-repo.ts:261-274)
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

function codeMatchScore(codeFields: string[], codeQuery: string, highPriority: boolean): number { // (product-repo.ts:276-282)
  if (!codeQuery) return 0;
  if (codeFields.some((field) => field === codeQuery)) return highPriority ? 10000 : 6200;
  if (codeFields.some((field) => field.startsWith(codeQuery))) return highPriority ? 9200 : 5400;
  if (codeFields.some((field) => field.includes(codeQuery))) return highPriority ? 8600 : 5000;
  return 0;
}

function scoreSearchMatch(product: AndroidProductRow, query: string, normalizedQuery: string, tokens: string[]): number { // (product-repo.ts:284-316)
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

// Hide template rows that have variant children (product-repo.ts:206-212).
const HIDE_TEMPLATES_WITH_VARIANTS = `
  AND id NOT IN (
    SELECT DISTINCT template_id
    FROM product_variants
    WHERE template_id IS NOT NULL AND is_active = 1
  )
`;

export interface AndroidProductRepo {
  getAll(): AndroidProductRow[];
  getById(id: string): AndroidProductRow | null;
  getByBarcode(barcode: string): AndroidProductRow | null;
  getByCategory(categoryId: string): AndroidProductRow[];
  search(query: string): AndroidProductRow[];
  /** Bulk upsert for the catalog sync worker (S6). */
  upsertProducts(products: AndroidProductRow[]): void;
}

/**
 * Build a product repo bound to a DB handle. Methods are copied verbatim from
 * the Windows productRepo (src/main/database/repos/product-repo.ts); the cited
 * line ranges are the Windows source of truth.
 */
export function createProductRepo(db: AndroidDatabase): AndroidProductRepo {
  return {
    getAll(): AndroidProductRow[] { // (product-repo.ts:319-323)
      return db.all<AndroidProductRow>(
        `SELECT * FROM product_variants WHERE is_active = 1 ${HIDE_TEMPLATES_WITH_VARIANTS} ORDER BY name`,
      );
    },

    getById(id: string): AndroidProductRow | null { // (product-repo.ts:338-340)
      return db.get<AndroidProductRow>('SELECT * FROM product_variants WHERE id = ?', [id]);
    },

    getByCategory(categoryId: string): AndroidProductRow[] { // (product-repo.ts:331-334)
      // Salon service grid reader (SHIM_CONTRACT_SALON_E2 §2.A) — active rows in
      // one category, name-sorted, template-with-variant rows hidden (same guard
      // as getAll). The salon grid calls this dedicated reader; retail filtered
      // getAll in the renderer.
      const cat = categoryId == null ? '' : String(categoryId);
      if (!cat) return [];
      return db.all<AndroidProductRow>(
        `SELECT * FROM product_variants WHERE is_active = 1 AND category_id = ? ${HIDE_TEMPLATES_WITH_VARIANTS} ORDER BY name`,
        [cat],
      );
    },

    getByBarcode(barcode: string): AndroidProductRow | null { // (product-repo.ts:349-395)
      // 1. Exact match (indexed). Exclude templates so the cashier lands on the
      //    sellable variant with the right stock.
      const exact = db.get<AndroidProductRow>(
        `SELECT * FROM product_variants WHERE barcode = ? AND is_active = 1 ${HIDE_TEMPLATES_WITH_VARIANTS}`,
        [barcode],
      );
      if (exact) return exact;

      // 2. Strip leading zeros — some scanners prepend padding.
      const stripped = barcode.replace(/^0+/, '');
      if (stripped !== barcode && stripped.length >= 4) {
        const m = db.get<AndroidProductRow>(
          `SELECT * FROM product_variants WHERE barcode = ? AND is_active = 1 ${HIDE_TEMPLATES_WITH_VARIANTS}`,
          [stripped],
        );
        if (m) return m;
      }

      // 3. Substring match — scanned data contains the stored barcode verbatim.
      const sub = db.get<AndroidProductRow>(
        `SELECT * FROM product_variants WHERE is_active = 1 AND barcode IS NOT NULL AND length(barcode) >= 4 AND INSTR(?, barcode) > 0 ${HIDE_TEMPLATES_WITH_VARIANTS}`,
        [barcode],
      );
      if (sub) return sub;

      // 4. Alphanumeric-only match — QR track data often rearranges special chars.
      const scanAlnum = barcode.replace(/[^A-Za-z0-9]/g, '');
      if (scanAlnum.length >= 8) {
        const allActive = db.all<AndroidProductRow>(
          `SELECT * FROM product_variants WHERE is_active = 1 AND barcode IS NOT NULL AND length(barcode) >= 4 ${HIDE_TEMPLATES_WITH_VARIANTS}`,
        );
        for (const row of allActive) {
          const rowAlnum = (row.barcode || '').replace(/[^A-Za-z0-9]/g, '');
          if (rowAlnum.length >= 4 && scanAlnum.includes(rowAlnum)) return row;
        }
      }

      // 5. Also try by SKU.
      return db.get<AndroidProductRow>(
        `SELECT * FROM product_variants WHERE sku = ? AND is_active = 1 ${HIDE_TEMPLATES_WITH_VARIANTS}`,
        [barcode],
      );
    },

    search(query: string): AndroidProductRow[] { // (product-repo.ts:410-432)
      const trimmed = query.trim();
      if (!trimmed || normalizeSearch(trimmed).length < 2) return [];

      // One full scan — sku/barcode/name filtering happens in JS on the same
      // dataset (the previous Windows version ran two SELECT * per keystroke).
      const normalizedQuery = normalizeSearch(trimmed);
      const tokens = searchTokens(trimmed);
      const allActive = db.all<AndroidProductRow>(
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

    upsertProducts(products: AndroidProductRow[]): void { // (product-repo.ts:434-475, column subset)
      if (products.length === 0) return;
      // NOTE: caller wraps in a transaction for atomicity (mirrors Windows
      // product-repo.ts:435-437). Not wrapped here to avoid nested transactions
      // when S6 also wraps the sync batch.
      for (const p of products) {
        if (!p.id || !p.name) {
          throw new Error(`Invalid product: missing id or name (id=${p.id})`);
        }
        // Column set = the PosProduct columns the Android schema stores. Windows
        // upsertMany writes ~28 columns (kiosk_*, item_type, …); those are not in
        // the Android schema (S5 §2) and are omitted here.
        db.run(
          `INSERT OR REPLACE INTO product_variants (
            id, template_id, name, sku, barcode, retail_price, category_id, image_url,
            in_stock, available_qty, vat_rate, is_active, is_on_sale, thumbnail_url,
            sale_unit, sell_by, track_inventory, updated_at
          )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            p.id, p.template_id, p.name, p.sku, p.barcode, p.retail_price ?? 0,
            p.category_id, p.image_url, p.in_stock ?? 0, p.available_qty ?? 0,
            p.vat_rate ?? 23, p.is_active ?? 1, p.is_on_sale ?? 0, p.thumbnail_url,
            p.sale_unit, p.sell_by ?? 'PIECE', p.track_inventory ?? 1, p.updated_at,
          ],
        );
      }
    },
  };
}
