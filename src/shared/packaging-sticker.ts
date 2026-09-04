/**
 * Packaging sticker for the garment factory: the paper label stuck on the bag,
 * printed on the Honeywell PC42E-D through its Windows driver.
 *
 * Layout mirrors the sticker the customer already supplies, so the factory can
 * keep using one design across both sources:
 *
 *   MoonCollection      customer / brand line
 *   |||| || ||||        Code 128 of the bag code (SP006290)
 *   SP006290            the same code, human readable
 *   KURTKA - 114        kind of garment - style code
 *   CAPPUCCINO          colour
 *
 * The bag code has no reader in the workshop; it is kept because the owner
 * wants the sticker to look like the one the customer sends. Every line is in
 * capitals, bold — the width estimate below is tuned for that, not for the
 * mixed case a body-text average would assume.
 */
import { code128Svg, encodeCode128 } from './code128';

/**
 * The barcode was switched off for a day (03/09) to give the text the space;
 * the owner asked for the old layout back once he saw it. One switch either way.
 */
export const PACKAGING_STICKER_BARCODE_ENABLED = true;

export const PACKAGING_STICKER_LIMITS = {
  /** Long enough for "MoonCollection" or a two-word colour, short enough to fit. */
  textChars: 40,
  /** Code 128 stays scannable well past this; the stock does not. */
  codeChars: 48,
  /** Guards against a config typo turning into a metre-long page box. */
  maxSideMm: 210,
} as const;

export interface PackagingStickerInput {
  customerName?: string;
  styleName?: string;
  styleCode?: string;
  colorName?: string;
  code: string;
  widthMm: number;
  heightMm: number;
}

export interface PackagingSticker {
  customerName: string;
  styleName: string;
  styleCode: string;
  colorName: string;
  code: string;
  widthMm: number;
  heightMm: number;
}

function text(value: unknown, field: string, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`Packaging sticker: ${field} is required`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Packaging sticker: ${field} must be a string`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`Packaging sticker: ${field} is required`);
  if (trimmed.length > PACKAGING_STICKER_LIMITS.textChars) {
    throw new Error(
      `Packaging sticker: ${field} must be at most ${PACKAGING_STICKER_LIMITS.textChars} characters`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(`Packaging sticker: ${field} must not contain control characters`);
  }
  return trimmed;
}

function sideMm(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Packaging sticker: ${field} must be a positive number of millimetres`);
  }
  if (value > PACKAGING_STICKER_LIMITS.maxSideMm) {
    throw new Error(
      `Packaging sticker: ${field} must be at most ${PACKAGING_STICKER_LIMITS.maxSideMm} mm`,
    );
  }
  return value;
}

/**
 * Validate untrusted sticker input at the process boundary.
 *
 * @throws with a field-named message; the caller shows it to the operator.
 */
export function parsePackagingSticker(input: PackagingStickerInput): PackagingSticker {
  const code = text(input.code, 'code', PACKAGING_STICKER_BARCODE_ENABLED);
  if (PACKAGING_STICKER_BARCODE_ENABLED) {
    if (code.length > PACKAGING_STICKER_LIMITS.codeChars) {
      throw new Error(
        `Packaging sticker: code must be at most ${PACKAGING_STICKER_LIMITS.codeChars} characters`,
      );
    }
    // Keep symbology validation next to the dormant renderer so one switch
    // restores the complete, safe barcode path.
    encodeCode128(code);
  }

  return {
    customerName: text(input.customerName, 'customerName'),
    styleName: text(input.styleName, 'styleName'),
    styleCode: text(input.styleCode, 'styleCode'),
    colorName: text(input.colorName, 'colorName'),
    code,
    widthMm: sideMm(input.widthMm, 'widthMm'),
    heightMm: sideMm(input.heightMm, 'heightMm'),
  };
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build the standalone HTML document handed to the Windows print path. */
const MM_PER_PT = 25.4 / 72;
/**
 * Arial Bold, capitals: the average advance is about 0.72 em. The 0.55 em of
 * mixed-case body text was used here once, and a sticker it measured as
 * fitting came out of the printer on two labels with its first line lost.
 */
const AVG_CHAR_EM = 0.72;
/** Below this the thermal head stops resolving the strokes at 203 dpi. */
const MIN_TEXT_PT = 5;
const LINE_HEIGHT = 1.2;

/**
 * How many lines a row takes, the way the browser breaks it: at spaces when a
 * word fits, anywhere inside a word that does not. Counting characters alone
 * says two lines for "KOMPLETY DRESOWE - 115" where the printer makes three.
 */
export function stickerLinesNeeded(text: string, pt: number, usableMm: number): number {
  if (!text) return 0;
  const charMm = pt * MM_PER_PT * AVG_CHAR_EM;
  const perLine = Math.max(1, Math.floor(usableMm / charMm));
  let lines = 1;
  let used = 0;
  for (const word of text.split(' ')) {
    const width = word.length;
    if (width === 0) continue;
    if (width > perLine) {
      // Too long for any line: moved to a fresh one, then broken anywhere.
      if (used) lines += 1;
      lines += Math.ceil(width / perLine) - 1;
      used = width % perLine || perLine;
      continue;
    }
    const needed = used ? used + 1 + width : width;
    if (needed > perLine) {
      lines += 1;
      used = width;
    } else {
      used = needed;
    }
  }
  return lines;
}

/**
 * The fixed parts of the label: padding, the barcode block, and the base type
 * sizes. Shared with the HTML builder so the space the text is measured against
 * is the space it is actually given.
 */
function stickerGeometry(sticker: PackagingSticker) {
  const { widthMm: w, heightMm: h } = sticker;
  const padX = clamp(w * 0.05, 1, 3);
  const padY = clamp(h * 0.06, 0.8, 2.5);
  const barcodeHeightMm = PACKAGING_STICKER_BARCODE_ENABLED
    ? clamp(h * 0.34, 6, 14)
    : 0;
  const barcodeGapsMm = PACKAGING_STICKER_BARCODE_ENABLED ? padY * 1.1 : 0;
  return {
    padX,
    padY,
    barcodeHeightMm,
    usableMm: w - padX * 2,
    budgetMm: h - padY * 2 - barcodeHeightMm - barcodeGapsMm,
    // The sizes of the customer's own sticker, which the workshop reads fine.
    base: {
      customerPt: clamp(h * 0.115, 6.5, 11),
      codePt: clamp(h * 0.105, 6, 10),
      stylePt: clamp(h * 0.12, 6.5, 11.5),
      colorPt: clamp(h * 0.115, 6.5, 11),
    },
  };
}

export interface PackagingStickerTextLayout {
  customerPt: number;
  codePt: number;
  stylePt: number;
  colorPt: number;
  /** What the wrapped text is expected to occupy, in millimetres. */
  textMm: number;
  /** What is left for text after the barcode and the padding take their share. */
  budgetMm: number;
}

/**
 * Decides the type sizes for one sticker.
 *
 * The label is a fixed 50x30 with `overflow:hidden`, so text that needs more
 * room than that is not wrapped onto a second sticker — it is silently cut off,
 * and nobody notices until a carton reaches the customer with half a style name
 * on it. Long lines are therefore wrapped and the type stepped down until the
 * estimate fits, rather than left to overflow.
 */
export function layoutPackagingStickerText(
  sticker: PackagingSticker,
): PackagingStickerTextLayout {
  const { base, usableMm, budgetMm } = stickerGeometry(sticker);
  const styleLine = [sticker.styleName, sticker.styleCode].filter(Boolean).join(' - ');
  const colorLine = sticker.colorName;
  const rows: Array<[string, number]> = [
    [sticker.customerName, base.customerPt],
    ...(PACKAGING_STICKER_BARCODE_ENABLED
      ? [[sticker.code, base.codePt] as [string, number]]
      : []),
    [styleLine, base.stylePt],
    [colorLine, base.colorPt],
  ];

  const heightAt = (scale: number) => rows.reduce((sum, [text, pt]) => {
    const size = Math.max(MIN_TEXT_PT, pt * scale);
    return sum + stickerLinesNeeded(text, size, usableMm) * size * MM_PER_PT * LINE_HEIGHT;
  }, 0);

  let scale = 1;
  // 5% at a time: fine enough that nothing shrinks further than it must, and
  // bounded so a pathological input cannot loop.
  while (scale > 0.5 && heightAt(scale) > budgetMm) scale -= 0.05;

  const at = (pt: number) => Math.max(MIN_TEXT_PT, Number((pt * scale).toFixed(2)));
  return {
    customerPt: at(base.customerPt),
    codePt: at(base.codePt),
    stylePt: at(base.stylePt),
    colorPt: at(base.colorPt),
    textMm: heightAt(scale),
    budgetMm,
  };
}

export function buildPackagingStickerHtml(sticker: PackagingSticker): string {
  const { widthMm: w, heightMm: h } = sticker;

  // Everything scales off the label height so 50x30 and larger stock both work.
  const { padX, padY, barcodeHeightMm } = stickerGeometry(sticker);
  const { customerPt, codePt, stylePt, colorPt } = layoutPackagingStickerText(sticker);

  const barcodeRows: string[] = [];
  if (PACKAGING_STICKER_BARCODE_ENABLED) {
    // A narrow module of ~0.25mm prints crisply at 203 dpi (2 dots).
    const barcodeWidthMm = w - padX * 2;
    const symbol = encodeCode128(sticker.code);
    const totalModules = symbol.modules.length + 20; // + quiet zones
    const moduleWidth = barcodeWidthMm / totalModules;
    const svg = code128Svg(symbol, {
      moduleWidth,
      height: barcodeHeightMm,
      unit: 'mm',
    });
    barcodeRows.push(
      `<div class="barcode">${svg}</div>`,
      `<div class="code">${esc(sticker.code)}</div>`,
    );
  }

  const styleLine = [sticker.styleName, sticker.styleCode].filter(Boolean).join(' - ');
  // Colour and code only. The size used to be optional here, but one sticker
  // per colour is what goes on a bag of mixed sizes, and printing a size on it
  // made the sticker wrong for the bag it was stuck to.
  const colorLine = sticker.colorName;

  const rows = [
    sticker.customerName
      ? `<div class="customer">${esc(sticker.customerName)}</div>`
      : '',
    ...barcodeRows,
    styleLine ? `<div class="style">${esc(styleLine)}</div>` : '',
    colorLine ? `<div class="color">${esc(colorLine)}</div>` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: ${w}mm ${h}mm; margin: 0; }
* { margin:0; padding:0; box-sizing:border-box; }
/* A long style code has no spaces to break at; without this it runs off the
   edge of the label and the tail is lost to overflow:hidden. */
.customer, .code, .style, .color { overflow-wrap:anywhere; word-break:break-word; max-width:100%; }
body {
  width:${w}mm;
  height:${h}mm;
  font-family: Arial, "Segoe UI", Helvetica, sans-serif;
  color:#000;
  background:#fff;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}
/* The clip lives on a box inside the body: print ignores overflow on the body
   itself and pages the excess onto a second label. "safe center" keeps the
   first line on the label when the estimate is still short — the tail is cut,
   not the head. */
.sheet {
  width:${w}mm;
  height:${h}mm;
  padding:${padY.toFixed(2)}mm ${padX.toFixed(2)}mm;
  overflow:hidden;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:safe center;
  text-align:center;
}
.customer { font-size:${customerPt.toFixed(1)}pt; font-weight:800; line-height:1.1; }
.barcode { margin:${(padY * 0.6).toFixed(2)}mm 0 0; line-height:0; }
.barcode svg { display:block; }
.code { font-size:${codePt.toFixed(1)}pt; font-weight:600; line-height:1.2; letter-spacing:0.4px; }
.style { font-size:${stylePt.toFixed(1)}pt; font-weight:700; line-height:1.2; margin-top:${(padY * 0.5).toFixed(2)}mm; }
.color { font-size:${colorPt.toFixed(1)}pt; font-weight:700; line-height:1.2; }
</style></head><body><div class="sheet">
${rows}
</div></body></html>`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
