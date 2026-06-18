import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildKitchenPaymentSlipLines,
  buildKitchenTicketLines,
  buildPickupSlipLines,
  kitchenItemCount,
} from '../src/main/printing/kitchen-ticket';
import type { KitchenTicketData } from '../src/shared/types';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const baseTicket: KitchenTicketData = {
  orderId: 'o-1',
  orderNumber: 'POS-0042',
  createdAt: '2026-06-04T18:30:00.000Z',
  source: 'SELF_CHECKOUT',
  items: [
    { name: 'Phở bò', quantity: 2 },
    { name: 'Chả giò', quantity: 1, notes: 'không hành' },
  ],
};

describe('kitchen ticket builder', () => {
  it('renders header, order number, source, and items — never prices', () => {
    const lines = buildKitchenTicketLines(baseTicket);
    const text = lines.map((l) => l.text).join('\n');

    expect(text).toContain('KUCHNIA');
    expect(text).toContain('#POS-0042');
    expect(text).toContain('KIOSK'); // SELF_CHECKOUT → KIOSK label
    expect(text).toContain('2x Phở bò');
    expect(text).toContain('1x Chả giò');
    expect(text).toContain('!! không hành');
    expect(text).not.toMatch(/zł|PLN|\d+,\d{2}/); // no money anywhere
  });

  it('keeps kitchen tickets price-free even when payment metadata is present', () => {
    const lines = buildKitchenTicketLines({
      ...baseTicket,
      totalGrosze: 2900,
      items: [
        { name: 'Pho bo', quantity: 2, unitPriceGrosze: 1200, lineTotalGrosze: 2400 },
        { name: 'Cha gio', quantity: 1, unitPriceGrosze: 500, lineTotalGrosze: 500 },
      ],
    });
    const text = lines.map((l) => `${l.text || ''} ${l.rightText || ''}`).join('\n');

    expect(text).toContain('2x Pho bo');
    expect(text).not.toMatch(/zl|zł|PLN|\d+,\d{2}/);
  });

  it('item lines are large and bold for kitchen readability', () => {
    const lines = buildKitchenTicketLines(baseTicket);
    const itemLine = lines.find((l) => l.text.includes('Phở bò'));
    expect(itemLine?.bold).toBe(true);
    expect(itemLine?.textSize).toBe('double-height');
  });

  it('marks reprints as a copy', () => {
    const lines = buildKitchenTicketLines({ ...baseTicket, isReprint: true });
    expect(lines.map((l) => l.text).join('\n')).toContain('KOPIA');
  });

  it('renders weighted quantities with their unit, trimmed', () => {
    const lines = buildKitchenTicketLines({
      ...baseTicket,
      items: [{ name: 'Thịt ba chỉ', quantity: 0.5, unit: 'kg' }],
    });
    expect(lines.map((l) => l.text).join('\n')).toContain('0.5 kg Thịt ba chỉ');
  });

  it('labels the cashier POS source as KASA', () => {
    const lines = buildKitchenTicketLines({ ...baseTicket, source: 'POS' });
    expect(lines.map((l) => l.text).join('\n')).toContain('KASA');
  });

  it('renders kitchen self-order tickets in Vietnamese with fulfillment and K-number', () => {
    const lines = buildKitchenTicketLines({
      ...baseTicket,
      orderNumber: 'K-042',
      pickupNumber: 'K-042',
      source: 'KIOSK PC-YURI',
      fulfillmentType: 'TAKEAWAY',
      kitchenLanguage: 'vi',
      items: [{ name: 'Pho bo', quantity: 2, notes: 'it cay' }],
    });
    const text = lines.map((l) => l.text).join('\n');

    expect(text).toContain('*** BEP ***');
    expect(text).toContain('K-042');
    expect(text).not.toContain('CHUA TRA TIEN');
    expect(text).toContain('MANG DI');
    expect(text).toContain('KIOSK PC-YURI');
    expect(text).toContain('!! it cay');
    expect(text).not.toContain('#K-042');
  });

  it('renders each modifier on its own » line, the note on a !! line, and a header count', () => {
    const lines = buildKitchenTicketLines({
      ...baseTicket,
      kitchenLanguage: 'vi',
      items: [
        { name: 'Trà sữa', quantity: 2, modifiers: ['Đường: 50%', 'Đá: ít'], notes: 'ít đá giùm em' },
        { name: 'Chè thái', quantity: 1, modifiers: ['+ trân châu'] },
      ],
    });
    const text = lines.map((l) => l.text).join('\n');

    expect(text).toContain('» Đường: 50%');
    expect(text).toContain('» Đá: ít');
    expect(text).toContain('» + trân châu');
    expect(text).toContain('!! ít đá giùm em');
    expect(text).toContain('· 3 món'); // 2 + 1
  });

  it('marks kitchen self-order tickets as unpaid when sent before cashier payment', () => {
    const lines = buildKitchenTicketLines({
      ...baseTicket,
      orderNumber: 'K-043',
      source: 'KIOSK PC-YURI',
      kitchenLanguage: 'vi',
      paymentStatus: 'UNPAID',
    });
    const text = lines.map((l) => l.text).join('\n');

    expect(text).toContain('K-043');
    expect(text).toContain('NIEOPLACONE');
    expect(text).toContain('CHUA TRA TIEN');
  });
});

describe('pickup number (so nhan do)', () => {
  it('prints the number big on the kitchen ticket', () => {
    const lines = buildKitchenTicketLines({ ...baseTicket, pickupNumber: '0007' });
    const numberLine = lines.find((l) => l.text === '0007');
    expect(numberLine?.textSize).toBe('double-size');
    expect(numberLine?.bold).toBe(true);
  });

  it('builds a customer slip with the same number, order ref, and no prices', () => {
    const lines = buildPickupSlipLines({ ...baseTicket, pickupNumber: '0007', kind: 'PICKUP_SLIP' });
    const text = lines.map((l) => l.text).join('\n');
    expect(text).toContain('NR ODBIORU');
    expect(text).toContain('0007');
    expect(text).toContain('#POS-0042');
    expect(text).not.toMatch(/zł|PLN|\d+,\d{2}/);
  });

  it('uses the configured brand name on customer pickup slips', () => {
    const lines = buildPickupSlipLines({
      ...baseTicket,
      brandName: 'BuBu Bubble Tea',
      pickupNumber: '0008',
      kind: 'PICKUP_SLIP',
    });
    const text = lines.map((l) => l.text).join('\n');

    expect(text).toContain('BuBu Bubble Tea');
    expect(text).not.toContain('SAIGON MARKET');
  });

  it('prints a QR payload on unpaid kiosk pickup slips for cashier recall', () => {
    const lines = buildPickupSlipLines({
      ...baseTicket,
      orderNumber: 'K-044',
      pickupNumber: 'K-044',
      kind: 'PICKUP_SLIP',
      customerLanguage: 'en',
      qrPayload: 'KSO1:test',
    });

    expect(lines.some((line) => line.qrData === 'KSO1:test' && line.qrSize === 5)).toBe(true);
    expect(lines.map((l) => l.text).join('\n')).toContain('Scan at cashier');
  });

  it('builds a self-order payment slip with item totals, customer total, and QR recall', () => {
    const lines = buildKitchenPaymentSlipLines({
      ...baseTicket,
      brandName: 'BuBu Bubble Tea',
      orderNumber: 'K-042',
      pickupNumber: 'K-042',
      customerLanguage: 'vi',
      fulfillmentType: 'TAKEAWAY',
      totalGrosze: 2900,
      qrPayload: 'KSO1:test',
      items: [
        { name: 'Pho bo', quantity: 2, unitPriceGrosze: 1200, lineTotalGrosze: 2400 },
        { name: 'Cha gio', quantity: 1, unitPriceGrosze: 500, lineTotalGrosze: 500 },
      ],
    });
    const text = lines.map((l) => `${l.text || ''} ${l.rightText || ''}`).join('\n');

    expect(text).toContain('BuBu Bubble Tea');
    expect(text).toContain('THANH TOAN TAI QUAY');
    expect(text).toContain('K-042');
    expect(text).toContain('MANG DI');
    expect(text).toContain('2x Pho bo 24,00 zl');
    expect(text).toContain('TONG CONG 29,00 zl');
    expect(lines.some((line) => line.qrData === 'KSO1:test' && line.qrSize === 5)).toBe(true);
  });

  it('payment slip renders modifiers and note and shows an item count', () => {
    const lines = buildKitchenPaymentSlipLines({
      ...baseTicket,
      customerLanguage: 'vi',
      totalGrosze: 3400,
      items: [
        { name: 'Trà sữa', quantity: 2, unitPriceGrosze: 1200, modifiers: ['Đường: 50%'], notes: 'ít đá' },
      ],
    });
    const text = lines.map((l) => l.text).join('\n');

    expect(text).toContain('» Đường: 50%');
    expect(text).toContain('!! ít đá');
    expect(text).toContain('· 2 món');
  });

  it('does not assign a new kitchen number to normal POS order creates', () => {
    const posModuleSource = readSource('src/main/modules/pos.module.ts');
    const repoSource = readSource('src/main/database/repos/order-repo.ts');

    expect(posModuleSource).not.toContain('normalizedOrder.kitchen_number = orderRepo.nextKitchenNumber()');
    expect(posModuleSource).not.toContain('const hasKitchenItems = (normalizedItems || []).some');
    expect(repoSource).toContain("date(created_at) = date('now')");
    expect(repoSource).toContain("String(next).padStart(4, '0')");
  });

  it('routes the slip to the shared receipt printer and returns the number to the kiosk', () => {
    const posModuleSource = readSource('src/main/modules/pos.module.ts');
    const sharedSource = readSource('src/main/printing/shared-kitchen-printer.ts');
    const appSource = readSource('src/renderer/windows/self-checkout/SelfCheckoutApp.tsx');
    const receiptSource = readSource('src/renderer/windows/self-checkout/screens/ReceiptScreen.tsx');

    expect(posModuleSource).toContain('submitSharedPickupSlip(slip)');
    expect(posModuleSource).toContain('pickupNumber,');
    expect(sharedSource).toContain("SHARED_SLIP_ROLE: SalonPrinterRole = 'SELF_CHECKOUT_RECEIPT'");
    expect(appSource).toContain('setLastPickupNumber(printResult?.pickupNumber ?? null)');
    expect(receiptSource).toContain('t.pickupNumberLabel');
  });
});

describe('kitchen ticket pipeline wiring', () => {
  it('does not auto-print kitchen tickets from normal POS order creation', () => {
    const posModuleSource = readSource('src/main/modules/pos.module.ts');

    expect(posModuleSource).not.toContain('void this.printKitchenTicketForOrder(id)');
    expect(posModuleSource).not.toContain("'pos:kitchen-ticket-failed'");
    expect(posModuleSource).not.toContain("ipcMain.handle('pos:orders:printKitchenTicket'");
  });

  it('self-order kitchen release prefers the dedicated local kitchen printer and never the receipt fallback', () => {
    const posModuleSource = readSource('src/main/modules/pos.module.ts');
    expect(posModuleSource).toContain('printers[PrinterType.KITCHEN]');
    expect(posModuleSource).toContain('submitSharedKitchenPrint(ticket)');
  });

  it('routes remote jobs through the KITCHEN role and handles them on the receiving POS', () => {
    const sharedSource = readSource('src/main/printing/shared-kitchen-printer.ts');
    const hardwareSource = readSource('src/main/modules/hardware.module.ts');

    expect(sharedSource).toContain("SHARED_KITCHEN_ROLE: SalonPrinterRole = 'KITCHEN'");
    expect(sharedSource).toContain('jobType: PrintJobType.KITCHEN_TICKET');
    expect(sharedSource).toContain('waitForCompletion: false');
    expect(hardwareSource).toContain('job.jobType === PrintJobType.KITCHEN_TICKET');
    expect(hardwareSource).toContain('buildKitchenTicketLines(ticket)');
  });

  it('keeps the kitchen flag synced and locally mirrored on toggle', () => {
    const posModuleSource = readSource('src/main/modules/pos.module.ts');
    const repoSource = readSource('src/main/database/repos/product-repo.ts');
    const apiClientSource = readSource('src/main/network/api-client.ts');
    const applicatorSource = readSource('src/main/sync/entity-applicators.ts');

    expect(posModuleSource).toContain('setCategoryKitchenPrint(categoryId, payload.kitchenPrint)');
    expect(repoSource).toContain('isKitchenPrintCategory(categoryId: string)');
    // Sync must PRESERVE the locally-known flag when an older backend payload
    // omits it instead of silently resetting it to 0.
    expect(repoSource).toContain('COALESCE(?, (SELECT kitchen_print FROM categories WHERE id = ?), 0)');
    expect(apiClientSource).toContain('cat.kitchenPrint');
    expect(applicatorSource).toContain("firstOwnValue(p, ['kitchenPrint', 'kitchen_print'])");
  });

  it('exposes the Settings toggle without exposing a POS Order History kitchen-print action', () => {
    const settingsSource = readSource('src/renderer/components/Settings.tsx');
    const kitchenSettingsSource = readSource('src/renderer/components/pos/KitchenPrintSettings.tsx');
    const modalSource = readSource('src/renderer/components/pos/OrderHistoryModal.tsx');

    expect(settingsSource).toContain('<KitchenPrintSettings');
    expect(kitchenSettingsSource).toContain('updateCategory(category.id');
    expect(kitchenSettingsSource).toContain('kitchenPrint: next');
    expect(modalSource).not.toContain('handlePrintKitchenTicket(order.id)');
    expect(modalSource).not.toContain('pos.history.printKitchenTicket');
  });
});

describe('kitchenItemCount', () => {
  it('sums piece quantities and counts weighted items as one', () => {
    expect(kitchenItemCount([{ name: 'a', quantity: 2 }, { name: 'b', quantity: 1 }])).toBe(3);
    expect(kitchenItemCount([{ name: 'a', quantity: 0.5, unit: 'kg' }])).toBe(1);
    expect(kitchenItemCount([
      { name: 'a', quantity: 2, unit: 'szt' },
      { name: 'b', quantity: 0.75, unit: 'kg' },
    ])).toBe(3);
  });
});
