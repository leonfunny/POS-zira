/**
 * Turns a print order into a catalogue product.
 *
 * The sheet is already a colour x size grid — rows are colours, columns are
 * sizes, cells are quantities — so the fabric salon types it once and either
 * prints labels from it, files it as a product, or both. Nothing here talks to
 * the network: it maps one shape onto another so both the panel and the tests
 * can see exactly what would be sent.
 */
import { LabelPrintOrder } from './label-print-order';

export interface ProductDraftVariant {
  colorName: string | null;
  sizeName: string | null;
  sku: string | null;
  initialStockQty: number;
}

export interface ProductDraft {
  name: string;
  sku: string | null;
  priceGrossGrosze: number;
  variants: ProductDraftVariant[];
}

export type ProductDraftProblem =
  | 'NO_NAME'
  | 'NO_CELLS'
  | 'ALREADY_FILED'
  | 'TOO_MANY_VARIANTS';

/**
 * The styles this workshop makes map one-to-one onto the categories its label
 * tab is configured to show. Without a category the filed product is invisible
 * there — `LabelModule` lists a product only when its category is configured or
 * the product is pinned — so the style the operator already picked is what
 * chooses the category, rather than asking them the same thing twice.
 *
 * Written as names, not ids: ids differ per salon, names are what the operator
 * sees. A category renamed in the dashboard stops matching, which is why the
 * panel shows the resolved category instead of filing silently without one.
 */
const STYLE_CATEGORY_NAMES: Record<string, string> = {
  KURTKA: 'Kurtki',
  BAWEŁNIANE: 'Bawełniane',
  'KOMPLET DRESOWY': 'Komplety dresowe',
};

/**
 * Compares category names the way a person would: case, spacing and Polish
 * diacritics are noise here, so `Komplety dresowe` and `KOMPLETY DRESOWE` are
 * the same category. `skuToken` already folds exactly that, with a length big
 * enough that no real category name is cut short.
 */
function foldName(value: string): string {
  return skuToken(value, 200);
}

export interface CategoryChoice {
  id: string;
  name: string;
}

/**
 * The category a sheet's style belongs to, or null when the style is one of the
 * free-text ones the shop invents and no category carries that name.
 */
export function resolveCategoryForStyle(
  styleName: string,
  categories: readonly CategoryChoice[],
): CategoryChoice | null {
  const wanted = STYLE_CATEGORY_NAMES[cleanText(styleName).toUpperCase()];
  if (!wanted) return null;
  const folded = foldName(wanted);
  return categories.find((category) => foldName(category.name) === folded) ?? null;
}

/** Matches the server's own ceiling for one create. */
export const MAX_PRODUCT_VARIANTS = 100;

/**
 * Polish letters that Unicode decomposition does not split. `ż` becomes `z`
 * through NFD; `ł` has no combining form and would otherwise be dropped, giving
 * "BIAY" for "Biały".
 */
const LETTER_FOLDS: Record<string, string> = {
  ł: 'l',
  Ł: 'L',
  đ: 'd',
  Đ: 'D',
  ß: 'ss',
};

/** "Beżowy" → "BEZOWY", "S/M" → "SM". Empty when nothing usable is left. */
export function skuToken(value: string, maxChars = 12): string {
  const folded = value
    .replace(/[łŁđĐß]/g, (ch) => LETTER_FOLDS[ch] ?? ch)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return folded
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, maxChars);
}

function cleanText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * "129,00" -> 12900. The shop types Polish money, so the comma is the decimal
 * separator and spaces group the thousands; a typed dot is accepted too because
 * a numeric keypad produces one. Anything unreadable is 0 rather than NaN — the
 * field is a price, and a price the panel cannot read is not a price.
 */
export function textToGrosze(value: string): number {
  // The comma becomes the decimal point first; the sweep afterwards removes
  // spacing, currency marks and anything else typed by accident.
  const cleaned = value.replace(',', '.').replace(/[^0-9.]/g, '');
  const amount = Number.parseFloat(cleaned);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount * 100);
}

/** 12900 -> "129,00". Empty for 0, so the field shows a placeholder. */
export function groszeToText(grosze: number | undefined | null): string {
  const amount = Number(grosze) || 0;
  if (amount <= 0) return '';
  return (amount / 100).toFixed(2).replace('.', ',');
}

/**
 * Build the SKU for one cell, then make it unique within this grid.
 *
 * Truncated colour names collide ("Czarny" and "Czarnyfioletowy" both start the
 * same), and the server rejects a grid holding one SKU twice — so a collision
 * is resolved here, where the operator can still see and edit the result.
 */
function buildSku(
  base: string,
  colorName: string | null,
  sizeName: string | null,
  taken: Set<string>,
): string | null {
  if (!base) return null;
  const parts = [base, colorName, sizeName]
    .map((part) => (part ? skuToken(part) : ''))
    .filter(Boolean);
  const candidate = parts.join('-');
  if (!candidate) return null;
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  for (let suffix = 2; ; suffix += 1) {
    const next = `${candidate}-${suffix}`;
    if (!taken.has(next)) {
      taken.add(next);
      return next;
    }
  }
}

/**
 * One variant per filled cell.
 *
 * A blank cell is not a variant: a 6x3 sheet with 11 numbers typed in is 11
 * physical rows, not 18 — the shop does not make the sizes it did not order.
 * A sheet with no size columns at all still yields one variant per colour.
 */
export function buildProductDraft(order: LabelPrintOrder): ProductDraft {
  const base = skuToken(cleanText(order.styleCode), 16);
  const taken = new Set<string>();
  const sizes = order.sizes.filter((size) => cleanText(size.label));
  const variants: ProductDraftVariant[] = [];

  for (const row of order.rows) {
    const colorName = cleanText(row.colorName) || null;
    if (sizes.length === 0) {
      if (!colorName) continue;
      variants.push({
        colorName,
        sizeName: null,
        sku: buildSku(base, colorName, null, taken),
        initialStockQty: 0,
      });
      continue;
    }
    for (const size of sizes) {
      const quantity = Number(row.quantities[size.id]) || 0;
      if (quantity <= 0) continue;
      const sizeName = cleanText(size.label);
      variants.push({
        colorName,
        sizeName,
        sku: buildSku(base, colorName, sizeName, taken),
        initialStockQty: quantity,
      });
    }
  }

  return {
    name: cleanText(order.styleName),
    sku: base || null,
    priceGrossGrosze: Number(order.priceGrossGrosze) || 0,
    variants,
  };
}

/** A colour and size the shop wants to add to a style that already exists. */
export interface AddedCell {
  colorName: string;
  sizeName: string;
}

export type AddedCellProblem =
  | 'NO_COLOR_OR_SIZE'
  | 'ALREADY_EXISTS';

/**
 * One new row under an existing style.
 *
 * The SKU is built the way the print order sheet builds one, from the style's
 * own code plus the colour and size, and is checked against the SKUs the style
 * already carries rather than only against the rows in this request — the
 * server refuses a collision, and finding that out after the operator has typed
 * is worse than not offering the number in the first place.
 */
export function buildAddedVariant(
  styleCode: string,
  cell: AddedCell,
  existingSkus: readonly (string | null | undefined)[],
): ProductDraftVariant {
  const colorName = cleanText(cell.colorName) || null;
  const sizeName = cleanText(cell.sizeName) || null;
  const taken = new Set(
    existingSkus
      .map((sku) => cleanText(String(sku ?? '')))
      .filter(Boolean),
  );
  return {
    colorName,
    sizeName,
    sku: buildSku(skuToken(cleanText(styleCode), 16), colorName, sizeName, taken),
    // Stock for a new colour arrives through the warehouse screens; a row
    // created here is a label to print, not a bundle that exists yet.
    initialStockQty: 0,
  };
}

/** What stops a cell from being added. Empty means the button is live. */
export function validateAddedCell(
  cell: AddedCell,
  existing: readonly { colorName?: string | null; sizeName?: string | null }[],
): AddedCellProblem[] {
  const colorName = cleanText(cell.colorName);
  const sizeName = cleanText(cell.sizeName);
  if (!colorName && !sizeName) return ['NO_COLOR_OR_SIZE'];
  // Compared without case, which is stricter than the server: it would accept
  // "czarny" beside "CZARNY", and a till showing both cannot tell them apart.
  const fold = (value: string) => value.toLocaleUpperCase('pl');
  const clash = existing.some(
    (row) =>
      fold(cleanText(String(row.colorName ?? ''))) === fold(colorName)
      && fold(cleanText(String(row.sizeName ?? ''))) === fold(sizeName),
  );
  // Refused here as well as by the server: the operator finds out before the
  // request, and two rows for one cell would leave the till unable to say
  // which one it just sold.
  return clash ? ['ALREADY_EXISTS'] : [];
}

/** What stops this sheet from being filed. Empty means the button is live. */
export function validateProductDraft(
  order: LabelPrintOrder,
  draft: ProductDraft,
): ProductDraftProblem[] {
  const problems: ProductDraftProblem[] = [];
  if (order.productId) problems.push('ALREADY_FILED');
  if (!draft.name) problems.push('NO_NAME');
  if (draft.variants.length === 0) problems.push('NO_CELLS');
  if (draft.variants.length > MAX_PRODUCT_VARIANTS) {
    problems.push('TOO_MANY_VARIANTS');
  }
  return problems;
}
