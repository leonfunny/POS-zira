import { describe, expect, it } from 'vitest';
import { buildPrintPlan, createEmptyOrder } from '../src/shared/label-print-order';
import {
  SelectionInput,
  buildSelectionOrder,
  orderToFabricTagTemplate,
  selectionProblems,
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
    expect(order.rows[0].quantities[order.sizes[0].id]).toBe(4);
    expect(order.rows[1].quantities[order.sizes[0].id]).toBe(2);
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
    expect(order.rows[0].quantities[order.sizes[0].id]).toBe(5);
  });

  it('feeds the sheet lanes so a reprint prints what the order printed', () => {
    const order = buildSelectionOrder(
      selection({ quantities: { v1: 2, v2: 1 } }),
    );
    const plan = buildPrintPlan(order, { composition: '70% BAWEŁNA' });

    const stickers = plan.filter((step) => step.kind === 'sticker');
    const fabric = plan.filter((step) => step.kind === 'fabric');
    // One bag per colour covering its sizes, one tag per garment.
    expect(stickers).toHaveLength(1);
    expect(stickers[0]).toMatchObject({ colorName: 'CZARNY', quantity: 3 });
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
  it('counts each lane separately', () => {
    const input = selection({ quantities: { v1: 2, v2: 3 } });
    expect(selectionTotals(input)).toEqual({ stickers: 5, fabricTags: 5, total: 10 });
    expect(selectionTotals({ ...input, printFabricTags: false })).toEqual({
      stickers: 5,
      fabricTags: 0,
      total: 5,
    });
  });

  it('names what stops the run', () => {
    expect(selectionProblems(selection())).toEqual(['NOTHING_SELECTED']);
    expect(
      selectionProblems(
        selection({ printStickers: false, printFabricTags: false, quantities: { v1: 1 } }),
      ),
    ).toEqual(['NO_LANE']);
    expect(selectionProblems(selection({ quantities: { v1: 1 } }))).toEqual([]);
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
