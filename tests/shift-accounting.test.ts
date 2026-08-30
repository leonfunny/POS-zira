import { describe, expect, it } from 'vitest';

import {
  getRefundPaymentAllocations,
  getOrderPaymentAllocations,
  isShiftSaleOrder,
  summarizeShiftSales,
} from '../src/shared/shift-accounting';

describe('shift accounting invariants', () => {
  it('does not subtract a discount already reflected in order.total', () => {
    const result = summarizeShiftSales([{
      total: 9_000,
      discount: 1_000,
      payment_method: 'CARD',
      payment_amount: 9_000,
      change_amount: 0,
    }]);

    expect(result.salesTotal).toBe(9_000);
    expect(result.totalDiscounts).toBe(1_000);
    expect(result.payments.card).toBe(9_000);
  });

  it('accounts for the same sale and tip in single and split payments', () => {
    const single = summarizeShiftSales([{
      total: 9_000,
      tip: 500,
      payment_method: 'CASH',
      payment_amount: 9_500,
      change_amount: 0,
    }]);
    const split = summarizeShiftSales([{
      total: 9_000,
      tip: 500,
      payment_method: 'SPLIT',
      payment_amount: 9_500,
      change_amount: 0,
      payment_tenders: JSON.stringify([
        { method: 'CASH', amount: 4_500 },
        { method: 'CARD', amount: 5_000 },
      ]),
    }]);

    expect(single.salesTotal).toBe(9_000);
    expect(single.totalTips).toBe(500);
    expect(single.payments.cash).toBe(9_500);
    expect(split.salesTotal).toBe(9_000);
    expect(split.totalTips).toBe(500);
    expect(split.payments.cash + split.payments.card).toBe(9_500);
  });

  it('uses cash kept after change and falls back for legacy payment rows', () => {
    expect(getOrderPaymentAllocations({
      total: 9_000,
      tip: 500,
      payment_method: 'CASH',
      payment_amount: 10_000,
      change_amount: 500,
    })).toEqual([{ method: 'CASH', amount: 9_500 }]);

    expect(getOrderPaymentAllocations({
      total: 9_000,
      tip: 500,
      payment_method: 'CASH',
      payment_amount: 0,
      change_amount: 0,
    })).toEqual([{ method: 'CASH', amount: 9_500 }]);
  });

  it('keeps invoice payments in the transfer bucket', () => {
    const result = summarizeShiftSales([{
      total: 12_000,
      payment_method: 'INVOICE',
      payment_amount: 12_000,
    }]);

    expect(result.payments.transfer).toBe(12_000);
  });

  it('accepts only settled sale rows into a shift report', () => {
    expect(isShiftSaleOrder({ status: 'COMPLETED', payment_method: 'CASH' })).toBe(true);
    expect(isShiftSaleOrder({ status: 'PAID', payment_method: 'CARD' })).toBe(true);
    expect(isShiftSaleOrder({ status: 'PARTIAL_REFUND', payment_method: 'CASH' })).toBe(true);
    expect(isShiftSaleOrder({ status: 'CANCELLED', payment_method: 'CASH' })).toBe(false);
    expect(isShiftSaleOrder({ status: 'VOID', payment_method: 'CARD' })).toBe(false);
    expect(isShiftSaleOrder({ status: 'PENDING', payment_method: 'CASH' })).toBe(false);
    expect(isShiftSaleOrder({ status: 'COMPLETED' })).toBe(false);
  });

  it('allocates an incremental split refund without losing rounding', () => {
    const allocations = getRefundPaymentAllocations({
      total: 10_000,
      payment_method: 'SPLIT',
      payment_tenders: JSON.stringify([
        { method: 'CASH', amount: 6_000 },
        { method: 'CARD', amount: 4_000 },
      ]),
    }, 3_333);

    expect(allocations).toEqual([
      { method: 'CASH', amount: 2_000 },
      { method: 'CARD', amount: 1_333 },
    ]);
    expect(allocations.reduce((sum, row) => sum + row.amount, 0)).toBe(3_333);
  });

  it('uses a refund-event tender snapshot even when the event has no sale total', () => {
    expect(getRefundPaymentAllocations({
      payment_method: 'SPLIT',
      payment_tenders: JSON.stringify([
        { method: 'CASH', amount: 600 },
        { method: 'CARD', amount: 400 },
      ]),
    }, 500)).toEqual([
      { method: 'CASH', amount: 300 },
      { method: 'CARD', amount: 200 },
    ]);
  });

  it('never creates a negative final allocation when several tenders round up', () => {
    const allocations = getRefundPaymentAllocations({
      payment_method: 'SPLIT',
      payment_tenders: JSON.stringify(Array.from({ length: 5 }, (_, index) => ({
        method: index === 0 ? 'CASH' : 'CARD',
        amount: 100,
      }))),
    }, 3);

    expect(allocations.every((row) => row.amount >= 0)).toBe(true);
    expect(allocations.reduce((sum, row) => sum + row.amount, 0)).toBe(3);
  });
});
