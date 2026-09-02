import { describe, it, expect } from 'vitest';
import { parsePastedGrid, parseQuantityCell } from '../src/shared/order-paste';

let counter = 0;
const makeId = (prefix: string) => `${prefix}-${(counter += 1)}`;

function grid(text: string) {
  counter = 0;
  return parsePastedGrid(text, makeId);
}

/** How the sheet reads once it is on the panel: colour, code, then quantities. */
function readable(text: string) {
  const parsed = grid(text);
  return parsed.rows.map((row) => ({
    colorName: row.colorName,
    code: row.code,
    quantities: parsed.sizes.map((size) => row.quantities[size.id] ?? 0),
  }));
}

describe('reading the customer sheet off the clipboard', () => {
  it('reads the block Excel puts on the clipboard', () => {
    const parsed = grid('\tS\tM\nCZEKOLADA\t40\t60\nBORDO\t20\t0');

    expect(parsed.problems).toEqual([]);
    expect(parsed.sizes.map((size) => size.label)).toEqual(['S', 'M']);
    expect(readable('\tS\tM\nCZEKOLADA\t40\t60\nBORDO\t20\t0')).toEqual([
      { colorName: 'CZEKOLADA', code: '', quantities: [40, 60] },
      { colorName: 'BORDO', code: '', quantities: [20, 0] },
    ]);
    expect(parsed.totalCopies).toBe(120);
  });

  it('reads a header that names the colour column', () => {
    expect(readable('KOLOR\tS\tM\nCZEKOLADA\t40\t60')).toEqual([
      { colorName: 'CZEKOLADA', code: '', quantities: [40, 60] },
    ]);
  });

  it('takes the sticker code from a column that says so', () => {
    expect(readable('KOLOR\tKOD\tS\tM\nCZEKOLADA\tsp006290\t40\t60')).toEqual([
      { colorName: 'CZEKOLADA', code: 'SP006290', quantities: [40, 60] },
    ]);
  });

  it('leaves the code blank when the sheet has none, and still prints the tags', () => {
    const parsed = grid('\tS\nCZEKOLADA\t40');
    expect(parsed.rows[0].code).toBe('');
    expect(parsed.problems).toEqual([]);
  });

  it('reads a header selected without its corner cell', () => {
    // The rows are one cell wider than the header, so the sizes sit one to the
    // right and the first column is the colours.
    expect(readable('S\tM\nCZEKOLADA\t40\t60')).toEqual([
      { colorName: 'CZEKOLADA', code: '', quantities: [40, 60] },
    ]);
  });

  it('reads a header that is all sizes, standing over the colour names', () => {
    // Same width as the rows: the first heading is over the colour column.
    expect(readable('S\tM\nCZEKOLADA\t60')).toEqual([
      { colorName: 'CZEKOLADA', code: '', quantities: [60] },
    ]);
  });

  it('puts everything in capitals, like everything else typed on this tab', () => {
    expect(readable('\ts\nczekolada\t40')).toEqual([
      { colorName: 'CZEKOLADA', code: '', quantities: [40] },
    ]);
    expect(grid('\ts\nczekolada\t40').sizes[0].label).toBe('S');
  });

  it('treats an empty cell, a dash and an x as "not this size"', () => {
    expect(readable('\tS\tM\tL\nCZEKOLADA\t40\t\t-\nBORDO\tx\t10\t')).toEqual([
      { colorName: 'CZEKOLADA', code: '', quantities: [40, 0, 0] },
      { colorName: 'BORDO', code: '', quantities: [0, 10, 0] },
    ]);
  });

  it('reads numbers the way a Polish Excel writes them', () => {
    // A decimal comma inside a tab-separated cell, and a space between
    // thousands. Half a label is not a thing, so the fraction is dropped.
    expect(readable('\tS\tM\nCZEKOLADA\t1,5\t1 200')).toEqual([
      { colorName: 'CZEKOLADA', code: '', quantities: [1, 1200] },
    ]);
  });

  it('reads a comma-separated sheet when there is not a tab in sight', () => {
    expect(readable(',S,M\nCZEKOLADA,40,60')).toEqual([
      { colorName: 'CZEKOLADA', code: '', quantities: [40, 60] },
    ]);
  });

  it('ignores blank lines above and below the block', () => {
    const parsed = grid('\n\n\tS\tM\nCZEKOLADA\t40\t60\n\n');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.problems).toEqual([]);
  });

  it('skips a line that has numbers but no colour', () => {
    const parsed = grid('\tS\nCZEKOLADA\t40\n\t99');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.totalCopies).toBe(40);
  });

  it('says what is wrong instead of handing back an empty grid', () => {
    expect(grid('').problems).toEqual(['NOT_A_GRID']);
    expect(grid('CZEKOLADA').problems).toEqual(['NOT_A_GRID']);
    // One line of headings and nothing under it is not a table either.
    expect(grid('S\tM').problems).toEqual(['NOT_A_GRID']);
    // Two lines of prose: no separator anywhere, so this is not a table.
    expect(grid('proszę wydrukować\nmetki na jutro').problems).toEqual(['NOT_A_GRID']);
  });

  it('says when the header carries no sizes', () => {
    expect(grid('KOLOR\tKOD\nCZEKOLADA\tSP006290').problems).toEqual(['NO_SIZES']);
  });

  it('says when the header is all there is', () => {
    expect(grid('\tS\tM\n\t40\t60').problems).toEqual(['NO_ROWS']);
  });

  it('hands out fresh ids, so a pasted sheet cannot inherit an old run', () => {
    const parsed = grid('\tS\tM\nCZEKOLADA\t40\t60');
    const ids = [...parsed.sizes.map((s) => s.id), ...parsed.rows.map((r) => r.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /-(\d+)$/.test(id))).toBe(true);
  });

  it('keeps the quantities lined up with the sizes when a code column sits between', () => {
    expect(readable('KOLOR\tKOD\tS\tM\nCZEKOLADA\tSP1\t40\t60\nBORDO\tSP2\t0\t20')).toEqual([
      { colorName: 'CZEKOLADA', code: 'SP1', quantities: [40, 60] },
      { colorName: 'BORDO', code: 'SP2', quantities: [0, 20] },
    ]);
  });

  it('reads a sheet with the code column last', () => {
    expect(readable('KOLOR\tS\tM\tKOD\nCZEKOLADA\t40\t60\tSP1')).toEqual([
      { colorName: 'CZEKOLADA', code: 'SP1', quantities: [40, 60] },
    ]);
  });

  it('reads a single colour and a single size', () => {
    const parsed = grid('\tS\nCZEKOLADA\t40');
    expect(parsed.sizes).toHaveLength(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.totalCopies).toBe(40);
  });
});

describe('a cell read as a number of labels', () => {
  it('takes the number Excel wrote, however it wrote it', () => {
    expect(parseQuantityCell('40')).toBe(40);
    expect(parseQuantityCell(' 40 ')).toBe(40);
    expect(parseQuantityCell('1 200')).toBe(1200);
    expect(parseQuantityCell('1,5')).toBe(1);
  });

  it('reads anything that is not a positive number as none', () => {
    // Never NaN: a cell with a dash, an "x" or a note in it means "not this
    // size", and a NaN escaping here would travel into the grid as a quantity.
    expect(parseQuantityCell('')).toBe(0);
    expect(parseQuantityCell('-')).toBe(0);
    expect(parseQuantityCell('x')).toBe(0);
    expect(parseQuantityCell('brak')).toBe(0);
    expect(parseQuantityCell('0')).toBe(0);
    expect(parseQuantityCell('-5')).toBe(0);
  });
});
