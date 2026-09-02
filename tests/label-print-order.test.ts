import { describe, it, expect } from 'vitest';
import {
  FABRIC_MATERIALS,
  LABEL_PRINT_ORDER_LIMITS,
  LabelPrintOrder,
  buildPrintPlan,
  compositionText,
  createEmptyOrder,
  orderTotals,
  validateOrder,
  CARE_TEXT_MAX_CHARS,
  CARE_TEXT_PRESETS,
  addCareTextLine,
  careTextHasPreset,
  careTextLines,
  careTextLinesFit,
  careTextPresetFits,
  removeCareTextLine,
  toggleCareTextPreset,
  upperCaseOrder,
} from '../src/shared/label-print-order';

/**
 * Modelled on the A4 order sheet the factory works from: one customer, one
 * style, size columns across the top, colour rows down the side, a quantity in
 * every cell.
 */
function sampleOrder(): LabelPrintOrder {
  return {
    ...createEmptyOrder(),
    customerName: 'MoonCollection',
    styleName: 'KURTKA',
    styleCode: '114',
    materials: [
      { name: 'POLIESTER', percent: 70 },
      { name: 'AKRYL', percent: 30 },
    ],
    careSymbols: ['WASH_30', 'IRON_LOW'],
    careText: '',
    sizes: [
      { id: 's', label: 'S' },
      { id: 'm', label: 'M' },
    ],
    rows: [
      { id: 'r1', colorName: 'CZEKOLADA', code: 'SP006290', quantities: { s: 40, m: 60 } },
      { id: 'r2', colorName: 'BORDO', code: 'SP006291', quantities: { s: 20, m: 0 } },
    ],
    printFabricTags: true,
    printStickers: true,
  };
}

describe('compositionText', () => {
  it('joins materials the way the tag prints them', () => {
    expect(compositionText(sampleOrder().materials)).toBe('70% POLIESTER 30% AKRYL');
  });

  it('drops materials with no percentage so a half-filled row prints nothing odd', () => {
    expect(compositionText([{ name: 'LEN', percent: 70 }, { name: 'WISKOZA', percent: 0 }])).toBe(
      '70% LEN',
    );
  });

  it('is empty when nothing is entered', () => {
    expect(compositionText([])).toBe('');
  });

  it('offers the materials the factory actually uses, in Polish', () => {
    expect(FABRIC_MATERIALS).toContain('POLIESTER');
    expect(FABRIC_MATERIALS).toContain('BAWEŁNA');
    expect(FABRIC_MATERIALS).toContain('WISKOZA');
    expect(FABRIC_MATERIALS).toContain('ELASTAN');
  });
});

describe('orderTotals', () => {
  it('totals each row, each size column and the whole order', () => {
    const totals = orderTotals(sampleOrder());
    expect(totals.rowTotals).toEqual({ r1: 100, r2: 20 });
    expect(totals.sizeTotals).toEqual({ s: 60, m: 60 });
    expect(totals.grandTotal).toBe(120);
  });

  it('counts a negative cell as zero instead of subtracting from the totals', () => {
    const order = sampleOrder();
    order.rows[0].quantities.s = -30;
    const totals = orderTotals(order);
    expect(totals.rowTotals.r1).toBe(60);
    expect(totals.sizeTotals.s).toBe(20);
    expect(totals.grandTotal).toBe(80);
  });

  it('ignores quantities for sizes that were removed from the grid', () => {
    const order = sampleOrder();
    order.sizes = [{ id: 's', label: 'S' }];
    const totals = orderTotals(order);
    expect(totals.rowTotals.r1).toBe(40);
    expect(totals.grandTotal).toBe(60);
  });
});

describe('validateOrder', () => {
  it('accepts the sample order', () => {
    expect(validateOrder(sampleOrder())).toEqual([]);
  });

  it('reports an order with nothing to print', () => {
    const order = sampleOrder();
    order.rows = order.rows.map((row) => ({ ...row, quantities: {} }));
    expect(validateOrder(order)).toContain('EMPTY_ORDER');
  });

  it('reports both output kinds switched off', () => {
    const order = { ...sampleOrder(), printFabricTags: false, printStickers: false };
    expect(validateOrder(order)).toContain('NOTHING_SELECTED');
  });

  it('reports duplicate size labels, which would merge two columns', () => {
    const order = sampleOrder();
    order.sizes = [
      { id: 'a', label: 'M' },
      { id: 'b', label: 'M' },
    ];
    expect(validateOrder(order)).toContain('DUPLICATE_SIZE');
  });

  it('reports a size column with no label', () => {
    const order = sampleOrder();
    order.sizes = [{ id: 'a', label: '  ' }];
    expect(validateOrder(order)).toContain('EMPTY_SIZE');
  });

  it('reports a fabric tag with neither size nor composition to print', () => {
    const order = sampleOrder();
    order.materials = [];
    order.sizes = [{ id: 'a', label: '' }];
    expect(validateOrder(order)).toContain('EMPTY_SIZE');
  });

  it('does not treat a missing sticker code as fatal — that row is skipped', () => {
    const order = sampleOrder();
    order.rows[1].code = '';
    expect(validateOrder(order)).toEqual([]);
  });

  it('reports a sticker code the symbology cannot carry', () => {
    const order = sampleOrder();
    order.rows[0].code = 'CZEKOLADĄ';
    expect(validateOrder(order)).toContain('BAD_CODE');
  });

  it('reports a run larger than the documented cap', () => {
    const order = sampleOrder();
    order.rows[0].quantities.s = LABEL_PRINT_ORDER_LIMITS.maxOrderQuantity;
    expect(validateOrder(order)).toContain('ORDER_TOO_LARGE');
  });
});

describe('buildPrintPlan', () => {
  it('prints stickers first, then fabric tags', () => {
    const plan = buildPrintPlan(sampleOrder());
    const kinds = plan.map((step) => step.kind);
    expect(kinds.indexOf('sticker')).toBeLessThan(kinds.indexOf('fabric'));
  });

  it('sends one sticker run per colour, counted over every size', () => {
    const stickers = buildPrintPlan(sampleOrder()).filter((s) => s.kind === 'sticker');
    expect(stickers).toHaveLength(2);
    expect(stickers[0]).toMatchObject({ colorName: 'CZEKOLADA', code: 'SP006290', quantity: 100 });
    expect(stickers[1]).toMatchObject({ colorName: 'BORDO', code: 'SP006291', quantity: 20 });
    expect(stickers[0].sizeText).toBeUndefined();
  });

  it('never splits stickers by size — one sticker covers the whole colour', () => {
    // The sticker goes on the bag and the bag holds mixed sizes, so a size on
    // it would be wrong for most of what is inside.
    const stickers = buildPrintPlan(sampleOrder()).filter((s) => s.kind === 'sticker');
    expect(stickers).toHaveLength(2); // one per colour, not per colour+size
    expect(stickers.every((s) => !('sizeText' in s))).toBe(true);
    expect(stickers[0]).toMatchObject({ quantity: 100 }); // 40 S + 60 M
  });

  it('skips a colour with no code instead of blocking the whole order', () => {
    const order = sampleOrder();
    order.rows[1].code = '   ';
    const plan = buildPrintPlan(order);
    const stickers = plan.filter((s) => s.kind === 'sticker');
    expect(stickers).toHaveLength(1);
    // The fabric tags for that colour are still printed.
    expect(plan.filter((s) => s.kind === 'fabric' && s.rowId === 'r2')).toHaveLength(1);
  });

  it('keeps fabric runs per colour and size, splitting a cell over the chunk size', () => {
    const fabric = buildPrintPlan(sampleOrder()).filter((s) => s.kind === 'fabric');
    // r1/S=40 -> one run; r1/M=60 -> 50+10; r2/S=20 -> one run; r2/M=0 -> none.
    expect(fabric).toHaveLength(4);
    expect(fabric[0]).toMatchObject({ rowId: 'r1', sizeText: 'S', quantity: 40 });
    expect(fabric[1]).toMatchObject({ rowId: 'r1', sizeText: 'M', quantity: 50 });
    expect(fabric[2]).toMatchObject({ rowId: 'r1', sizeText: 'M', quantity: 10 });
    expect(fabric[3]).toMatchObject({ rowId: 'r2', sizeText: 'S', quantity: 20 });
  });

  it('never chunks stickers — the paper printer runs unattended', () => {
    const order = sampleOrder();
    order.rows[0].quantities.s = 300;
    const stickers = buildPrintPlan(order).filter((s) => s.kind === 'sticker');
    expect(stickers[0].quantity).toBe(360);
  });

  it('carries the composition and care symbols onto every fabric run', () => {
    const fabric = buildPrintPlan(sampleOrder()).filter((s) => s.kind === 'fabric');
    for (const step of fabric) {
      expect(step.composition).toBe('70% POLIESTER 30% AKRYL');
      expect(step.careSymbols).toEqual(['WASH_30', 'IRON_LOW']);
    }
  });

  it('omits a kind entirely when its checkbox is off', () => {
    const noStickers = buildPrintPlan({ ...sampleOrder(), printStickers: false });
    expect(noStickers.every((s) => s.kind === 'fabric')).toBe(true);

    const noFabric = buildPrintPlan({ ...sampleOrder(), printFabricTags: false });
    expect(noFabric.every((s) => s.kind === 'sticker')).toBe(true);
  });

  it('splits any run over the chunk size so the operator can tear between bundles', () => {
    const order = sampleOrder();
    order.rows[0].quantities.s = 120;
    const runs = buildPrintPlan(order).filter((s) => s.kind === 'fabric' && s.sizeText === 'S');
    expect(runs.map((r) => r.quantity)).toEqual([50, 50, 20, 20]);
  });

  it('drops zero and negative cells rather than sending an empty job', () => {
    const order = sampleOrder();
    order.rows[0].quantities.s = 0;
    order.rows[0].quantities.m = -5;
    const fabric = buildPrintPlan(order).filter((s) => s.kind === 'fabric' && s.rowId === 'r1');
    expect(fabric).toHaveLength(0);
  });

  it('gives every step a stable id so a resumed order knows what already printed', () => {
    const ids = buildPrintPlan(sampleOrder()).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(buildPrintPlan(sampleOrder()).map((s) => s.id)).toEqual(ids);
  });
});

describe('the extra line offers the lines this shop keeps writing', () => {
  it('adds a preset to an empty field', () => {
    expect(toggleCareTextPreset('', 'NATURALNY LEN')).toBe('NATURALNY LEN');
  });

  it('puts a second one on its own line, not on the end of the first', () => {
    // Joined onto one line, a hand-typed note ran on from the last preset and
    // printed as part of that sentence.
    expect(toggleCareTextPreset('NATURALNY LEN', 'MADE IN POLAND'))
      .toBe('NATURALNY LEN\nMADE IN POLAND');
  });

  it('removes a preset that is already chosen, from either end', () => {
    expect(toggleCareTextPreset('NATURALNY LEN\nMADE IN POLAND', 'NATURALNY LEN'))
      .toBe('MADE IN POLAND');
    expect(toggleCareTextPreset('NATURALNY LEN\nMADE IN POLAND', 'MADE IN POLAND'))
      .toBe('NATURALNY LEN');
  });

  it('leaves text typed by hand alone, on its own line', () => {
    expect(toggleCareTextPreset('SZYTE W KRAKOWIE', 'NATURALNY LEN'))
      .toBe('SZYTE W KRAKOWIE\nNATURALNY LEN');
  });

  it('reads an order saved before the split as separate lines', () => {
    expect(careTextLines('NATURALNY LEN · MADE IN POLAND'))
      .toEqual(['NATURALNY LEN', 'MADE IN POLAND']);
    expect(careTextHasPreset('NATURALNY LEN · MADE IN POLAND', 'MADE IN POLAND')).toBe(true);
  });

  it('refuses wording the printer would reject, rather than losing the run', () => {
    // The fabric lane caps this field; an over-length block is thrown out at
    // the print boundary, mid-order.
    const long = CARE_TEXT_PRESETS.filter((p) => p.length > 20);
    const packed = long.reduce<string>((acc, p) => toggleCareTextPreset(acc, p), '');
    expect(packed.length).toBeLessThanOrEqual(CARE_TEXT_MAX_CHARS);
    expect(careTextPresetFits(packed, 'NATURALNY LEN')).toBe(false);
    expect(toggleCareTextPreset(packed, 'NATURALNY LEN')).toBe(packed);
  });

  it('counts the cap across every line, not per line', () => {
    // The ribbon has one height budget; four short lines and one long one cost
    // the tag the same.
    const long = 'X'.repeat(CARE_TEXT_MAX_CHARS - 2);
    expect(careTextLinesFit([long])).toBe(true);
    expect(careTextLinesFit([long, 'YY'])).toBe(false);
    expect(addCareTextLine(long, 'YY')).toBe(long);
  });

  it('refuses a fifth line even when the characters would fit', () => {
    const four = ['A', 'B', 'C', 'D'].join('\n');
    expect(careTextLinesFit(['A', 'B', 'C', 'D'])).toBe(true);
    expect(careTextLinesFit(['A', 'B', 'C', 'D', 'E'])).toBe(false);
    expect(addCareTextLine(four, 'E')).toBe(four);
  });

  it('adds and removes a hand-typed line by position', () => {
    const one = addCareTextLine('', 'SZYTE W KRAKOWIE');
    const two = addCareTextLine(one, 'NATURALNY LEN');
    expect(careTextLines(two)).toEqual(['SZYTE W KRAKOWIE', 'NATURALNY LEN']);
    // The same line twice would print twice; it is refused.
    expect(addCareTextLine(two, 'NATURALNY LEN')).toBe(two);
    expect(addCareTextLine(two, '   ')).toBe(two);
    expect(careTextLines(removeCareTextLine(two, 0))).toEqual(['NATURALNY LEN']);
  });

  it('always lets a chosen preset be switched off, however full the line is', () => {
    const packed = CARE_TEXT_PRESETS.reduce<string>((acc, p) => toggleCareTextPreset(acc, p), '');
    for (const preset of CARE_TEXT_PRESETS) {
      if (careTextHasPreset(packed, preset)) {
        expect(careTextPresetFits(packed, preset), preset).toBe(true);
      }
    }
  });

  it('reports which presets are on the tag', () => {
    expect(careTextHasPreset('NATURALNY LEN\nMADE IN POLAND', 'MADE IN POLAND')).toBe(true);
    expect(careTextHasPreset('NATURALNY LEN', 'MADE IN POLAND')).toBe(false);
    // A preset that is only part of a longer hand-typed line is not "chosen".
    expect(careTextHasPreset('MADE IN POLAND BY US', 'MADE IN POLAND')).toBe(false);
  });
});

describe('everything typed into a print order is printed in capitals', () => {
  it('lifts every text field, including ones typed in mixed case', () => {
    const order = upperCaseOrder({
      ...createEmptyOrder(),
      customerName: 'MoonCollection',
      styleName: 'Kurtka',
      styleCode: 'sp006290',
      careText: 'szyte w krakowie\nnaturalny len',
      materials: [{ name: 'poliester', percent: 70 }],
      sizes: [{ id: 's1', label: 'xl' }],
      rows: [{ id: 'r1', colorName: 'czekolada', code: 'sp006290', quantities: { s1: 4 } }],
    });

    expect(order.customerName).toBe('MOONCOLLECTION');
    expect(order.styleName).toBe('KURTKA');
    expect(order.styleCode).toBe('SP006290');
    expect(order.careText).toBe('SZYTE W KRAKOWIE\nNATURALNY LEN');
    expect(order.materials[0].name).toBe('POLIESTER');
    expect(order.sizes[0].label).toBe('XL');
    expect(order.rows[0]).toMatchObject({ colorName: 'CZEKOLADA', code: 'SP006290' });
  });

  it('lifts Polish letters the shop actually types', () => {
    const order = upperCaseOrder({
      ...createEmptyOrder(),
      careText: 'prać z podobnymi kolorami\nzalecany płyn do płukania dla miękkości',
    });
    expect(order.careText).toBe(
      'PRAĆ Z PODOBNYMI KOLORAMI\nZALECANY PŁYN DO PŁUKANIA DLA MIĘKKOŚCI',
    );
  });

  it('changes nothing else about the order', () => {
    const before = {
      ...createEmptyOrder(),
      customerName: 'MOON',
      rows: [{ id: 'r1', colorName: 'CZEKOLADA', code: '', quantities: { s1: 4 } }],
      sizes: [{ id: 's1', label: 'S' }],
      printStickers: false,
    };
    expect(upperCaseOrder(before)).toEqual(before);
  });
});
