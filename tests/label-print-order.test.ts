import { describe, it, expect } from 'vitest';
import {
  FABRIC_MATERIALS,
  LABEL_PRINT_ORDER_LIMITS,
  LabelPrintOrder,
  buildPrintPlan,
  buildSamplePlan,
  compositionText,
  parseCompositionText,
  createEmptyOrder,
  orderTotals,
  percentFix,
  materialPercentSum,
  validateOrder,
  orderWarnings,
  randomStickerCode,
  fallbackStickerCode,
  todayIsoDate,
  stickerGarmentType,
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
import { encodeCode128 } from '../src/shared/code128';

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
      // 100 garments packed in 24 bags; 20 garments in 5.
      { id: 'r1', colorName: 'CZEKOLADA', code: 'SP006290', quantities: { s: 40, m: 60 }, stickerQuantity: 24 },
      { id: 'r2', colorName: 'BORDO', code: 'SP006291', quantities: { s: 20, m: 0 }, stickerQuantity: 5 },
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

  it('reads its own line back into the parts that made it', () => {
    // Rows saved before the parts were stored beside the line carry only the
    // line; reopening the editor has to start from what the tag would print.
    expect(parseCompositionText('70% POLIESTER 30% AKRYL')).toEqual([
      { name: 'POLIESTER', percent: 70 },
      { name: 'AKRYL', percent: 30 },
    ]);
    expect(parseCompositionText('100% BAWEŁNA')).toEqual([{ name: 'BAWEŁNA', percent: 100 }]);
  });

  it('gives up on a line it cannot rebuild rather than shortening it', () => {
    // Wording someone typed by hand is the whole point of giving up here: the
    // caller keeps showing the stored line instead of a rewritten one.
    expect(parseCompositionText('70% BAWEŁNA + dodatki')).toEqual([]);
    expect(parseCompositionText('mieszanka bawełny')).toEqual([]);
    expect(parseCompositionText('')).toEqual([]);
    expect(parseCompositionText(null)).toEqual([]);
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
    order.rows = order.rows.map((row) => ({ ...row, quantities: {}, stickerQuantity: undefined }));
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

  it('does not require a bag code: a blank one is filled at print time', () => {
    const order = sampleOrder();
    order.rows[1].code = '';
    expect(validateOrder(order)).toEqual([]);
  });

  it('reports a bag code Code 128 cannot carry', () => {
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

  it('sends one sticker run per colour, as many as the packer typed', () => {
    const stickers = buildPrintPlan(sampleOrder()).filter((s) => s.kind === 'sticker');
    expect(stickers).toHaveLength(2);
    expect(stickers[0]).toMatchObject({ colorName: 'CZEKOLADA', code: 'SP006290', quantity: 24 });
    expect(stickers[1]).toMatchObject({ colorName: 'BORDO', code: 'SP006291', quantity: 5 });
    expect(stickers[0].sizeText).toBeUndefined();
  });

  it('never splits stickers by size — one sticker covers the whole colour', () => {
    // The sticker goes on the bag and the bag holds mixed sizes, so a size on
    // it would be wrong for most of what is inside.
    const stickers = buildPrintPlan(sampleOrder()).filter((s) => s.kind === 'sticker');
    expect(stickers).toHaveLength(2); // one per colour, not per colour+size
    expect(stickers.every((s) => !('sizeText' in s))).toBe(true);
    // 24 bags, whatever 40 S + 60 M add up to.
    expect(stickers[0]).toMatchObject({ quantity: 24 });
  });

  it('prints no sticker for a colour whose bag count is empty, and every garment tag', () => {
    const order = sampleOrder();
    order.rows[1].stickerQuantity = undefined;
    const plan = buildPrintPlan(order);
    expect(plan.filter((s) => s.kind === 'sticker').map((s) => s.rowId)).toEqual(['r1']);
    expect(plan.filter((s) => s.kind === 'fabric' && s.rowId === 'r2')).toHaveLength(1);
  });

  it('prints stickers alone for a sheet with bag counts and no garment quantities', () => {
    const order = { ...sampleOrder(), printFabricTags: false };
    order.rows[0].quantities = {};
    order.rows[1].quantities = {};
    expect(validateOrder(order)).toEqual([]);
    expect(buildPrintPlan(order).map((s) => s.quantity)).toEqual([24, 5]);
  });

  it('prints a colour with no bag code under a code made from style and colour', () => {
    const order = sampleOrder();
    order.rows[1].code = '   ';
    const plan = buildPrintPlan(order);
    const stickers = plan.filter((s) => s.kind === 'sticker');
    expect(stickers).toHaveLength(2);
    expect(stickers[1]).toMatchObject({
      colorName: 'BORDO',
      code: fallbackStickerCode(order.styleCode, 'BORDO'),
      quantity: 5,
    });
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
    order.rows[0].stickerQuantity = 360;
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

describe('one of each, to look at before the ribbon is committed', () => {
  it('sends exactly one label of each kind', () => {
    const sample = buildSamplePlan(sampleOrder());
    expect(sample.map((s) => s.kind)).toEqual(['sticker', 'fabric']);
    expect(sample.every((s) => s.quantity === 1)).toBe(true);
  });

  it('carries the wording the real run would print', () => {
    const fabric = buildSamplePlan(sampleOrder()).find((s) => s.kind === 'fabric');
    const real = buildPrintPlan(sampleOrder()).find((s) => s.kind === 'fabric');
    expect(fabric).toMatchObject({
      sizeText: (real as any).sizeText,
      composition: (real as any).composition,
      careText: (real as any).careText,
      careSymbols: (real as any).careSymbols,
    });
  });

  it('works before any quantity is typed — a tag reads the same either way', () => {
    const order = sampleOrder();
    order.rows = order.rows.map((row) => ({ ...row, quantities: {}, stickerQuantity: undefined }));
    expect(buildPrintPlan(order)).toHaveLength(0);
    expect(buildSamplePlan(order)).toHaveLength(2);
  });

  it('respects what the operator ticked to print', () => {
    expect(buildSamplePlan({ ...sampleOrder(), printStickers: false }).map((s) => s.kind))
      .toEqual(['fabric']);
    expect(buildSamplePlan({ ...sampleOrder(), printFabricTags: false }).map((s) => s.kind))
      .toEqual(['sticker']);
  });

  it('takes the sticker from the first colour even when its code is empty', () => {
    const order = sampleOrder();
    order.rows[0].code = '   ';
    const sticker = buildSamplePlan(order).find((s) => s.kind === 'sticker');
    expect(sticker).toMatchObject({
      colorName: order.rows[0].colorName,
      code: fallbackStickerCode(order.styleCode, order.rows[0].colorName),
    });
  });

  describe('fallbackStickerCode', () => {
    it('has the shape of a typed code and Code 128 can carry it', () => {
      const code = fallbackStickerCode('114', 'CZARNY');
      expect(code).toMatch(/^SP\d{6}$/);
      expect(() => encodeCode128(code)).not.toThrow();
    });

    it('is the same for the same style and colour however they are typed', () => {
      expect(fallbackStickerCode('114', 'czarny ')).toBe(fallbackStickerCode(' 114', 'CZARNY'));
    });

    it('differs between colours of one style, and between styles of one colour', () => {
      expect(fallbackStickerCode('114', 'CZARNY')).not.toBe(fallbackStickerCode('114', 'BORDO'));
      expect(fallbackStickerCode('114', 'CZARNY')).not.toBe(fallbackStickerCode('115', 'CZARNY'));
    });
  });

  it('has nothing to show for an order with no colours or no sizes', () => {
    expect(buildSamplePlan({ ...createEmptyOrder() })).toHaveLength(0);
    expect(buildSamplePlan({ ...sampleOrder(), sizes: [] })).toHaveLength(0);
  });

  it('marks its ids apart so a sample is never mistaken for a sent batch', () => {
    const sampleIds = buildSamplePlan(sampleOrder()).map((s) => s.id);
    const realIds = buildPrintPlan(sampleOrder()).map((s) => s.id);
    expect(sampleIds.every((id) => id.startsWith('sample:'))).toBe(true);
    expect(sampleIds.some((id) => realIds.includes(id))).toBe(false);
  });
});

describe('the composition has to add up before anything prints', () => {
  it('passes at 100, and at a three-way split', () => {
    expect(validateOrder(sampleOrder())).not.toContain('PERCENT_NOT_100');
    expect(
      validateOrder({
        ...sampleOrder(),
        materials: [
          { name: 'BAWEŁNA', percent: 33 },
          { name: 'LEN', percent: 33 },
          { name: 'WISKOZA', percent: 34 },
        ],
      }),
    ).not.toContain('PERCENT_NOT_100');
  });

  it('blocks at 70, which used to be only a warning', () => {
    const order = { ...sampleOrder(), materials: [{ name: 'LEN', percent: 70 }] };
    expect(validateOrder(order)).toContain('PERCENT_NOT_100');
  });

  it('blocks a material ticked but never typed', () => {
    const order = { ...sampleOrder(), materials: [{ name: 'LEN', percent: 0 }] };
    expect(validateOrder(order)).toContain('PERCENT_NOT_100');
  });

  it('blocks over 100 as well as under', () => {
    const order = {
      ...sampleOrder(),
      materials: [{ name: 'LEN', percent: 80 }, { name: 'AKRYL', percent: 40 }],
    };
    expect(validateOrder(order)).toContain('PERCENT_NOT_100');
  });

  it('lets an order with no composition through — that tag is legal', () => {
    expect(validateOrder({ ...sampleOrder(), materials: [] })).not.toContain('PERCENT_NOT_100');
  });

  it('adds up what is there, ignoring junk in the percent field', () => {
    expect(materialPercentSum([
      { name: 'LEN', percent: 70 },
      { name: 'AKRYL', percent: Number.NaN },
    ])).toBe(70);
  });
});

describe('the one press that lands the composition on 100', () => {
  it('fills the material just ticked, not the one already typed', () => {
    const fix = percentFix([{ name: 'LEN', percent: 70 }, { name: 'AKRYL', percent: 0 }]);
    expect(fix).toMatchObject({ name: 'AKRYL', percent: 30 });
    expect(fix!.materials).toEqual([
      { name: 'LEN', percent: 70 },
      { name: 'AKRYL', percent: 30 },
    ]);
  });

  it('fills the empty one wherever it sits, not just the last row', () => {
    // BAWEŁNA was ticked first and left at 0; the press belongs to it.
    expect(percentFix([{ name: 'BAWEŁNA', percent: 0 }, { name: 'AKRYL', percent: 70 }]))
      .toMatchObject({ name: 'BAWEŁNA', percent: 30 });
  });

  it('tops up the only material there is', () => {
    expect(percentFix([{ name: 'LEN', percent: 70 }])).toMatchObject({ name: 'LEN', percent: 100 });
  });

  it('takes the surplus off the last material that has any', () => {
    expect(percentFix([{ name: 'LEN', percent: 80 }, { name: 'AKRYL', percent: 40 }]))
      .toMatchObject({ name: 'AKRYL', percent: 20 });
  });

  it('skips an empty material when taking a surplus back off', () => {
    expect(percentFix([
      { name: 'LEN', percent: 80 },
      { name: 'AKRYL', percent: 40 },
      { name: 'ELASTAN', percent: 0 },
    ])).toMatchObject({ name: 'AKRYL', percent: 20 });
  });

  it('offers nothing when one press would push a material below zero', () => {
    expect(percentFix([
      { name: 'LEN', percent: 90 },
      { name: 'AKRYL', percent: 30 },
      { name: 'ELASTAN', percent: 10 },
    ])).toBeNull();
  });

  it('offers nothing at exactly 100, and nothing with no materials', () => {
    expect(percentFix([{ name: 'LEN', percent: 100 }])).toBeNull();
    expect(percentFix([])).toBeNull();
  });

  it('leaves the order it was handed alone', () => {
    const materials = [{ name: 'LEN', percent: 70 }, { name: 'AKRYL', percent: 0 }];
    percentFix(materials);
    expect(materials[1].percent).toBe(0);
  });
});

describe('validateOrder — what the labels cannot go without', () => {
  it('refuses a sheet with no customer, which heads both labels', () => {
    const order = { ...sampleOrder(), customerName: '  ' };
    expect(validateOrder(order)).toContain('NO_CUSTOMER');
  });

  it('needs a style code for the bag sticker only', () => {
    const order = { ...sampleOrder(), styleCode: '' };
    expect(validateOrder(order)).toContain('NO_STYLE_CODE');
    expect(validateOrder({ ...order, printStickers: false })).not.toContain('NO_STYLE_CODE');
  });
});

describe('orderWarnings', () => {
  it('wants a bag count for every colour with garments while the sticker lane is on', () => {
    const order = sampleOrder();
    order.rows[1].stickerQuantity = undefined;
    expect(validateOrder(order)).toContain('NO_STICKER_QTY');
    expect(validateOrder({ ...order, printStickers: false })).not.toContain('NO_STICKER_QTY');
    // A colour with no garments at all is not asked for bags.
    order.rows[1].quantities = {};
    expect(validateOrder(order)).not.toContain('NO_STICKER_QTY');
  });

  it('counts bags and garments apart', () => {
    const totals = orderTotals(sampleOrder());
    expect(totals.grandTotal).toBe(120);
    expect(totals.stickerTotal).toBe(29);
  });

  it('points out a fabric tag with no composition', () => {
    const order = { ...sampleOrder(), materials: [] };
    expect(orderWarnings(order)).toEqual(['NO_COMPOSITION']);
    expect(validateOrder(order)).toEqual([]);
  });

  it('says nothing when the fabric lane is off or a material is named', () => {
    expect(orderWarnings({ ...sampleOrder(), materials: [], printFabricTags: false })).toEqual([]);
    expect(orderWarnings(sampleOrder())).toEqual([]);
  });
});

describe('randomStickerCode', () => {
  it('is the prefix the sheets used plus six digits, zero-padded', () => {
    expect(randomStickerCode(() => 0)).toBe('SP000000');
    expect(randomStickerCode(() => 0.999999)).toBe('SP999999');
    expect(randomStickerCode()).toMatch(/^SP\d{6}$/);
  });

  it('is something Code 128 can carry, should the barcode come back', () => {
    expect(() => encodeCode128(randomStickerCode())).not.toThrow();
  });
});

describe('todayIsoDate', () => {
  it('writes the local day the way the date input wants it', () => {
    expect(todayIsoDate(new Date(2026, 8, 4, 23, 30))).toBe('2026-09-04');
    expect(todayIsoDate(new Date(2026, 0, 9))).toBe('2026-01-09');
  });

  it('is what a fresh sheet is dated', () => {
    expect(createEmptyOrder().orderDate).toBe(todayIsoDate());
  });
});

describe('stickerGarmentType', () => {
  it('is the category, in capitals, when there is one', () => {
    expect(stickerGarmentType('Komplety dresowe', 'Komplet czarny barbi 9949')).toBe('KOMPLETY DRESOWE');
  });

  it('is the style name when there is no category', () => {
    expect(stickerGarmentType(null, ' kurtka ')).toBe('KURTKA');
    expect(stickerGarmentType('  ', 'kurtka')).toBe('KURTKA');
  });

  it('cuts the fallback to what the sticker holds, so the printer never refuses it', () => {
    const long = 'Komplet czarny barbi zaira phối ren czarny aone jf 9949 art:6591#14';
    expect(stickerGarmentType(null, long)).toHaveLength(LABEL_PRINT_ORDER_LIMITS.textChars);
  });
});
