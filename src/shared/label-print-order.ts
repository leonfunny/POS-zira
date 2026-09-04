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
import { PACKAGING_STICKER_BARCODE_ENABLED } from './packaging-sticker';

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

/**
 * Lines that keep turning up on the sheets this shop works from, offered as
 * one-tap chips so nobody types Polish diacritics into a field that ends up
 * burnt onto a garment. The field stays free text for anything else.
 */
export const CARE_TEXT_PRESETS = [
  'PRAĆ Z PODOBNYMI KOLORAMI',
  'PRAĆ NA LEWEJ STRONIE',
  'PRAĆ PRZED PIERWSZYM UŻYCIEM',
  'ZALECANY PŁYN DO PŁUKANIA DLA MIĘKKOŚCI',
  'NATURALNY LEN',
  'MADE IN POLAND',
] as const;

/**
 * Each chosen sentence gets its own printed row. It used to be one line joined
 * with " · ", which meant a note typed by hand ran on from the end of the last
 * preset and read as part of it.
 */
export const CARE_TEXT_SEPARATOR = '\n';

/** The fabric lane's own ceiling, counted across every line. */
export const CARE_TEXT_MAX_CHARS = FABRIC_TAG_LIMITS.careText;

/** And how many rows those characters may occupy. */
export const CARE_TEXT_MAX_LINES = FABRIC_TAG_LIMITS.careTextLines;

/** Orders saved before the split still hold one " · " line; read them as lines. */
const LEGACY_SEPARATOR = / · /;

export function careTextParts(current: string): string[] {
  return current
    .split(CARE_TEXT_SEPARATOR)
    .flatMap((line) => line.split(LEGACY_SEPARATOR))
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The lines as the tag will print them, normalised. */
export function careTextLines(current: string): string[] {
  return careTextParts(current);
}

export function joinCareTextLines(lines: string[]): string {
  return lines.map((line) => line.trim()).filter(Boolean).join(CARE_TEXT_SEPARATOR);
}

/** False when the wording would not fit — too many rows, or too long overall. */
export function careTextLinesFit(lines: string[]): boolean {
  const kept = lines.map((line) => line.trim()).filter(Boolean);
  return kept.length <= CARE_TEXT_MAX_LINES
    && kept.join(CARE_TEXT_SEPARATOR).length <= CARE_TEXT_MAX_CHARS;
}

/** Adds a hand-typed line; refuses one that would not fit, and duplicates. */
export function addCareTextLine(current: string, line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return current;
  const parts = careTextParts(current);
  if (parts.includes(trimmed)) return current;
  const next = [...parts, trimmed];
  return careTextLinesFit(next) ? joinCareTextLines(next) : current;
}

export function removeCareTextLine(current: string, index: number): string {
  return joinCareTextLines(careTextParts(current).filter((_, at) => at !== index));
}

/** True when `preset` is one of the lines currently in `careText`. */
export function careTextHasPreset(current: string, preset: string): boolean {
  return careTextParts(current).includes(preset);
}

/** False when adding `preset` would push the wording past what the tag accepts. */
export function careTextPresetFits(current: string, preset: string): boolean {
  if (careTextHasPreset(current, preset)) return true;
  // Measured directly, not by asking the toggle: the toggle refuses wording
  // that will not fit by returning the old value, which would always look like
  // it fitted and leave the chip enabled on a tag it cannot go on.
  return careTextLinesFit([...careTextParts(current), preset]);
}

/**
 * Adds the preset as its own line if it is absent, takes that line away if it
 * is already there — the same on/off a care-symbol button has, so one idea
 * covers both pickers. Anything typed by hand is left alone, and wording that
 * would overflow the tag is refused here as well as disabled in the picker, so
 * the two cannot disagree.
 */
export function toggleCareTextPreset(current: string, preset: string): string {
  const parts = careTextParts(current);
  const without = parts.filter((part) => part !== preset);
  if (without.length !== parts.length) return joinCareTextLines(without);
  const added = [...parts, preset];
  return careTextLinesFit(added) ? joinCareTextLines(added) : current;
}

/**
 * Everything on these tags is printed in capitals — customer, style, colour,
 * size, the extra wording — so the order holds capitals too. Done in one place
 * over the whole order rather than field by field, so a field added later
 * cannot quietly opt out, and so an order typed before this rule reads the same
 * as one typed after it. Polish diacritics survive: ć→Ć, ł→Ł, ę→Ę.
 */
export function upperCaseOrder(order: LabelPrintOrder): LabelPrintOrder {
  const up = (value: string) => value.toUpperCase();
  return {
    ...order,
    customerName: up(order.customerName),
    styleName: up(order.styleName),
    styleCode: up(order.styleCode),
    careText: up(order.careText),
    materials: order.materials.map((material) => ({ ...material, name: up(material.name) })),
    sizes: order.sizes.map((size) => ({ ...size, label: up(size.label) })),
    rows: order.rows.map((row) => ({
      ...row,
      colorName: up(row.colorName),
      code: up(row.code),
    })),
  };
}

export const LABEL_PRINT_ORDER_LIMITS = {
  /** Matches the fabric lane, which is the stricter of the two printers. */
  maxRunQuantity: 999,
  /**
   * Fabric tags only, and no longer a pause — the whole order runs straight
   * through. The batches are what makes Stop mean anything: a run is only
   * abandoned between batches, because each one is already at the printer by
   * the time the call returns. 50 tags is a few seconds of ribbon, which is how
   * long Stop takes to bite. Stickers are die-cut on a roll and are only split
   * to stay inside the driver's copy count.
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
  /** Retained customer packaging code; currently hidden on the printed sticker. */
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
  /**
   * The two fields below exist only to turn a sheet into a product; printing
   * ignores them. They are optional because orders saved before this feature
   * have no such keys, and those sheets must still open.
   *
   * There is deliberately no supplier: this workshop sews to order, so the
   * counterparty is `customerName` above and a second name would only ever
   * repeat it or contradict it.
   */
  /** Gross price per piece, in grosze. 0 means "not priced yet". */
  priceGrossGrosze?: number;
  /** `yyyy-mm-dd`, the day the order was taken. */
  orderDate?: string;
  /**
   * Set once the sheet has been turned into a product. Its presence is what
   * stops a second press from creating a duplicate catalogue entry.
   */
  productId?: string | null;
  /**
   * The category picked on the sheet, when the operator chose one by hand.
   * Absent, the panel falls back to what the machine learned for the style
   * name and then to the built-in guess — see `resolveOrderCategory`.
   */
  categoryId?: string | null;
}

export type OrderProblem =
  | 'EMPTY_ORDER'
  | 'NOTHING_SELECTED'
  | 'NO_CUSTOMER'
  | 'NO_STYLE_CODE'
  | 'DUPLICATE_SIZE'
  | 'EMPTY_SIZE'
  | 'BAD_CODE'
  | 'PERCENT_NOT_100'
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
}

export interface FabricStep extends PrintStepBase {
  kind: 'fabric';
  sizeText: string;
  composition: string;
  careSymbols: CareSymbol[];
  careText: string;
}

export type PrintStep = StickerStep | FabricStep;

/** Today, as the date input wants it: `yyyy-mm-dd` in local time. */
export function todayIsoDate(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * A code for a colour row nobody has to type. The bag sticker does not print
 * it today, so its only job is to stand in the slot the customer's own code
 * would fill — six digits behind the prefix the photographed sheets used, and
 * inside what Code 128 can carry should the barcode layout come back.
 */
export function randomStickerCode(random: () => number = Math.random): string {
  const digits = Math.floor(random() * 1_000_000);
  return `SP${String(digits).padStart(6, '0')}`;
}

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
    priceGrossGrosze: 0,
    // The day the order was taken is nearly always today; the sheet is typed
    // while the customer is still in the shop.
    orderDate: todayIsoDate(),
    productId: null,
    categoryId: null,
  };
}

/** "70% POLIESTER 30% AKRYL" — the line printed on the care tag. */
export function compositionText(materials: OrderMaterial[]): string {
  return materials
    .filter((m) => m.name.trim() && Number.isFinite(m.percent) && m.percent > 0)
    .map((m) => `${m.percent}% ${m.name.trim()}`)
    .join(' ');
}

/**
 * Read a composition line back into the parts that built it.
 *
 * Only for rows saved before the parts were stored beside the line. Every part
 * must name a fabric the picker offers and the whole line must rebuild to
 * itself; anything else returns nothing, because a line reading "70% BAWEŁNA +
 * dodatki" says more than a percentage list can hold and rewriting it would
 * drop the rest. The caller goes on showing the stored line in that case.
 */
export function parseCompositionText(line: string | null | undefined): OrderMaterial[] {
  const text = (line ?? '').trim();
  if (!text) return [];
  const known = new Set<string>(FABRIC_MATERIALS);
  const matches = [...text.matchAll(/(\d{1,3})%\s*([^\d%]+)/g)];
  if (matches.length === 0) return [];
  const materials: OrderMaterial[] = [];
  for (const match of matches) {
    const percent = Number(match[1]);
    const name = match[2].trim();
    if (!known.has(name) || !Number.isFinite(percent) || percent <= 0 || percent > 100) return [];
    materials.push({ name, percent });
  }
  // A line that does not rebuild to itself carries wording between the parts.
  return compositionText(materials) === text ? materials : [];
}

export function materialPercentSum(materials: OrderMaterial[]): number {
  return materials.reduce(
    (sum, m) => sum + (Number.isFinite(m.percent) ? Number(m.percent) : 0),
    0,
  );
}

/** What the one-press fix would do, or null when one press cannot reach 100. */
export interface PercentFix {
  name: string;
  percent: number;
  materials: OrderMaterial[];
}

/**
 * Put the missing percent somewhere sensible in one press.
 *
 * Short of 100 it goes to the last material still at 0 -- the one just tapped
 * and not yet typed -- and otherwise onto the last material. Over 100 it comes
 * off the last material that has anything to give. If one edit cannot land
 * exactly on 100 the panel offers nothing rather than guessing across several
 * materials: the operator is reading the customer's sheet and knows the split.
 */
export function percentFix(materials: OrderMaterial[]): PercentFix | null {
  const named = materials.filter((m) => m.name.trim());
  if (named.length === 0) return null;

  const gap = 100 - materialPercentSum(materials);
  if (gap === 0) return null;

  const zeros = named.filter((m) => !(Number(m.percent) > 0));
  const target =
    gap > 0
      ? zeros[zeros.length - 1] ?? named[named.length - 1]
      : [...named].reverse().find((m) => Number(m.percent) > 0);
  if (!target) return null;

  const percent = (Number(target.percent) || 0) + gap;
  if (percent < 0 || percent > 100) return null;

  return {
    name: target.name,
    percent,
    materials: materials.map((m) => (m === target ? { ...m, percent } : m)),
  };
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

export type OrderWarning = 'NO_COMPOSITION';

/**
 * Things worth a look before printing that do not stop the run. A fabric tag
 * with no composition is legal and customers do order it, so the sheet only
 * points it out — a run of two hundred blank tags is usually a forgotten
 * field, not a decision.
 */
export function orderWarnings(order: LabelPrintOrder): OrderWarning[] {
  const warnings: OrderWarning[] = [];
  if (order.printFabricTags && !order.materials.some((m) => m.name.trim())) {
    warnings.push('NO_COMPOSITION');
  }
  return warnings;
}

/**
 * Problems that must be fixed before printing.
 *
 * The dormant sticker code is deliberately ignored while its barcode is off.
 * If the old barcode layout returns, the same switch restores its validation.
 */
export function validateOrder(order: LabelPrintOrder): OrderProblem[] {
  const problems = new Set<OrderProblem>();

  if (!order.printFabricTags && !order.printStickers) problems.add('NOTHING_SELECTED');
  // The customer heads the bag sticker and is the brand line on the fabric
  // tag; a sheet without one prints labels nobody can tell apart. The style
  // code is on the bag sticker only, so a fabric-tag-only run may go without.
  if (!order.customerName.trim()) problems.add('NO_CUSTOMER');
  if (order.printStickers && !order.styleCode.trim()) problems.add('NO_STYLE_CODE');

  const labels = order.sizes.map((size) => size.label.trim());
  if (labels.some((label) => !label)) problems.add('EMPTY_SIZE');
  const filled = labels.filter(Boolean);
  if (new Set(filled).size !== filled.length) problems.add('DUPLICATE_SIZE');

  if (PACKAGING_STICKER_BARCODE_ENABLED) {
    for (const row of order.rows) {
      const code = row.code.trim();
      if (!code) continue;
      try {
        encodeCode128(code);
      } catch {
        problems.add('BAD_CODE');
      }
    }
  }

  // A tag with no composition at all is legal and customers do order it, so an
  // order with nothing ticked prints. Once a material is ticked the tag makes a
  // claim about the garment, and "70% POLIESTER" with the other 30% missing is
  // wrong both to the customer and under the EU textile labelling rules.
  if (order.materials.some((m) => m.name.trim()) && materialPercentSum(order.materials) !== 100) {
    problems.add('PERCENT_NOT_100');
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
export function buildPrintPlan(
  order: LabelPrintOrder,
  options?: {
    /**
     * The composition line, when the caller already holds it as text.
     *
     * A sheet keeps its materials as name + percent and prints what they add up
     * to. A reprint from the catalogue holds the finished line instead, saved
     * the day the style was filed; parsing it back into percentages would turn
     * a hand-corrected composition into a silently shortened one.
     */
    composition?: string;
  },
): PrintStep[] {
  const steps: PrintStep[] = [];
  const composition = options?.composition ?? compositionText(order.materials);

  if (order.printStickers) {
    for (const row of order.rows) {
      const code = row.code.trim();

      // One sticker per colour, covering every size in that row. The sticker
      // goes on the bag, and a bag holds mixed sizes — a size printed on it
      // would be wrong for most of what is inside.
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

/**
 * One of each, to look at before committing a ribbon to the whole order.
 *
 * Written apart from `buildPrintPlan` rather than as a flag on it: a sample and
 * a real run mean different things, and a flag on the one function that decides
 * how many labels come out is exactly the place a mistake ships 680 of them.
 * The ids carry their own prefix so a sample can never be mistaken for a batch
 * of the real order that has already been sent.
 */
export function buildSamplePlan(order: LabelPrintOrder): PrintStep[] {
  // Built from an order with one of everything rather than from the quantities
  // typed so far: what a label says does not depend on how many are wanted, and
  // the operator wants to look at a tag before filling the grid in. It also
  // means a first colour with no dormant sticker code still yields a sample.
  const oneOfEach: LabelPrintOrder = {
    ...order,
    rows: order.rows.map((row) => ({
      ...row,
      quantities: Object.fromEntries(order.sizes.map((size) => [size.id, 1])),
    })),
  };

  const full = buildPrintPlan(oneOfEach);
  const sample: PrintStep[] = [];
  for (const kind of ['sticker', 'fabric'] as const) {
    const first = full.find((step) => step.kind === kind);
    if (first) sample.push({ ...first, id: `sample:${first.id}`, quantity: 1 });
  }
  return sample;
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

/**
 * The size columns staff reach for on most sheets, offered as one-tap buttons.
 * Anything else is typed once and then remembered on the machine, so a shop
 * that works in "3XL" or "48/50" stops retyping it — see the renderer's
 * learned-size store.
 */
export const SIZE_SUGGESTIONS = ['S', 'M', 'L', 'XL', '2XL', 'S/M', 'L/XL', '44/46'] as const;

/**
 * Style names offered in the dropdown. Seeded with the ones this shop named;
 * anything else is typed once and remembered on the machine when the order is
 * saved or printed, the same way a size column is.
 */
export const STYLE_SUGGESTIONS = [
  'KURTKA',
  'BAWEŁNIANE',
  'KOMPLET DRESOWY',
] as const;
