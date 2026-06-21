import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnqueuePosEventInput } from '../src/main/database/repos/pos-event-outbox-repo';

const enqueue = vi.fn((input: EnqueuePosEventInput) => ({
  event_id: `evt:${input.dedupeKey}`,
  dedupe_key: input.dedupeKey,
  ...input,
}));

vi.mock('../src/main/database/repos/pos-event-outbox-repo', () => ({
  posEventOutboxRepo: { enqueue: (input: EnqueuePosEventInput) => enqueue(input) },
}));

vi.mock('../src/main/config/store', () => ({
  getConfigValue: vi.fn((key: string) =>
    key === 'salonId' ? 'salon-1' : key === 'machineId' ? 'dev-1' : undefined,
  ),
}));

vi.mock('../src/main/logger', () => ({ default: { warn: vi.fn(), info: vi.fn() } }));

import { posEventEmitter } from '../src/main/events/pos-event-emitter';

function calls(eventType: string): EnqueuePosEventInput[] {
  return enqueue.mock.calls
    .map((c: [EnqueuePosEventInput]) => c[0])
    .filter((i: EnqueuePosEventInput) => i.eventType === eventType);
}

const baseOrder = {
  id: 'order-1',
  order_number: 'POS-1',
  status: 'COMPLETED',
  subtotal: 1000,
  discount: 0,
  tax: 0,
  total: 1000,
  payment_method: 'CASH',
  payment_amount: 1000,
  change_amount: 0,
  staff_id: 's1',
  staff_name: 'Anna',
  customer_id: null,
  customer_name: null,
  customer_nip: null,
  shift_id: 'shift-1',
  source: 'POS',
  synced: 0,
  backend_id: null,
  created_at: '2026-06-21T10:00:00.000Z',
  synced_at: null,
  table_id: null,
  covers: null,
  order_type: 'standard',
  tip: 0,
  mode: 'retail',
  payment_tenders: null,
  sync_attempts: 0,
  sync_error: null,
  refund_amount: null,
  refund_reason: null,
  refunded_at: null,
  refund_lines: null,
} as any;

const items = [
  { id: 'l1', order_id: 'order-1', variant_id: 'v1', name: 'Tea', sku: 'T1', price: 1000, quantity: 1, total: 1000, vat_rate: 23, staff_id: null, staff_name: null, notes: null, course: 1 },
] as any;

// NB: block body — never `() => enqueue.mockClear()`. mockClear() returns the
// mock fn, and vitest treats a function returned from beforeEach as a per-test
// cleanup callback, invoking it with no args (enqueue(undefined)) after the test.
beforeEach(() => {
  enqueue.mockClear();
});

describe('posEventEmitter.emitOrderFinalized', () => {
  it('emits one SaleCompleted and one PaymentCaptured for a single-tender cash sale', () => {
    posEventEmitter.emitOrderFinalized(baseOrder, items);
    expect(calls('SaleCompleted')).toHaveLength(1);
    const pays = calls('PaymentCaptured');
    expect(pays).toHaveLength(1);
    expect(pays[0].payload.method).toBe('cash');
    expect(pays[0].payload.amountMinor).toBe(1000);
    // cash settles instantly
    expect((pays[0].payload.settlement as any).settledAt).toBe('2026-06-21T10:00:00.000Z');
    // payment is caused by the sale
    expect(pays[0].causationId).toBe('evt:SaleCompleted:order-1');
  });

  it('captures the SALE total, not the cash tendered, when change is given', () => {
    // 87 zł sale, customer pays 100 zł cash, 13 zł change.
    posEventEmitter.emitOrderFinalized(
      { ...baseOrder, total: 8700, payment_amount: 10000, change_amount: 1300 },
      [{ ...items[0], price: 8700, total: 8700 }] as any,
    );
    const pays = calls('PaymentCaptured');
    expect(pays).toHaveLength(1);
    expect(pays[0].payload.amountMinor).toBe(8700); // NOT 10000
    expect(pays[0].payload.cashReceivedMinor).toBe(10000);
    expect(pays[0].payload.changeGivenMinor).toBe(1300);
  });

  it('emits one PaymentCaptured per tender for a split payment', () => {
    posEventEmitter.emitOrderFinalized(
      { ...baseOrder, payment_method: 'SPLIT', payment_tenders: JSON.stringify([
        { method: 'CASH', amount: 600 },
        { method: 'CARD', amount: 400 },
      ]) },
      items,
    );
    const pays = calls('PaymentCaptured');
    expect(pays).toHaveLength(2);
    expect(pays.map((p) => p.payload.amountMinor)).toEqual([600, 400]);
    // cash instant, card pending settlement
    expect((pays[0].payload.settlement as any).settledAt).toBe('2026-06-21T10:00:00.000Z');
    expect((pays[1].payload.settlement as any).settledAt).toBeNull();
    // distinct idempotent keys per tender
    expect(pays[0].dedupeKey).toBe('PaymentCaptured:order-1:0');
    expect(pays[1].dedupeKey).toBe('PaymentCaptured:order-1:1');
  });

  it('builds a SaleCompleted tax summary from item vat rates (minor units)', () => {
    posEventEmitter.emitOrderFinalized(baseOrder, items);
    const sale = calls('SaleCompleted')[0];
    expect(sale.payload.totalGrossMinor).toBe(1000);
    const tax = (sale.payload.taxSummary as any[])[0];
    expect(tax.vatRateBps).toBe(2300);
    expect(tax.grossMinor).toBe(1000);
    expect(tax.netMinor + tax.taxMinor).toBe(1000);
  });
});

describe('posEventEmitter.emitRefundIssued', () => {
  it('uses the explicit delta amount, not cumulative', () => {
    posEventEmitter.emitRefundIssued({
      localOrderId: 'order-1',
      backendOrderId: 'srv-1',
      amountMinor: 250,
      method: 'CASH',
      reason: 'return',
      refundedAt: '2026-06-21T11:00:00.000Z',
    });
    const refunds = calls('RefundIssued');
    expect(refunds).toHaveLength(1);
    expect(refunds[0].payload.amountMinor).toBe(250);
    expect(refunds[0].payload.method).toBe('cash');
    expect(refunds[0].reliabilityClass).toBe('critical_financial');
  });

  it('skips zero/negative refunds', () => {
    posEventEmitter.emitRefundIssued({
      localOrderId: 'order-1',
      amountMinor: 0,
      method: 'CASH',
      refundedAt: '2026-06-21T11:00:00.000Z',
    });
    expect(calls('RefundIssued')).toHaveLength(0);
  });
});
