import { describe, expect, it } from 'vitest';
import { shouldDecrementStockAtCheckout } from '../src/main/pos/order-line-contract';
import {
  getRefundLinesForRequest,
  mergeRefundLines,
  shouldApplyRefundRequestLocally,
} from '../src/main/pos/refund-backend-payload';
import {
  canSubmitBilliardOwnerCorrection,
  canShowBilliardOwnerCorrection,
  hasBilliardCorrectionExternalSettlementRisk,
  isBilliardCorrectionInvoiceLinked,
} from '../src/renderer/components/pos/billiard-owner-correction';

describe('Billiard POS policy rails', () => {
  it('deduplicates a correction retry by refundRequestId plus Billiard line key', () => {
    const requestId = '11111111-1111-4111-8111-111111111111';
    const existing = JSON.stringify([
      { refundRequestId: requestId, billiardLineKey: 'time-1', refundAmount: 1000 },
      { refundRequestId: requestId, billiardLineKey: 'fnb-1', refundAmount: 500 },
    ]);
    const retryDelta = [
      { refundRequestId: requestId, billiardLineKey: 'time-1', quantity: 1, unitPrice: 1000, refundAmount: 1000 },
      { refundRequestId: requestId, billiardLineKey: 'fnb-1', quantity: 1, unitPrice: 500, refundAmount: 500 },
    ];

    expect(getRefundLinesForRequest(existing, requestId)).toHaveLength(2);
    expect(shouldApplyRefundRequestLocally(existing, requestId)).toBe(false);
    expect(mergeRefundLines(existing, retryDelta)).toHaveLength(2);
    expect(mergeRefundLines(existing, [{
      ...retryDelta[0],
      refundRequestId: '22222222-2222-4222-8222-222222222222',
    }])).toHaveLength(3);
  });

  it('does not apply local mutation/event again after a save succeeded but handoff recovery failed', () => {
    const requestId = '33333333-3333-4333-8333-333333333333';
    const firstDelta = [{
      refundRequestId: requestId,
      billiardLineKey: 'fnb-1',
      quantity: 1,
      unitPrice: 1200,
      refundAmount: 1200,
    }];
    expect(shouldApplyRefundRequestLocally(null, requestId)).toBe(true);

    // This JSON represents the durable local state immediately after the
    // first mutation/event save and immediately before prepare-handoff failed.
    const savedRefundLines = JSON.stringify(mergeRefundLines(null, firstDelta));
    expect(shouldApplyRefundRequestLocally(savedRefundLines, requestId)).toBe(false);
    expect(mergeRefundLines(savedRefundLines, firstDelta)).toEqual(firstDelta);
  });

  it('never decrements Billiard F&B stock a second time at POS checkout', () => {
    const fnb = {
      variant_id: 'cola-variant',
      quantity: 2,
      sale_quantity: 2,
      sell_by: 'PIECE',
      billiard_json: JSON.stringify({ lineKey: 'fnb-1', kind: 'FNB' }),
    };
    expect(shouldDecrementStockAtCheckout(fnb, true)).toBe(false);
    expect(shouldDecrementStockAtCheckout(fnb, false)).toBe(true);
  });

  it('exposes owner correction only to OWNER for a synced, non-refunded Billiard order', () => {
    const order = {
      billiardOriginJson: JSON.stringify({ type: 'BILLIARD_SESSION' }),
      backendId: 'backend-order-1',
      synced: 1,
      status: 'COMPLETED',
    };
    expect(canShowBilliardOwnerCorrection({ ...order, role: 'OWNER' })).toBe(true);
    expect(canShowBilliardOwnerCorrection({ ...order, role: 'MANAGER' })).toBe(false);
    expect(canShowBilliardOwnerCorrection({ ...order, role: 'STAFF' })).toBe(false);
    expect(canShowBilliardOwnerCorrection({ ...order, role: 'OWNER', synced: 0 })).toBe(false);
    expect(canShowBilliardOwnerCorrection({ ...order, role: 'OWNER', status: 'REFUNDED' })).toBe(false);
  });

  it('blocks the local correction CTA for invoice-linked orders', () => {
    expect(isBilliardCorrectionInvoiceLinked({ customerNip: '1234567890' })).toBe(true);
    expect(isBilliardCorrectionInvoiceLinked({ requiresInvoice: true })).toBe(true);
    expect(isBilliardCorrectionInvoiceLinked({ invoiceId: 'invoice-1' })).toBe(true);
    expect(isBilliardCorrectionInvoiceLinked({})).toBe(false);
  });

  it('requires explicit external terminal/fiscal acknowledgement before correction', () => {
    expect(hasBilliardCorrectionExternalSettlementRisk({
      paymentMethod: 'CARD',
      hasFiscal: 1,
    })).toBe(true);
    expect(hasBilliardCorrectionExternalSettlementRisk({
      paymentMethod: 'CASH',
      paymentTendersJson: JSON.stringify([
        { method: 'CASH', amount: 500 },
        { method: 'CARD', amount: 500 },
      ]),
    })).toBe(true);

    const base = {
      reason: 'Owner correction test',
      shiftOpen: true,
      shiftId: 'shift-1',
      invoiceLinked: false,
    };
    expect(canSubmitBilliardOwnerCorrection({
      ...base,
      externalReversalAcknowledged: false,
    })).toBe(false);
    expect(canSubmitBilliardOwnerCorrection({
      ...base,
      externalReversalAcknowledged: true,
    })).toBe(true);
  });
});
