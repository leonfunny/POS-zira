import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildKitchenTicketLines, buildPickupSlipLines } from '../src/main/printing/kitchen-ticket';
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
    expect(text).toContain('>> không hành');
    expect(text).not.toMatch(/zł|PLN|\d+,\d{2}/); // no money anywhere
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
    expect(text).toContain('MANG DI');
    expect(text).toContain('KIOSK PC-YURI');
    expect(text).toContain('Ghi chu: it cay');
    expect(text).not.toContain('#K-042');
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

  it('assigns a daily 4-digit number at order create when kitchen items exist', () => {
    const posModuleSource = readSource('src/main/modules/pos.module.ts');
    const repoSource = readSource('src/main/database/repos/order-repo.ts');

    expect(posModuleSource).toContain('normalizedOrder.kitchen_number = orderRepo.nextKitchenNumber()');
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
  it('fires after order create, never blocking the sale, and skips duplicates', () => {
    const posModuleSource = readSource('src/main/modules/pos.module.ts');

    expect(posModuleSource).toContain('void this.printKitchenTicketForOrder(id)');
    expect(posModuleSource).toContain("'pos:kitchen-ticket-failed'");
    expect(posModuleSource).toContain("ipcMain.handle('pos:orders:printKitchenTicket'");
    // The idempotent duplicate-create return happens in the catch BEFORE the
    // kitchen hook, so a retried sale can't print a second ticket.
    const dupIndex = posModuleSource.indexOf('duplicate: true');
    const hookIndex = posModuleSource.indexOf('void this.printKitchenTicketForOrder(id)');
    expect(dupIndex).toBeGreaterThan(hookIndex);
  });

  it('prefers the dedicated local kitchen printer and never the receipt fallback', () => {
    const posModuleSource = readSource('src/main/modules/pos.module.ts');
    expect(posModuleSource).toContain('printers[PrinterType.KITCHEN]');
    expect(posModuleSource).toContain('submitSharedKitchenPrint(ticket)');
  });

  it('routes remote jobs through the KITCHEN role and handles them on the receiving POS', () => {
    const sharedSource = readSource('src/main/printing/shared-kitchen-printer.ts');
    const hardwareSource = readSource('src/main/modules/hardware.module.ts');

    expect(sharedSource).toContain("SHARED_KITCHEN_ROLE: SalonPrinterRole = 'KITCHEN'");
    expect(sharedSource).toContain('jobType: PrintJobType.KITCHEN_TICKET');
    expect(sharedSource).toContain('waitForCompletion: true');
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

  it('exposes the Settings toggle and the Order History reprint button', () => {
    const settingsSource = readSource('src/renderer/components/Settings.tsx');
    const kitchenSettingsSource = readSource('src/renderer/components/pos/KitchenPrintSettings.tsx');
    const modalSource = readSource('src/renderer/components/pos/OrderHistoryModal.tsx');

    expect(settingsSource).toContain('<KitchenPrintSettings');
    expect(kitchenSettingsSource).toContain('updateCategory(category.id');
    expect(kitchenSettingsSource).toContain('kitchenPrint: next');
    expect(modalSource).toContain('handlePrintKitchenTicket(order.id)');
    expect(modalSource).toContain('pos.history.printKitchenTicket');
  });
});
