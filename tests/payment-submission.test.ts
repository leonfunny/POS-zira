import { describe, expect, it } from 'vitest';
import { resolvePaymentSubmission } from '../src/renderer/components/pos/payment-submission';

describe('resolvePaymentSubmission', () => {
  it('keeps a normal complete split payment intact', () => {
    const submission = resolvePaymentSubmission({
      method: 'CASH',
      splitMode: true,
      tenders: [
        { method: 'CASH', amount: 400 },
        { method: 'CARD', amount: 600 },
      ],
      cashAmountGrosze: 0,
      grandTotal: 1000,
    });

    expect(submission.complete).toBe(true);
    expect(submission.splitMode).toBe(true);
    expect(submission.paymentAmount).toBe(1000);
    expect(submission.tenders).toEqual([
      { method: 'CASH', amount: 400 },
      { method: 'CARD', amount: 600 },
    ]);
  });

  it('rejects an incomplete split before any payment boundary can be crossed', () => {
    const submission = resolvePaymentSubmission({
      method: 'CASH',
      splitMode: true,
      tenders: [{ method: 'CASH', amount: 400 }],
      cashAmountGrosze: 0,
      grandTotal: 1000,
    });

    expect(submission.complete).toBe(false);
    expect(submission.paymentAmount).toBe(400);
  });

  it('turns a CARD scan from stale split state into one explicit card submission', () => {
    const submission = resolvePaymentSubmission({
      method: 'CARD',
      splitMode: true,
      tenders: [{ method: 'CASH', amount: 400 }],
      cashAmountGrosze: 0,
      grandTotal: 1000,
    }, {
      method: 'CARD',
      splitMode: false,
      tenders: [],
      cashAmountGrosze: 0,
    });

    expect(submission).toMatchObject({
      complete: true,
      method: 'CARD',
      splitMode: false,
      tenders: [],
      paymentAmount: 1000,
      changeGrosze: 0,
    });
  });

  it('turns a CASH scan from stale split state into one exact-cash submission', () => {
    const submission = resolvePaymentSubmission({
      method: 'CASH',
      splitMode: true,
      tenders: [
        { method: 'CARD', amount: 500 },
        { method: 'CASH', amount: 500 },
      ],
      cashAmountGrosze: 0,
      grandTotal: 1000,
    }, {
      method: 'CASH',
      splitMode: false,
      tenders: [],
      cashAmountGrosze: 1000,
    });

    expect(submission).toMatchObject({
      complete: true,
      method: 'CASH',
      splitMode: false,
      tenders: [],
      cashAmountGrosze: 1000,
      paymentAmount: 1000,
      changeGrosze: 0,
    });
  });
});
