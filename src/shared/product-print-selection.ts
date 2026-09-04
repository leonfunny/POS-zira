/**
 * Reprinting labels for a style that is already in the catalogue.
 *
 * The print order sheet is where a style is born; this is where it is printed
 * again — one bag label gone missing, a bundle re-tagged, ten more of a size
 * that sold out. Rather than a second print path, the selection is turned back
 * into the same order shape the sheet produces, so `buildPrintPlan` and
 * `runPrintPlan` do the work: identical chunking, identical Stop, identical
 * tags. Two lanes that print "the same" label but not from the same code drift
 * apart, and the drift shows up on a customer's garment.
 *
 * Nothing here talks to the database or the printer: it maps a selection onto
 * an order so the mapping can be read and tested on its own.
 */
import { CareSymbol, FabricTagTemplate } from './types';
import {
  LABEL_PRINT_ORDER_LIMITS,
  LabelPrintOrder,
  OrderRow,
  OrderSize,
  compositionText,
  createEmptyOrder,
  foldGridIntoSizes,
} from './label-print-order';

/** One physical catalogue row: a colour, a size, and the codes on it. */
export interface SelectionVariant {
  id: string;
  colorName?: string | null;
  sizeName?: string | null;
}

export interface SelectionInput {
  /** The style's own name, from the template row. */
  styleName: string;
  /** The lot code printed under the style name; the template's SKU. */
  styleCode: string;
  /** Who the style is sewn for. Saved with the care content, not on the product. */
  customerName: string;
  careSymbols: readonly CareSymbol[];
  careText: string;
  /** The finished composition line, exactly as it was saved. */
  composition: string;
  variants: readonly SelectionVariant[];
  /** How many to print, per variant id. Missing or 0 means "not this one". */
  quantities: Readonly<Record<string, number>>;
  /**
   * Bag stickers per colour, keyed by the colour as `selectionColours` spells
   * it. Typed by the packer: one per bag, not one per garment.
   */
  stickerQuantities?: Readonly<Record<string, number>>;
  printStickers: boolean;
  printFabricTags: boolean;
}

export type SelectionProblem = 'NOTHING_SELECTED' | 'NO_LANE' | 'TOO_MANY' | 'NO_STICKER_QTY';

function cleanText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Whole labels only, and never more than one run's worth from one press.
 *
 * The box is typed by hand next to a printer that will obey it, so a stray
 * keystroke is capped here rather than at the driver.
 */
export function selectionQuantity(value: unknown): number {
  const amount = Math.floor(Number(value));
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.min(amount, LABEL_PRINT_ORDER_LIMITS.maxRunQuantity);
}

/** Total labels the selection would produce, per lane and together. */
export function selectionTotals(input: SelectionInput): {
  stickers: number;
  fabricTags: number;
  total: number;
} {
  let cells = 0;
  for (const variant of input.variants) {
    cells += selectionQuantity(input.quantities[variant.id]);
  }
  // One tag per garment; stickers as many as the packer typed per colour.
  const bags = selectionColours(input).reduce(
    (sum, colour) => sum + selectionQuantity(input.stickerQuantities?.[colour]),
    0,
  );
  const stickers = input.printStickers ? bags : 0;
  const fabricTags = input.printFabricTags ? cells : 0;
  return { stickers, fabricTags, total: stickers + fabricTags };
}

/** The colours with at least one garment asked for, in the order the rows list them. */
export function selectionColours(input: SelectionInput): string[] {
  const colours: string[] = [];
  for (const variant of input.variants) {
    if (selectionQuantity(input.quantities[variant.id]) <= 0) continue;
    const colour = cleanText(variant.colorName);
    if (!colours.includes(colour)) colours.push(colour);
  }
  return colours;
}

/** What stops this selection from printing. Empty means the button is live. */
export function selectionProblems(input: SelectionInput): SelectionProblem[] {
  const problems: SelectionProblem[] = [];
  const { total } = selectionTotals(input);
  if (!input.printStickers && !input.printFabricTags) problems.push('NO_LANE');
  if (
    input.printStickers
    && selectionColours(input).some((colour) => selectionQuantity(input.stickerQuantities?.[colour]) <= 0)
  ) {
    problems.push('NO_STICKER_QTY');
  }
  if (total === 0 && problems.length === 0) problems.push('NOTHING_SELECTED');
  if (total > LABEL_PRINT_ORDER_LIMITS.maxOrderQuantity) problems.push('TOO_MANY');
  return problems;
}

/**
 * The selection as an order sheet.
 *
 * Colours become rows and sizes become columns, the way they were typed the
 * first time. Only the cells with a quantity are carried over: a style with six
 * colours reprinted in one is one row, so the plan holds one run and the
 * progress counter says 1 of 1 rather than 1 of 18.
 *
 * A variant with no size of its own (a one-size style) still gets a column, an
 * unnamed one, so its tag prints without a size line instead of not printing.
 */
export function buildSelectionOrder(input: SelectionInput): LabelPrintOrder {
  const rows: OrderRow[] = [];
  const sizes: OrderSize[] = [];
  const rowByColor = new Map<string, OrderRow>();
  const sizeByLabel = new Map<string, OrderSize>();

  for (const variant of input.variants) {
    const quantity = selectionQuantity(input.quantities[variant.id]);
    if (quantity <= 0) continue;

    const colorName = cleanText(variant.colorName);
    let row = rowByColor.get(colorName);
    if (!row) {
      row = {
        id: `sel-color-${rowByColor.size}`,
        colorName,
        // A reprint has no sheet to take a bag code from; the print plan fills
        // a blank one from the style code and colour, the same way every time.
        code: '',
        quantities: {},
        stickerQuantity: selectionQuantity(input.stickerQuantities?.[colorName]),
      };
      rowByColor.set(colorName, row);
      rows.push(row);
    }

    const sizeLabel = cleanText(variant.sizeName);
    let size = sizeByLabel.get(sizeLabel);
    if (!size) {
      size = { id: `sel-size-${sizeByLabel.size}`, label: sizeLabel };
      sizeByLabel.set(sizeLabel, size);
      sizes.push(size);
    }

    // Two catalogue rows can carry the same colour and size — a duplicate from
    // an import, or a style filed twice. Adding rather than overwriting prints
    // what was asked for on both.
    row.quantities[size.id] = (row.quantities[size.id] ?? 0) + quantity;
  }

  // The sheet prints fabric tags per size across colours; the cells typed
  // per variant are folded the same way a pasted grid is.
  const folded = foldGridIntoSizes(sizes, rows);

  return {
    ...createEmptyOrder(),
    customerName: cleanText(input.customerName),
    styleName: cleanText(input.styleName),
    styleCode: cleanText(input.styleCode),
    careSymbols: [...input.careSymbols],
    careText: cleanText(input.careText),
    // Materials stay empty on purpose: the saved composition is already a
    // finished line and is handed to the plan builder as one.
    materials: [],
    sizes: folded.sizes,
    rows: folded.rows,
    printStickers: input.printStickers,
    printFabricTags: input.printFabricTags,
  };
}

/**
 * The care content of a sheet, in the shape the machine stores per style.
 *
 * Written when the sheet becomes a product, because the catalogue has nowhere
 * to keep a washing symbol: a product carries a name, a colour and a size, and
 * the rest of what goes on a fabric tag exists only on the sheet that was
 * typed. The customer rides along as the brand line, which is what the bag
 * label prints at the top.
 */
export function orderToFabricTagTemplate(
  templateId: string,
  order: LabelPrintOrder,
): FabricTagTemplate {
  return {
    templateId,
    brandName: cleanText(order.customerName) || null,
    logoDataUrl: null,
    composition: compositionText(order.materials) || null,
    careSymbols: [...order.careSymbols],
    careText: cleanText(order.careText) || null,
    // The finished line still prints; the parts ride along so the style's own
    // panel can reopen the composition instead of parsing it back apart.
    materials: order.materials.map((material) => ({
      name: material.name,
      percent: Math.max(0, Math.min(100, Math.floor(Number(material.percent) || 0))),
    })),
    fabric: null,
    layout: 'default',
  };
}
