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
/**
 * Simplified hand silhouette for the hand-wash symbol, shrunk into the tub.
 * Drawn at full size it filled the basin edge to edge and printed as a solid
 * block of ink at 203 dpi — a blob, not a hand. Scaled down it keeps white
 * space around it, which is what makes it readable that small.
 */
const HAND_PATH = 'M32 86 c0-10 2-15 6-19 l0-17 a4 4 0 0 1 8 0 l0 11 l0-19'
  + ' a4 4 0 0 1 8 0 l0 19 l0-15 a4 4 0 0 1 8 0 l0 15 l0-9 a4 4 0 0 1 8 0'
  + ' l0 21 c0 8-4 13-10 13 z';
const HAND = `<g transform="translate(22 22) scale(0.56)"><path d="${HAND_PATH}" ${SOLID}/></g>`;

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

/**
 * The milder processes are the same symbol with one or two bars beneath it, so
 * the base art is scaled up out of the way rather than redrawn. One bar means
 * reduced agitation and spin, two means the gentlest cycle the machine has.
 */
function withBars(art: string, count: 1 | 2): string {
  if (count === 1) {
    return `<g transform="translate(9 0) scale(0.82)">${art}</g>`
      + `<rect x="16" y="88" width="68" height="9" ${SOLID}/>`;
  }
  return `<g transform="translate(13 0) scale(0.74)">${art}</g>`
    + `<rect x="16" y="79" width="68" height="8" ${SOLID}/>`
    + `<rect x="16" y="92" width="68" height="8" ${SOLID}/>`;
}

/** Diagonal stroke across the top-left corner: dry out of direct sunlight. */
const SHADE = `<path d="M11 39 L39 11" ${STROKE}/>`;
/** Hung to dry; a second line means hung dripping wet, without spinning. */
const HANG_1 = `<path d="M50 20 V82" ${STROKE}/>`;
const HANG_2 = `<path d="M38 20 V82 M62 20 V82" ${STROKE}/>`;
/** Laid flat to dry, and the same unspun. */
const LAY_1 = `<path d="M18 50 H82" ${STROKE}/>`;
const LAY_2 = `<path d="M18 38 H82 M18 62 H82" ${STROKE}/>`;

export const CARE_SYMBOL_ART: Record<CareSymbol, string> = {
  WASH_95: tubText('95'),
  WASH_95_MILD: withBars(tubText('95'), 1),
  WASH_70: tubText('70'),
  WASH_60: tubText('60'),
  WASH_60_MILD: withBars(tubText('60'), 1),
  WASH_50: tubText('50'),
  WASH_50_MILD: withBars(tubText('50'), 1),
  WASH_40: tubText('40'),
  WASH_40_MILD: withBars(tubText('40'), 1),
  WASH_40_VERY_MILD: withBars(tubText('40'), 2),
  WASH_30: tubText('30'),
  WASH_30_MILD: withBars(tubText('30'), 1),
  WASH_30_VERY_MILD: withBars(tubText('30'), 2),
  WASH_HAND: `${TUB}${HAND}`,
  WASH_NO: `${TUB}${CROSS}`,

  BLEACH_OK: TRIANGLE,
  // Two diagonal stripes inside the triangle: oxygen bleach only. It replaced
  // the older triangle holding a crossed-out "CL".
  BLEACH_OXYGEN: `${TRIANGLE}<path d="M24 70 L40 40 M44 70 L60 40" ${STROKE}/>`,
  BLEACH_NO: `${TRIANGLE}${CROSS}`,

  DRY_ANY: SQUARE,
  TUMBLE_NORMAL: `${TUMBLE}${dots(2, 50)}`,
  TUMBLE_LOW: `${TUMBLE}${dots(1, 50)}`,
  TUMBLE_NO: `${TUMBLE}${CROSS}`,

  DRY_LINE: `${SQUARE}${HANG_1}`,
  DRY_DRIP: `${SQUARE}${HANG_2}`,
  DRY_FLAT: `${SQUARE}${LAY_1}`,
  DRY_FLAT_DRIP: `${SQUARE}${LAY_2}`,
  DRY_LINE_SHADE: `${SQUARE}${HANG_1}${SHADE}`,
  DRY_DRIP_SHADE: `${SQUARE}${HANG_2}${SHADE}`,
  DRY_FLAT_SHADE: `${SQUARE}${LAY_1}${SHADE}`,
  DRY_FLAT_DRIP_SHADE: `${SQUARE}${LAY_2}${SHADE}`,

  IRON_HIGH: `${IRON}${dots(3, 66)}`,
  IRON_MEDIUM: `${IRON}${dots(2, 66)}`,
  IRON_LOW: `${IRON}${dots(1, 66)}`,
  IRON_NO: `${IRON}${CROSS}`,

  DRYCLEAN_ANY: CIRCLE,
  DRYCLEAN_P: circleLetter('P'),
  DRYCLEAN_P_MILD: withBars(circleLetter('P'), 1),
  DRYCLEAN_F: circleLetter('F'),
  DRYCLEAN_F_MILD: withBars(circleLetter('F'), 1),
  DRYCLEAN_NO: `${CIRCLE}${CROSS}`,

  WETCLEAN_W: circleLetter('W'),
  WETCLEAN_W_MILD: withBars(circleLetter('W'), 1),
  WETCLEAN_W_VERY_MILD: withBars(circleLetter('W'), 2),
  WETCLEAN_NO: `${circleLetter('W')}${CROSS}`,
};

/**
 * What each symbol tells the launderer, in the languages spoken on the shop
 * floor. The picker shows these on hover and to screen readers, because
 * "WASH_40_VERY_MILD" means nothing to the person choosing it, and choosing the
 * wrong one puts a wrong instruction on a customer's garment.
 */
export const CARE_SYMBOL_LABELS: Record<CareSymbol, { vi: string; pl: string; en: string }> = {
  WASH_95: { vi: 'Giặt máy 95°C', pl: 'Pranie 95°C', en: 'Wash at 95°C' },
  WASH_95_MILD: { vi: 'Giặt máy 95°C, nhẹ', pl: 'Pranie 95°C, łagodne', en: 'Wash at 95°C, mild' },
  WASH_70: { vi: 'Giặt máy 70°C', pl: 'Pranie 70°C', en: 'Wash at 70°C' },
  WASH_60: { vi: 'Giặt máy 60°C', pl: 'Pranie 60°C', en: 'Wash at 60°C' },
  WASH_60_MILD: { vi: 'Giặt máy 60°C, nhẹ', pl: 'Pranie 60°C, łagodne', en: 'Wash at 60°C, mild' },
  WASH_50: { vi: 'Giặt máy 50°C', pl: 'Pranie 50°C', en: 'Wash at 50°C' },
  WASH_50_MILD: { vi: 'Giặt máy 50°C, nhẹ', pl: 'Pranie 50°C, łagodne', en: 'Wash at 50°C, mild' },
  WASH_40: { vi: 'Giặt máy 40°C', pl: 'Pranie 40°C', en: 'Wash at 40°C' },
  WASH_40_MILD: { vi: 'Giặt máy 40°C, nhẹ', pl: 'Pranie 40°C, łagodne', en: 'Wash at 40°C, mild' },
  WASH_40_VERY_MILD: {
    vi: 'Giặt máy 40°C, rất nhẹ',
    pl: 'Pranie 40°C, bardzo łagodne',
    en: 'Wash at 40°C, very mild',
  },
  WASH_30: { vi: 'Giặt máy 30°C', pl: 'Pranie 30°C', en: 'Wash at 30°C' },
  WASH_30_MILD: { vi: 'Giặt máy 30°C, nhẹ', pl: 'Pranie 30°C, łagodne', en: 'Wash at 30°C, mild' },
  WASH_30_VERY_MILD: {
    vi: 'Giặt máy 30°C, rất nhẹ',
    pl: 'Pranie 30°C, bardzo łagodne',
    en: 'Wash at 30°C, very mild',
  },
  WASH_HAND: {
    vi: 'Giặt tay, tối đa 40°C',
    pl: 'Pranie ręczne, maks. 40°C',
    en: 'Hand wash, max 40°C',
  },
  WASH_NO: { vi: 'Không giặt', pl: 'Nie prać', en: 'Do not wash' },

  BLEACH_OK: { vi: 'Được dùng thuốc tẩy', pl: 'Można wybielać', en: 'Bleaching allowed' },
  BLEACH_OXYGEN: {
    vi: 'Chỉ tẩy oxy, không tẩy clo',
    pl: 'Tylko wybielacz tlenowy',
    en: 'Oxygen bleach only',
  },
  BLEACH_NO: { vi: 'Không dùng thuốc tẩy', pl: 'Nie wybielać', en: 'Do not bleach' },

  DRY_ANY: { vi: 'Được làm khô', pl: 'Można suszyć', en: 'Drying allowed' },
  TUMBLE_NORMAL: {
    vi: 'Sấy máy, nhiệt thường',
    pl: 'Suszarka bębnowa, normalna',
    en: 'Tumble dry, normal heat',
  },
  TUMBLE_LOW: {
    vi: 'Sấy máy, nhiệt thấp',
    pl: 'Suszarka bębnowa, niska temperatura',
    en: 'Tumble dry, low heat',
  },
  TUMBLE_NO: { vi: 'Không sấy máy', pl: 'Nie suszyć w suszarce', en: 'Do not tumble dry' },

  DRY_LINE: { vi: 'Phơi treo', pl: 'Suszyć na sznurze', en: 'Line dry' },
  DRY_DRIP: { vi: 'Phơi treo, không vắt', pl: 'Suszyć ociekające na sznurze', en: 'Drip dry' },
  DRY_FLAT: { vi: 'Phơi nằm', pl: 'Suszyć na płasko', en: 'Dry flat' },
  DRY_FLAT_DRIP: {
    vi: 'Phơi nằm, không vắt',
    pl: 'Suszyć ociekające na płasko',
    en: 'Drip dry flat',
  },
  DRY_LINE_SHADE: {
    vi: 'Phơi treo trong bóng râm',
    pl: 'Suszyć na sznurze w cieniu',
    en: 'Line dry in the shade',
  },
  DRY_DRIP_SHADE: {
    vi: 'Phơi treo, không vắt, trong bóng râm',
    pl: 'Suszyć ociekające na sznurze w cieniu',
    en: 'Drip dry in the shade',
  },
  DRY_FLAT_SHADE: {
    vi: 'Phơi nằm trong bóng râm',
    pl: 'Suszyć na płasko w cieniu',
    en: 'Dry flat in the shade',
  },
  DRY_FLAT_DRIP_SHADE: {
    vi: 'Phơi nằm, không vắt, trong bóng râm',
    pl: 'Suszyć ociekające na płasko w cieniu',
    en: 'Drip dry flat in the shade',
  },

  IRON_HIGH: { vi: 'Là tối đa 200°C', pl: 'Prasować maks. 200°C', en: 'Iron, max 200°C' },
  IRON_MEDIUM: { vi: 'Là tối đa 150°C', pl: 'Prasować maks. 150°C', en: 'Iron, max 150°C' },
  IRON_LOW: {
    vi: 'Là tối đa 110°C, không hơi nước',
    pl: 'Prasować maks. 110°C, bez pary',
    en: 'Iron, max 110°C, no steam',
  },
  IRON_NO: { vi: 'Không là', pl: 'Nie prasować', en: 'Do not iron' },

  DRYCLEAN_ANY: {
    vi: 'Giặt khô chuyên nghiệp',
    pl: 'Czyszczenie profesjonalne',
    en: 'Professional dry cleaning',
  },
  DRYCLEAN_P: {
    vi: 'Giặt khô, dung môi P',
    pl: 'Czyszczenie w rozpuszczalniku P',
    en: 'Dry clean, solvent P',
  },
  DRYCLEAN_P_MILD: {
    vi: 'Giặt khô, dung môi P, nhẹ',
    pl: 'Czyszczenie w rozpuszczalniku P, łagodne',
    en: 'Dry clean, solvent P, mild',
  },
  DRYCLEAN_F: {
    vi: 'Giặt khô, dung môi F',
    pl: 'Czyszczenie w rozpuszczalniku F',
    en: 'Dry clean, solvent F',
  },
  DRYCLEAN_F_MILD: {
    vi: 'Giặt khô, dung môi F, nhẹ',
    pl: 'Czyszczenie w rozpuszczalniku F, łagodne',
    en: 'Dry clean, solvent F, mild',
  },
  DRYCLEAN_NO: { vi: 'Không giặt khô', pl: 'Nie czyścić chemicznie', en: 'Do not dry clean' },

  WETCLEAN_W: {
    vi: 'Giặt ướt chuyên nghiệp',
    pl: 'Profesjonalne pranie wodne',
    en: 'Professional wet cleaning',
  },
  WETCLEAN_W_MILD: {
    vi: 'Giặt ướt chuyên nghiệp, nhẹ',
    pl: 'Profesjonalne pranie wodne, łagodne',
    en: 'Professional wet cleaning, mild',
  },
  WETCLEAN_W_VERY_MILD: {
    vi: 'Giặt ướt chuyên nghiệp, rất nhẹ',
    pl: 'Profesjonalne pranie wodne, bardzo łagodne',
    en: 'Professional wet cleaning, very mild',
  },
  WETCLEAN_NO: {
    vi: 'Không giặt ướt chuyên nghiệp',
    pl: 'Nie prać wodnie profesjonalnie',
    en: 'Do not wet clean',
  },
};

/** The symbol's meaning in `locale`, falling back to English. */
export function careSymbolLabel(symbol: CareSymbol, locale: string): string {
  const entry = CARE_SYMBOL_LABELS[symbol];
  if (!entry) return symbol;
  if (locale === 'vi' || locale === 'pl') return entry[locale];
  return entry.en;
}

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
