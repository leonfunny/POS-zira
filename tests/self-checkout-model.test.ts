import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_IDLE_TIMEOUT_MULTIPLIER,
  resolveIdleTimeoutMs,
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

  it('enables production with assisted payment and backend printer routing', () => {
    const demo = resolveSelfCheckoutRuntime({ selfCheckoutMode: 'demo' });
    expect(demo.unavailableReasons).toEqual([]);
    expect(demo.paymentProfile).toBe('assistedDemo');

    const production = resolveSelfCheckoutRuntime({ selfCheckoutMode: 'production' });
    expect(production.unavailableReasons).toEqual([]);
    expect(production.paymentProfile).toBe('assistedProduction');
  });

  it('resolves payment profiles while preserving fail-closed blockers', () => {
    expect(resolveSelfCheckoutPaymentProfile('demo', [])).toBe('assistedDemo');
    expect(resolveSelfCheckoutPaymentProfile('production', [])).toBe('assistedProduction');
    expect(resolveSelfCheckoutPaymentProfile('production', ['no_terminal'])).toBe('unavailable');
  });

  it('extends the idle window while the payment overlay is open', () => {
    // A customer sending a BLIK transfer from their own phone (or waiting for
    // staff to bring change) doesn't touch the kiosk. A 90s hard reset there
    // would wipe a sale the customer may have already paid for.
    expect(resolveIdleTimeoutMs(90_000, false)).toBe(90_000);
    expect(resolveIdleTimeoutMs(90_000, true)).toBe(90_000 * PAYMENT_IDLE_TIMEOUT_MULTIPLIER);

    // The app must consult the payment-aware helper, and the idle effect must
    // still run during payment (paymentOpen is a dep, not a skip condition).
    const appSource = readFileSync(
      new URL('../src/renderer/windows/self-checkout/SelfCheckoutApp.tsx', import.meta.url),
      'utf8',
    );
    expect(appSource).toContain('resolveIdleTimeoutMs(idleTimeoutMs, paymentOpen)');
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
    expect(paymentSource).toContain("const assisted = profile === 'assistedDemo' || profile === 'assistedProduction'");
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
    const posModuleSource = readSource('src/main/modules/pos.module.ts');

    expect(buildSaleSource).toContain("source: 'SELF_CHECKOUT'");
    expect(appSource).toContain('buildSelfCheckoutSale');
    expect(appSource).toContain('pos?.orders?.create');
    expect(appSource).toContain('selfCheckout?.finalizePrint?.({ orderId, method })');
    expect(appSource).toContain('pos?.sync?.orders');
    // The paid cart must be dropped from localStorage as soon as the order
    // is durably saved — a crash on the receipt/thank-you screens must not
    // restore an already-paid cart for the next customer.
    expect(appSource).toContain('setLastTotalGrosze(saleTotalGrosze);');
    expect(appSource).toContain('cart.clear();');
    expect(appSource).toContain('totalGrosze={lastTotalGrosze}');
    expect(preloadSource).toContain("ipcRenderer.invoke('pos:payment:card', data)");
    expect(preloadSource).toContain("ipcRenderer.invoke('pos:print-receipt', orderId)");
    expect(preloadSource).toContain("ipcRenderer.invoke('self-checkout:finalize-print', payload)");
    expect(preloadSource).toContain("ipcRenderer.invoke('pos:sync:orders')");
    expect(posModuleSource).toContain("route: 'FISCAL_RECEIPT'");
    expect(posModuleSource).toContain("ipcMain.handle('self-checkout:finalize-print'");
    expect(posModuleSource).toContain('printFiscalReceipt(orderId)');
    expect(posModuleSource).toContain("method === 'CASH'");
  });

  it('gates production sessions on fiscal readiness and self-recovers', () => {
    // A production kiosk must not invite a customer into a session it can't
    // legally finish (no fiscal route = no paragon). The welcome screen
    // polls readiness; the unavailable screen polls for auto-recovery so a
    // restored printer reopens the lane without a manual restart.
    const appSource = readSource('src/renderer/windows/self-checkout/SelfCheckoutApp.tsx');
    const preloadSource = readSource('src/preload/preload-self-checkout.ts');
    const posModuleSource = readSource('src/main/modules/pos.module.ts');

    expect(appSource).toContain("if (mode !== 'production') return;");
    expect(appSource).toContain('selfCheckout?.readiness?.()');
    expect(appSource).toContain("if (screen === 'welcome') goTo('unavailable')");
    expect(preloadSource).toContain("ipcRenderer.invoke('self-checkout:readiness')");
    expect(posModuleSource).toContain("ipcMain.handle('self-checkout:readiness'");
    expect(posModuleSource).toContain('hasFiscalPrinter()');
  });

  it('polls help status via the public apiKey endpoint with a legacy fallback', () => {
    // The kiosk is unattended: the lock-release poll must not depend on a
    // fresh staff JWT. Primary route = apiKey status endpoint; legacy
    // Bearer /open scan remains for older backends. Unknown help reasons
    // (e.g. PRINT_FAILED on an old backend) retry once as OTHER.
    const posModuleSource = readSource('src/main/modules/pos.module.ts');

    expect(posModuleSource).toContain('self-checkout/help-request/status');
    expect(posModuleSource).toContain('JSON.stringify({ apiKey, id })');
    expect(posModuleSource).toContain('self-checkout/help-requests/open');
    expect(posModuleSource).toContain("retrying as OTHER");
  });

  it('reuses one order id per payment attempt and dedupes on the main side', () => {
    // If the create reply is lost after the order actually committed, the
    // staff retry must NOT record the sale twice: the renderer reuses the
    // same order id and pos:orders:create treats the PK conflict as success.
    const appSource = readSource('src/renderer/windows/self-checkout/SelfCheckoutApp.tsx');
    const posModuleSource = readSource('src/main/modules/pos.module.ts');

    expect(appSource).toContain('pendingOrderIdRef.current ?? crypto.randomUUID()');
    expect(appSource).toContain('pendingOrderIdRef.current = orderId');
    expect(posModuleSource).toContain('UNIQUE constraint failed: orders\\.id');
    expect(posModuleSource).toContain('duplicate: true');
  });

  it('routes every kiosk payment method through the fiscal paragon', () => {
    // Polish fiscal law requires a paragon fiskalny for cash and BLIK sales
    // too — the kiosk must never downgrade them to a non-fiscal order copy.
    const posModuleSource = readSource('src/main/modules/pos.module.ts');
    const finalizeStart = posModuleSource.indexOf("ipcMain.handle('self-checkout:finalize-print'");
    const finalizeEnd = posModuleSource.indexOf("ipcMain.handle('pos:shift:open'", finalizeStart);
    const finalizeBlock = posModuleSource.slice(finalizeStart, finalizeEnd);

    expect(finalizeBlock).toContain('printFiscalReceipt(orderId)');
    expect(finalizeBlock).toContain('openCashDrawer()');
    expect(finalizeBlock).not.toContain("route: 'ORDER_COPY'");
    expect(finalizeBlock).not.toContain('printReceiptAndOpenDrawer');

    const receiptSource = readSource('src/renderer/windows/self-checkout/screens/ReceiptScreen.tsx');
    expect(receiptSource).toContain('const printLabel = t.receiptPrintStep');
    expect(receiptSource).toContain('const printingLabel = t.receiptFiscalPrinting');
  });

  it('holds the receipt screen on print failure, alerts staff, then self-recovers', () => {
    const appSource = readSource('src/renderer/windows/self-checkout/SelfCheckoutApp.tsx');
    const receiptSource = readSource('src/renderer/windows/self-checkout/screens/ReceiptScreen.tsx');

    expect(receiptSource).toContain('const printFailed = !receiptPrinted && !receiptPrinting');
    expect(receiptSource).toContain('if (!receiptPrinted || receiptPrinting) return');
    expect(receiptSource).toContain('{printFailed && onCallStaff && (');
    expect(receiptSource).not.toContain('onClick={onComplete}');
    expect(receiptSource).not.toContain('t.receiptContinue');
    // No fast auto-advance on failure, but a long recovery timer so an
    // abandoned failed print can't dead-end the kiosk for the next customer
    // (the receipt screen is excluded from the global idle reset).
    expect(receiptSource).toContain('PRINT_FAILED_AUTO_ADVANCE_MS');
    expect(receiptSource).toContain('if (!printFailed) return');
    expect(appSource).toContain("|| screen === 'receipt'");
    expect(appSource).not.toContain("if (screen === 'receipt' && lastReceiptPrinted) return;");
    // Paid-but-no-paragon must proactively notify staff, not just toast.
    expect(appSource).toContain("reason: 'PRINT_FAILED'");
  });

  it('keeps the self-checkout staff swipe-down exit wired to its own close IPC', () => {
    const appSource = readSource('src/renderer/windows/self-checkout/SelfCheckoutApp.tsx');
    const preloadSource = readSource('src/preload/preload-self-checkout.ts');

    expect(appSource).toContain("document.addEventListener('touchstart'");
    expect(appSource).toContain("document.addEventListener('touchmove'");
    expect(appSource).toContain('STAFF_SWIPE_PX');
    expect(appSource).toContain('selfCheckout?.close?.()');
    expect(preloadSource).toContain("ipcRenderer.invoke('self-checkout:close')");

    // The swipe gesture must only OPEN the hold-to-confirm dialog — a
    // customer who discovers the gesture must not be able to close the
    // kiosk (and reach the desktop / cashier POS) without the 3s hold.
    const gestureStart = appSource.indexOf('const onTouchMove');
    const gestureEnd = appSource.indexOf('const onTouchEnd');
    const gestureBlock = appSource.slice(gestureStart, gestureEnd);
    expect(gestureBlock).toContain('setStaffExitOpen(true)');
    expect(gestureBlock).not.toContain('selfCheckout?.close');
    expect(appSource).toContain('STAFF_EXIT_HOLD_MS = 3000');
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
    expect(i18nSource).toContain("retailScanOnlyTitle: 'Tryb sklepu'");
    expect(i18nSource).toContain("retailScanOnlyBody: 'Skanuj kod kreskowy.");
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
    const searchSource = readSource('src/renderer/windows/self-checkout/components/SearchDialog.tsx');

    expect(welcomeSource).toContain("profile === 'menu_kitchen'");
    expect(scanSource).toContain("profile === 'menu_kitchen'");
    expect(scanSource).toContain('{menuProfile ? (');
    expect(scanSource).toContain('<RetailScanOnlyPanel');
    expect(scanSource).toContain('<KioskMenuPanel');
    expect(scanSource).toContain('data-self-checkout-retail-panel="true"');
    expect(scanSource).toContain('data-self-checkout-retail-copy="true"');
    expect(scanSource).toContain('showDepartmentTabs={false}');
    expect(menuSource).toContain('showDepartmentTabs = true');
    expect(searchSource).toContain('TouchKeyboard');
    expect(searchSource).toContain('inputMode="none"');
    expect(searchSource).toContain('mode="full"');
    expect(searchSource).toContain('data-self-checkout-touch-keyboard="true"');
    expect(welcomeSource).toContain('aria-label={t.barcodeScannerLabel}');
    expect(scanSource).toContain('aria-label={t.barcodeScannerLabel}');
    expect(welcomeSource).toContain('{t.kioskName}');
    expect(scanSource).toContain('{t.kioskName}');
    expect(menuSource).toContain('{t.catalogLoading}');
    expect(menuSource).not.toContain("lang === 'pl'");
    expect(menuSource).not.toContain("lang === 'vi'");
  });
});
