import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertBilliardRealFiscalGate,
  assertTenderFiscalCompatibilityForProtocol,
  hasTenderFiscalDiscount,
  requiresBilliardFiscalPrinterReadiness,
} from '../src/main/pos/fiscal-tender-preflight';

describe('protected tender fiscal preflight', () => {
  it('requires readiness for an enabled or detected POSNET route even when the ELZAB kill switch is off', () => {
    expect(requiresBilliardFiscalPrinterReadiness({
      allowRealFiscalPrint: false,
      fiscalOnCashSale: 'ask',
      localFiscalEnabled: true,
      detectedFiscalConfigured: false,
    })).toBe(true);
    expect(requiresBilliardFiscalPrinterReadiness({
      allowRealFiscalPrint: false,
      fiscalOnCashSale: 'ask',
      localFiscalEnabled: false,
      detectedFiscalConfigured: true,
    })).toBe(true);
  });

  it('allows non-fiscal test checkout only when no fiscal route is expected', () => {
    expect(requiresBilliardFiscalPrinterReadiness({
      allowRealFiscalPrint: false,
      fiscalOnCashSale: 'ask',
      localFiscalEnabled: false,
      detectedFiscalConfigured: false,
    })).toBe(false);
  });

  it('blocks a configured fiscal route before Billiard end-session while the production gate is off', () => {
    expect(() => assertBilliardRealFiscalGate({
      allowRealFiscalPrint: false,
      fiscalOnCashSale: 'ask',
      localFiscalEnabled: true,
      detectedFiscalConfigured: false,
    })).toThrow('REAL_FISCAL_PRINT_DISABLED');
    expect(() => assertBilliardRealFiscalGate({
      allowRealFiscalPrint: false,
      fiscalOnCashSale: 'always',
      localFiscalEnabled: false,
      detectedFiscalConfigured: false,
    })).toThrow('REAL_FISCAL_PRINT_DISABLED');
  });

  it('allows a configured fiscal route only after the controlled go-live flag is enabled', () => {
    expect(() => assertBilliardRealFiscalGate({
      allowRealFiscalPrint: true,
      fiscalOnCashSale: 'ask',
      localFiscalEnabled: true,
      detectedFiscalConfigured: true,
    })).not.toThrow();
    expect(() => assertBilliardRealFiscalGate({
      allowRealFiscalPrint: false,
      fiscalOnCashSale: 'ask',
      localFiscalEnabled: false,
      detectedFiscalConfigured: false,
    })).not.toThrow();
  });

  it('uses the checkout-level discount for restored carts on ELZAB', () => {
    const lines = [{ vatRate: 23 }];
    expect(hasTenderFiscalDiscount(lines, { checkoutDiscountGrosze: 100 })).toBe(true);
    expect(() => assertTenderFiscalCompatibilityForProtocol(
      'ELZAB_STX',
      lines,
      { checkoutDiscountGrosze: 100 },
    )).toThrow('ELZAB_LINE_DISCOUNT_UNSUPPORTED');
  });

  it('lets an ordinary discounted checkout tender on ELZAB while per-line allocations stay blocked', () => {
    // Ordinary retail commits pass no checkout-level discount — the sidecar
    // prints it whole-receipt via ReceiptEndEx (chesaigon POS1 regression,
    // 2026-07-23: 100%-discount ingredient sales could not be tendered).
    const ordinaryLines = [{ vatRate: 23 }, { vatRate: 8 }];
    expect(hasTenderFiscalDiscount(ordinaryLines)).toBe(false);
    expect(() => assertTenderFiscalCompatibilityForProtocol('ELZAB_STX', ordinaryLines)).not.toThrow();
    expect(() => assertTenderFiscalCompatibilityForProtocol(
      'ELZAB_STX',
      [{ vatRate: 23, allocatedDiscountGrosze: 100 }],
    )).toThrow('ELZAB_LINE_DISCOUNT_UNSUPPORTED');
  });

  it('lets a manual per-product discount tender on ELZAB; only frozen Billiard allocations stay blocked', () => {
    // PaymentModal persists the cashier's per-product discount in the same
    // order_items.allocated_discount column Billiard uses. It is a display
    // detail on the order copy: the sum is already inside the whole-receipt
    // rabat, so ELZAB prints it fine via ReceiptEndEx (chesaigon POS
    // regression, 2026-08-28: every line-discounted sale was refused at commit).
    const manualLines = [
      { vat_rate: 23, allocated_discount: 500, billiard_json: null },
      { vat_rate: 8, allocated_discount: 0, billiard_json: null },
    ];
    expect(hasTenderFiscalDiscount(manualLines)).toBe(false);
    expect(() => assertTenderFiscalCompatibilityForProtocol('ELZAB_STX', manualLines)).not.toThrow();

    // The frozen Billiard allocation on the same column is still refused.
    const billiardLines = [
      { vat_rate: 23, allocated_discount: 500, billiard_json: JSON.stringify({ allocatedDiscountGrosze: 500 }) },
    ];
    expect(hasTenderFiscalDiscount(billiardLines)).toBe(true);
    expect(() => assertTenderFiscalCompatibilityForProtocol('ELZAB_STX', billiardLines))
      .toThrow('ELZAB_LINE_DISCOUNT_UNSUPPORTED');
    expect(() => assertTenderFiscalCompatibilityForProtocol(
      'ELZAB_STX',
      [{ vat_rate: 23, billiard: { allocatedDiscountGrosze: 500 } as any }],
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
    // Ordinary commits must not feed the retail checkout discount into the
    // protected-tender gate — that regressed every discounted sale on ELZAB
    // registers (chesaigon POS1, 2026-07-23).
    expect(source).toContain('this.assertLocalTenderFiscalCompatibility(normalizedItems);');
    expect(source).not.toContain('this.assertLocalTenderFiscalCompatibility(normalizedItems, Number(normalizedOrder.discount)');
  });
});
