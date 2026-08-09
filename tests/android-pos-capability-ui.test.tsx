// @vitest-environment happy-dom
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  state: {
    cart: { items: [], subtotal: 0, discount: 0, tax: 0, total: 0 },
    checkoutDraft: {},
    session: {
      shiftId: 'shift-1',
      staffId: 'staff-1',
      staffName: 'Cashier',
      isOpen: true,
      openedAt: '2026-08-09T00:00:00.000Z',
    },
    display: { mode: 'idle' },
  } as any,
  productGridProps: null as Record<string, any> | null,
  searchBarProps: null as Record<string, any> | null,
  cartProps: null as Record<string, any> | null,
  scanImportProps: null as Record<string, any> | null,
  dispatchCalls: [] as any[],
  autoCameraMounts: 0,
  quickAddPanelMounts: 0,
  addProductPanelMounts: 0,
  debtPanelMounts: 0,
}));

vi.mock('../src/renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: {
      posMode: 'retail',
      posLanguage: 'en',
      scale: { enabled: true, port: 'COM1' },
      salonCode: 'salon-code',
    },
    saveConfig: vi.fn(),
  }),
}));
vi.mock('../src/renderer/hooks/usePosStore', () => ({
  usePosStore: () => ({
    state: captured.state,
    dispatch: (action: any) => { captured.dispatchCalls.push(action); },
    dispatchError: null,
    clearDispatchError: vi.fn(),
  }),
}));
vi.mock('../src/renderer/hooks/useBarcodeForwarder', () => ({
  useBarcodeForwarder: () => undefined,
}));
vi.mock('../src/renderer/components/pos/SearchBar', () => ({
  default: (props: Record<string, any>) => {
    captured.searchBarProps = props;
    return null;
  },
}));
vi.mock('../src/renderer/components/pos/ProductGrid', () => ({
  default: (props: Record<string, any>) => {
    captured.productGridProps = props;
    return createElement('div', { 'data-testid': 'product-grid' });
  },
}));
vi.mock('../src/renderer/components/pos/Cart', () => ({
  default: (props: Record<string, any>) => {
    captured.cartProps = props;
    return createElement('div', { 'data-testid': 'cart' });
  },
}));
vi.mock('../src/renderer/components/pos/ScanImportModal', () => ({
  default: (props: Record<string, any>) => {
    captured.scanImportProps = props;
    return null;
  },
}));
vi.mock('../src/renderer/components/pos/AutoCameraSearch', () => ({
  default: () => {
    captured.autoCameraMounts += 1;
    return createElement('div', { 'data-testid': 'auto-camera' });
  },
}));
vi.mock('../src/renderer/components/pos/QuickAddCameraModal', () => ({
  default: () => {
    captured.quickAddPanelMounts += 1;
    return null;
  },
}));
vi.mock('../src/renderer/components/pos/AddProductWebviewPanel', () => ({
  default: () => {
    captured.addProductPanelMounts += 1;
    return null;
  },
}));
vi.mock('../src/renderer/components/pos/DebtWebviewPanel', () => ({
  default: () => {
    captured.debtPanelMounts += 1;
    return null;
  },
}));
vi.mock('../src/renderer/components/pos/SyncConflictBanner', () => ({ default: () => null }));

import POSLayout from '../src/renderer/components/pos/POSLayout';
import PaymentModal from '../src/renderer/components/pos/PaymentModal';
import QuickActions, {
  isPosCapabilityUsable,
} from '../src/renderer/components/pos/templates/retail/QuickActions';
import {
  ANDROID_POS_CAPABILITY_OUTCOMES,
  PosCapabilityProvider,
  RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
  resolveAndroidPosCapabilityManifest,
  resolveWindowsPosCapabilityManifest,
  type PosCapabilityContextValue,
  type PosCapabilityHost,
} from '../src/renderer/components/pos/capabilities/PosCapabilityProvider';
import {
  CASHIER_CAPABILITY_KEYS,
  createCashierCapabilityManifest,
  type CashierCapabilityPolicyInputs,
} from '../src/shared/pos/cashier-capabilities';

const identity = {
  salonId: 'salon-1',
  userId: 'user-1',
  registerId: 'register-1',
  authEpoch: 1,
};

const weightedProduct = {
  id: 'weighted-1',
  template_id: null,
  name: 'Weighted apples',
  sku: 'APPLE-KG',
  barcode: null,
  retail_price: 1000,
  category_id: null,
  image_url: null,
  in_stock: 10,
  available_qty: 10,
  vat_rate: 5,
  is_active: 1,
  updated_at: null,
  sell_by: 'WEIGHT',
  sale_unit: 'kg',
};

function capabilityHost(platform: 'android' | 'windows'): PosCapabilityHost {
  return {
    session: {
      authenticated: true,
      salonId: identity.salonId,
      userId: identity.userId,
      registerId: identity.registerId,
      authRevision: identity.authEpoch,
      roleRevision: 'OWNER',
      entitlementRevision: 'entitlements-1',
      configRevision: 'config-1',
      platformRevision: `${platform}-v1`,
    },
    policyInputs: RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
    resolvePlatformManifest: platform === 'android'
      ? resolveAndroidPosCapabilityManifest
      : resolveWindowsPosCapabilityManifest,
  };
}

function context(
  platform: 'android' | 'windows',
  policyInputs: CashierCapabilityPolicyInputs = RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
): PosCapabilityContextValue {
  return {
    status: 'ready',
    policyInputs,
    manifest: platform === 'android'
      ? createCashierCapabilityManifest(identity, ANDROID_POS_CAPABILITY_OUTCOMES)
      : resolveWindowsPosCapabilityManifest(identity),
  };
}

function makeApi() {
  const pickup = {
    machineId: vi.fn(() => Promise.resolve('machine-1')),
    listOpen: vi.fn(() => Promise.resolve([])),
    claim: vi.fn(),
    claimByRef: vi.fn(),
    release: vi.fn(() => Promise.resolve({ ok: true })),
  };
  const openCustomer = vi.fn(() => Promise.resolve({ success: true }));
  const closeCustomer = vi.fn(() => Promise.resolve({ success: true }));
  const listWindows = vi.fn(() => Promise.resolve([]));
  const readWeight = vi.fn(() => Promise.resolve({
    success: true,
    stable: true,
    weightKg: 0.5,
  }));
  const printLabel = vi.fn(() => Promise.resolve({ success: true }));
  const loyaltyLookup = vi.fn(() => Promise.resolve({ success: true, result: { found: false } }));
  const preflight = vi.fn(() => Promise.resolve({ success: true, token: 'preflight-token' }));
  const beginRestoredTender = vi.fn(() => Promise.resolve({ success: true }));
  const recognitionAnalyze = vi.fn(() => Promise.resolve({ ok: true, products: [] }));
  const productGetByBarcode = vi.fn(() => Promise.resolve(null as any));
  const draftGetByBarcode = vi.fn(() => Promise.resolve(null as any));
  const importDraft = vi.fn(() => Promise.resolve({ ok: true } as any));

  return {
    spies: {
      pickup,
      openCustomer,
      closeCustomer,
      listWindows,
      readWeight,
      printLabel,
      loyaltyLookup,
      preflight,
      beginRestoredTender,
      recognitionAnalyze,
      productGetByBarcode,
      draftGetByBarcode,
      importDraft,
    },
    api: {
      getStatus: () => Promise.resolve({ connected: true }),
      onConnectionStatus: () => () => {},
      onConfigUpdated: () => () => {},
      getConfig: () => Promise.resolve({ authUser: { id: 'user-1' } }),
      window: { list: listWindows, open: openCustomer, close: closeCustomer },
      printLabel,
      scale: { readWeight },
      pos: {
        getState: () => Promise.resolve(captured.state),
        dispatch: () => Promise.resolve(),
        onFiscalUnknown: () => () => {},
        onReceiptPrintStatus: () => () => {},
        listReceiptPrintStatuses: () => Promise.resolve([]),
        onPickupOrderEvent: vi.fn(() => () => {}),
        pickupOrders: pickup,
        categories: {
          getAll: () => Promise.resolve([]),
          getAllIncludingEmpty: () => Promise.resolve([]),
        },
        products: {
          getAll: () => Promise.resolve([]),
          search: () => Promise.resolve([]),
          getById: () => Promise.resolve(null),
          getByBarcode: productGetByBarcode,
        },
        draftProducts: {
          searchByCode: () => Promise.resolve([]),
          getByBarcode: draftGetByBarcode,
        },
        masterCatalog: {
          lookupByEan: () => Promise.resolve({ ok: false }),
          lookupExternalByEan: () => Promise.resolve({ ok: false }),
          importDraft,
        },
        sync: {
          onProductsSynced: () => () => {},
          products: () => Promise.resolve({ success: true }),
        },
        hold: {
          supported: true,
          list: () => Promise.resolve([]),
          importLegacy: () => Promise.resolve({ success: true }),
        },
        billiardCheckout: {
          recover: () => Promise.resolve({ success: true, intent: null }),
          beginRestoredTender,
        },
        payment: {
          hasFiscalPrinter: () => Promise.resolve({ configured: false }),
          preflight,
        },
        loyalty: { lookupCustomer: loyaltyLookup },
        recognition: { analyze: recognitionAnalyze },
        scale: { readWeight },
      },
    },
  };
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button'))
    .find((button) => (button.textContent || '').includes(text));
}

describe('POS capability consumer gates', () => {
  let container: HTMLDivElement;
  let root: Root;
  const previousApi = (globalThis as any).electronAPI;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    captured.productGridProps = null;
    captured.searchBarProps = null;
    captured.cartProps = null;
    captured.scanImportProps = null;
    captured.dispatchCalls = [];
    captured.autoCameraMounts = 0;
    captured.quickAddPanelMounts = 0;
    captured.addProductPanelMounts = 0;
    captured.debtPanelMounts = 0;
    localStorage.clear();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    (globalThis as any).electronAPI = previousApi;
  });

  test('all Android outcomes fail closed while the current Windows profile remains usable', () => {
    const android = context('android');
    const windows = context('windows');
    for (const key of CASHIER_CAPABILITY_KEYS) {
      expect(isPosCapabilityUsable(android, key), `${key} leaked on Android`).toBe(false);
      expect(isPosCapabilityUsable(windows, key), `${key} regressed on Windows`).toBe(true);
    }
  });

  test('unknown or negative policy never turns a supported runtime into permission', () => {
    const negativeCases: Array<[keyof CashierCapabilityPolicyInputs, string]> = [
      ['salonConfig', 'unknown'],
      ['salonConfig', 'disabled'],
      ['entitlements', 'unknown'],
      ['entitlements', 'denied'],
      ['roleAccess', 'unknown'],
      ['roleAccess', 'denied'],
    ];
    for (const [axis, decision] of negativeCases) {
      const policy = {
        salonConfig: { ...RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS.salonConfig },
        entitlements: { ...RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS.entitlements },
        roleAccess: { ...RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS.roleAccess },
      } as CashierCapabilityPolicyInputs;
      (policy[axis] as Record<string, string>).loyaltyLookup = decision;
      expect(isPosCapabilityUsable(context('windows', policy), 'loyaltyLookup')).toBe(false);
    }
  });

  test('Android hides first-consumer affordances and does not probe gated bridges', async () => {
    const { api, spies } = makeApi();
    (globalThis as any).electronAPI = api;
    (globalThis as any).window = globalThis;

    await act(async () => {
      root.render(createElement(POSLayout, { capabilityHost: capabilityHost('android') }));
    });
    await settle();

    expect(captured.quickAddPanelMounts).toBe(0);
    expect(captured.addProductPanelMounts).toBe(0);
    expect(captured.debtPanelMounts).toBe(0);
    expect(captured.autoCameraMounts).toBe(0);
    expect(captured.productGridProps?.onLongPressProduct).toBeUndefined();
    expect(captured.cartProps?.onPrintItemLabel).toBeUndefined();
    expect(findButton(container, 'Camera')).toBeUndefined();
    expect(findButton(container, 'Tạo sản phẩm')).toBeUndefined();
    expect(spies.listWindows).not.toHaveBeenCalled();
    expect(spies.pickup.machineId).not.toHaveBeenCalled();
    expect(spies.pickup.listOpen).not.toHaveBeenCalled();
    await act(async () => {
      await captured.productGridProps!.onAddProduct(weightedProduct);
    });
    expect(spies.readWeight).not.toHaveBeenCalled();
    expect(spies.printLabel).not.toHaveBeenCalled();
    expect(spies.recognitionAnalyze).not.toHaveBeenCalled();
  });

  test('Windows supported/degraded profile keeps the existing panels and hardware paths', async () => {
    const { api, spies } = makeApi();
    (globalThis as any).electronAPI = api;
    (globalThis as any).window = globalThis;

    await act(async () => {
      root.render(createElement(POSLayout, { capabilityHost: capabilityHost('windows') }));
    });
    await settle();

    expect(captured.quickAddPanelMounts).toBeGreaterThan(0);
    expect(captured.addProductPanelMounts).toBeGreaterThan(0);
    expect(captured.debtPanelMounts).toBeGreaterThan(0);
    expect(captured.autoCameraMounts).toBeGreaterThan(0);
    expect(typeof captured.productGridProps?.onLongPressProduct).toBe('function');
    expect(typeof captured.cartProps?.onPrintItemLabel).toBe('function');
    expect(spies.listWindows).toHaveBeenCalled();
    expect(spies.pickup.machineId).toHaveBeenCalled();
    expect(spies.pickup.listOpen).toHaveBeenCalled();
    await act(async () => {
      await captured.productGridProps!.onAddProduct(weightedProduct);
    });
    expect(spies.readWeight).toHaveBeenCalledWith({ port: 'COM1' });
  });

  test('Android scan-import classifies a weighted variant and falls back to manual weight', async () => {
    const { api, spies } = makeApi();
    spies.draftGetByBarcode.mockResolvedValue({
      id: 'draft-weighted-1',
      name: weightedProduct.name,
      barcode: '5901234567890',
      retail_price: weightedProduct.retail_price,
      stock_qty: weightedProduct.in_stock,
      vat_rate: weightedProduct.vat_rate,
      image_url: null,
      status: 'draft',
    });
    spies.importDraft.mockResolvedValue({ ok: true, variant: weightedProduct });
    (globalThis as any).electronAPI = api;
    (globalThis as any).window = globalThis;

    await act(async () => {
      root.render(createElement(POSLayout, { capabilityHost: capabilityHost('android') }));
    });
    await settle();

    await act(async () => {
      await captured.searchBarProps!.onBarcodeScanned('5901234567890');
    });
    await settle();
    expect(captured.scanImportProps?.open).toBe(true);

    await act(async () => {
      await captured.scanImportProps!.onConfirm(1000, undefined, 10);
    });
    await settle();

    expect(spies.importDraft).toHaveBeenCalledWith({
      ean: '5901234567890',
      retailPriceGrosze: 1000,
      stockQty: 10,
    });
    expect(spies.readWeight).not.toHaveBeenCalled();
    expect(captured.dispatchCalls).not.toContainEqual(expect.objectContaining({ type: 'cart/addItem' }));
    expect(container.textContent).toContain('Manual weight');
  });

  test('real Cart ignores stale scale config when the Android runtime forbids scale', async () => {
    const { default: RealCart } = await vi.importActual<typeof import('../src/renderer/components/pos/Cart')>(
      '../src/renderer/components/pos/Cart',
    );
    const { api, spies } = makeApi();
    const dispatch = vi.fn();
    const weightedCart = {
      items: [{
        id: 'weighted-line-1',
        variantId: weightedProduct.id,
        name: weightedProduct.name,
        sku: weightedProduct.sku,
        price: weightedProduct.retail_price,
        quantity: 0.5,
        total: 500,
        saleUnit: weightedProduct.sale_unit,
        sellBy: weightedProduct.sell_by,
        vatRate: weightedProduct.vat_rate,
      }],
      subtotal: 500,
      discount: 0,
      tax: 0,
      total: 500,
    };
    const cartProps = {
      cart: weightedCart,
      dispatch,
      onPay: vi.fn(),
      t: (key: string) => key,
    };
    (globalThis as any).electronAPI = api;
    (globalThis as any).window = globalThis;

    await act(async () => {
      root.render(createElement(
        PosCapabilityProvider,
        { host: capabilityHost('android') },
        createElement(RealCart, cartProps as any),
      ));
    });
    await settle();

    expect(container.querySelector('button[aria-label="Read scale"]')).toBeNull();
    expect(spies.readWeight).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'cart/updateQuantity' }));

    act(() => { root.unmount(); });
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(
        PosCapabilityProvider,
        { host: capabilityHost('windows') },
        createElement(RealCart, cartProps as any),
      ));
    });
    await settle();
    const readScaleButton = container.querySelector<HTMLButtonElement>('button[aria-label="Read scale"]');
    expect(readScaleButton).toBeTruthy();
    await act(async () => { readScaleButton!.click(); });
    await settle();
    expect(spies.readWeight).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'cart/updateQuantity',
      payload: { id: 'weighted-line-1', quantity: 0.5 },
    });
  });

  test('QuickActions cannot call customer-display/create/recognition callbacks on Android', async () => {
    const onDisplay = vi.fn();
    const onCamera = vi.fn();
    const onCreate = vi.fn();
    const props = {
      dispatch: vi.fn(),
      hasItems: false,
      onOpenCustomerDisplay: onDisplay,
      onCloseCustomerDisplay: vi.fn(),
      isCustomerDisplayOpen: false,
      displayMode: 'idle',
      t: (key: string) => key,
      onQuickAddCamera: onCamera,
      onCreateProduct: onCreate,
    };

    await act(async () => {
      root.render(createElement(
        PosCapabilityProvider,
        { host: capabilityHost('android') },
        createElement(QuickActions, props),
      ));
    });
    await settle();
    expect(findButton(container, 'Camera')).toBeUndefined();
    expect(findButton(container, 'Tạo sản phẩm')).toBeUndefined();
    expect(findButton(container, 'pos.displayOn')).toBeUndefined();
    expect(onDisplay).not.toHaveBeenCalled();
    expect(onCamera).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();

    await act(async () => {
      root.render(createElement(
        PosCapabilityProvider,
        { host: capabilityHost('windows') },
        createElement(QuickActions, props),
      ));
    });
    await settle();
    const camera = findButton(container, 'Camera');
    const create = findButton(container, 'Tạo sản phẩm');
    const display = findButton(container, 'pos.displayOn');
    expect(camera).toBeTruthy();
    expect(create).toBeTruthy();
    expect(display).toBeTruthy();
    await act(async () => {
      camera!.click();
      create!.click();
      display!.click();
    });
    expect(onCamera).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onDisplay).toHaveBeenCalledTimes(1);
  });

  test('restored tender is disabled before bridge/preflight on Android and still begins on Windows', async () => {
    const restoredInterruption = {
      holdId: 'hold-1',
      checkoutId: 'checkout-1',
      orderId: 'order-1',
      clientAttemptId: 'attempt-1',
      tenderState: 'READY',
    };
    const paymentProps = {
      cart: { items: [], subtotal: 1000, discount: 0, tax: 0, total: 1000 },
      checkoutDraft: { restoredInterruption },
      dispatch: vi.fn(),
      onClose: vi.fn(),
      t: (key: string) => key,
      shiftId: 'shift-1',
      staffId: 'staff-1',
      staffName: 'Cashier',
    };
    const androidApi = makeApi();
    (globalThis as any).electronAPI = androidApi.api;
    (globalThis as any).window = globalThis;

    await act(async () => {
      root.render(createElement(
        PosCapabilityProvider,
        { host: capabilityHost('android') },
        createElement(PaymentModal, paymentProps as any),
      ));
    });
    await settle();
    expect(androidApi.spies.preflight).not.toHaveBeenCalled();
    expect(androidApi.spies.beginRestoredTender).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Restored-cart payment is unavailable on this device.');
    expect(findButton(container, 'Loyalty')).toBeUndefined();

    act(() => { root.unmount(); });
    root = createRoot(container);
    const windowsApi = makeApi();
    (globalThis as any).electronAPI = windowsApi.api;
    await act(async () => {
      root.render(createElement(
        PosCapabilityProvider,
        { host: capabilityHost('windows') },
        createElement(PaymentModal, paymentProps as any),
      ));
    });
    await settle(12);
    expect(windowsApi.spies.preflight).toHaveBeenCalledTimes(1);
    expect(windowsApi.spies.beginRestoredTender).toHaveBeenCalledWith('hold-1', 'preflight-token');
    expect(findButton(container, 'Loyalty')).toBeTruthy();
  });
});
