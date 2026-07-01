import { describe, expect, it } from 'vitest';
import { resolveFiscalAction } from '../src/renderer/components/pos/payment-fiscal-prompt-mode';

describe('resolveFiscalAction', () => {
  it('skips all fiscal prompt/print work when no fiscal printer is configured', () => {
    expect(resolveFiscalAction({
      printOrderCopy: true,
      hasFiscalPrinter: false,
      method: 'CASH',
      mode: 'always',
    })).toBe('skip');
    expect(resolveFiscalAction({
      printOrderCopy: false,
      hasFiscalPrinter: false,
      method: 'CARD',
      mode: 'ask',
    })).toBe('skip');
  });

  it('keeps the current ask behavior by default for cash/BLIK order-copy sales', () => {
    expect(resolveFiscalAction({
      printOrderCopy: true,
      hasFiscalPrinter: true,
      method: 'CASH',
      mode: undefined,
    })).toBe('prompt');
    expect(resolveFiscalAction({
      printOrderCopy: true,
      hasFiscalPrinter: true,
      method: 'BLIK',
      mode: 'ask',
    })).toBe('prompt');
  });

  it('auto-prints fiscal receipts for cash/BLIK order-copy sales in always mode', () => {
    expect(resolveFiscalAction({
      printOrderCopy: true,
      hasFiscalPrinter: true,
      method: 'CASH',
      mode: 'always',
    })).toBe('autoPrint');
    expect(resolveFiscalAction({
      printOrderCopy: true,
      hasFiscalPrinter: true,
      method: 'BLIK',
      mode: 'always',
    })).toBe('autoPrint');
  });

  it('skips fiscal receipts for cash/BLIK order-copy sales in never mode', () => {
    expect(resolveFiscalAction({
      printOrderCopy: true,
      hasFiscalPrinter: true,
      method: 'CASH',
      mode: 'never',
    })).toBe('skip');
    expect(resolveFiscalAction({
      printOrderCopy: true,
      hasFiscalPrinter: true,
      method: 'BLIK',
      mode: 'never',
    })).toBe('skip');
  });

  it('leaves card and transfer fiscal auto-printing unaffected by cash/BLIK mode', () => {
    expect(resolveFiscalAction({
      printOrderCopy: false,
      hasFiscalPrinter: true,
      method: 'CARD',
      mode: 'never',
    })).toBe('autoPrint');
    expect(resolveFiscalAction({
      printOrderCopy: false,
      hasFiscalPrinter: true,
      method: 'TRANSFER',
      mode: 'ask',
    })).toBe('autoPrint');
  });

  it('skips invoice fiscal printing', () => {
    expect(resolveFiscalAction({
      printOrderCopy: false,
      hasFiscalPrinter: true,
      method: 'INVOICE',
      mode: 'always',
    })).toBe('skip');
  });
});
