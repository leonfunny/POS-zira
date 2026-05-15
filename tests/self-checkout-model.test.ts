import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
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

  it('allows production mode once self-checkout uses the POS sale path', () => {
    expect(resolveSelfCheckoutRuntime({ selfCheckoutMode: 'demo' }).unavailableReasons).toEqual([]);
    const production = resolveSelfCheckoutRuntime({ selfCheckoutMode: 'production' });
    expect(production.unavailableReasons).toEqual([]);
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

  it('keeps BLIK input on the physical terminal instead of an app keypad', () => {
    const paymentSource = readSource('src/renderer/windows/self-checkout/screens/PaymentScreen.tsx');

    expect(paymentSource).not.toContain('BlikPad');
    expect(paymentSource).not.toContain('blikCode');
    expect(paymentSource).toContain('paymentTerminalHint');
    expect(paymentSource).toContain('blikProductionUnsupported');
    expect(paymentSource).toContain('onLangChange');
  });

  it('connects production self-checkout to POS order, payment, print, and sync IPC', () => {
    const appSource = readSource('src/renderer/windows/self-checkout/SelfCheckoutApp.tsx');
    const preloadSource = readSource('src/preload/preload-display.ts');

    expect(appSource).toContain("source: 'SELF_CHECKOUT'");
    expect(appSource).toContain('pos?.payment?.cardPayment');
    expect(appSource).toContain('pos?.orders?.create');
    expect(appSource).toContain('pos?.payment?.printReceipt');
    expect(appSource).toContain('pos?.sync?.orders');
    expect(appSource).toContain('selfCheckoutFakePaymentEnabled');
    expect(preloadSource).toContain("ipcRenderer.invoke('pos:payment:card', data)");
    expect(preloadSource).toContain("ipcRenderer.invoke('pos:print-receipt', orderId)");
    expect(preloadSource).toContain("ipcRenderer.invoke('pos:sync:orders')");
  });

  it('keeps the self-checkout staff swipe-down exit wired to its own close IPC', () => {
    const appSource = readSource('src/renderer/windows/self-checkout/SelfCheckoutApp.tsx');
    const preloadSource = readSource('src/preload/preload-display.ts');

    expect(appSource).toContain("document.addEventListener('touchstart'");
    expect(appSource).toContain("document.addEventListener('touchmove'");
    expect(appSource).toContain('STAFF_SWIPE_PX');
    expect(appSource).toContain('selfCheckout?.close?.()');
    expect(preloadSource).toContain("ipcRenderer.invoke('self-checkout:close')");
  });

  it('models bag fee as a local quantity instead of a single yes/no toggle', () => {
    const cartSource = readSource('src/renderer/windows/self-checkout/useScCart.ts');
    const scanSource = readSource('src/renderer/windows/self-checkout/screens/ScanScreen.tsx');

    expect(cartSource).toContain('setBagQuantity');
    expect(cartSource).toContain('MAX_BAG_QUANTITY');
    expect(cartSource).not.toContain('setBagFee');
    expect(scanSource).toContain('bagQuantity');
    expect(scanSource).toContain('t.bagUnit');
  });
});
