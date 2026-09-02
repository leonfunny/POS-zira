/**
 * Code 128 encoder for the packaging stickers printed in the Label module.
 *
 * The factory's codes look like `SP006290` — letters plus digits — so EAN-13 is
 * not an option (see docs/superpowers/specs/2026-09-01-fabric-label-handover.md).
 * `qrcode` is the only symbology library bundled with the app, so this file
 * carries the Code 128 bar pattern itself.
 *
 * Output is a module array (1 = bar, 0 = space) at one module per element. The
 * caller scales it into an SVG at whatever width the label needs; keeping the
 * encoder free of geometry means the checksum can be tested on its own.
 */

/** Bar/space widths for values 0..106, indexed by symbol value. */
const PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100',
  '10001001100', '10011001000', '10011000100', '10001100100', '11001001000',
  '11001000100', '11000100100', '10110011100', '10011011100', '10011001110',
  '10111001100', '10011101100', '10011100110', '11001110010', '11001011100',
  '11001001110', '11011100100', '11001110100', '11101101110', '11101001100',
  '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000',
  '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110',
  '10111011000', '10111000110', '10001110110', '11101110110', '11010001110',
  '11000101110', '11011101000', '11011100010', '11011101110', '11101011000',
  '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100',
  '10010110000', '10010000110', '10000101100', '10000100110', '10110010000',
  '10110000100', '10011010000', '10011000010', '10000110100', '10000110010',
  '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100', '10011110100',
  '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110',
  '10111101000', '10111100010', '11110101000', '11110100010', '10111011110',
  '10111101110', '11101011110', '11110101110', '11010000100', '11010010000',
  '11010011100', '1100011101011',
] as const;

const CODE_B_SHIFT = 32;
const START_B = 104;
const START_C = 105;
const SWITCH_TO_B = 100;
const SWITCH_TO_C = 99;
const STOP = 106;

/**
 * GS1 requires a quiet zone of at least 10 narrow modules on each side.
 * Below that, scanners read intermittently — which on a packaging sticker looks
 * like a printer fault rather than a layout bug.
 */
export const CODE128_QUIET_ZONE_MODULES = 10;

export interface Code128Symbol {
  /** Symbol values in order: start, data…, checksum, stop. */
  values: number[];
  /** Checksum value, also present in `values`. */
  checksum: number;
  /** 1 = bar, 0 = space, one entry per module. */
  modules: number[];
  /** The text that was encoded, unchanged. */
  text: string;
}

/** Digits are packed two per symbol in Code C, so long runs pay for the switch. */
function digitRunLength(text: string, from: number): number {
  let end = from;
  while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++;
  return end - from;
}

/**
 * Code C is worth entering for a run of 4+ digits mid-string, or 2+ at the very
 * start/end where no switch back is needed. Shorter runs cost more in switch
 * codes than they save.
 */
function shouldUseCodeC(text: string, at: number, run: number): boolean {
  const atStart = at === 0;
  const toEnd = at + run === text.length;
  if (run % 2 !== 0) return false;
  if (atStart && toEnd) return run >= 2;
  if (atStart || toEnd) return run >= 4;
  return run >= 6;
}

function encodeValues(text: string): number[] {
  const values: number[] = [];
  let mode: 'B' | 'C' | null = null;
  let i = 0;

  while (i < text.length) {
    const run = digitRunLength(text, i);
    const useC = run > 0 && shouldUseCodeC(text, i, run);

    if (useC) {
      if (mode === null) values.push(START_C);
      else if (mode !== 'C') values.push(SWITCH_TO_C);
      mode = 'C';
      for (let d = 0; d < run; d += 2) {
        values.push(Number(text.slice(i + d, i + d + 2)));
      }
      i += run;
      continue;
    }

    if (mode === null) values.push(START_B);
    else if (mode !== 'B') values.push(SWITCH_TO_B);
    mode = 'B';

    // Emit one character, then re-evaluate: the next position may open a digit run.
    values.push(text.charCodeAt(i) - CODE_B_SHIFT);
    i += 1;
  }

  return values;
}

/**
 * Encode `text` as a Code 128 symbol.
 *
 * @throws if `text` is empty or contains anything outside printable ASCII
 *   (32..126). Polish and Vietnamese letters are rejected rather than silently
 *   mangled — a wrong barcode on a box is worse than a refused print.
 */
export function encodeCode128(text: string): Code128Symbol {
  if (!text) throw new Error('Code 128: cannot encode an empty code');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 || code > 126) {
      throw new Error(
        `Code 128: only printable ASCII is supported, found ${JSON.stringify(text[i])} at position ${i}`,
      );
    }
  }

  const values = encodeValues(text);
  const start = values[0];
  const checksum =
    (start + values.slice(1).reduce((sum, value, index) => sum + value * (index + 1), 0)) % 103;

  const full = [...values, checksum, STOP];
  const modules: number[] = [];
  for (const value of full) {
    for (const bit of PATTERNS[value]) modules.push(bit === '1' ? 1 : 0);
  }

  return { values: full, checksum, modules, text };
}

/**
 * Render a symbol as a standalone SVG string, quiet zones included.
 *
 * `moduleWidth` is in the caller's units (px or mm); at 203 dpi a narrow module
 * of 0.25mm scans reliably on the 50x30mm stock the factory uses.
 */
export function code128Svg(
  symbol: Code128Symbol,
  opts: { moduleWidth: number; height: number; unit?: string },
): string {
  const unit = opts.unit ?? '';
  const quiet = CODE128_QUIET_ZONE_MODULES;
  const totalModules = symbol.modules.length + quiet * 2;
  const width = totalModules * opts.moduleWidth;

  const bars: string[] = [];
  let index = 0;
  while (index < symbol.modules.length) {
    if (symbol.modules[index] === 0) {
      index++;
      continue;
    }
    let run = 0;
    while (index + run < symbol.modules.length && symbol.modules[index + run] === 1) run++;
    const x = (quiet + index) * opts.moduleWidth;
    bars.push(
      `<rect x="${round(x)}" y="0" width="${round(run * opts.moduleWidth)}" height="${round(opts.height)}"/>`,
    );
    index += run;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}${unit}" height="${round(opts.height)}${unit}" ` +
    `viewBox="0 0 ${round(width)} ${round(opts.height)}" shape-rendering="crispEdges">` +
    `<rect x="0" y="0" width="${round(width)}" height="${round(opts.height)}" fill="#fff"/>` +
    `<g fill="#000">${bars.join('')}</g></svg>`
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
