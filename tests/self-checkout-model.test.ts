import { describe, expect, it } from 'vitest';
import {
  resolveSelfCheckoutMode,
  resolveSelfCheckoutRuntime,
} from '../src/renderer/windows/self-checkout/self-checkout-model';

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

});
