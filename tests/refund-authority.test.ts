import { describe, expect, it } from 'vitest';
import { validateAuthoritativeRefundResult, validateRefundDetailIdentity, type RefundAuthorityExpected } from '../src/shared/refund-authority';

const expected = (): RefundAuthorityExpected => ({
  backendOrderId: 'order-server', requestId: 'request-stable', orderTotalGrosze: 5000,
  alreadyRefundedGrosze: 1000, expectedDeltaGrosze: 2000,
  items: [{ orderItemId: 'item-a', quantity: 1, restock: false }, { orderItemId: 'item-b', quantity: 0.5, restock: true }],
});
const response = (): any => ({
  success: true, orderId: 'order-server', status: 'PARTIAL_REFUND', refundAmount: 20,
  totalRefundedAmount: '30.00', stockMovementIds: [],
  refundedLines: [
    { orderItemId: 'item-a', variantId: 'same-product', quantity: 1, unit: 'szt', saleUnit: 'szt', unitPrice: 10, refundAmount: '10.00', restock: false, refundRequestId: 'request-stable', taxRate: 23 },
    { orderItemId: 'item-b', variantId: 'same-product', quantity: 0.5, unit: 'kg', unitPrice: '20.00', refundAmount: 10, restock: true },
  ],
});

describe('raw refund detail identity gate', () => {
  const scope = { backendOrderId: 'order-server', salonId: 'salon-1' };
  const detail = (): any => ({ id: 'order-server', items: [{ id: 'item-a' }, { id: 'item-b' }] });

  it('accepts absent legacy parent/tenant fields without generating or mutating IDs', () => {
    const raw = detail(); const before = JSON.stringify(raw);
    expect(validateRefundDetailIdentity(raw, scope)).toEqual({ ok: true });
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('accepts all matching declared identities with duplicate products and reversed item order', () => {
    const raw = detail();
    Object.assign(raw, { salonId: 'salon-1', salon_id: 'salon-1', salon: { id: 'salon-1' } });
    for (const item of raw.items) Object.assign(item, {
      productId: 'same-product', orderId: 'order-server', order_id: 'order-server',
      b2bOrderId: 'order-server', b2b_order_id: 'order-server', salonId: 'salon-1',
      salon: { id: 'salon-1' }, order: { id: 'order-server', salon: { id: 'salon-1' } },
    });
    raw.items.reverse();
    expect(validateRefundDetailIdentity(raw, scope)).toEqual({ ok: true });
  });

  it.each([
    ['wrong order', (r: any) => { r.id = 'other'; }],
    ['missing order', (r: any) => { delete r.id; }],
    ['missing items', (r: any) => { delete r.items; }],
    ['empty items', (r: any) => { r.items = []; }],
    ['nonarray items', (r: any) => { r.items = {}; }],
    ['missing item ID', (r: any) => { delete r.items[0].id; }],
    ['empty item ID', (r: any) => { r.items[0].id = ''; }],
    ['blank item ID', (r: any) => { r.items[0].id = ' '; }],
    ['trimmed item ID', (r: any) => { r.items[0].id = ' item-a'; }],
    ['numeric item ID', (r: any) => { r.items[0].id = 1; }],
    ['duplicate ID', (r: any) => { r.items[1].id = r.items[0].id; }],
    ['null item', (r: any) => { r.items[0] = null; }],
    ['nested salon', (r: any) => { r.salon = { id: 'other' }; }],
    ['null salon', (r: any) => { r.salon = null; }],
    ['nested item salon', (r: any) => { r.items[0].salon = { id: 'other' }; }],
    ['nested item parent', (r: any) => { r.items[0].order = { id: 'other' }; }],
    ['nested parent salon', (r: any) => { r.items[0].order = { id: 'order-server', salonId: 'other' }; }],
    ['null nested parent', (r: any) => { r.items[0].order = null; }],
  ])('rejects %s', (_name, mutate) => {
    const raw = detail(); mutate(raw);
    expect(validateRefundDetailIdentity(raw, scope)).toMatchObject({ ok: false });
  });

  it.each(['salonId', 'salon_id'])('rejects conflicting or null declared tenant %s at both levels', key => {
    for (const bad of ['other', '', null, undefined]) {
      const raw = detail(); raw[key] = bad;
      expect(validateRefundDetailIdentity(raw, scope).ok).toBe(false);
      delete raw[key]; raw.items[0][key] = bad;
      expect(validateRefundDetailIdentity(raw, scope).ok).toBe(false);
    }
  });

  it.each(['orderId', 'order_id', 'b2bOrderId', 'b2b_order_id'])('rejects every conflicting declared item parent %s', key => {
    for (const bad of ['other', '', null, undefined]) {
      const raw = detail(); raw.items[0][key] = bad;
      expect(validateRefundDetailIdentity(raw, scope).ok).toBe(false);
    }
  });

  it('rejects invalid expected scope', () => {
    expect(validateRefundDetailIdentity(detail(), { ...scope, salonId: '' }).ok).toBe(false);
    expect(validateRefundDetailIdentity(detail(), { ...scope, backendOrderId: ' order-server' }).ok).toBe(false);
  });
});

describe('authoritative normal-product refund response', () => {
  it('normalizes exact duplicate-product lines in reversed order without needing stock movement IDs', () => {
    const raw = response(); raw.refundedLines.reverse();
    const result = validateAuthoritativeRefundResult(raw, expected());
    expect(result).toMatchObject({ ok: true, deltaGrosze: 2000, cumulativeGrosze: 3000, status: 'PARTIAL', lines: [
      { orderItemId: 'item-b', quantity: 0.5, unitPrice: 2000, refundAmount: 1000, refundRequestId: 'request-stable' },
      { orderItemId: 'item-a', unitPrice: 1000, vatRate: 23 },
    ] });
    expect(raw.refundedLines[0].unitPrice).toBe('20.00');
  });

  it('accepts FULL after prior partial and binds an absent response request ID to expected context', () => {
    const ctx = expected(); ctx.orderTotalGrosze = 3000;
    const raw = response(); raw.status = 'REFUNDED';
    expect(validateAuthoritativeRefundResult(raw, ctx)).toMatchObject({ ok: true, status: 'FULL' });
  });

  it('preserves a zero-price server line without fabricating an amount; total delta must still be positive', () => {
    const raw = response();
    raw.refundedLines[0].unitPrice = 0; raw.refundedLines[0].refundAmount = 0;
    raw.refundedLines[1].refundAmount = 20;
    expect(validateAuthoritativeRefundResult(raw, expected())).toMatchObject({ ok: true, lines: [{ refundAmount: 0 }, {}] });
  });

  it.each([null, undefined, [], true, 'success', 1])('rejects a non-object response %j', raw => {
    expect(validateAuthoritativeRefundResult(raw, expected()).ok).toBe(false);
  });

  it('allows a one-grosz canonical residual, but not two', () => {
    const raw = response(); raw.refundedLines[0].refundAmount = 10.01;
    expect(validateAuthoritativeRefundResult(raw, expected()).ok).toBe(true);
    raw.refundedLines[0].refundAmount = 10.02;
    expect(validateAuthoritativeRefundResult(raw, expected()).ok).toBe(false);
  });

  it('accepts a one-grosz expected delta residual with exact cumulative arithmetic', () => {
    const raw = response(); raw.refundAmount = 20.01; raw.totalRefundedAmount = 30.01;
    expect(validateAuthoritativeRefundResult(raw, expected()).ok).toBe(true);
    raw.totalRefundedAmount = 30;
    expect(validateAuthoritativeRefundResult(raw, expected()).ok).toBe(false);
  });

  it.each([
    ['false success', (r: any) => { r.success = false; }],
    ['missing success', (r: any) => { delete r.success; }],
    ['wrong order', (r: any) => { r.orderId = 'other'; }],
    ['missing order', (r: any) => { delete r.orderId; }],
    ['wrong request', (r: any) => { r.refundRequestId = 'other'; }],
    ['wrong line request', (r: any) => { r.refundedLines[0].refundRequestId = 'other'; }],
    ['null line request', (r: any) => { r.refundedLines[0].refundRequestId = null; }],
    ['missing lines', (r: any) => { delete r.refundedLines; }],
    ['empty lines', (r: any) => { r.refundedLines = []; }],
    ['extra lines', (r: any) => { r.refundedLines.push({ ...r.refundedLines[0] }); }],
    ['duplicate item', (r: any) => { r.refundedLines[1].orderItemId = 'item-a'; }],
    ['missing item', (r: any) => { delete r.refundedLines[0].orderItemId; }],
    ['wrong item', (r: any) => { r.refundedLines[0].orderItemId = 'other'; }],
    ['product is not item', (r: any) => { r.refundedLines[0].orderItemId = 'same-product'; }],
    ['wrong quantity', (r: any) => { r.refundedLines[0].quantity = 0.5; }],
    ['string quantity', (r: any) => { r.refundedLines[0].quantity = '1'; }],
    ['zero quantity', (r: any) => { r.refundedLines[0].quantity = 0; }],
    ['subgram quantity', (r: any) => { r.refundedLines[0].quantity = 1.0001; }],
    ['tiny quantity', (r: any) => { r.refundedLines[0].quantity = 0.0000000001; }],
    ['infinite quantity', (r: any) => { r.refundedLines[0].quantity = Infinity; }],
    ['restock escalation', (r: any) => { r.refundedLines[0].restock = true; }],
    ['missing restock', (r: any) => { delete r.refundedLines[0].restock; }],
    ['missing unit', (r: any) => { delete r.refundedLines[0].unit; }],
    ['inconsistent unit', (r: any) => { r.refundedLines[0].saleUnit = 'kg'; }],
    ['wrong status', (r: any) => { r.status = 'PAID'; }],
    ['premature FULL', (r: any) => { r.status = 'REFUNDED'; }],
    ['wrong delta', (r: any) => { r.refundAmount = 21; r.totalRefundedAmount = 31; }],
    ['overrefund', (r: any) => { r.totalRefundedAmount = 51; }],
    ['missing cumulative', (r: any) => { delete r.totalRefundedAmount; }],
    ['missing line money', (r: any) => { delete r.refundedLines[0].refundAmount; }],
    ['negative line amount', (r: any) => { r.refundedLines[0].refundAmount = -1; }],
    ['invalid product', (r: any) => { r.refundedLines[0].variantId = null; }],
    ['invalid tax', (r: any) => { r.refundedLines[0].taxRate = NaN; }],
    ['invalid timestamp', (r: any) => { r.refundedLines[0].refundedAt = 'yesterday'; }],
  ])('rejects %s', (_name, mutate) => {
    const raw = response(); mutate(raw);
    expect(validateAuthoritativeRefundResult(raw, expected())).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it.each(['20junk', ' 20', '20 ', '2e1', '', true, null, [], {}, NaN, Infinity, -20, '20.001', 20.001, Number.MAX_SAFE_INTEGER])('rejects malformed PLN %j', bad => {
    for (const field of ['refundAmount', 'totalRefundedAmount']) {
      const raw = response(); raw[field] = bad;
      expect(validateAuthoritativeRefundResult(raw, expected()).ok).toBe(false);
    }
    if (bad !== '20.001' && bad !== 20.001) {
      const raw = response(); raw.refundedLines[0].unitPrice = bad;
      expect(validateAuthoritativeRefundResult(raw, expected()).ok).toBe(false);
    }
  });

  it.each([13.3333, '13.3333', 20.001, '20.001'])('preserves valid 4dp PLN unit price %j as fractional grosze', price => {
    const raw = response(); raw.refundedLines[1].unitPrice = price;
    const result = validateAuthoritativeRefundResult(raw, expected());
    expect(result).toMatchObject({ ok: true, lines: [{}, { unitPrice: Math.round(Number(price) * 10000) / 100, refundAmount: 1000 }] });
  });

  it.each(['13.33333', 13.33333, '13.3333junk', '1.33333e1', Infinity, -13.3333])('rejects invalid unit price precision/value %j', price => {
    const raw = response(); raw.refundedLines[1].unitPrice = price;
    expect(validateAuthoritativeRefundResult(raw, expected()).ok).toBe(false);
  });

  it('rejects zero-delta already-refunded replay: caller must use journal context, not current totals', () => {
    const raw = response(); raw.refundAmount = 0; raw.totalRefundedAmount = 10;
    expect(validateAuthoritativeRefundResult(raw, expected()).ok).toBe(false);
    const ctx = expected(); ctx.alreadyRefundedGrosze = 3000;
    expect(validateAuthoritativeRefundResult(response(), ctx).ok).toBe(false);
  });

  it('does not dedupe or apply replay: identical immutable expectation produces identical validated audit', () => {
    expect(validateAuthoritativeRefundResult(response(), expected())).toEqual(validateAuthoritativeRefundResult(response(), expected()));
  });

  it.each([
    (e: RefundAuthorityExpected) => { e.items[1].orderItemId = 'item-a'; },
    (e: RefundAuthorityExpected) => { e.items = []; },
    (e: RefundAuthorityExpected) => { e.items[0].quantity = -1; },
    (e: RefundAuthorityExpected) => { e.requestId = ''; },
    (e: RefundAuthorityExpected) => { e.orderTotalGrosze = Infinity; },
    (e: RefundAuthorityExpected) => { e.alreadyRefundedGrosze = 5000; },
    (e: RefundAuthorityExpected) => { e.expectedDeltaGrosze = 0; },
    (e: RefundAuthorityExpected) => { e.expectedDeltaGrosze = 4001; },
    (e: RefundAuthorityExpected) => { e.expectedDeltaGrosze = 2000.5; },
  ])('rejects malformed immutable expectation %#', mutate => {
    const ctx = expected(); mutate(ctx);
    expect(validateAuthoritativeRefundResult(response(), ctx).ok).toBe(false);
  });
});
