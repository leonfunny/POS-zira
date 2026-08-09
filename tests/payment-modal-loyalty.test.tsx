// @vitest-environment happy-dom
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/renderer/hooks/useConfig', () => ({
  useConfig: () => ({ config: { fiscalOnCashSale: 'NEVER' } }),
}));

import PaymentModal from '../src/renderer/components/pos/PaymentModal';
import {
  PosCapabilityProvider,
  RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
  resolveAndroidPosCapabilityManifest,
  type PosCapabilityHost,
} from '../src/renderer/components/pos/capabilities/PosCapabilityProvider';

const identity = { salonId: 'salon-1', userId: 'user-1', registerId: 'register-1', authEpoch: 1 };

function host(loyaltyLookup: boolean): PosCapabilityHost {
  return {
    session: {
      authenticated: true,
      salonId: identity.salonId,
      userId: identity.userId,
      registerId: identity.registerId,
      authRevision: identity.authEpoch,
      roleRevision: 'STAFF',
      entitlementRevision: 'entitlements-1',
      configRevision: 'config-1',
      platformRevision: JSON.stringify({ loyaltyLookup }),
    },
    policyInputs: RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
    resolvePlatformManifest: (current) => resolveAndroidPosCapabilityManifest(current, { loyaltyLookup }),
  };
}

async function settle(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function button(container: HTMLDivElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent?.includes(label));
  expect(found, `missing ${label} button`).toBeTruthy();
  return found as HTMLButtonElement;
}

describe('PaymentModal loyalty capability gate', () => {
  let container: HTMLDivElement;
  let root: Root;
  const previousApi = (globalThis as any).electronAPI;
  const lookupCustomer = vi.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    lookupCustomer.mockReset();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).electronAPI = {
      onBarcodeScanned: () => () => {},
      pos: {
        loyalty: { lookupCustomer },
        payment: { hasFiscalPrinter: async () => ({ configured: false }), preflight: async () => ({ success: true, token: 'pf-1' }) },
        billiardCheckout: { beginTender: async () => ({ success: false }), beginRestoredTender: async () => ({ success: false }) },
        sync: { orders: async () => {} },
        orders: { create: async () => ({ success: true, id: 'order-1' }) },
        customers: { increaseDebt: async () => ({ success: true }) },
      },
    };
    (globalThis as any).window = globalThis;
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    container.remove();
    (globalThis as any).electronAPI = previousApi;
  });

  async function render(loyaltyLookup: boolean) {
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(
        PosCapabilityProvider,
        { host: host(loyaltyLookup) },
        createElement(PaymentModal, {
          cart: { items: [], subtotal: 1000, discount: 0, tax: 0, total: 1000 },
          checkoutDraft: {},
          dispatch: vi.fn(),
          onClose: vi.fn(),
          t: (key: string) => key,
          shiftId: 'shift-1',
          staffId: 'staff-1',
          staffName: 'Cashier',
        } as any),
      ));
    });
    await settle();
  }

  test('keeps Loyalty hidden when the host runtime fact is false', async () => {
    await render(false);
    expect(container.textContent).not.toContain('Loyalty');
  });

  test.each([
    [{ found: true, phone: '48123456789', owner: { fullName: 'Anna Customer', phone: '48123456789', isBlocked: false, noShowCount: 0, lateCount: 0, cancelCount: 0 } }, 'Anna Customer'],
    [{ found: false, phone: '48123456789' }, 'No customer found for this phone.'],
  ])('looks up and renders the result when the host runtime fact is true', async (result, expected) => {
    lookupCustomer.mockResolvedValue({ success: true, result });
    await render(true);
    await act(async () => { button(container, 'Loyalty').click(); });
    const input = container.querySelector('input[placeholder="Customer phone"]') as HTMLInputElement;
    await act(async () => {
      // Bypass React's value tracker so this is the same user-driven input
      // path the controlled PaymentModal receives in the WebView.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' 48123456789 ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button(container, 'Lookup').click(); });
    await settle();
    expect(lookupCustomer).toHaveBeenCalledWith('48123456789');
    expect(container.textContent).toContain(expected);
  });
});
