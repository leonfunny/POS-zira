// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mounted = vi.hoisted(() => ({ addProduct: 0, debt: 0 }));

vi.mock('../src/renderer/hooks/useConfig', () => ({
  useConfig: () => ({ config: { posMode: 'retail', posLanguage: 'en' }, saveConfig: vi.fn() }),
}));
vi.mock('../src/renderer/hooks/usePosStore', () => ({
  usePosStore: () => ({
    state: {
      cart: { items: [], subtotal: 0, discount: 0, tax: 0, total: 0 },
      checkoutDraft: {},
      session: { isOpen: true, shiftId: 'shift-1', staffId: 'staff-1', staffName: 'Cashier' },
      display: { mode: 'idle' },
    },
    dispatch: vi.fn(), dispatchError: null, clearDispatchError: vi.fn(),
  }),
}));
vi.mock('../src/renderer/hooks/useBarcodeForwarder', () => ({ useBarcodeForwarder: () => undefined }));
vi.mock('../src/renderer/components/pos/AddProductWebviewPanel', () => ({
  default: () => {
    mounted.addProduct += 1;
    return createElement('webview', { 'data-testid': 'add-product-webview' });
  },
}));
vi.mock('../src/renderer/components/pos/DebtWebviewPanel', () => ({
  default: () => {
    mounted.debt += 1;
    return createElement('webview', { 'data-testid': 'debt-webview' });
  },
}));
vi.mock('../src/renderer/components/pos/ShiftModal', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/ShiftReport', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/templates/retail/RetailTemplate', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/templates/salon/SalonTemplate', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/templates/b2b/B2BTemplate', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/templates/restaurant/RestaurantTemplate', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/PaymentModal', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/SyncConflictBanner', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/ScanImportModal', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/QuickAddCameraModal', () => ({ default: () => null }));

import POSLayout from '../src/renderer/components/pos/POSLayout';
import {
  RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
  resolveAndroidPosCapabilityManifest,
  resolveWindowsPosCapabilityManifest,
  type PosCapabilityHost,
} from '../src/renderer/components/pos/capabilities/PosCapabilityProvider';

function host(platform: 'android' | 'windows'): PosCapabilityHost {
  return {
    session: {
      authenticated: true, salonId: 'salon-1', userId: 'user-1', registerId: 'register-1',
      authRevision: 1, roleRevision: 'OWNER', entitlementRevision: 'entitlements-1',
      configRevision: 'config-1', platformRevision: platform,
    },
    policyInputs: RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
    resolvePlatformManifest: platform === 'android'
      ? resolveAndroidPosCapabilityManifest
      : resolveWindowsPosCapabilityManifest,
  };
}

describe('Android WebView containment boundary', () => {
  let container: HTMLDivElement;
  let root: Root;
  const previousApi = (globalThis as any).electronAPI;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mounted.addProduct = 0;
    mounted.debt = 0;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).window = globalThis;
    (globalThis as any).electronAPI = {
      getStatus: async () => ({ connected: true }),
      onBarcodeScanned: () => () => {},
      onConnectionStatus: () => () => {},
      pos: { onFiscalUnknown: () => () => {}, onPickupOrderEvent: () => () => {} },
    };
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    (globalThis as any).electronAPI = previousApi;
  });

  test('never mounts webview panels for Android while retaining the Windows panel contract', async () => {
    await act(async () => {
      root.render(createElement(POSLayout, { capabilityHost: host('android') }));
    });
    expect(mounted.addProduct).toBe(0);
    expect(mounted.debt).toBe(0);
    expect(container.querySelector('webview')).toBeNull();

    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(POSLayout, { capabilityHost: host('windows') }));
    });
    expect(mounted.addProduct).toBeGreaterThan(0);
    expect(mounted.debt).toBeGreaterThan(0);
    expect(container.querySelectorAll('webview')).toHaveLength(2);
  });
});
