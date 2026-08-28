/**
 * ISO 3758 textile care symbols, drawn as vector art.
 *
 * Vector rather than a symbol font because no care-symbol font ships with
 * Windows, and a missing font would silently print tofu boxes onto physical
 * garments. Lives in shared/ because both sides need it: the main process
 * rasterises these into the tag bitmap, and the renderer shows the same art in
 * the picker so what you choose is literally what gets printed.
 *
 * Each symbol is drawn in a 100x100 viewBox with a 7-unit stroke, which stays
 * legible after downsampling to the ~28 dots a tag can spare per symbol.
 */
import type { CareSymbol } from './types';

const STROKE = 'fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"';
const SOLID = 'fill="currentColor" stroke="none"';

/** Washtub outline with the wavy waterline across its rim. */
const TUB = `<path d="M10 40 H90 L80 90 H20 Z" ${STROKE}/><path d="M14 40 q9 -13 18 0 t18 0 t18 0 t18 0" ${STROKE}/>`;
/** Diagonal cross meaning "do not". */
const CROSS = `<path d="M12 12 L88 88 M88 12 L12 88" ${STROKE}/>`;
const TRIANGLE = `<path d="M50 10 L94 90 H6 Z" ${STROKE}/>`;
const SQUARE = `<rect x="8" y="8" width="84" height="84" rx="4" ${STROKE}/>`;
const TUMBLE = `${SQUARE}<circle cx="50" cy="50" r="28" ${STROKE}/>`;
/**
 * Iron seen from the side, tip to the left: pointed soleplate, flat top, and a
 * handle bar above it. The earlier single-curve outline collapsed into a dome
 * once downsampled to ~26 dots, which is unreadable on a tag.
 */
const IRON = `<path d="M6 84 C12 56 22 38 40 38 H84 L94 84 Z" ${STROKE}/>`
  + `<path d="M40 38 V24 H88" ${STROKE}/>`;
const CIRCLE = `<circle cx="50" cy="50" r="42" ${STROKE}/>`;
/** Simplified hand silhouette for the hand-wash symbol. */
const HAND = `<path d="M32 86 c0-10 2-15 6-19 l0-17 a4 4 0 0 1 8 0 l0 11 l0-19 a4 4 0 0 1 8 0 l0 19 l0-15 a4 4 0 0 1 8 0 l0 15 l0-9 a4 4 0 0 1 8 0 l0 21 c0 8-4 13-10 13 z" ${SOLID}/>`;

function tubText(label: string): string {
  return `${TUB}<text x="50" y="82" font-family="Arial, sans-serif" font-size="36" font-weight="700" text-anchor="middle" ${SOLID}>${label}</text>`;
}

/** `count` evenly spaced dots on the horizontal centreline at `cy`. */
function dots(count: number, cy: number): string {
  const spacing = 22;
  const start = 50 - ((count - 1) * spacing) / 2;
  return Array.from({ length: count }, (_, i) =>
    `<circle cx="${start + i * spacing}" cy="${cy}" r="6" ${SOLID}/>`).join('');
}

function circleLetter(letter: string): string {
  return `${CIRCLE}<text x="50" y="68" font-family="Arial, sans-serif" font-size="46" font-weight="700" text-anchor="middle" ${SOLID}>${letter}</text>`;
}

export const CARE_SYMBOL_ART: Record<CareSymbol, string> = {
  WASH_30: tubText('30'),
  WASH_40: tubText('40'),
  WASH_60: tubText('60'),
  WASH_HAND: `${TUB}${HAND}`,
  WASH_NO: `${TUB}${CROSS}`,

  BLEACH_OK: TRIANGLE,
  BLEACH_NO: `${TRIANGLE}${CROSS}`,

  DRY_ANY: SQUARE,
  TUMBLE_LOW: `${TUMBLE}${dots(1, 50)}`,
  TUMBLE_NORMAL: `${TUMBLE}${dots(2, 50)}`,
  TUMBLE_NO: `${TUMBLE}${CROSS}`,
  DRY_LINE: `${SQUARE}<path d="M50 18 V82" ${STROKE}/>`,
  DRY_FLAT: `${SQUARE}<path d="M18 50 H82" ${STROKE}/>`,

  IRON_LOW: `${IRON}${dots(1, 66)}`,
  IRON_MEDIUM: `${IRON}${dots(2, 66)}`,
  IRON_HIGH: `${IRON}${dots(3, 66)}`,
  IRON_NO: `${IRON}${CROSS}`,

  DRYCLEAN_ANY: CIRCLE,
  DRYCLEAN_P: circleLetter('P'),
  DRYCLEAN_F: circleLetter('F'),
  DRYCLEAN_NO: `${CIRCLE}${CROSS}`,
};

/**
 * A complete `<svg>` element for one symbol.
 * Colour comes from `currentColor`, so the picker can tint it and the tag
 * rasteriser gets solid black from its own stylesheet.
 */
export function careSymbolSvg(symbol: CareSymbol, sizePx: number): string {
  const art = CARE_SYMBOL_ART[symbol];
  if (!art) return '';
  return `<svg class="care" width="${sizePx}" height="${sizePx}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">${art}</svg>`;
}
