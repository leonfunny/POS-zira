import { describe, expect, it } from 'vitest';
import { prepareAndroidRefundIntent } from '../src/shared/android-refund-intent';
import type { RefundIpcPayload } from '../src/shared/refund-backend-payload';

const requestId = '11111111-1111-4111-8111-111111111111';
const priorId = '22222222-2222-4222-8222-222222222222';
const context = { backendOrderId: 'order-server', salonId: 'salon-a', backendShiftId: '33333333-3333-4333-8333-333333333333' };
function raw(): any {
  return { id: 'order-server', salonId: 'salon-a', status: 'COMPLETED', posMode: 'restaurant', createdAt: '2026-09-08T10:00:00Z',
    total: '20.00', subtotal: '16.26', taxAmount: '3.74', paidAmount: '20.00', discountAmount: '0.00', refundAmount: '0.00',
    paymentMethod: 'CASH', items: ['b', 'a'].map(id => ({ id: `server-${id}`, orderId: 'order-server', productId: 'same-product',
      productName: 'Same Tea', sellBy: 'PIECE', saleUnit: 'szt', totalUnits: 1, unitPrice: '8.13', totalPrice: '8.13',
      grossUnitPrice: '10.00', grossTotalPrice: '10.00', taxRate: 23 })) };
}
function dto(): RefundIpcPayload {
  return { type: 'PARTIAL', refundRequestId: requestId, amount: 1000, reason: 'Damaged', lines: [
    { orderItemId: 'server-a', quantity: 1, unit: 'szt', unitPrice: 1000, refundAmount: 1000, restock: true },
  ] };
}
function prior(r: any, quantity = 1, amount = '10.00') {
  r.status = 'PARTIAL_REFUND'; r.refundAmount = amount;
  r.refundedLines = [{ orderItemId: 'server-a', refundRequestId: priorId, quantity, unit: 'szt', unitPrice: '10.00', refundAmount: amount, restock: false }];
}

describe('pure Android canonical refund intent', () => {
  it('uses reversed exact server IDs and explicit gross prices without a second VAT gross-up', () => {
    const r = raw(); const d = dto(); const before = JSON.stringify([r, d]);
    const result = prepareAndroidRefundIntent(r, d, context);
    expect(result).toMatchObject({ payload: { amount: 10, items: [{ orderItemId: 'server-a', quantity: 1, restock: true, unit: 'szt' }],
      shiftId: context.backendShiftId, tenderAllocations: [{ method: 'CASH', amount: 10 }] },
      expected: { orderTotalGrosze: 2000, alreadyRefundedGrosze: 0, expectedDeltaGrosze: 1000, requestId }, priorRefundLines: [] });
    expect(result.payload).not.toHaveProperty('lines'); expect(JSON.stringify([r, d])).toBe(before);
    expect(prepareAndroidRefundIntent(r, d, context)).toEqual(result);
  });
  it('requires FULL to select every remaining exact line', () => {
    const d = dto(); d.type = 'FULL'; d.amount = 2000;
    expect(() => prepareAndroidRefundIntent(raw(), d, context)).toThrow(/Full refund/);
    d.lines!.push({ ...d.lines![0], orderItemId: 'server-b' });
    expect(prepareAndroidRefundIntent(raw(), d, context).expected.expectedDeltaGrosze).toBe(2000);
  });
  it('uses audited exact identity after a previous partial without consuming the duplicate product', () => {
    const r = raw(); prior(r); const d = dto(); d.lines![0].orderItemId = 'server-b'; d.type = 'FULL';
    const result = prepareAndroidRefundIntent(r, d, context);
    expect(result.expected).toMatchObject({ alreadyRefundedGrosze: 1000, expectedDeltaGrosze: 1000 });
    expect(result.priorRefundLines[0]).toMatchObject({ orderItemId: 'server-a', refundAmount: 1000, unitPrice: 1000 });
  });
  it('supports weighted canonical quantities and 4dp canonical price without losing audit precision', () => {
    const r = raw(); r.total = '1.00'; r.items = [{ ...r.items[0], id: 'server-a', sellBy: 'WEIGHT', saleUnit: 'kg',
      totalUnits: 3, saleQuantity: 3, grossUnitPrice: '0.3333', grossTotalPrice: '1.00' }];
    prior(r, 1, '0.33'); r.refundedLines[0].unit = 'kg'; r.refundedLines[0].unitPrice = '0.3333';
    const d = dto(); d.type = 'FULL'; d.amount = 67; Object.assign(d.lines![0], { quantity: 2, unit: 'kg', unitPrice: 34, refundAmount: 67 });
    const result = prepareAndroidRefundIntent(r, d, context);
    expect(result.payload.amount).toBe(0.67); expect(result.priorRefundLines[0].unitPrice).toBe(33.33);
  });
  it('uses backend original-ratio partial rounding and final remaining money', () => {
    const r = raw(); r.total = '1.00'; r.items = [{ ...r.items[0], id: 'server-a', totalUnits: 3, grossUnitPrice: '0.3333', grossTotalPrice: '1.00' }];
    prior(r, 1, '0.33'); r.refundedLines[0].unitPrice = '0.33';
    const d = dto(); d.amount = 33; Object.assign(d.lines![0], { unitPrice: 34, refundAmount: 33 });
    expect(prepareAndroidRefundIntent(r, d, context).payload.amount).toBe(0.33);
    d.amount = 34; d.lines![0].refundAmount = 34;
    expect(() => prepareAndroidRefundIntent(r, d, context)).toThrow(/Renderer line money/);
  });
  it('ignores renderer payout redirection and derives allocation from original canonical tenders', () => {
    const r = raw(); r.paymentMethod = 'SPLIT'; r.tenders = [{ method: 'CASH', amount: 5 }, { method: 'CARD', amount: 15 }];
    const d = dto(); d.refundMethod = 'BANK_TRANSFER'; d.tenderAllocations = [{ method: 'BANK_TRANSFER', amount: 1000 }];
    expect(prepareAndroidRefundIntent(r, d, context).payload.tenderAllocations).toEqual([{ method: 'CASH', amount: 2.5 }, { method: 'CARD', amount: 7.5 }]);
  });
  it.each([
    ['tenant', (r: any) => { r.salonId = 'other'; }], ['order', (r: any) => { r.id = 'other'; }],
    ['missing ID', (r: any) => { delete r.items[0].id; }], ['duplicate ID', (r: any) => { r.items[0].id = 'server-a'; }],
    ['discount', (r: any) => { r.discountAmount = '1.00'; }], ['tip', (r: any) => { r.tip = 1; }],
    ['fee', (r: any) => { r.deliveryFee = 1; }], ['Billiard', (r: any) => { r.posMode = 'billiard'; }],
    ['line policy', (r: any) => { r.items[0].refundPolicy = 'FORBIDDEN'; }],
    ['malformed total', (r: any) => { r.total = '20.00junk'; }], ['nonfinite', (r: any) => { r.items[0].grossTotalPrice = Infinity; }],
    ['missing gross', (r: any) => { delete r.items[0].grossUnitPrice; }],
    ['missing sale mode', (r: any) => { delete r.items[0].sellBy; }],
    ['inconsistent unit', (r: any) => { r.items[0].saleUnit = 'kg'; }],
    ['missing refund audit', (r: any) => { r.status = 'PARTIAL_REFUND'; r.refundAmount = 1; }],
    ['unknown prior ID', (r: any) => { prior(r); r.refundedLines[0].orderItemId = 'unknown'; }],
    ['prior quantity', (r: any) => { prior(r, 2); }], ['prior amount', (r: any) => { prior(r, 1, '15.00'); }],
    ['duplicate prior', (r: any) => { prior(r); r.refundedLines.push({ ...r.refundedLines[0] }); }],
    ['invalid prior money', (r: any) => { prior(r); r.refundedLines[0].unitPrice = 'x'; }],
    ['invalid prior VAT', (r: any) => { prior(r); r.refundedLines[0].taxRate = Infinity; }],
    ['invalid prior description', (r: any) => { prior(r); r.refundedLines[0].name = {}; }],
    ['invalid order VAT', (r: any) => { r.taxAmount = 'junk'; }],
    ['prior request replay', (r: any) => { prior(r); r.refundedLines[0].refundRequestId = requestId; }],
    ['malformed tender', (r: any) => { r.tenders = [{ method: 'CARD', amount: '20junk' }]; }],
  ])('rejects unsafe canonical %s', (_name, change) => {
    const r = raw(); change(r); expect(() => prepareAndroidRefundIntent(r, dto(), context)).toThrow(/ANDROID_REFUND_INTENT/);
  });
  it.each([
    ['request UUID', (d: any) => { d.refundRequestId = 'not-uuid'; }],
    ['missing ID', (d: any) => { delete d.lines[0].orderItemId; }], ['wrong ID', (d: any) => { d.lines[0].orderItemId = 'local-a'; }],
    ['duplicate ID', (d: any) => { d.lines.push({ ...d.lines[0] }); }], ['manual', (d: any) => { d.manualAdjustmentAmount = 0; }],
    ['line amount', (d: any) => { d.lines[0].refundAmount = 999; }], ['unit price', (d: any) => { d.lines[0].unitPrice = 1; }],
    ['total', (d: any) => { d.amount = 999; }], ['fractional piece', (d: any) => { d.lines[0].quantity = 0.5; }],
    ['over quantity', (d: any) => { d.lines[0].quantity = 2; }], ['restock', (d: any) => { d.lines[0].restock = 1; }],
  ])('rejects invalid renderer %s', (_name, change) => {
    const d = dto(); change(d); expect(() => prepareAndroidRefundIntent(raw(), d, context)).toThrow(/ANDROID_REFUND_INTENT/);
  });
  it('requires a backend shift UUID without changing it', () => {
    expect(() => prepareAndroidRefundIntent(raw(), dto(), { ...context, backendShiftId: 'local-shift' })).toThrow(/UUID/);
  });
  it('rejects inconsistent weighted quantities instead of silently selecting an adapter fallback', () => {
    const r = raw(); Object.assign(r.items[0], { sellBy: 'WEIGHT', saleUnit: 'kg', totalUnits: 1, saleQuantity: 0.5 });
    expect(() => prepareAndroidRefundIntent(r, dto(), context)).toThrow(/quantities disagree/);
  });
  it('does not invent a VAT rate for a valid historical audit without one', () => {
    const r = raw(); prior(r); const d = dto(); d.lines![0].orderItemId = 'server-b';
    expect(prepareAndroidRefundIntent(r, d, context).priorRefundLines[0].vatRate).toBeUndefined();
  });
});
