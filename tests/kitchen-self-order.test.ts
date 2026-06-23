import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeKitchenSelfOrderQr,
  encodeKitchenSelfOrderUuidToken,
  formatKitchenSelfOrderNumber,
  normalizeKitchenSelfOrderPriceGrosze,
  normalizeKitchenSelfOrderQuantity,
  resolveKitchenSelfOrderCheckoutUnitPrice,
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
    expect(normalizeKitchenSelfOrderPriceGrosze(-1)).toBe(0);
    expect(normalizeKitchenSelfOrderPriceGrosze(1234.5)).toBe(1235);
    expect(normalizeKitchenSelfOrderPriceGrosze(99_999_999)).toBe(9_999_999);
    expect(sanitizeKitchenSelfOrderNote('  no   onion  ')).toBe('no onion');
    expect(sanitizeKitchenSelfOrderNote('')).toBeNull();
  });

  it('uses QR price snapshots only as checkout fallback data', () => {
    expect(resolveKitchenSelfOrderCheckoutUnitPrice(2900, 1)).toEqual({
      unitPriceGrosze: 2900,
      source: 'CATALOG',
    });
    expect(resolveKitchenSelfOrderCheckoutUnitPrice(0, 2900)).toEqual({
      unitPriceGrosze: 2900,
      source: 'QR_SNAPSHOT',
    });
    expect(resolveKitchenSelfOrderCheckoutUnitPrice(0, 0)).toEqual({
      unitPriceGrosze: 0,
      source: 'NONE',
    });
  });

  it('decodes compact label QR payloads with base64url UUID tokens', () => {
    const orderId = 'b344bf97-a4c3-487f-a63c-990cb293512d';
    const variantId = 'ac45b4fa-d3b8-48e5-81fa-90c9c795ade0';
    const payload = `KSO1:${Buffer.from(JSON.stringify({
      t: 'K',
      v: 1,
      id: encodeKitchenSelfOrderUuidToken(orderId),
      n: 'K-001',
      f: 'D',
      s: 'KIOSK',
      k: 1,
      i: [[encodeKitchenSelfOrderUuidToken(variantId), 2, 2490]],
    }), 'utf8').toString('base64url')}`;

    expect(decodeKitchenSelfOrderQr(payload)).toEqual({
      type: 'KSO',
      version: 1,
      orderNumber: 'K-001',
      orderId,
      fulfillmentType: 'DINE_IN',
      sourceLabel: 'KIOSK',
      kitchenAlreadyReleased: true,
      items: [{
        variantId,
        quantity: 2,
        unitPriceGrosze: 2490,
      }],
    });
  });

  it('uses separate local tables instead of POS orders/order_items', () => {
    const migrationSource = readSource('src/main/database/migrations.ts');
    const repoSource = readSource('src/main/database/repos/kitchen-self-order-repo.ts');

    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS kitchen_self_orders');
    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS kitchen_self_order_items');
    expect(migrationSource).toContain('total_grosze');
    expect(migrationSource).toContain('unit_price_grosze');
    expect(migrationSource).toContain('line_total_grosze');
    expect(repoSource).toContain('formatKitchenSelfOrderNumber(sequence)');
    expect(repoSource).toContain('normalizeKitchenSelfOrderPriceGrosze(item.unitPriceGrosze)');
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
    expect(preloadSource).toContain('kitchen-self-order:reprintSlip');
    expect(posModuleSource).toContain("ipcMain.handle('kitchen-self-order:submit'");
    expect(posModuleSource).toContain("ipcMain.handle('kitchen-self-order:reprintSlip'");
    expect(posModuleSource).toContain('printKitchenSelfOrderTicket(kitchenTicket)');
    expect(posModuleSource).toContain('printKitchenSelfOrderCustomerSlip(ticket)');
  });

  it('prints unpaid kitchen tickets and QR payment slips before cashier payment', () => {
    const posModuleSource = readSource('src/main/modules/pos.module.ts');
    const ticketSource = readSource('src/main/printing/kitchen-ticket.ts');
    const formatterSource = readSource('src/main/hardware/thermal/escpos-formatter.ts');

    expect(posModuleSource).toContain('buildKitchenSelfOrderQrPayload(created, {');
    // The customer slip prints when the kitchen is released — confirmed-printed
    // OR uncertain (LAN timed out, ticket most likely printed) — so the customer
    // always gets a pickup number without dispatching a duplicate kitchen ticket.
    expect(posModuleSource).toContain('const kitchenReleased = kitchenPrint.printed || kitchenPrint.uncertain === true');
    expect(posModuleSource).toContain('kitchenAlreadyReleased: kitchenReleased');
    expect(posModuleSource).toContain('const slipPrint = kitchenReleased');
    expect(posModuleSource).toContain('kitchenPrinted: kitchenReleased');
    expect(posModuleSource).toContain('success = kitchenReleased && slipPrint.printed');
    expect(posModuleSource).toContain('canRetrySlip: kitchenReleased && !slipPrint.printed');
    expect(posModuleSource).toContain('compactKitchenSelfOrderQrOptions');
    expect(posModuleSource).toContain('buildKitchenSelfOrderLabelQrPayload(order, kitchenAlreadyReleased)');
    expect(posModuleSource).toContain('kr: kitchenAlreadyReleased ? 1 : 0');
    expect(posModuleSource).toContain('item.unit_price_grosze > 0');
    expect(posModuleSource).not.toContain('if (item.line_total_grosze > 0) qrItem');
    expect(posModuleSource).not.toContain('productId: item.product_id');
    expect(posModuleSource).toContain("paymentStatus: 'UNPAID'");
    expect(posModuleSource).toContain('qrPayload,');
    expect(posModuleSource).toContain('printKitchenSelfOrderCustomerSlipToPrinter');
    expect(ticketSource).toContain('buildKitchenPaymentSlipLines');
    expect(posModuleSource).toContain('unitPriceGrosze: normalizeKitchenSelfOrderPriceGrosze');
    expect(ticketSource).toContain('NIEOPLACONE / CHUA TRA TIEN');
    expect(ticketSource).toContain('THANH TOAN TAI QUAY');
    expect(ticketSource).toContain('qrData: data.qrPayload');
    expect(formatterSource).toContain('formatQRCode(line.qrData');
  });

  it('lets the cashier POS scan the pickup-slip QR into the normal payment cart', () => {
    const layoutSource = readSource('src/renderer/components/pos/POSLayout.tsx');

    expect(layoutSource).toContain('decodeKitchenSelfOrderQr(code)');
    expect(layoutSource).toContain('loadKitchenSelfOrderQr(kioskOrder)');
    expect(layoutSource).toContain('handleUnknownBarcodeScanned');
    expect(layoutSource).toContain('onUnknownBarcodeScanned={handleUnknownBarcodeScanned}');
    expect(layoutSource).toContain('window.electronAPI.pos.products.getById(variantId)');
    expect(layoutSource).toContain('const cartItems: CartItem[] = []');
    expect(layoutSource).toContain('resolveKitchenSelfOrderCheckoutUnitPrice');
    expect(layoutSource).toContain("priceResolution.source === 'QR_SNAPSHOT'");
    expect(layoutSource).toContain("type: 'checkoutDraft/update'");
    expect(layoutSource).toContain('kitchenAlreadyReleased: payload.kitchenAlreadyReleased !== false');
    expect(layoutSource).toContain('saleClass.requiresScale');
    expect(layoutSource).toContain('await window.electronAPI.pos.dispatch');
    expect(layoutSource).toContain("type: 'cart/addItem'");
  });

  it('routes slip-only failures through retryPrint without a second kitchen ticket', () => {
    const appSource = readSource('src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx');
    const repoSource = readSource('src/main/database/repos/kitchen-self-order-repo.ts');
    const posModuleSource = readSource('src/main/modules/pos.module.ts');

    expect(appSource).toContain('result?.canRetrySlip');
    expect(appSource).toContain('kitchenSelfOrder?.retryPrint?.(orderId)');
    expect(appSource).toContain('orderLockedForRetry');
    expect(appSource).toContain('setCart([]);');
    expect(posModuleSource).toContain("if (action === 'reprint_slip')");
    expect(repoSource).toContain('markCustomerSlipResult');
    expect(posModuleSource).toContain('const order = kitchenSelfOrderRepo.getById(id)');
    expect(posModuleSource).toContain('const slipPrint = await this.printKitchenSelfOrderCustomerSlip(ticket)');
    expect(posModuleSource).not.toContain('await this.printKitchenSelfOrderTicket(ticket);');
  });

  it('offers a no-duplicate retry that re-prints the existing order', () => {
    const posModuleSource = readSource('src/main/modules/pos.module.ts');
    const preloadSource = readSource('src/preload/preload-kitchen-self-order.ts');
    const retryStart = posModuleSource.indexOf("ipcMain.handle('kitchen-self-order:retryPrint'");
    const retryEnd = posModuleSource.indexOf("ipcMain.handle('", retryStart + 1);
    const retryBlock = retryStart >= 0 ? posModuleSource.slice(retryStart, retryEnd === -1 ? undefined : retryEnd) : '';

    expect(retryStart).toBeGreaterThan(-1);
    expect(retryBlock).toContain('kitchenSelfOrderRepo.getById');
    expect(retryBlock).toContain('resolveKitchenSelfOrderRetryAction');
    expect(retryBlock).not.toContain('kitchenSelfOrderRepo.create');
    expect(retryBlock).toContain('markPrintResult(order.id');
    expect(retryBlock).toContain('pushPickupOrderBestEffort');
    expect(posModuleSource).toContain('orderId: created?.id');
    expect(preloadSource).toContain("ipcRenderer.invoke('kitchen-self-order:retryPrint'");
  });

  it('locks a failed-created order to retry instead of submitting a duplicate', () => {
    const appSource = readSource('src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx');
    const submitStart = appSource.indexOf('const submitOrder');
    const submitEnd = appSource.indexOf('const orderLockedForRetry', submitStart);
    const submitBlock = submitStart >= 0 ? appSource.slice(submitStart, submitEnd === -1 ? undefined : submitEnd) : '';

    expect(appSource).toContain('orderLockedForRetry');
    expect(appSource).toContain('kitchenSelfOrder?.retryPrint?.(');
    expect(submitBlock).toContain('orderLockedForRetry');
    expect(submitBlock).toContain('retryPrint(');
    expect(appSource).toContain('onStartOver');
  });

  it('marks QR-paid kiosk orders so checkout does not print a second kitchen ticket', () => {
    const paymentSource = readSource('src/renderer/components/pos/PaymentModal.tsx');
    const posModuleSource = readSource('src/main/modules/pos.module.ts');

    expect(paymentSource).toContain('kitchenSelfOrderCheckout');
    expect(paymentSource).toContain("source: kitchenSelfOrderCheckout ? 'KITCHEN_SELF_ORDER' : 'POS'");
    expect(paymentSource).toContain('kitchen_number: kitchenSelfOrderCheckout');
    expect(posModuleSource).not.toContain('void this.printKitchenTicketForOrder(id)');
  });

  it('operator launch settings are separate from store self-checkout settings', () => {
    const kitchenPanel = readSource('src/renderer/components/pos/KitchenSelfOrderPanel.tsx');
    const groceryPanel = readSource('src/renderer/components/pos/GrocerySelfCheckoutPanel.tsx');
    const settings = readSource('src/renderer/components/Settings.tsx');

    expect(kitchenPanel).toContain("window.open('kitchenSelfOrder')");
    expect(kitchenPanel).toContain('kitchenSelfOrderLanguage');
    expect(kitchenPanel).toContain('kitchenSelfOrderDefaultFulfillment');
    expect(kitchenPanel).toContain('kitchenSelfOrderSlipPrinterType');
    expect(kitchenPanel).toContain('kitchenSelfOrderMenuSource');
    expect(kitchenPanel).toContain('resolveKitchenSelfOrderMenuSource');
    expect(kitchenPanel).toContain('KitchenPrintSettings');
    expect(groceryPanel).toContain("window.open('selfCheckout')");
    expect(groceryPanel).toContain("selfCheckoutProfile: 'retail_scan'");
    expect(groceryPanel).not.toContain('menu_kitchen');
    expect(settings).not.toContain('<KitchenPrintSettings');
  });

  it('opens directly on the menu while keeping language and fulfillment editable inline', () => {
    const appSource = readSource('src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx');

    expect(appSource).toContain("useState<Step>('menu')");
    expect(appSource).toContain('function FulfillmentToggle');
    expect(appSource).toContain('function LanguageToggle');
    expect(appSource).toContain('unitPriceGrosze: item.product.priceGrosze + modifierTotal(item)');
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
