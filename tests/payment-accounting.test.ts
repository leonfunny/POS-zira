import { describe, expect, it } from 'vitest';
import {
  assertPosPaymentAccounting,
  assertProtectedPosPaymentMethods,
} from '../src/main/pos/payment-accounting';

describe('POS payment accounting', () => {
  it('accepts exact split tenders and rejects over-tender for ordinary/protected orders', () => {
    const exact = {
      total: 10_000,
      tip: 0,
      payment_method: 'CARD',
      payment_amount: 10_000,
      change_amount: 0,
      payment_tenders: JSON.stringify([
        { method: 'CARD', amount: 6_000 },
        { method: 'CASH', amount: 4_000 },
      ]),
    };
    expect(() => assertPosPaymentAccounting(exact)).not.toThrow();
    expect(() => assertPosPaymentAccounting({
      ...exact,
      payment_amount: 20_000,
      payment_tenders: JSON.stringify([
        { method: 'CARD', amount: 10_000 },
        { method: 'CASH', amount: 10_000 },
      ]),
    })).toThrow(/exact payable total/i);
  });

  it('keeps cash received and change separate from accounting total', () => {
    expect(() => assertPosPaymentAccounting({
      total: 10_000,
      tip: 500,
      payment_method: 'CASH',
      payment_amount: 12_000,
      change_amount: 1_500,
      payment_tenders: null,
    })).not.toThrow();
    expect(() => assertPosPaymentAccounting({
      total: 10_000,
      payment_method: 'CASH',
      payment_amount: 12_000,
      change_amount: 0,
    })).toThrow(/cash received\/change/i);
  });

  it('requires exact non-cash accounting', () => {
    expect(() => assertPosPaymentAccounting({
      total: 10_000,
      payment_method: 'CARD',
      payment_amount: 10_001,
      change_amount: 0,
    })).toThrow(/non-cash/i);
  });

  it('rejects forged credit, SPLIT, unknown, and mismatched protected tenders', () => {
    const base = {
      total: 10_000,
      payment_amount: 10_000,
      change_amount: 0,
    };
    for (const payment_method of ['CREDIT', 'SPLIT', 'CRYPTO']) {
      expect(() => assertProtectedPosPaymentMethods({ ...base, payment_method }))
        .toThrow(/not supported/i);
    }
    expect(() => assertProtectedPosPaymentMethods({
      ...base,
      payment_method: 'CARD',
      payment_tenders: JSON.stringify([
        { method: 'CARD', amount: 4_000 },
        { method: 'CREDIT', amount: 6_000 },
      ]),
    })).toThrow(/tender method CREDIT/i);
    expect(() => assertProtectedPosPaymentMethods({
      ...base,
      payment_method: 'CARD',
      payment_tenders: JSON.stringify([
        { method: 'CARD', amount: 4_000 },
        { method: 'CASH', amount: 6_000 },
      ]),
    })).toThrow(/largest tender/i);
  });

  it('accepts renderer/backend protected payment methods and exact split primary', () => {
    for (const payment_method of ['CASH', 'CARD', 'BLIK', 'TRANSFER', 'BANK_TRANSFER', 'INVOICE']) {
      expect(() => assertProtectedPosPaymentMethods({ payment_method })).not.toThrow();
    }
    expect(() => assertProtectedPosPaymentMethods({
      payment_method: 'CASH',
      payment_tenders: JSON.stringify([
        { method: 'CARD', amount: 4_000 },
        { method: 'CASH', amount: 6_000 },
      ]),
    })).not.toThrow();
  });
});
