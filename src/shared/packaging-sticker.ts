/**
 * Packaging sticker for the garment factory: the paper label stuck on the bag,
 * printed on the Honeywell PC42E-D through its Windows driver.
 *
 * Three lines, the only three the packer needs to tell one bag from another:
 *
 *   MOONCOLLECTION      customer / brand line
 *   MARYNARKA - 111     kind of garment - style code
 *   CZEKOLADOWY         colour
 *
 * The barcode and the bag code under it were removed for good on 04/09: the
 * workshop has no reader, the code was generated rather than meaningful, and
 * between them they took 12 of the 30 millimetres. What is left is set in the
 * type sizes that space bought.
 *
 * Every line is in capitals, bold — the width estimate below is tuned for that,
 * not for the mixed case a body-text average would assume.
 */

export const PACKAGING_STICKER_LIMITS = {
  /** Long enough for "MoonCollection" or a two-word colour, short enough to fit. */
  textChars: 40,
  /** Guards against a config typo turning into a metre-long page box. */
  maxSideMm: 210,
} as const;

export interface PackagingStickerInput {
  customerName?: string;
  styleName?: string;
  styleCode?: string;
  colorName?: string;
  widthMm: number;
  heightMm: number;
}

export interface PackagingSticker {
  customerName: string;
  styleName: string;
  styleCode: string;
  colorName: string;
  widthMm: number;
  heightMm: number;
}

/**
 * Every line is optional: a sticker with only a colour on it is a sticker the
 * packer can still use, and refusing to print one would stop a run over a field
 * nobody looks at.
 */
function text(value: unknown, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new Error(`Packaging sticker: ${field} must be a string`);
  }
  const trimmed = value.trim();
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
  return {
    customerName: text(input.customerName, 'customerName'),
    styleName: text(input.styleName, 'styleName'),
    styleCode: text(input.styleCode, 'styleCode'),
    colorName: text(input.colorName, 'colorName'),
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
 * The fixed parts of the label: padding and the base type sizes. Shared with
 * the HTML builder so the space the text is measured against is the space it is
 * actually given.
 *
 * The sizes come off the label WIDTH, not its height. Three short lines never
 * come close to filling 30mm, but a capitalised "MARYNARKA - 111" is fifteen
 * characters that have to sit on one line of a 45mm text column — at 11pt that
 * line holds sixteen, at 12pt only fourteen and the code drops onto a second
 * line. Height is handled after the fact by the shrink loop below, which is
 * what taller-than-usual content on smaller stock actually needs.
 */
function stickerGeometry(sticker: PackagingSticker) {
  const { widthMm: w, heightMm: h } = sticker;
  const padX = clamp(w * 0.05, 1, 3);
  const padY = clamp(h * 0.06, 0.8, 2.5);
  return {
    padX,
    padY,
    usableMm: w - padX * 2,
    budgetMm: h - padY * 2,
    // Tuned on the 50mm stock the workshop runs; the upper clamps keep a wide
    // label from turning three words into a poster.
    base: {
      customerPt: clamp(w * 0.22, 6.5, 16),
      stylePt: clamp(w * 0.22, 6.5, 16),
      // The colour is what the packer is actually looking for on the shelf.
      colorPt: clamp(w * 0.26, 6.5, 19),
    },
  };
}

export interface PackagingStickerTextLayout {
  customerPt: number;
  stylePt: number;
  colorPt: number;
  /** What the wrapped text is expected to occupy, in millimetres. */
  textMm: number;
  /** What is left for text once the padding has taken its share. */
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
    stylePt: at(base.stylePt),
    colorPt: at(base.colorPt),
    textMm: heightAt(scale),
    budgetMm,
  };
}

export function buildPackagingStickerHtml(sticker: PackagingSticker): string {
  const { widthMm: w, heightMm: h } = sticker;

  const { padX, padY } = stickerGeometry(sticker);
  const { customerPt, stylePt, colorPt } = layoutPackagingStickerText(sticker);

  const styleLine = [sticker.styleName, sticker.styleCode].filter(Boolean).join(' - ');
  // Colour and code only. The size used to be optional here, but one sticker
  // per colour is what goes on a bag of mixed sizes, and printing a size on it
  // made the sticker wrong for the bag it was stuck to.
  const colorLine = sticker.colorName;

  const rows = [
    sticker.customerName
      ? `<div class="customer">${esc(sticker.customerName)}</div>`
      : '',
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
.customer, .style, .color { overflow-wrap:anywhere; word-break:break-word; max-width:100%; }
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
.style { font-size:${stylePt.toFixed(1)}pt; font-weight:700; line-height:1.2; margin-top:${(padY * 0.5).toFixed(2)}mm; }
.color { font-size:${colorPt.toFixed(1)}pt; font-weight:700; line-height:1.2; }
</style></head><body><div class="sheet">
${rows}
</div></body></html>`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
