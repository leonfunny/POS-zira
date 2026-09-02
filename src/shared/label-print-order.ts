/**
 * A print order for the garment factory: one customer, one style, sizes across
 * the top, colours down the side, a quantity in every cell — the A4 sheet the
 * shop already works from, typed in.
 *
 * Deliberately independent of the product catalog. The factory prints for its
 * customers' styles; those codes (`SP006290`) belong to the customer's system,
 * carry no size, and must not become sellable products with stock and prices.
 */
import { CareSymbol, FABRIC_TAG_LIMITS } from './types';
import { encodeCode128 } from './code128';

/** Materials the shop uses, in the Polish spelling that goes on the tag. */
export const FABRIC_MATERIALS = [
  'BAWEŁNA',
  'POLIESTER',
  'WISKOZA',
  'AKRYL',
  'ELASTAN',
  'LEN',
  'WEŁNA',
  'POLIAMID',
  'LYCRA',
  'MODAL',
  'JEDWAB',
  'NYLON',
] as const;

export const LABEL_PRINT_ORDER_LIMITS = {
  /** Matches the fabric lane, which is the stricter of the two printers. */
  maxRunQuantity: 999,
  /**
   * Fabric tags only. The TSC has no cutter, so the strip is torn by hand
   * between bundles; the app pauses at every chunk boundary to allow that.
   * Stickers are die-cut on a roll and run unattended, so they are not chunked.
   */
  chunkSize: 50,
  /** A whole-order ceiling; past this the sheet was almost certainly mistyped. */
  maxOrderQuantity: 20000,
  textChars: 40,
} as const;

export interface OrderMaterial {
  name: string;
  percent: number;
}

export interface OrderSize {
  id: string;
  label: string;
}

export interface OrderRow {
  id: string;
  colorName: string;
  /** The customer's packaging code. Blank means "no sticker for this colour". */
  code: string;
  quantities: Record<string, number>;
}

export interface LabelPrintOrder {
  customerName: string;
  styleName: string;
  styleCode: string;
  materials: OrderMaterial[];
  careSymbols: CareSymbol[];
  careText: string;
  sizes: OrderSize[];
  rows: OrderRow[];
  printFabricTags: boolean;
  printStickers: boolean;
  /** Adds "· M" to the sticker's colour line. */
  stickerIncludesSize: boolean;
}

export type OrderProblem =
  | 'EMPTY_ORDER'
  | 'NOTHING_SELECTED'
  | 'DUPLICATE_SIZE'
  | 'EMPTY_SIZE'
  | 'BAD_CODE'
  | 'ORDER_TOO_LARGE';

export interface PrintStepBase {
  /** Stable across rebuilds of the same order, so progress can be resumed. */
  id: string;
  rowId: string;
  quantity: number;
}

export interface StickerStep extends PrintStepBase {
  kind: 'sticker';
  colorName: string;
  code: string;
  sizeText?: string;
}

export interface FabricStep extends PrintStepBase {
  kind: 'fabric';
  sizeText: string;
  composition: string;
  careSymbols: CareSymbol[];
  careText: string;
}

export type PrintStep = StickerStep | FabricStep;

export function createEmptyOrder(): LabelPrintOrder {
  return {
    customerName: '',
    styleName: '',
    styleCode: '',
    materials: [],
    careSymbols: [],
    careText: '',
    sizes: [],
    rows: [],
    printFabricTags: true,
    printStickers: true,
    stickerIncludesSize: false,
  };
}

/** "70% POLIESTER 30% AKRYL" — the line printed on the care tag. */
export function compositionText(materials: OrderMaterial[]): string {
  return materials
    .filter((m) => m.name.trim() && Number.isFinite(m.percent) && m.percent > 0)
    .map((m) => `${m.percent}% ${m.name.trim()}`)
    .join(' ');
}

export interface OrderTotals {
  rowTotals: Record<string, number>;
  sizeTotals: Record<string, number>;
  grandTotal: number;
}

export function orderTotals(order: LabelPrintOrder): OrderTotals {
  const rowTotals: Record<string, number> = {};
  const sizeTotals: Record<string, number> = {};
  let grandTotal = 0;

  for (const row of order.rows) {
    let rowTotal = 0;
    for (const size of order.sizes) {
      const quantity = cellQuantity(row, size.id);
      rowTotal += quantity;
      sizeTotals[size.id] = (sizeTotals[size.id] ?? 0) + quantity;
    }
    rowTotals[row.id] = rowTotal;
    grandTotal += rowTotal;
  }

  return { rowTotals, sizeTotals, grandTotal };
}

function cellQuantity(row: OrderRow, sizeId: string): number {
  const raw = row.quantities?.[sizeId];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/**
 * Problems that must be fixed before printing.
 *
 * A missing sticker code is deliberately absent: that colour simply gets no
 * sticker, and its fabric tags still print. Blocking a 680-tag order because
 * one code has not arrived yet would be worse than printing what is known.
 */
export function validateOrder(order: LabelPrintOrder): OrderProblem[] {
  const problems = new Set<OrderProblem>();

  if (!order.printFabricTags && !order.printStickers) problems.add('NOTHING_SELECTED');

  const labels = order.sizes.map((size) => size.label.trim());
  if (labels.some((label) => !label)) problems.add('EMPTY_SIZE');
  const filled = labels.filter(Boolean);
  if (new Set(filled).size !== filled.length) problems.add('DUPLICATE_SIZE');

  for (const row of order.rows) {
    const code = row.code.trim();
    if (!code) continue;
    try {
      encodeCode128(code);
    } catch {
      problems.add('BAD_CODE');
    }
  }

  const totals = orderTotals(order);
  if (totals.grandTotal <= 0) problems.add('EMPTY_ORDER');
  if (totals.grandTotal >= LABEL_PRINT_ORDER_LIMITS.maxOrderQuantity) {
    problems.add('ORDER_TOO_LARGE');
  }

  return [...problems];
}

/**
 * Flatten an order into the runs to send, in print order.
 *
 * Stickers go first: they need no attention between runs, so the operator can
 * start them and turn to the fabric printer, which has no cutter and must be
 * torn by hand between bundles.
 *
 * One fabric run per (colour, size) cell rather than per size: the same size in
 * two colours prints an identical tag, but the bundles leave the table with
 * their garments, so they are kept apart on purpose.
 */
export function buildPrintPlan(order: LabelPrintOrder): PrintStep[] {
  const steps: PrintStep[] = [];
  const composition = compositionText(order.materials);

  if (order.printStickers) {
    for (const row of order.rows) {
      const code = row.code.trim();
      if (!code) continue; // No code yet: skip this colour, warn in the UI.

      if (order.stickerIncludesSize) {
        for (const size of order.sizes) {
          pushChunks(steps, cellQuantity(row, size.id), STICKER_CHUNK, (quantity, index) => ({
            kind: 'sticker',
            id: `sticker:${row.id}:${size.id}:${index}`,
            rowId: row.id,
            colorName: row.colorName.trim(),
            code,
            sizeText: size.label.trim(),
            quantity,
          }));
        }
      } else {
        const total = order.sizes.reduce((sum, size) => sum + cellQuantity(row, size.id), 0);
        pushChunks(steps, total, STICKER_CHUNK, (quantity, index) => ({
          kind: 'sticker',
          id: `sticker:${row.id}:${index}`,
          rowId: row.id,
          colorName: row.colorName.trim(),
          code,
          quantity,
        }));
      }
    }
  }

  if (order.printFabricTags) {
    for (const row of order.rows) {
      for (const size of order.sizes) {
        pushChunks(steps, cellQuantity(row, size.id), FABRIC_CHUNK, (quantity, index) => ({
          kind: 'fabric',
          id: `fabric:${row.id}:${size.id}:${index}`,
          rowId: row.id,
          sizeText: size.label.trim(),
          composition,
          careSymbols: order.careSymbols,
          careText: order.careText.trim(),
          quantity,
        }));
      }
    }
  }

  return steps;
}

/** Stickers are only split to stay inside the driver's copy count. */
const STICKER_CHUNK = LABEL_PRINT_ORDER_LIMITS.maxRunQuantity;
const FABRIC_CHUNK = LABEL_PRINT_ORDER_LIMITS.chunkSize;

function pushChunks(
  steps: PrintStep[],
  total: number,
  chunkSize: number,
  make: (quantity: number, index: number) => PrintStep,
): void {
  let remaining = Math.min(total, LABEL_PRINT_ORDER_LIMITS.maxOrderQuantity);
  let index = 0;
  while (remaining > 0) {
    const quantity = Math.min(remaining, chunkSize);
    steps.push(make(quantity, index));
    remaining -= quantity;
    index += 1;
  }
}

/** The fabric renderer caps the size text; keep the grid inside it. */
export const MAX_SIZE_LABEL_CHARS = FABRIC_TAG_LIMITS.size;
