// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const layout = vi.hoisted(() => ({
  state: {
    cart: { items: [], subtotal: 0, discount: 0, tax: 0, total: 0 },
    checkoutDraft: {},
    session: { shiftId: 'shift-1', staffId: 'staff-1', staffName: 'Cashier', isOpen: true, openedAt: '2026-08-09T00:00:00.000Z' },
    display: { mode: 'idle' },
  } as any,
  dispatches: [] as any[],
}));

vi.mock('../src/renderer/hooks/useConfig', () => ({
  useConfig: () => ({ config: { posMode: 'retail', posLanguage: 'en' }, saveConfig: vi.fn() }),
}));
vi.mock('../src/renderer/hooks/usePosStore', () => ({
  usePosStore: () => ({ state: layout.state, dispatch: (action: any) => layout.dispatches.push(action), dispatchError: null, clearDispatchError: vi.fn() }),
}));
vi.mock('../src/renderer/hooks/useBarcodeForwarder', () => ({ useBarcodeForwarder: () => undefined }));
vi.mock('../src/renderer/components/pos/SearchBar', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/ProductGrid', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/Cart', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/ScanImportModal', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/AutoCameraSearch', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/PaymentModal', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/OrderHistoryModal', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/ShiftModal', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/ShiftReport', () => ({ default: () => null }));
vi.mock('../src/renderer/components/pos/SyncConflictBanner', () => ({ default: () => null }));

import ProductCreateDialog from '../src/renderer/components/products/ProductCreateDialog';
import ProductModule from '../src/renderer/components/products/ProductModule';
import { productAdminVariantToCartLine } from '../src/renderer/components/products/product-admin-variant-adapter';
import { resetProductAdminCapabilitiesCache, useProductAdminCapabilities } from '../src/renderer/hooks/useProductAdminCapabilities';
import POSLayout from '../src/renderer/components/pos/POSLayout';
import { RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS, resolveAndroidPosCapabilityManifest, type PosCapabilityHost } from '../src/renderer/components/pos/capabilities/PosCapabilityProvider';

const variant = {
  id: 'variant-1', templateId: 'template-1', name: 'Native EAN item', sku: 'SKU-1', barcode: '5901234567890',
  priceGrossGrosze: 1299, vatRate: 23, totalStockQty: 4, availableQty: 4, isActive: true,
  saleUnit: 'szt', sellBy: 'PIECE' as const, updatedAt: '2026-08-09T00:00:00.000Z',
};

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function androidHost(authRevision = 1): PosCapabilityHost {
  return {
    session: {
      authenticated: true, salonId: 'salon-1', userId: 'user-1', registerId: 'register-1', authRevision,
      roleRevision: 'OWNER', entitlementRevision: 'entitlements-1', configRevision: 'config-1', platformRevision: 'android-v1',
    },
    policyInputs: RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
    resolvePlatformManifest: resolveAndroidPosCapabilityManifest,
  };
}

describe('Android native product create', () => {
  let root: Root;
  let container: HTMLDivElement;
  const createProduct = vi.fn();
  const previousApi = (globalThis as any).electronAPI;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    createProduct.mockReset();
    resetProductAdminCapabilitiesCache();
    layout.dispatches = [];
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).window = globalThis;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('idem-native-1');
    (globalThis as any).electronAPI = {
      onBarcodeScanned: () => () => {},
      getStatus: async () => ({ connected: true }),
      onConnectionStatus: () => () => {},
      onConfigUpdated: () => () => {},
      getConfig: async () => ({}),
      invoice: { vatRates: { get: async () => ({ success: true, data: [{ rate: 23, is_active: true }] }) } },
      pos: {
        getState: async () => ({ cart: { items: [], subtotal: 0, discount: 0, tax: 0, total: 0 }, checkoutDraft: {}, session: null }),
        onStateChanged: () => () => {},
        onFiscalUnknown: () => () => {}, onReceiptPrintStatus: () => () => {}, listReceiptPrintStatuses: async () => [],
        onPickupOrderEvent: () => () => {},
        billiardCheckout: { recover: async () => ({ success: true, intent: null }) },
        hold: { list: async () => [], importLegacy: async () => ({ success: true }), createCurrent: async () => ({ success: true }), recall: async () => ({ success: true }), remove: async () => ({ success: true }) },
        productAdmin: {
          getCapabilities: vi.fn(async () => ({ ok: true, capabilities: { canCreateProduct: true } })),
          createProduct,
          uploadMainImage: vi.fn(),
        },
        products: {
          getAll: async () => [], getAllIncludingInactive: async () => [], getByBarcode: async () => null, getById: async () => null, search: async () => [],
        },
        categories: { getAll: async () => [], getAllIncludingEmpty: async () => [] },
        draftProducts: { getAll: async () => [], getByBarcode: async () => null },
        sync: {
          products: async () => ({ success: true }),
          onProductsSynced: () => () => {}, onCatalogUpdated: () => () => {}, onStockUpdated: () => () => {},
          onDraftProductsSynced: () => () => {},
        },
        localVariantImports: { listFailed: async () => ({ ok: true, items: [] }), listUnresolvedIds: async () => ({ ok: true, ids: [] }) },
      },
    };
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    (globalThis as any).electronAPI = previousApi;
    vi.restoreAllMocks();
  });

  async function render(canCreateProduct: boolean, products: any[] = []) {
    await act(async () => {
      root.render(createElement(ProductCreateDialog, {
        open: true, categories: [], products, language: 'en', t: (key: string) => key,
        supportsItemType: false, canCreateProduct, canViewPurchasePrice: false,
        canReplaceMainImage: false, onClose: vi.fn(), onCreated: vi.fn(),
      }));
    });
  }

  async function fillValidCreate() {
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[];
    await act(async () => {
      setInput(inputs[0], 'Native EAN item');
      setInput(inputs[1], '5901234567890');
      setInput(inputs[2], '12.99');
      setInput(inputs[3], '4');
    });
  }

  test('is fail-closed before the per-auth canCreateProduct capability resolves', async () => {
    await render(false);
    const submit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Create product'))!;
    expect(submit.disabled).toBe(true);
    await act(async () => { submit.click(); });
    expect(createProduct).not.toHaveBeenCalled();
  });

  test('sends the native typed create payload with immutable idempotency and reports the created variant', async () => {
    const onCreated = vi.fn();
    createProduct.mockResolvedValue({ ok: true, data: { variant } });
    await act(async () => {
      root.render(createElement(ProductCreateDialog, {
        open: true, categories: [], products: [], language: 'en', t: (key: string) => key,
        supportsItemType: false, canCreateProduct: true, canViewPurchasePrice: false,
        canReplaceMainImage: false, onClose: vi.fn(), onCreated,
      }));
    });
    await fillValidCreate();
    const submit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Create product'))!;
    await act(async () => { submit.click(); });
    expect(createProduct).toHaveBeenCalledWith({
      name: 'Native EAN item', barcode: '5901234567890', sku: null, priceGrossGrosze: 1299,
      vatRate: 23, initialStockQty: 4, categoryId: null, saleUnit: 'szt', sellBy: 'PIECE', imageUrl: null,
      idempotencyKey: 'idem-native-1',
    });
    expect(onCreated).toHaveBeenCalledWith(variant);
  });

  test('rejects a duplicate local EAN before it calls the Android bridge', async () => {
    await render(true, [{ id: 'existing', name: 'Existing', barcode: '5901234567890', sku: null, is_active: 1 }]);
    await fillValidCreate();
    const submit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Create product'))!;
    await act(async () => { submit.click(); });
    expect(createProduct).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Barcode already exists');
  });

  test('closes the native route on an authorization denial', async () => {
    const onAccessDenied = vi.fn();
    createProduct.mockResolvedValue({ ok: false, code: 'UNAUTHORIZED_PRODUCT_ADMIN', error: 'forbidden' });
    await act(async () => {
      root.render(createElement(ProductCreateDialog, {
        open: true, categories: [], products: [], language: 'en', t: (key: string) => key,
        supportsItemType: false, canCreateProduct: true, canViewPurchasePrice: false,
        canReplaceMainImage: false, onClose: vi.fn(), onAccessDenied, onCreated: vi.fn(),
      }));
    });
    await fillValidCreate();
    const submit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Create product'))!;
    await act(async () => { submit.click(); });
    expect(onAccessDenied).toHaveBeenCalledTimes(1);
    await act(async () => { submit.click(); });
    expect(createProduct).toHaveBeenCalledTimes(2);
  });

  test('non-external authorization denial remains a definitive visible form error', async () => {
    createProduct.mockResolvedValue({ ok: false, code: 'UNAUTHORIZED_PRODUCT_ADMIN', error: 'forbidden' });
    await render(true);
    await fillValidCreate();
    const submit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Create product'))!;
    await act(async () => { submit.click(); });
    expect(container.textContent).toContain('forbidden');
    await act(async () => { submit.click(); });
    expect(createProduct).toHaveBeenCalledTimes(2);
  });

  test('external create cancel exits back to the till instead of exposing ProductModule browse UI', async () => {
    function ExternalRoute() {
      const [open, setOpen] = useState(true);
      return open
        ? createElement(ProductModule, {
          language: 'en', openCreate: true, adminCapabilityScope: 'salon:user:register:1',
          onCreatedForExternal: vi.fn(), onExitExternal: () => setOpen(false),
        })
        : createElement('div', { 'data-testid': 'back-at-pos' });
    }
    await act(async () => { root.render(createElement(ExternalRoute)); });
    for (let index = 0; index < 6; index += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    const cancel = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Cancel'));
    expect(cancel).toBeDefined();
    await act(async () => { cancel!.click(); });
    expect(container.querySelector('[data-testid="back-at-pos"]')).not.toBeNull();
  });

  test('a committed external create still adds its exact piece line and exits when catalogue sync fails', async () => {
    const addLine = vi.fn();
    const syncProducts = vi.fn(async () => ({ success: false, error: 'network' }));
    createProduct.mockResolvedValue({ ok: true, data: { variant } });
    (globalThis as any).electronAPI.pos.sync.products = syncProducts;
    function ExternalRoute() {
      const [open, setOpen] = useState(true);
      return open
        ? createElement(ProductModule, {
          language: 'en', openCreate: true, adminCapabilityScope: 'salon:user:register:1',
          onCreatedForExternal: (created: typeof variant) => addLine(productAdminVariantToCartLine(created, 'line-after-sync-failure')),
          onExitExternal: () => setOpen(false),
        })
        : createElement('div', { 'data-testid': 'back-at-pos' });
    }
    await act(async () => { root.render(createElement(ExternalRoute)); });
    for (let index = 0; index < 6; index += 1) await act(async () => { await Promise.resolve(); });
    await fillValidCreate();
    const submit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Create product'))!;
    await act(async () => { submit.click(); });
    expect(createProduct).toHaveBeenCalledTimes(1);
    expect(syncProducts).toHaveBeenCalledTimes(1);
    expect(addLine).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'cart-line',
      line: expect.objectContaining({ variantId: 'variant-1', price: 1299, quantity: 1, total: 1299, vatRate: 23 }),
    }));
    expect(container.querySelector('[data-testid="back-at-pos"]')).not.toBeNull();
  });

  test('real Android POSLayout route delivers committed piece cart/exit before a deferred catalogue sync resolves', async () => {
    const getCapabilities = (globalThis as any).electronAPI.pos.productAdmin.getCapabilities as ReturnType<typeof vi.fn>;
    let resolveSync: ((value: { success: boolean }) => void) | undefined;
    const pendingSync = new Promise<{ success: boolean }>((resolve) => { resolveSync = resolve; });
    (globalThis as any).electronAPI.pos.sync.products = vi.fn(() => pendingSync);
    getCapabilities.mockResolvedValueOnce({ ok: true, capabilities: { canCreateProduct: true } });
    createProduct.mockResolvedValue({ ok: true, data: { variant } });
    await act(async () => { root.render(createElement(POSLayout, { capabilityHost: androidHost(1) })); });
    for (let index = 0; index < 8; index += 1) await act(async () => { await Promise.resolve(); });
    const create = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Tạo sản phẩm'));
    expect(create).toBeDefined();
    await act(async () => { create!.click(); });
    expect(container.textContent).toContain('Create product');
    expect(container.querySelector('webview')).toBeNull();
    await fillValidCreate();
    const submit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Create product'))!;
    await act(async () => { submit.click(); });
    expect(createProduct).toHaveBeenCalledTimes(1);
    expect(layout.dispatches).toContainEqual(expect.objectContaining({
      type: 'cart/addItem', payload: expect.objectContaining({ variantId: 'variant-1', quantity: 1, price: 1299, total: 1299, vatRate: 23 }),
    }));
    expect(container.textContent).not.toContain('Create product');
    resolveSync?.({ success: true });
  });

  test('real Android POSLayout route revokes the same auth scope after create 403 without a second bridge call', async () => {
    const getCapabilities = (globalThis as any).electronAPI.pos.productAdmin.getCapabilities as ReturnType<typeof vi.fn>;
    getCapabilities.mockResolvedValueOnce({ ok: true, capabilities: { canCreateProduct: true } });
    createProduct.mockResolvedValue({ ok: false, code: 'UNAUTHORIZED_PRODUCT_ADMIN', error: 'forbidden' });
    await act(async () => { root.render(createElement(POSLayout, { capabilityHost: androidHost(1) })); });
    for (let index = 0; index < 8; index += 1) await act(async () => { await Promise.resolve(); });
    const create = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Tạo sản phẩm'))!;
    await act(async () => { create.click(); });
    await fillValidCreate();
    const submit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Create product'))!;
    await act(async () => { submit.click(); });
    expect(createProduct).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Create product');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('Tạo sản phẩm'))).toBe(false);
    expect(getCapabilities).toHaveBeenCalledTimes(1);
  });

  test('capability denial sentinel survives same-scope remount, rejects stale success, and only retry/new auth may probe', async () => {
    let latest: ReturnType<typeof useProductAdminCapabilities> | null = null;
    function Probe({ scope }: { scope: string }) {
      latest = useProductAdminCapabilities(true, scope);
      return createElement('div', null, latest.error || (latest.capabilities?.canCreateProduct ? 'enabled' : 'pending'));
    }
    let resolveStale: ((value: any) => void) | undefined;
    const stale = new Promise((resolve) => { resolveStale = resolve; });
    const getCapabilities = (globalThis as any).electronAPI.pos.productAdmin.getCapabilities as ReturnType<typeof vi.fn>;
    getCapabilities.mockImplementationOnce(() => stale);
    await act(async () => { root.render(createElement(Probe, { scope: 'salon:user:register:1' })); });
    await act(async () => { await Promise.resolve(); });
    expect(getCapabilities).toHaveBeenCalledTimes(1);
    act(() => { latest!.invalidate(); });
    expect(container.textContent).toContain('UNAUTHORIZED_PRODUCT_ADMIN');
    await act(async () => { resolveStale?.({ ok: true, capabilities: { canCreateProduct: true } }); await Promise.resolve(); });
    expect(container.textContent).toContain('UNAUTHORIZED_PRODUCT_ADMIN');

    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { root.render(createElement(Probe, { scope: 'salon:user:register:1' })); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('UNAUTHORIZED_PRODUCT_ADMIN');
    expect(getCapabilities).toHaveBeenCalledTimes(1);

    getCapabilities.mockResolvedValueOnce({ ok: true, capabilities: { canCreateProduct: true } });
    act(() => { latest!.retry(); });
    for (let index = 0; index < 3; index += 1) await act(async () => { await Promise.resolve(); });
    expect(getCapabilities).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('enabled');

    getCapabilities.mockResolvedValueOnce({ ok: true, capabilities: { canCreateProduct: false } });
    await act(async () => { root.render(createElement(Probe, { scope: 'salon:user-2:register:2' })); });
    for (let index = 0; index < 3; index += 1) await act(async () => { await Promise.resolve(); });
    expect(getCapabilities).toHaveBeenCalledTimes(3);
  });
});
