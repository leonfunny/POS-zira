import { describe, expect, it } from 'vitest';
import { buildPrintPlan, createEmptyOrder } from '../src/shared/label-print-order';
import {
  SelectionInput,
  buildSelectionOrder,
  orderFromStyle,
  orderToFabricTagTemplate,
  selectionProblems,
  selectionColours,
  selectionQuantity,
  selectionTotals,
} from '../src/shared/product-print-selection';

const VARIANTS = [
  { id: 'v1', colorName: 'CZARNY', sizeName: 'S' },
  { id: 'v2', colorName: 'CZARNY', sizeName: 'M' },
  { id: 'v3', colorName: 'BEŻOWY', sizeName: 'S' },
];

function selection(overrides: Partial<SelectionInput> = {}): SelectionInput {
  return {
    styleName: 'KOMPLET DRESOWY',
    styleCode: '115',
    customerName: 'MoonCollection',
    careSymbols: ['wash-30'] as never,
    careText: 'PRAĆ NA LEWEJ STRONIE',
    composition: '70% BAWEŁNA 30% POLIESTER',
    variants: VARIANTS,
    quantities: {},
    stickerQuantities: { CZARNY: 1, 'BEŻOWY': 1 },
    printStickers: true,
    printFabricTags: true,
    ...overrides,
  };
}

describe('selectionQuantity', () => {
  it('keeps whole labels only', () => {
    expect(selectionQuantity('3')).toBe(3);
    expect(selectionQuantity('2.7')).toBe(2);
    expect(selectionQuantity('')).toBe(0);
    expect(selectionQuantity('abc')).toBe(0);
    expect(selectionQuantity(-4)).toBe(0);
  });

  it('caps a stray keystroke at one run', () => {
    expect(selectionQuantity(999)).toBe(999);
    expect(selectionQuantity(100000)).toBe(999);
  });
});

describe('buildSelectionOrder', () => {
  it('carries only the cells that were given a quantity', () => {
    const order = buildSelectionOrder(
      selection({ quantities: { v1: 4, v3: 2 } }),
    );

    expect(order.rows.map((row) => row.colorName)).toEqual(['CZARNY', 'BEŻOWY']);
    expect(order.sizes.map((size) => size.label)).toEqual(['S']);
    // The sheet counts garments per size across colours: 4 + 2.
    expect(order.sizes[0].quantity).toBe(6);
    expect(order.rows.every((row) => Object.keys(row.quantities).length === 0)).toBe(true);
  });

  it('prints nothing for a style where every box is empty', () => {
    const order = buildSelectionOrder(selection());
    expect(order.rows).toEqual([]);
    expect(buildPrintPlan(order)).toEqual([]);
  });

  it('gives a one-size style a column so its tag still prints', () => {
    const order = buildSelectionOrder(
      selection({
        variants: [{ id: 'v1', colorName: 'CZARNY', sizeName: null }],
        quantities: { v1: 2 },
      }),
    );

    expect(order.sizes).toHaveLength(1);
    expect(order.sizes[0].label).toBe('');
    const plan = buildPrintPlan(order, { composition: 'X' });
    expect(plan.filter((step) => step.kind === 'fabric')).toHaveLength(1);
  });

  it('adds up two catalogue rows that carry the same colour and size', () => {
    const order = buildSelectionOrder(
      selection({
        variants: [
          { id: 'v1', colorName: 'CZARNY', sizeName: 'S' },
          { id: 'dup', colorName: 'CZARNY', sizeName: 'S' },
        ],
        quantities: { v1: 3, dup: 2 },
      }),
    );

    expect(order.rows).toHaveLength(1);
    expect(order.sizes[0].quantity).toBe(5);
  });

  it('feeds the sheet lanes so a reprint prints what the order printed', () => {
    const order = buildSelectionOrder(
      selection({ quantities: { v1: 2, v2: 1 } }),
    );
    const plan = buildPrintPlan(order, { composition: '70% BAWEŁNA' });

    const stickers = plan.filter((step) => step.kind === 'sticker');
    const fabric = plan.filter((step) => step.kind === 'fabric');
    // As many bag labels as typed for the colour, one tag per garment.
    expect(stickers).toHaveLength(1);
    expect(stickers[0]).toMatchObject({ colorName: 'CZARNY', quantity: 1 });
    expect(fabric.map((step) => step.quantity)).toEqual([2, 1]);
    expect(fabric.every((step) => step.composition === '70% BAWEŁNA')).toBe(true);
  });

  it('keeps the saved composition line instead of rebuilding it from percentages', () => {
    // The catalogue stores the finished line; parsing it back into materials
    // would quietly shorten a composition someone corrected by hand.
    const order = buildSelectionOrder(selection({ quantities: { v1: 1 } }));
    expect(order.materials).toEqual([]);

    const plan = buildPrintPlan(order, { composition: '100% LEN + dodatki' });
    expect(plan.find((step) => step.kind === 'fabric')).toMatchObject({
      composition: '100% LEN + dodatki',
    });
  });
});

describe('selectionTotals and selectionProblems', () => {
  it('counts each lane separately: garments for tags, typed bags for stickers', () => {
    const input = selection({ quantities: { v1: 2, v2: 3 }, stickerQuantities: { CZARNY: 2 } });
    expect(selectionTotals(input)).toEqual({ stickers: 2, fabricTags: 5, total: 7 });
    expect(selectionTotals({ ...input, printFabricTags: false })).toEqual({
      stickers: 2,
      fabricTags: 0,
      total: 2,
    });
    // A bag count for a colour nobody asked garments for counts nothing.
    expect(selectionTotals(selection({ quantities: { v1: 2 }, stickerQuantities: { 'BEŻOWY': 4 } })))
      .toEqual({ stickers: 0, fabricTags: 2, total: 2 });
  });

  it('lists the colours with garments, once each, in row order', () => {
    expect(selectionColours(selection({ quantities: { v3: 1, v1: 2, v2: 1 } }))).toEqual(['CZARNY', 'BEŻOWY']);
    expect(selectionColours(selection())).toEqual([]);
  });

  it('names what stops the run', () => {
    expect(selectionProblems(selection())).toEqual(['NOTHING_SELECTED']);
    expect(
      selectionProblems(
        selection({ printStickers: false, printFabricTags: false, quantities: { v1: 1 } }),
      ),
    ).toEqual(['NO_LANE']);
    expect(selectionProblems(selection({ quantities: { v1: 1 } }))).toEqual([]);
    expect(
      selectionProblems(selection({ quantities: { v1: 1 }, stickerQuantities: {} })),
    ).toEqual(['NO_STICKER_QTY']);
    expect(
      selectionProblems(selection({ quantities: { v1: 1 }, stickerQuantities: {}, printStickers: false })),
    ).toEqual([]);
  });

  it('refuses a run past the whole-order ceiling', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `v${i}`,
      colorName: `KOLOR ${i}`,
      sizeName: 'S',
    }));
    const quantities = Object.fromEntries(many.map((variant) => [variant.id, 999]));
    expect(
      selectionProblems(selection({ variants: many, quantities })),
    ).toContain('TOO_MANY');
  });
});

describe('orderToFabricTagTemplate', () => {
  it('keeps the sheet content the catalogue has nowhere to store', () => {
    const template = orderToFabricTagTemplate('template-1', {
      ...createEmptyOrder(),
      customerName: ' MoonCollection ',
      careText: ' PRAĆ NA LEWEJ STRONIE ',
      careSymbols: ['wash-30'] as never,
      materials: [
        { name: 'BAWEŁNA', percent: 70 },
        { name: 'POLIESTER', percent: 30 },
      ],
    });

    expect(template).toEqual({
      templateId: 'template-1',
      brandName: 'MoonCollection',
      logoDataUrl: null,
      composition: '70% BAWEŁNA 30% POLIESTER',
      careSymbols: ['wash-30'],
      careText: 'PRAĆ NA LEWEJ STRONIE',
      // The parts ride along with the finished line so the style's own panel
      // can reopen the composition instead of parsing it back apart.
      materials: [
        { name: 'BAWEŁNA', percent: 70 },
        { name: 'POLIESTER', percent: 30 },
      ],
      fabric: null,
      layout: 'default',
    });
  });

  it('stores nothing rather than an empty line for a sheet with no materials', () => {
    const template = orderToFabricTagTemplate('template-2', createEmptyOrder());
    expect(template.composition).toBeNull();
    expect(template.brandName).toBeNull();
    expect(template.careText).toBeNull();
  });
});

describe('orderFromStyle', () => {
  // The label tab opens a style as the same sheet the order tab uses, filled
  // from what the till holds about it and with the quantities blank.
  const rows = [
    { color_name: 'CZARNY', size_name: 'M', retail_price: 4000 },
    { color_name: 'CZARNY', size_name: 'S', retail_price: 4000 },
    { color_name: 'BORDO', size_name: 'XL', retail_price: 4000 },
    { color_name: 'BORDO', size_name: '44/46', retail_price: 4000 },
    { color_name: 'bordo ', size_name: ' S', retail_price: 4000 },
  ];
  const tag = {
    templateId: 'template-115',
    brandName: 'MOON',
    logoDataUrl: null,
    composition: '70% POLIESTER 30% AKRYL',
    careSymbols: ['WASH_30'] as any,
    careText: 'NIE PRAĆ',
    materials: [],
    fabric: null,
    layout: 'default' as const,
  };

  it('lays out every colour and size once, sizes in the order the shop uses', () => {
    const order = orderFromStyle({
      templateId: 'template-115', name: 'KOMPLET DRESOWY', styleCode: '115', categoryId: 'cat-1', variants: rows, tag,
    });
    expect(order.rows.map((row) => row.colorName)).toEqual(['CZARNY', 'BORDO']);
    expect(order.sizes.map((size) => size.label)).toEqual(['S', 'M', 'XL', '44/46']);
    expect(order.rows.every((row) => Object.keys(row.quantities).length === 0 && row.stickerQuantity === undefined)).toBe(true);
    expect(order.sizes.every((size) => size.quantity === undefined)).toBe(true);
    expect(order.productId).toBe('template-115');
    expect(order.categoryId).toBe('cat-1');
    expect(order.styleName).toBe('KOMPLET DRESOWY');
    expect(order.styleCode).toBe('115');
  });

  it('prints one sticker per colour, carrying no bag code', () => {
    const order = orderFromStyle({
      templateId: 't', name: 'X', styleCode: '115', categoryId: null, variants: rows, tag: null,
    });
    const plan = buildPrintPlan({ ...order, customerName: 'MOON', rows: order.rows.map((row) => ({ ...row, stickerQuantity: 1 })), printFabricTags: false });
    const stickers = plan.filter((step) => step.kind === 'sticker');
    expect(stickers.map((step: any) => step.colorName)).toEqual(order.rows.map((row) => row.colorName));
    expect(stickers.every((step) => !('code' in step))).toBe(true);
  });

  it('takes the customer, composition and care from the saved tag', () => {
    const order = orderFromStyle({
      templateId: 't', name: 'X', styleCode: '115', categoryId: null, variants: rows, tag,
    });
    expect(order.customerName).toBe('MOON');
    expect(order.materials).toEqual([{ name: 'POLIESTER', percent: 70 }, { name: 'AKRYL', percent: 30 }]);
    expect(order.careSymbols).toEqual(['WASH_30']);
    expect(order.careText).toBe('NIE PRAĆ');
    // Saved parts win over the finished line when the tag carries them.
    const parts = orderFromStyle({
      templateId: 't', name: 'X', styleCode: '115', categoryId: null, variants: rows,
      tag: { ...tag, materials: [{ name: 'BAWEŁNA', percent: 100 }] },
    });
    expect(parts.materials).toEqual([{ name: 'BAWEŁNA', percent: 100 }]);
    // No tag yet: the sheet opens with the care fields blank, not broken.
    const bare = orderFromStyle({ templateId: 't', name: 'X', styleCode: '115', categoryId: null, variants: rows, tag: null });
    expect(bare.customerName).toBe('');
    expect(bare.materials).toEqual([]);
  });

  it('carries the price most rows sell at, and a colour sold apart keeps its own', () => {
    const agreed = orderFromStyle({ templateId: 't', name: 'X', styleCode: '1', categoryId: null, variants: rows, tag: null });
    expect(agreed.priceGrossGrosze).toBe(4000);
    expect(agreed.rows.map((row) => row.priceGrossGrosze)).toEqual([undefined, undefined]);

    // One old row at 1 zł among eleven at 40: the sheet says 40, and CZARNY —
    // whose rows disagree among themselves — sits on the sheet's price.
    const oneOff = orderFromStyle({
      templateId: 't', name: 'X', styleCode: '1', categoryId: null,
      variants: [...rows, { color_name: 'CZARNY', size_name: 'L', retail_price: 100 }], tag: null,
    });
    expect(oneOff.priceGrossGrosze).toBe(4000);
    expect(oneOff.rows.map((row) => row.priceGrossGrosze)).toEqual([undefined, undefined]);

    // Three BORDO rows at 35 zł against two CZARNY at 40: the sheet says 35,
    // and CZARNY — every row of it at 40 — carries 40 as its own.
    const apart = orderFromStyle({
      templateId: 't', name: 'X', styleCode: '1', categoryId: null,
      variants: rows.map((row) => (row.color_name.trim().toUpperCase() === 'BORDO' ? { ...row, retail_price: 3500 } : row)),
      tag: null,
    });
    expect(apart.priceGrossGrosze).toBe(3500);
    expect(apart.rows.map((row) => [row.colorName, row.priceGrossGrosze])).toEqual([['CZARNY', 4000], ['BORDO', undefined]]);
  });
});
