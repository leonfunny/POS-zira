import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  resolveSelfCheckoutPaymentProfile,
  resolveSelfCheckoutProfile,
  resolveSelfCheckoutMode,
  resolveSelfCheckoutRuntime,
} from '../src/renderer/windows/self-checkout/self-checkout-model';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('self-checkout runtime model', () => {
  it('defaults unknown runtime values to demo mode', () => {
    expect(resolveSelfCheckoutMode(undefined)).toBe('demo');
    expect(resolveSelfCheckoutMode('demo')).toBe('demo');
    expect(resolveSelfCheckoutMode('production')).toBe('production');
    expect(resolveSelfCheckoutMode('bogus')).toBe('demo');
  });

  it('defaults unknown kiosk profiles to retail scan mode', () => {
    expect(resolveSelfCheckoutProfile(undefined)).toBe('retail_scan');
    expect(resolveSelfCheckoutProfile('retail_scan')).toBe('retail_scan');
    expect(resolveSelfCheckoutProfile('menu_kitchen')).toBe('menu_kitchen');
    expect(resolveSelfCheckoutProfile('grocery_kitchen_mix')).toBe('retail_scan');
  });

  it('keeps production mode fail-closed until unattended contracts exist', () => {
    const demo = resolveSelfCheckoutRuntime({ selfCheckoutMode: 'demo' });
    expect(demo.unavailableReasons).toEqual([]);
    expect(demo.paymentProfile).toBe('assistedDemo');

    const production = resolveSelfCheckoutRuntime({ selfCheckoutMode: 'production' });
    expect(production.unavailableReasons).toEqual([
      'no_terminal',
      'no_fiscal_printer',
      'order_creation_unverified',
    ]);
    expect(production.paymentProfile).toBe('unavailable');
  });

  it('resolves payment profiles without allowing assisted methods in production', () => {
    expect(resolveSelfCheckoutPaymentProfile('demo', [])).toBe('assistedDemo');
    expect(resolveSelfCheckoutPaymentProfile('production', [])).toBe('terminalProduction');
    expect(resolveSelfCheckoutPaymentProfile('production', ['no_terminal'])).toBe('unavailable');
  });

  it('keeps customer checkout out of separate summary and payment routes', () => {
    const appSource = readSource('src/renderer/windows/self-checkout/SelfCheckoutApp.tsx');
    const screenStateSource = readSource('src/renderer/windows/self-checkout/screen-state.ts');

    expect(screenStateSource).not.toContain("'summary'");
    expect(screenStateSource).not.toContain("'payment'");
    expect(appSource).toContain('paymentOpen');
    expect(appSource).not.toContain("goTo('summary')");
    expect(appSource).not.toContain("goTo('payment')");
  });

  it('offers BLIK as a manual phone-transfer method, not an in-app keypad', () => {
    // The kiosk supports BLIK by displaying the shop's phone number and asking
    // the customer to send a peer-to-peer BLIK transfer from their banking
    // app. No in-app BLIK code entry — that would require a terminal we don't
    // have. The negative assertions guard against a future regression that
    // adds an in-kiosk BlikPad/blikCode flow.
    const paymentSource = readSource('src/renderer/windows/self-checkout/screens/PaymentScreen.tsx');

    expect(paymentSource).not.toContain('BlikPad');
    expect(paymentSource).not.toContain('blikCode');
    expect(paymentSource).toContain("'CASH' | 'CARD' | 'BLIK'");
    expect(paymentSource).toContain("const ASSISTED_PAYMENT_METHODS: PaymentMethod[] = ['BLIK', 'CARD', 'CASH']");
    expect(paymentSource).toContain("const assisted = profile === 'assistedDemo'");
    expect(paymentSource).toContain("if (phase !== 'idle' || !assisted) return");
    expect(paymentSource).toContain('blikInstructionTitle');
    expect(paymentSource).toContain('BLIK_PHONE_DISPLAY');
    expect(paymentSource).toContain('paymentTerminalHint');
    expect(paymentSource).toContain('onLangChange');
  });

  it('connects production self-checkout to POS order, payment, print, and sync IPC', () => {
    // Manual-workflow rewrite collects payment off-device, so SelfCheckoutApp
    // no longer calls a card-terminal IPC — it just saves the order, syncs,
    // and prints. The order-payload shape lives in build-sale.ts (extracted
    // so smoke tests can exercise it without React); the IPC plumbing stays
    // in SelfCheckoutApp.tsx.
    const appSource = readSource('src/renderer/windows/self-checkout/SelfCheckoutApp.tsx');
    const buildSaleSource = readSource('src/renderer/windows/self-checkout/build-sale.ts');
    const preloadSource = readSource('src/preload/preload-self-checkout.ts');

    expect(buildSaleSource).toContain("source: 'SELF_CHECKOUT'");
    expect(appSource).toContain('buildSelfCheckoutSale');
    expect(appSource).toContain('pos?.orders?.create');
    expect(appSource).toContain('pos?.payment?.printReceipt');
    expect(appSource).toContain('pos?.sync?.orders');
    expect(preloadSource).toContain("ipcRenderer.invoke('pos:payment:card', data)");
    expect(preloadSource).toContain("ipcRenderer.invoke('pos:print-receipt', orderId)");
    expect(preloadSource).toContain("ipcRenderer.invoke('pos:sync:orders')");
  });

  it('locks the receipt screen on print failure instead of completing the session', () => {
    const appSource = readSource('src/renderer/windows/self-checkout/SelfCheckoutApp.tsx');
    const receiptSource = readSource('src/renderer/windows/self-checkout/screens/ReceiptScreen.tsx');

    expect(receiptSource).toContain('const printFailed = !receiptPrinted && !fiscalPrinting');
    expect(receiptSource).toContain('if (!receiptPrinted || fiscalPrinting) return');
    expect(receiptSource).toContain('{printFailed && onCallStaff && (');
    expect(receiptSource).not.toContain('onClick={onComplete}');
    expect(receiptSource).not.toContain('t.receiptContinue');
    expect(appSource).toContain("|| screen === 'receipt'");
    expect(appSource).not.toContain("if (screen === 'receipt' && lastReceiptPrinted) return;");
  });

  it('keeps the self-checkout staff swipe-down exit wired to its own close IPC', () => {
    const appSource = readSource('src/renderer/windows/self-checkout/SelfCheckoutApp.tsx');
    const preloadSource = readSource('src/preload/preload-self-checkout.ts');

    expect(appSource).toContain("document.addEventListener('touchstart'");
    expect(appSource).toContain("document.addEventListener('touchmove'");
    expect(appSource).toContain('STAFF_SWIPE_PX');
    expect(appSource).toContain('selfCheckout?.close?.()');
    expect(preloadSource).toContain("ipcRenderer.invoke('self-checkout:close')");
  });

  it('keeps free bags out of self-checkout pricing and order payloads', () => {
    const cartSource = readSource('src/renderer/windows/self-checkout/useScCart.ts');
    const scanSource = readSource('src/renderer/windows/self-checkout/screens/ScanScreen.tsx');
    const appSource = readSource('src/renderer/windows/self-checkout/SelfCheckoutApp.tsx');
    const saleSource = readSource('src/renderer/windows/self-checkout/build-sale.ts');
    const settingsSource = readSource('src/renderer/components/SelfCheckoutTab.tsx');

    expect(cartSource).not.toContain('setBagQuantity');
    expect(cartSource).not.toContain('setBagFee');
    expect(scanSource).not.toContain('bagQuantity');
    expect(scanSource).not.toContain('bagQuestion');
    expect(appSource).not.toContain('selfCheckoutBagFeeAmount');
    expect(appSource).not.toContain('bagFeeProductionBlocked');
    expect(saleSource).not.toContain('SELF_CHECKOUT_BAG_FEE');
    expect(settingsSource).not.toContain('selfCheckout.bagFee');
  });

  it('keeps scan and menu copy aligned for PL and VI customers', () => {
    const scanSource = readSource('src/renderer/windows/self-checkout/screens/ScanScreen.tsx');
    const i18nSource = readSource('src/renderer/windows/self-checkout/i18n.ts');

    expect(scanSource).toContain('Retail is scan-first');
    expect(scanSource).not.toContain('Scanner is the ONLY path');
    expect(i18nSource).toContain("paymentNotice: 'Płatność z obsługą'");
    expect(i18nSource).toContain("grocery: 'Sklep'");
    expect(i18nSource).toContain("manualEntry: 'Wpisz kod kreskowy'");
    expect(i18nSource).toContain("kioskName: 'Kasa samoobsługowa'");
    expect(i18nSource).toContain("catalogLoading: 'Ładowanie produktów...'");
    expect(i18nSource).toContain("paymentNotice: 'Thanh toán có nhân viên hỗ trợ'");
    expect(i18nSource).toContain("grocery: 'Cửa hàng'");
    expect(i18nSource).toContain("manualEntry: 'Nhập mã vạch'");
    expect(i18nSource).toContain("kioskName: 'Quầy tự thanh toán'");
    expect(i18nSource).toContain("catalogLoading: 'Đang tải sản phẩm...'");
  });

  it('keeps kiosk chrome, profile split, and loading labels in the self-checkout i18n table', () => {
    const welcomeSource = readSource('src/renderer/windows/self-checkout/screens/WelcomeScreen.tsx');
    const scanSource = readSource('src/renderer/windows/self-checkout/screens/ScanScreen.tsx');
    const menuSource = readSource('src/renderer/windows/self-checkout/components/KioskMenuPanel.tsx');

    expect(welcomeSource).toContain("profile === 'menu_kitchen'");
    expect(scanSource).toContain("profile === 'menu_kitchen'");
    expect(scanSource).toContain('{menuProfile ? (');
    expect(scanSource).toContain('<RetailScanOnlyPanel');
    expect(scanSource).toContain('<KioskMenuPanel');
    expect(scanSource).toContain('showDepartmentTabs={false}');
    expect(menuSource).toContain('showDepartmentTabs = true');
    expect(welcomeSource).toContain('aria-label={t.barcodeScannerLabel}');
    expect(scanSource).toContain('aria-label={t.barcodeScannerLabel}');
    expect(welcomeSource).toContain('{t.kioskName}');
    expect(scanSource).toContain('{t.kioskName}');
    expect(menuSource).toContain('{t.catalogLoading}');
    expect(menuSource).not.toContain("lang === 'pl'");
    expect(menuSource).not.toContain("lang === 'vi'");
  });
});
