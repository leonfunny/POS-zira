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
    stickerIncludesSize: false,
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

  it('splits stickers per size when the operator ticks "print size"', () => {
    const order = { ...sampleOrder(), stickerIncludesSize: true };
    const stickers = buildPrintPlan(order).filter((s) => s.kind === 'sticker');
    expect(stickers).toHaveLength(3); // r1/S, r1/M, r2/S — r2/M is zero
    expect(stickers[0]).toMatchObject({ sizeText: 'S', quantity: 40 });
    expect(stickers[1]).toMatchObject({ sizeText: 'M', quantity: 60 });
    expect(stickers[2]).toMatchObject({ colorName: 'BORDO', sizeText: 'S', quantity: 20 });
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
