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
