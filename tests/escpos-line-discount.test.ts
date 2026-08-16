/**
 * Non-fiscal order copies itemize manual per-line discounts under their
 * product (post-UOKiK Lidl/Biedronka style): a "Rabat: -x,xx" line follows the
 * discounted item, while the receipt-level rabat row still shows the combined
 * total before DO ZAPLATY.
 */
import { describe, expect, it } from 'vitest';
import { EscPosFormatter } from '../src/main/hardware/thermal/escpos-formatter';
import type { ReceiptData } from '../src/shared/types';

function buildReceiptData(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    orderNumber: 'POS-20260816-0001',
    sellerName: 'Bao Han Sp. z o.o.',
    sellerAddress: 'ul. Testowa 1, 00-001 Warszawa',
    sellerNip: '5220052349',
    items: [
      { name: 'Pho bo', quantity: 1, unitPrice: 2500, totalPrice: 2500, displayLineDiscount: 250, vatRate: 8 },
      { name: 'Bia Saigon', quantity: 2, unitPrice: 1500, totalPrice: 3000, vatRate: 23 },
    ],
    payment: { method: 'CASH', amount: 5250 },
    subtotal: 5500,
    discount: 250,
    total: 5250,
    cashierName: 'Anna',
    ...overrides,
  };
}

describe('EscPosFormatter per-line discounts', () => {
  it('formatReceipt prints Rabat under the discounted item only', () => {
    const fmt = new EscPosFormatter(42);
    const text = fmt.formatReceipt(buildReceiptData()).toString('utf8');
    const phoIdx = text.indexOf('Pho bo');
    const rabatIdx = text.indexOf('Rabat:', phoIdx);
    const biaIdx = text.indexOf('Bia Saigon');
    expect(phoIdx).toBeGreaterThan(-1);
    expect(rabatIdx).toBeGreaterThan(phoIdx);
    expect(rabatIdx).toBeLessThan(biaIdx); // sits under its item, not at the end
    expect(text).toContain('-2,50');
  });

  it('formatReceiptPlainLines itemizes the line rabat too', () => {
    const fmt = new EscPosFormatter(42);
    const lines = fmt.formatReceiptPlainLines(buildReceiptData());
    const texts = lines.map((l: any) => l.text ?? '');
    const phoIdx = texts.findIndex((t: string) => t.includes('Pho bo'));
    const rabatIdx = texts.findIndex((t: string, i: number) => i > phoIdx && t.includes('Rabat:'));
    const biaIdx = texts.findIndex((t: string) => t.includes('Bia Saigon'));
    expect(rabatIdx).toBeGreaterThan(phoIdx);
    expect(rabatIdx).toBeLessThan(biaIdx);
  });

  it('items without displayLineDiscount stay unchanged', () => {
    const fmt = new EscPosFormatter(42);
    const data = buildReceiptData();
    data.items = [{ name: 'Mleko', quantity: 1, unitPrice: 350, totalPrice: 350, vatRate: 8 }];
    data.subtotal = 350;
    data.discount = 0;
    data.total = 350;
    const text = fmt.formatReceipt(data).toString('utf8');
    expect(text).not.toContain('Rabat:');
  });
});
