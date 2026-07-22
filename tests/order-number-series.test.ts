import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

// Two independent daily numbering series: fiscal sales keep POS-YYYYMMDD-####
// (same counter as before), order-copy-only sales (cash/BLIK without fiscal,
// invoice) get their own ZAM-YYYYMMDD-#### counter so non-fiscal slips never
// interleave with — or reveal gaps in — the fiscal series.
describe('order number series split', () => {
  const repoSource = readSource('src/main/database/repos/order-repo.ts');
  const modalSource = readSource('src/renderer/components/pos/PaymentModal.tsx');

  it('uses two separate atomic counters with distinct prefixes', () => {
    expect(repoSource).toContain("generateOrderNumber(series: 'FISCAL' | 'ORDER' = 'FISCAL')");
    expect(repoSource).toContain("series === 'ORDER' ? `order-copy-${datePrefix}` : `order-${datePrefix}`");
    expect(repoSource).toContain("series === 'ORDER' ? 'ZAM' : 'POS'");
  });

  it('create() respects the series hint, defaulting to FISCAL', () => {
    expect(repoSource).toContain("order.number_series === 'ORDER' ? 'ORDER' : 'FISCAL'");
  });

  it('cashier assigns ZAM to cash/BLIK/invoice and POS to card/transfer', () => {
    expect(modalSource).toContain("seriesHasCash || seriesHasBlik || paymentMethod === 'INVOICE' ? 'ORDER' : 'FISCAL'");
    expect(modalSource).toContain('number_series: numberSeries');
  });

  it('kiosk orders stay on the fiscal series (no series hint = default)', () => {
    const buildSaleSource = readSource('src/renderer/windows/self-checkout/build-sale.ts');
    expect(buildSaleSource).not.toContain('number_series');
    expect(buildSaleSource).toContain('order_number: null');
  });

  it('remote cash-drawer inference recognizes both prefixes', () => {
    const hardwareSource = readSource('src/main/modules/hardware.module.ts');
    expect(hardwareSource).toContain('/^(POS|ZAM)[-\\d]/i.test(orderNumber)');
  });
});
