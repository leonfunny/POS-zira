/**
 * Reads the customer's sheet straight off the clipboard.
 *
 * Eight colours by six sizes is 48 cells typed by hand, and one wrong cell
 * prints a wrong bundle. Excel puts the selected block on the clipboard as
 * tab-separated text, so the reader is split-lines-and-tabs: no dependency, no
 * file to save, and the operator picks exactly the block they mean.
 *
 * Reading .xlsx directly was the alternative. It needs a heavy dependency and
 * still needs a column-mapping screen, because every customer's sheet is laid
 * out differently -- merged cells, headings above the table, notes down the
 * side. Pasting makes the operator do the selecting, which they can see.
 */
import { OrderRow, OrderSize } from './label-print-order';

export type PasteProblem = 'NOT_A_GRID' | 'NO_SIZES' | 'NO_ROWS';

export interface PastedGrid {
  sizes: OrderSize[];
  rows: OrderRow[];
  /** Labels the pasted grid would print, for the preview line. */
  totalCopies: number;
  problems: PasteProblem[];
}

/** Header cells that name the sticker code column. */
const CODE_HEADERS = /^(kod|code|m[ãa]|m[ãa] tem|kod ean|ean|symbol|indeks)$/i;

/**
 * A quantity as Excel may hand it over: a decimal comma, a space or a
 * non-breaking space between thousands, a stray apostrophe. Anything that is
 * not a positive number is a zero -- an empty cell in the customer's grid means
 * "not this size", and so does a dash or an "x".
 */
export function parseQuantityCell(cell: string): number {
  // \s covers the non-breaking and thin spaces Excel puts between thousands.
  const cleaned = cell.replace(/[\s']/g, '').replace(',', '.');
  const value = Number(cleaned);
  // Written this way round so NaN -- a dash, an "x", a note in the cell -- is a
  // zero by the same test as a negative.
  if (!(value > 0)) return 0;
  return Math.floor(value);
}

function splitCells(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((cell) => cell.trim());
}

/**
 * @param text  what the operator pasted
 * @param makeId ids for the new columns and rows. Taken from the panel rather
 *   than made up here: fresh ids keep a pasted grid from colliding with the
 *   batch ids in a progress record left by the sheet it replaces.
 */
export function parsePastedGrid(text: string, makeId: (prefix: string) => string): PastedGrid {
  const empty: PastedGrid = { sizes: [], rows: [], totalCopies: 0, problems: ['NOT_A_GRID'] };

  const lines = (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) return empty;

  // Excel copies tab-separated. A comma is only read as a separator when there
  // is no tab anywhere, so "1,5" in a real Excel paste stays one cell.
  const delimiter = lines.some((line) => line.includes('\t')) ? '\t' : ',';
  if (!lines[0].includes(delimiter)) return empty;

  const header = splitCells(lines[0], delimiter);

  let codeColumn = -1;
  const sizes: OrderSize[] = [];
  const sizeColumns: number[] = [];
  const labelColumns: number[] = [];

  header.forEach((cell, index) => {
    if (!cell) {
      // The corner cell above the colour names is usually blank.
      labelColumns.push(index);
      return;
    }
    if (CODE_HEADERS.test(cell) && codeColumn === -1) {
      codeColumn = index;
      return;
    }
    // Every other heading is a size until proven otherwise. A heading over the
    // colour column ("KOLOR", "MÀU") is caught below, by the same rule that
    // catches a sheet with no heading there at all -- listing the words was a
    // second way of saying it, and a mutation run showed it changed nothing.
    sizes.push({ id: makeId('size'), label: cell.toUpperCase() });
    sizeColumns.push(index);
  });

  if (sizes.length === 0) return { sizes: [], rows: [], totalCopies: 0, problems: ['NO_SIZES'] };

  const body = lines.slice(1).map((line) => splitCells(line, delimiter));

  // No blank corner cell. Two sheets look like this:
  // one where the operator left the corner out of the selection, so the rows
  // are one cell wider than the header and the sizes simply sit one to the
  // right; and one where the header is genuinely all sizes, where the first of
  // them is standing over the colour names.
  if (labelColumns.length === 0) {
    const width = body.reduce((widest, cells) => Math.max(widest, cells.length), 0);
    const offset = Math.max(0, width - header.length);
    if (offset > 0) {
      for (let index = 0; index < offset; index += 1) labelColumns.push(index);
      for (let index = 0; index < sizeColumns.length; index += 1) sizeColumns[index] += offset;
      if (codeColumn >= 0) codeColumn += offset;
    } else {
      // Same width as the rows, so the first heading is standing over the
      // colour names -- whether it reads "KOLOR" or something else entirely.
      labelColumns.push(sizeColumns[0]);
      sizes.shift();
      sizeColumns.shift();
      if (sizes.length === 0) {
        return { sizes: [], rows: [], totalCopies: 0, problems: ['NO_SIZES'] };
      }
    }
  }

  const rows: OrderRow[] = [];
  let totalCopies = 0;

  for (const cells of body) {
    const colorName = labelColumns.map((index) => cells[index] ?? '').find(Boolean) ?? '';
    if (!colorName) continue;

    const quantities: Record<string, number> = {};
    sizes.forEach((size, position) => {
      const value = parseQuantityCell(cells[sizeColumns[position]] ?? '');
      if (value > 0) {
        quantities[size.id] = value;
        totalCopies += value;
      }
    });

    rows.push({
      id: makeId('row'),
      colorName: colorName.toUpperCase(),
      code: (codeColumn === -1 ? '' : cells[codeColumn] ?? '').toUpperCase(),
      quantities,
    });
  }

  if (rows.length === 0) return { sizes, rows: [], totalCopies: 0, problems: ['NO_ROWS'] };
  return { sizes, rows, totalCopies, problems: [] };
}
