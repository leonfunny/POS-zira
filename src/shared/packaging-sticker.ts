/**
 * Packaging sticker for the garment factory: the paper label stuck on the bag,
 * printed on the Honeywell PC42E-D through its Windows driver.
 *
 * Layout mirrors the sticker the customer already supplies, so the factory can
 * keep using one design across both sources:
 *
 *   MoonCollection      customer / brand line
 *   |||| || ||||        Code 128 of the customer's own code (SP006290)
 *   SP006290            the same code, human readable
 *   KURTKA - 114        style name - style code
 *   CAPPUCCINO          colour, optionally "COLOUR · SIZE"
 *
 * The codes are the customer's (`SP…`), not EAN-13, which is why this lane uses
 * Code 128 and does not touch the product catalog.
 */
import { code128Svg, encodeCode128 } from './code128';

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
  sizeText?: string;
  code: string;
  widthMm: number;
  heightMm: number;
}

export interface PackagingSticker {
  customerName: string;
  styleName: string;
  styleCode: string;
  colorName: string;
  sizeText?: string;
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
  const code = text(input.code, 'code', true);
  if (code.length > PACKAGING_STICKER_LIMITS.codeChars) {
    throw new Error(
      `Packaging sticker: code must be at most ${PACKAGING_STICKER_LIMITS.codeChars} characters`,
    );
  }
  // Fail here rather than at the printer: encodeCode128 rejects non-ASCII.
  encodeCode128(code);

  const sizeText = text(input.sizeText, 'sizeText');

  return {
    customerName: text(input.customerName, 'customerName'),
    styleName: text(input.styleName, 'styleName'),
    styleCode: text(input.styleCode, 'styleCode'),
    colorName: text(input.colorName, 'colorName'),
    sizeText: sizeText || undefined,
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
/** Arial's average advance across mixed-case Latin text is close to 0.55 em. */
const AVG_CHAR_EM = 0.55;
/** Below this the thermal head stops resolving the strokes at 203 dpi. */
const MIN_TEXT_PT = 5;
const LINE_HEIGHT = 1.2;

function linesNeeded(text: string, pt: number, usableMm: number): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil((text.length * pt * MM_PER_PT * AVG_CHAR_EM) / usableMm));
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
  const barcodeHeightMm = clamp(h * 0.34, 6, 14);
  return {
    padX,
    padY,
    barcodeHeightMm,
    usableMm: w - padX * 2,
    // What the barcode, the padding and the two inter-row margins leave.
    budgetMm: h - padY * 2 - barcodeHeightMm - padY * 0.6 - padY * 0.5,
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
  const colorLine = [sticker.colorName, sticker.sizeText].filter(Boolean).join(' \u00b7 ');
  const rows: Array<[string, number]> = [
    [sticker.customerName, base.customerPt],
    [sticker.code, base.codePt],
    [styleLine, base.stylePt],
    [colorLine, base.colorPt],
  ];

  const heightAt = (scale: number) => rows.reduce((sum, [text, pt]) => {
    const size = Math.max(MIN_TEXT_PT, pt * scale);
    return sum + linesNeeded(text, size, usableMm) * size * MM_PER_PT * LINE_HEIGHT;
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

  const styleLine = [sticker.styleName, sticker.styleCode].filter(Boolean).join(' - ');
  // sizeText is absent unless the operator ticked "print size on the sticker".
  const colorLine = [sticker.colorName, sticker.sizeText].filter(Boolean).join(' · ');

  const rows = [
    sticker.customerName
      ? `<div class="customer">${esc(sticker.customerName)}</div>`
      : '',
    `<div class="barcode">${svg}</div>`,
    `<div class="code">${esc(sticker.code)}</div>`,
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
  padding:${padY.toFixed(2)}mm ${padX.toFixed(2)}mm;
  color:#000;
  background:#fff;
  overflow:hidden;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  text-align:center;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}
.customer { font-size:${customerPt.toFixed(1)}pt; font-weight:800; line-height:1.1; }
.barcode { margin:${(padY * 0.6).toFixed(2)}mm 0 0; line-height:0; }
.barcode svg { display:block; }
.code { font-size:${codePt.toFixed(1)}pt; font-weight:600; line-height:1.2; letter-spacing:0.4px; }
.style { font-size:${stylePt.toFixed(1)}pt; font-weight:700; line-height:1.2; margin-top:${(padY * 0.5).toFixed(2)}mm; }
.color { font-size:${colorPt.toFixed(1)}pt; font-weight:700; line-height:1.2; }
</style></head><body>
${rows}
</body></html>`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
