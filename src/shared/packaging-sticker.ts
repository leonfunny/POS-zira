/**
 * Packaging sticker for the garment factory: the paper label stuck on the bag,
 * printed on the Honeywell PC42E-D through its Windows driver.
 *
 * Four rows ordered for shelf recognition: small customer, garment type,
 * large style code, then colour. No barcode, bag code, or mixed-bag size.
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
const LINE_HEIGHT = 1.1;

/**
 * How many lines a row takes, the way the browser breaks it: at spaces when a
 * word fits, anywhere inside a word that does not. Counting characters alone
 * says two lines for "KOMPLETY DRESOWE - 115" where the printer makes three.
 */
export function stickerLinesNeeded(text: string, pt: number, usableMm: number): number {
  if (!text) return 0;
  const capacity = usableMm / (pt * MM_PER_PT);
  // Arial's W/M and full-width scripts exceed the usual uppercase average.
  // Counting them as average-width once let the last row get clipped.
  const advance = (char: string) => /[WM@%\u2e80-\uffef]/u.test(char) ? 1 : AVG_CHAR_EM;
  let lines = 1;
  let used = 0;
  for (const word of text.split(' ')) {
    const chars = Array.from(word);
    const width = chars.reduce((sum, char) => sum + advance(char), 0);
    if (!width) continue;
    if (width > capacity) {
      if (used) lines += 1;
      used = 0;
      for (const char of chars) {
        const next = advance(char);
        if (used && used + next > capacity) {
          lines += 1;
          used = 0;
        }
        used += next;
      }
      continue;
    }
    const needed = used ? used + AVG_CHAR_EM + width : width;
    if (needed > capacity) {
      lines += 1;
      used = width;
    } else {
      used = needed;
    }
  }
  return lines;
}

/** Shared physical geometry for both the fit calculation and print CSS. */
function stickerGeometry(sticker: PackagingSticker) {
  const { widthMm: w, heightMm: h } = sticker;
  const padX = clamp(w * 0.05, 1, 3);
  const padY = clamp(h * 0.06, 0.8, 2.5);
  return {
    padX,
    padY,
    usableMm: w - padX * 2,
    budgetMm: h - padY * 2,
    rowGapMm: 0.35,
    base: {
      customerPt: clamp(w * 0.16, 6.5, 10),
      stylePt: clamp(w * 0.32, 6.5, 20),
      codePt: clamp(w * 28 / 50, 10, 36),
      colorPt: clamp(w * 0.24, 6.5, 16),
    },
  };
}

export interface PackagingStickerTextLayout {
  customerPt: number;
  stylePt: number;
  codePt: number;
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
  const { base, usableMm, budgetMm, rowGapMm } = stickerGeometry(sticker);
  const rows = [
    { text: sticker.customerName, pt: base.customerPt },
    { text: sticker.styleName, pt: base.stylePt },
    { text: sticker.styleCode, pt: base.codePt },
    { text: sticker.colorName, pt: base.colorPt },
  ];
  const code = rows[2];
  // Keep a code together where possible, without converting it to a number
  // (leading zeroes and letters identify different products).
  while (code.pt > MIN_TEXT_PT && stickerLinesNeeded(code.text, code.pt, usableMm) > 1) {
    code.pt = Math.max(MIN_TEXT_PT, code.pt - 0.5);
  }
  const rowHeight = (row: typeof code) =>
    stickerLinesNeeded(row.text, row.pt, usableMm) * row.pt * MM_PER_PT * LINE_HEIGHT;
  const gapMm = Math.max(0, rows.filter(row => row.text).length - 1) * rowGapMm;
  const height = () => rows.reduce((sum, row) => sum + rowHeight(row), gapMm);

  // Shrink the tallest supporting row first. A long customer/type/colour must
  // not shrink the identifying code along with it. Only unusually small stock
  // may require shrinking the code after the other rows reach the font floor.
  while (height() > budgetMm) {
    const candidates = rows.filter(row => row !== code && row.text && row.pt > MIN_TEXT_PT);
    const tallest = candidates.sort((a, b) => rowHeight(b) - rowHeight(a))[0]
      ?? (code.text && code.pt > MIN_TEXT_PT ? code : undefined);
    if (!tallest) break;
    tallest.pt = Math.max(MIN_TEXT_PT, tallest.pt - 0.5);
  }

  return {
    customerPt: rows[0].pt,
    stylePt: rows[1].pt,
    codePt: code.pt,
    colorPt: rows[3].pt,
    textMm: height(),
    budgetMm,
  };
}

export function buildPackagingStickerHtml(sticker: PackagingSticker): string {
  const { widthMm: w, heightMm: h } = sticker;

  const { padX, padY, rowGapMm } = stickerGeometry(sticker);
  const { customerPt, stylePt, codePt, colorPt } = layoutPackagingStickerText(sticker);

  // Colour and code only. The size used to be optional here, but one sticker
  // per colour is what goes on a bag of mixed sizes, and printing a size on it
  // made the sticker wrong for the bag it was stuck to.
  const colorLine = sticker.colorName;

  const rows = [
    sticker.customerName
      ? `<div class="customer">${esc(sticker.customerName)}</div>`
      : '',
    sticker.styleName ? `<div class="style">${esc(sticker.styleName)}</div>` : '',
    sticker.styleCode ? `<div class="style-code">${esc(sticker.styleCode)}</div>` : '',
    colorLine ? `<div class="color">${esc(colorLine)}</div>` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: ${w}mm ${h}mm; margin: 0; }
* { margin:0; padding:0; box-sizing:border-box; }
/* A long style code has no spaces to break at; without this it runs off the
   edge of the label and the tail is lost to overflow:hidden. */
.customer, .style, .style-code, .color { overflow-wrap:anywhere; word-break:break-word; max-width:100%; }
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
  gap:${rowGapMm}mm;
  align-items:center;
  justify-content:safe center;
  text-align:center;
}
.sheet > div { flex-shrink:0; line-height:${LINE_HEIGHT}; }
.customer { font-size:${customerPt.toFixed(1)}pt; font-weight:400; }
.style { font-size:${stylePt.toFixed(1)}pt; font-weight:700; }
.style-code { font-size:${codePt.toFixed(1)}pt; font-weight:800; }
.color { font-size:${colorPt.toFixed(1)}pt; font-weight:700; }
</style></head><body><div class="sheet">
${rows}
</div></body></html>`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
