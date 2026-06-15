import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatKitchenSelfOrderNumber,
  normalizeKitchenSelfOrderQuantity,
  resolveKitchenSelfOrderBrandName,
  sanitizeKitchenSelfOrderNote,
} from '../src/shared/kitchen-self-order';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('kitchen self-order MVP wiring', () => {
  it('formats customer-facing order numbers as K-042 style', () => {
    expect(formatKitchenSelfOrderNumber(1)).toBe('K-001');
    expect(formatKitchenSelfOrderNumber(42)).toBe('K-042');
    expect(formatKitchenSelfOrderNumber(1002)).toBe('K-1002');
  });

  it('normalizes kiosk quantities and notes before persistence', () => {
    expect(normalizeKitchenSelfOrderQuantity(0)).toBe(1);
    expect(normalizeKitchenSelfOrderQuantity(200)).toBe(99);
    expect(sanitizeKitchenSelfOrderNote('  no   onion  ')).toBe('no onion');
    expect(sanitizeKitchenSelfOrderNote('')).toBeNull();
  });

  it('uses separate local tables instead of POS orders/order_items', () => {
    const migrationSource = readSource('src/main/database/migrations.ts');
    const repoSource = readSource('src/main/database/repos/kitchen-self-order-repo.ts');

    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS kitchen_self_orders');
    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS kitchen_self_order_items');
    expect(repoSource).toContain('formatKitchenSelfOrderNumber(sequence)');
    expect(repoSource).not.toContain('INSERT INTO orders');
    expect(repoSource).not.toContain('INSERT INTO order_items');
  });

  it('has a separate window, preload, Vite entry, and IPC namespace', () => {
    const windowSource = readSource('src/main/windows/window-manager.ts');
    const viteSource = readSource('vite.config.ts');
    const preloadSource = readSource('src/preload/preload-kitchen-self-order.ts');
    const posModuleSource = readSource('src/main/modules/pos.module.ts');

    expect(windowSource).toContain('kitchenSelfOrder');
    expect(windowSource).toContain('preload-kitchen-self-order.js');
    expect(viteSource).toContain('windows/kitchen-self-order/index.html');
    expect(preloadSource).toContain('kitchen-self-order:submit');
    expect(posModuleSource).toContain("ipcMain.handle('kitchen-self-order:submit'");
    expect(posModuleSource).toContain('printKitchenSelfOrderTicket(ticket)');
    expect(posModuleSource).toContain('printKitchenSelfOrderCustomerSlip(ticket)');
  });

  it('prints unpaid kitchen tickets and QR customer slips before cashier payment', () => {
    const posModuleSource = readSource('src/main/modules/pos.module.ts');
    const ticketSource = readSource('src/main/printing/kitchen-ticket.ts');
    const formatterSource = readSource('src/main/hardware/thermal/escpos-formatter.ts');

    expect(posModuleSource).toContain('buildKitchenSelfOrderQrPayload(created)');
    expect(posModuleSource).toContain('compactKitchenSelfOrderQrOptions');
    expect(posModuleSource).not.toContain('productId: item.product_id');
    expect(posModuleSource).toContain("paymentStatus: 'UNPAID'");
    expect(posModuleSource).toContain('qrPayload,');
    expect(ticketSource).toContain('NIEOPLACONE / CHUA TRA TIEN');
    expect(ticketSource).toContain('qrData: data.qrPayload');
    expect(formatterSource).toContain('formatQRCode(line.qrData');
  });

  it('lets the cashier POS scan the pickup-slip QR into the normal payment cart', () => {
    const layoutSource = readSource('src/renderer/components/pos/POSLayout.tsx');

    expect(layoutSource).toContain('decodeKitchenSelfOrderQr(code)');
    expect(layoutSource).toContain('loadKitchenSelfOrderQr(kioskOrder)');
    expect(layoutSource).toContain('window.electronAPI.pos.products.getById(variantId)');
    expect(layoutSource).toContain('const cartItems: CartItem[] = []');
    expect(layoutSource).toContain('saleClass.requiresScale');
    expect(layoutSource).toContain('await window.electronAPI.pos.dispatch');
    expect(layoutSource).toContain("type: 'cart/addItem'");
  });

  it('operator launch settings are separate from store self-checkout settings', () => {
    const tabSource = readSource('src/renderer/components/SelfCheckoutTab.tsx');

    expect(tabSource).toContain("window.open('kitchenSelfOrder')");
    expect(tabSource).toContain('kitchenSelfOrderLanguage');
    expect(tabSource).toContain('kitchenSelfOrderDefaultFulfillment');
    expect(tabSource).toContain('kitchenSelfOrderSlipPrinterType');
    expect(tabSource).toContain('selfCheckoutProfile');
  });

  it('opens directly on the menu while keeping language and fulfillment editable inline', () => {
    const appSource = readSource('src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx');

    expect(appSource).toContain("useState<Step>('menu')");
    expect(appSource).toContain('function FulfillmentToggle');
    expect(appSource).toContain('function LanguageToggle');
    expect(appSource).not.toContain("setStep('language')");
    expect(appSource).not.toContain("setStep('fulfillment')");
  });

  it('uses tenant brand copy instead of the old Saigon MVP placeholder', () => {
    expect(resolveKitchenSelfOrderBrandName({
      kitchenSelfOrderBrandName: 'BuBu Bubble Tea',
      salonName: 'Wrong Store',
    })).toBe('BuBu Bubble Tea');
    expect(resolveKitchenSelfOrderBrandName({ salonName: 'Bubu Cafe' })).toBe('Bubu Cafe');
    expect(resolveKitchenSelfOrderBrandName({ authUser: { salonName: 'Auth Cafe' } })).toBe('Auth Cafe');
    expect(resolveKitchenSelfOrderBrandName({})).toBe('Zira POS');

    const appSource = readSource('src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx');
    expect(appSource).not.toMatch(/Saigon Market/i);
    expect(appSource).toContain('menu?.brand.name');
    expect(appSource).toContain('menu?.brand.logoUrl');
    expect(appSource).toContain('menuLabel={t.menu}');
  });

  it('renders drink-friendly product images and does not show food modifier chips globally', () => {
    const appSource = readSource('src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx');

    expect(appSource).not.toContain('h-24 w-full object-cover');
    expect(appSource).toContain('object-contain');
    expect(appSource).not.toContain('QUICK_OPTIONS');
    expect(appSource).not.toContain('no onion');
    expect(appSource).not.toContain('less spicy');
  });

  it('prioritizes a four-column visual catalog over an oversized cart rail', () => {
    const appSource = readSource('src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx');
    const cssSource = readSource('src/renderer/index.css');

    expect(appSource).toContain('grid-cols-[minmax(0,1fr)_320px]');
    expect(appSource).toContain('className="kso-product-grid"');
    expect(appSource).toContain('className="kso-product-media"');
    expect(cssSource).toContain('@media (min-width: 1280px)');
    expect(cssSource).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(cssSource).toContain('@media (min-width: 1600px)');
    expect(cssSource).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))');
    expect(cssSource).toContain('height: 230px');
    expect(appSource).not.toContain('grid-cols-[minmax(0,1fr)_390px]');
    expect(appSource).not.toContain('h-36 w-full');
  });
});
