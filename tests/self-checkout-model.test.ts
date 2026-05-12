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

  it('fails production mode closed until payment/order/fiscal wiring exists', () => {
    expect(resolveSelfCheckoutRuntime({ selfCheckoutMode: 'demo' }).unavailableReasons).toEqual([]);
    const production = resolveSelfCheckoutRuntime({ selfCheckoutMode: 'production' });
    expect(production.unavailableReasons).toEqual([
      'Payment terminal SDK is not integrated.',
      'Fiscal printer flow is not wired to self-checkout.',
      'Real order creation for kiosk sales is not wired.',
    ]);
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
    expect(paymentSource).toContain('onLangChange');
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
