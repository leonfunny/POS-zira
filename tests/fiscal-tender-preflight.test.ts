import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertTenderFiscalCompatibilityForProtocol,
  hasTenderFiscalDiscount,
} from '../src/main/pos/fiscal-tender-preflight';

describe('protected tender fiscal preflight', () => {
  it('uses the checkout-level discount for restored carts on ELZAB', () => {
    const lines = [{ vatRate: 23 }];
    expect(hasTenderFiscalDiscount(lines, { checkoutDiscountGrosze: 100 })).toBe(true);
    expect(() => assertTenderFiscalCompatibilityForProtocol(
      'ELZAB_STX',
      lines,
      { checkoutDiscountGrosze: 100 },
    )).toThrow('ELZAB_LINE_DISCOUNT_UNSUPPORTED');
  });

  it('keeps the exact POSNET VAT allowlist fail-closed', () => {
    for (const vatRate of [23, 8, 5, 0, -1]) {
      expect(() => assertTenderFiscalCompatibilityForProtocol('POSNET', [{ vatRate }])).not.toThrow();
    }
    expect(() => assertTenderFiscalCompatibilityForProtocol('POSNET', [{ vatRate: 7 }]))
      .toThrow(/VAT/i);
  });

  it('resolves the actual local-first or assigned shared protocol before protected tender', () => {
    const source = readFileSync(new URL('../src/main/modules/pos.module.ts', import.meta.url), 'utf8');
    expect(source).toContain('const localPrinter = this.getLocalPrinterForType(PrinterType.FISCAL)');
    expect(source).toContain('const shared = await getSharedFiscalPrinterStatus()');
    expect(source).toContain('SHARED_FISCAL_PROTOCOL_UNKNOWN_FOR_DISCOUNT');
    expect(source).toContain('await this.assertTenderFiscalCompatibility(record.bundle.lines, record.bundle.discountGrosze)');
    expect(source).toContain('await this.assertTenderFiscalCompatibility(state.cart.items, state.cart.discount)');
  });
});
