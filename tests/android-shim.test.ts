import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  __resetShimForTest,
  installShim,
  sanitizeConfigForRenderer,
  ShimConfigStore,
} from '../src/renderer/android-pos/shim/index';
import {
  createInitialState,
  posReducer,
  type CartItem,
  type PosAction,
  type PosState,
} from '../src/renderer/android-pos/shim/pos-store';
import {
  ensureStableMachineId,
  SYNTHETIC_AUTH_USER,
} from '../src/renderer/android-pos/shim/config-store';
import type { ShimTransport } from '../src/renderer/android-pos/shim/transport';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeMapStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    __map: map,
  };
}

function cartItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    id: 'line-1',
    variantId: 'v-1',
    name: 'Test Product',
    sku: 'SKU-1',
    price: 1000, // 10.00 zł in grosze
    quantity: 1,
    total: 1000,
    vatRate: 23,
    ...overrides,
  };
}

// ── shim surface ────────────────────────────────────────────────────────────

describe('android shim installShim', () => {
  beforeEach(() => __resetShimForTest());
  afterEach(() => __resetShimForTest());

  test('opening a shift flips the POS store session so payment unlocks', async () => {
    const { api } = installShim();
    expect((await api.pos.getState()).session.isOpen).toBe(false);

    const opened = await api.pos.shift.open({ staffId: 's1', staffName: 'Ala', openingCash: 1000 });
    expect(opened.success).toBe(true);

    const state = await api.pos.getState();
    expect(state.session.isOpen).toBe(true);
    expect(state.session.shiftId).toBe(opened.shiftId);
    expect(state.session.staffName).toBe('Ala');

    await api.pos.shift.close({ shiftId: opened.shiftId, closingCash: 1000 });
    expect((await api.pos.getState()).session.isOpen).toBe(false);
  });

  test('a fresh login resets the POS session so no ghost shift survives a tenant switch', async () => {
    const { api } = installShim();
    const opened = await api.pos.shift.open({ staffId: 's1', staffName: 'Ala', openingCash: 1000 });
    expect((await api.pos.getState()).session.isOpen).toBe(true);

    // Re-login (e.g. after an onExpired or a salon switch) must clear the
    // in-memory session — otherwise payment stays unlocked by a shift whose
    // row was wiped, and createOrder would reject every sale.
    await api.auth.loginWithEmail('other@salon.pl', 'pw');
    expect((await api.pos.getState()).session.isOpen).toBe(false);
    void opened;
  });

  test('installs the full S1 contract surface', async () => {
    const { api } = installShim();

    // Boot · Config · Connection (S1 §2.A)
    expect(typeof api.getConfig).toBe('function');
    expect(typeof api.setConfig).toBe('function');
    expect(typeof api.saveConfig).toBe('function');
    expect(typeof api.onConfigUpdated).toBe('function');
    expect(typeof api.getStatus).toBe('function');
    expect(typeof api.onConnectionStatus).toBe('function');
    expect(typeof api.connect).toBe('function');
    expect(typeof api.disconnect).toBe('function');

    // Auth (S1 §2.B)
    for (const m of ['loginWithEmail', 'getUser', 'logout', 'onExpired', 'generateLoginToken', 'checkToken', 'generateRegisterToken']) {
      expect(typeof api.auth[m], `auth.${m}`).toBe('function');
    }

    // POS store (S1 §2.C)
    expect(typeof api.pos.getState).toBe('function');
    expect(typeof api.pos.dispatch).toBe('function');
    expect(typeof api.pos.onStateChanged).toBe('function');

    // Catalog / orders / shift / staff / sync / payment (S1 §2.D–§2.H)
    for (const m of ['getAll', 'getById', 'getByBarcode', 'search']) {
      expect(typeof api.pos.products[m], `pos.products.${m}`).toBe('function');
    }
    expect(typeof api.pos.categories.getAll).toBe('function');
    expect(typeof api.pos.orders.create).toBe('function');
    expect(typeof api.pos.shift.open).toBe('function');
    expect(typeof api.pos.shift.close).toBe('function');
    expect(typeof api.pos.staff.getAll).toBe('function');
    expect(typeof api.pos.sync.products).toBe('function');
    expect(typeof api.pos.payment.printReceiptAndOpenDrawer).toBe('function');
    expect(typeof api.pos.payment.hasFiscalPrinter).toBe('function');
    expect(typeof api.pos.payment.preflight).toBe('function');

    // Boot subscriptions that fire unconditionally (S1 §7.8)
    expect(typeof api.pos.onFiscalUnknown).toBe('function');
    expect(typeof api.pos.onPickupOrderEvent).toBe('function');

    // Entitlements + window + hardware stubs (S1 §2.A, §2.J–§2.L)
    expect(typeof api.entitlements.get).toBe('function');
    expect(typeof api.window.open).toBe('function');
    expect(typeof api.scale.readWeight).toBe('function');
    expect(typeof api.sendKeyboardInput).toBe('function');
    expect(typeof api.onBarcodeScanned).toBe('function');
  });

  test('assigns window.electronAPI when a window exists', () => {
    const g = globalThis as unknown as { window?: Record<string, unknown> };
    const originalWindow = g.window;
    g.window = {};
    try {
      const { api } = installShim();
      expect((g.window as Record<string, unknown>).electronAPI).toBe(api);
    } finally {
      g.window = originalWindow;
    }
  });

  test('subscriptions return unsubscribe functions', () => {
    const { api } = installShim();
    for (const unsub of [
      api.onConfigUpdated(() => {}),
      api.onConnectionStatus(() => {}),
      api.onBarcodeScanned(() => {}),
      api.auth.onExpired(() => {}),
      api.pos.onStateChanged(() => {}),
      api.pos.onFiscalUnknown(() => {}),
      api.pos.sync.onProductsSynced(() => {}),
      api.entitlements.onChanged(() => {}),
    ]) {
      expect(typeof unsub).toBe('function');
    }
  });
});

// ── STUB returns match S1 exactly (spot-check 10+) ──────────────────────────

describe('android shim S1 stub defaults', () => {
  let api: ReturnType<typeof installShim>['api'];
  beforeEach(() => {
    __resetShimForTest();
    api = installShim().api;
  });
  afterEach(() => __resetShimForTest());

  test('boot/connection + hardware stubs', async () => {
    expect(await api.getStatus()).toEqual({ connected: true, deviceStatus: null });
    expect(await api.connect()).toEqual({ success: true });
    expect(await api.disconnect()).toEqual({ success: true });
    expect(await api.scale.readWeight()).toEqual({
      success: false, weightKg: 0, stable: false, code: 'NO_SCALE', error: 'no-scale',
    });
    expect(await api.printLabel('123')).toEqual({ success: false, error: 'no-label-printer' });
    expect(await api.testPrint()).toEqual({ success: false, error: 'no-printer' });
    expect(await api.testPrinterByType('thermal')).toEqual({ success: false, error: 'no-printer' });
    expect(await api.listWindowsPrinters()).toEqual([]);
  });

  test('Telegram-QR auth login is unavailable (email is the pilot path)', async () => {
    const expected = { success: false, error: 'telegram-login-unavailable' };
    expect(await api.auth.generateLoginToken()).toEqual(expected);
    expect(await api.auth.checkToken('any')).toEqual(expected);
    expect(await api.auth.generateRegisterToken()).toEqual(expected);
  });

  test('payment / receipt stubs let the CASH checkout complete without the recovery overlay', async () => {
    // Synthetic install only (no transport injected), which is why an
    // unverified success is still acceptable here: nothing can take money on
    // this path. With a real transport, preflight delegates to
    // transport.paymentPreflight, which verifies the local open shift AND the
    // register's shift on the server — see android-payment-preflight.test.ts.
    // The literal is deliberately distinct from the old 'android:<orderId>' so
    // a synthetic token can never be mistaken for a verified one.
    expect(await api.pos.payment.preflight('order-1')).toMatchObject({
      success: true,
      token: 'android-synthetic:order-1',
    });
    expect(await api.pos.payment.hasFiscalPrinter()).toEqual({
      success: true, configured: false, connected: false,
    });
    // The receipt COPY reports printed so PaymentModal does not enter the
    // receipt-recovery overlay on every CASH sale (Wave 1 fix). The fiscal
    // receipt is NOT claimed printed.
    expect(await api.pos.payment.printReceipt('o1')).toEqual({
      success: true, receiptPrinted: true,
    });
    expect(await api.pos.payment.printReceiptAndOpenDrawer('o1')).toEqual({
      success: true, receiptPrinted: true, drawerOpened: false,
    });
    expect(await api.pos.payment.printFiscalReceipt('o1')).toEqual({
      success: true, fiscalPrinted: false,
    });
    expect(await api.pos.payment.reprintReceipt('o1')).toMatchObject({ receiptPrinted: true });
    expect(await api.pos.payment.getPrintAttempts('o1')).toEqual({ success: true, attempts: [] });
    expect(await api.pos.payment.getLatestFiscalAttempt('o1')).toEqual({
      success: true, attempt: null, printer: null,
    });
    expect(await api.pos.payment.getReconcilableFiscalAttempt('o1')).toEqual({
      success: true, attempt: null,
    });
    expect(await api.pos.payment.reconcileFiscalAttempt('o1', true)).toEqual({
      success: false,
      error: 'Fiscal attempt reconciliation is available on the Windows counter.',
    });
  });

  test('catalog / master-catalog / admin / AI / window stubs', async () => {
    expect(await api.pos.products.getAll()).toEqual([]);
    expect(await api.pos.products.getById('x')).toBeNull();
    expect(await api.pos.products.getByBarcode('x')).toBeNull();
    expect(await api.pos.categories.getAll()).toEqual([]);
    expect(await api.pos.masterCatalog.lookupByEan('123')).toEqual({ ok: false, draft: null });
    expect(await api.pos.productAdmin.updateVariant('v', {})).toEqual({
      ok: false, code: 'UNAUTHORIZED_PRODUCT_ADMIN',
    });
    expect(await api.pos.recognition.analyze({ images: [] })).toEqual({
      ok: false, products: [], error: 'recognition-unavailable',
    });
    expect(await api.pos.voice.transcribe({ audioBase64: '' })).toEqual({
      ok: false, error: 'voice-unavailable',
    });
    expect(await api.pos.pickupOrders.machineId()).toBeNull();
    expect(await api.pos.pickupOrders.listOpen()).toEqual([]);
    // Android has one WebView, so a shared renderer must never be told that a
    // customer display (or any Electron child window) is active.
    expect(await api.window.open('customer')).toEqual({ success: false, error: 'desktop-only' });
    expect(await api.window.close('customer')).toEqual({ success: false, error: 'desktop-only' });
    expect(await api.window.setFullScreen(true)).toEqual({ success: false, error: 'desktop-only' });
    expect(await api.window.setKiosk(true)).toEqual({ success: false, error: 'desktop-only' });
    expect(await api.window.list()).toEqual([]);
  });

  test('order history returns the unconfigured server-list source', async () => {
    expect(await api.pos.orders.getServerList({})).toEqual({
      orders: [], items: {}, total: 0, page: 1, limit: 50, source: 'unconfigured',
    });
    expect(await api.pos.orders.getHistory({ from: '2026-01-01', to: '2026-01-02' })).toEqual({
      orders: [], total: 0, page: 1, limit: 50,
    });
  });

  test('entitlements default to all-enabled', async () => {
    const entitlements = await api.entitlements.get();
    expect(entitlements.plan).toBe('enterprise');
    expect(entitlements.features.pos.enabled).toBe(true);
    expect(entitlements.features.orders.enabled).toBe(true);
    expect(await api.entitlements.isEnabled('pos')).toBe(true);
  });
});

// ── synthetic auth (S1 §2.B + S2 seed) ──────────────────────────────────────

describe('android shim synthetic auth', () => {
  beforeEach(() => __resetShimForTest());
  afterEach(() => __resetShimForTest());

  test('loginWithEmail succeeds with the synthetic staff identity', async () => {
    const { api, configStore } = installShim();
    const result = await api.auth.loginWithEmail('cashier@salon.test', 'pw');
    expect(result.success).toBe(true);
    expect(result.data?.user).toMatchObject({ role: 'STAFF', salonId: 'synthetic' });
    // Mirrors the Windows setConfig side-effect (minus the print-agent connect rail).
    expect(configStore.getRawConfig().authUser?.email).toBe('cashier@salon.test');
  });

  test('getUser reports an authenticated synthetic session', async () => {
    const { api } = installShim();
    const result = await api.auth.getUser();
    expect(result.success).toBe(true);
    expect(result.data?.isAuthenticated).toBe(true);
    expect(result.data?.user).toEqual(SYNTHETIC_AUTH_USER);
  });

  test('logout clears the cached identity but keeps POS data', async () => {
    const { api, configStore } = installShim();
    await api.auth.loginWithEmail('cashier@salon.test', 'pw');
    expect(configStore.getRawConfig().authUser).toBeTruthy();
    await api.auth.logout();
    expect(configStore.getRawConfig().authUser).toBeUndefined();
  });

  test('an injected transport overrides the synthetic fakes', async () => {
    const transport: ShimTransport = {
      getProducts: async () => [{
        id: 'real-1', template_id: null, name: 'Real Product', sku: 'R1', barcode: null,
        retail_price: 2500, category_id: null, image_url: null, in_stock: 10, available_qty: 10,
        vat_rate: 23, is_active: 1, is_on_sale: 0, thumbnail_url: null, sale_unit: 'PIECE',
        sell_by: 'PIECE', updated_at: null,
      }],
    };
    __resetShimForTest();
    const { api } = installShim({ transport });
    const products = await api.pos.products.getAll();
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe('Real Product');
  });
});

// ── pos-store reducer parity (ported from src/main/pos/pos-store.ts) ─────────

describe('android shim pos-store reducer', () => {
  test('createInitialState is empty with idle display', () => {
    const state = createInitialState();
    expect(state.cart.items).toEqual([]);
    expect(state.cart.total).toBe(0);
    expect(state.session.isOpen).toBe(false);
    expect(state.display.mode).toBe('idle');
  });

  test('addItem computes grosze subtotal / VAT / total', () => {
    let state = createInitialState();
    state = posReducer(state, {
      type: 'cart/addItem',
      payload: cartItem({ quantity: 2, price: 1000, vatRate: 23 }),
    });
    expect(state.cart.items).toHaveLength(1);
    expect(state.cart.items[0].total).toBe(2000);
    expect(state.cart.subtotal).toBe(2000);
    // VAT per line: round(2000 - 2000*100/123) = 374
    expect(state.cart.tax).toBe(374);
    expect(state.cart.total).toBe(2000);
    expect(state.display.mode).toBe('cart');
  });

  test('addItem merges same variant + staff + course', () => {
    let state = createInitialState();
    const item = cartItem({ variantId: 'v-1', quantity: 1, price: 1000 });
    state = posReducer(state, { type: 'cart/addItem', payload: item });
    state = posReducer(state, { type: 'cart/addItem', payload: { ...item, id: 'line-2' } });
    expect(state.cart.items).toHaveLength(1);
    expect(state.cart.items[0].quantity).toBe(2);
    expect(state.cart.subtotal).toBe(2000);
  });

  test('removeItem and updateQuantity keep totals consistent', () => {
    let state = createInitialState();
    state = posReducer(state, { type: 'cart/addItem', payload: cartItem({ id: 'a', variantId: 'a', quantity: 2, price: 1000 }) });
    state = posReducer(state, { type: 'cart/addItem', payload: cartItem({ id: 'b', variantId: 'b', quantity: 1, price: 500 }) });
    expect(state.cart.subtotal).toBe(2500);
    state = posReducer(state, { type: 'cart/updateQuantity', payload: { id: 'a', quantity: 1 } });
    expect(state.cart.items.find((i) => i.id === 'a')?.quantity).toBe(1);
    expect(state.cart.subtotal).toBe(1500);
    state = posReducer(state, { type: 'cart/removeItem', payload: { id: 'b' } });
    expect(state.cart.items).toHaveLength(1);
    expect(state.cart.subtotal).toBe(1000);
    // Removing the last item returns the display to idle (Windows parity).
    state = posReducer(state, { type: 'cart/removeItem', payload: { id: 'a' } });
    expect(state.cart.items).toEqual([]);
    expect(state.display.mode).toBe('idle');
  });

  test('updateQuantity to zero drops the line', () => {
    let state = createInitialState();
    state = posReducer(state, { type: 'cart/addItem', payload: cartItem({ id: 'a', variantId: 'a', quantity: 1 }) });
    state = posReducer(state, { type: 'cart/updateQuantity', payload: { id: 'a', quantity: 0 } });
    expect(state.cart.items).toEqual([]);
  });

  test('applyDiscount fixed and percentage, then clearDiscount', () => {
    let state = createInitialState();
    state = posReducer(state, { type: 'cart/addItem', payload: cartItem({ quantity: 2, price: 1000 }) });
    expect(state.cart.subtotal).toBe(2000);

    state = posReducer(state, { type: 'cart/applyDiscount', payload: { amount: 500, discountType: 'fixed' } });
    expect(state.cart.discount).toBe(500);
    expect(state.cart.total).toBe(1500);

    state = posReducer(state, { type: 'cart/clearDiscount' });
    expect(state.cart.discount).toBe(0);
    expect(state.cart.total).toBe(2000);

    state = posReducer(state, { type: 'cart/applyDiscount', payload: { amount: 10, discountType: 'percentage' } });
    expect(state.cart.discount).toBe(200); // 10% of 2000
    expect(state.cart.total).toBe(1800);
  });

  test('clear resets cart, discount, tip, and checkoutDraft', () => {
    let state = createInitialState();
    state = posReducer(state, { type: 'cart/addItem', payload: cartItem({ quantity: 1, price: 1000 }) });
    state = posReducer(state, { type: 'cart/applyDiscount', payload: { amount: 100 } });
    state = posReducer(state, { type: 'tip/set', payload: { amount: 50 } });
    state = posReducer(state, { type: 'cart/clear' });
    expect(state.cart.items).toEqual([]);
    expect(state.cart.total).toBe(0);
    expect(state.cart.discount).toBe(0);
    expect(state.tip).toBe(0);
  });

  test('session/open and session/close', () => {
    let state = createInitialState();
    state = posReducer(state, {
      type: 'session/open',
      payload: { shiftId: 'shift-1', staffId: 's-1', staffName: 'Alice' },
    });
    expect(state.session.isOpen).toBe(true);
    expect(state.session.shiftId).toBe('shift-1');
    expect(state.session.openedAt).toBeTruthy();

    state = posReducer(state, { type: 'cart/addItem', payload: cartItem({ quantity: 1, price: 1000 }) });
    state = posReducer(state, { type: 'session/close' });
    expect(state.session.isOpen).toBe(false);
    expect(state.cart.items).toEqual([]); // close clears the cart (Windows parity)
  });

  test('store broadcasts state changes to subscribers', async () => {
    const { api, posStore } = installShim();
    const seen: PosState[] = [];
    api.pos.onStateChanged((s: PosState) => seen.push(s));
    await api.pos.dispatch({ type: 'cart/addItem', payload: cartItem({ quantity: 1 }) } as PosAction);
    expect(seen.length).toBe(1);
    expect(seen[0].cart.items).toHaveLength(1);
    expect(posStore.getState().cart.items).toHaveLength(1);
  });
});

// ── config persistence + secret stripping (S1 §2.A) ─────────────────────────

describe('android shim config store', () => {
  test('getConfig sanitizes every secret field the Windows getRendererConfig strips', () => {
    const store = new ShimConfigStore({ storage: makeMapStorage() });
    store.setConfig({
      apiKey: 'pa_secret_key',
      aiApiKey: 'sk-ai',
      telegramToken: 'tok',
      // Secret fields arrive via the encrypted-* keys on Windows.
      ...(Object.fromEntries([
        ['encryptedAuthToken', 'enc-auth'],
        ['encryptedRefreshToken', 'enc-refresh'],
        ['encryptedApiKey', 'enc-key'],
        ['encryptedAiApiKey', 'enc-ai'],
        ['encryptedTelegramToken', 'enc-tg'],
        ['encryptedRemotePin', 'enc-pin'],
      ]) as Record<string, string>),
    } as Record<string, unknown> as Record<string, never>);

    const sanitized = store.getConfig();
    expect(sanitized.apiKey).toBe('');
    expect(sanitized.aiApiKey).toBe('');
    expect((sanitized as Record<string, unknown>).encryptedAuthToken).toBe('');
    expect((sanitized as Record<string, unknown>).encryptedRefreshToken).toBe('');
    expect((sanitized as Record<string, unknown>).encryptedApiKey).toBe('');
    expect((sanitized as Record<string, unknown>).encryptedAiApiKey).toBe('');
    expect((sanitized as Record<string, unknown>).encryptedTelegramToken).toBe('');
    expect((sanitized as Record<string, unknown>).encryptedRemotePin).toBe('');
  });

  test('seeds salon mode (Windows default) + synthetic authUser', () => {
    const store = new ShimConfigStore({ storage: makeMapStorage() });
    const config = store.getConfig();
    expect(config.posMode).toBe('salon'); // E2a: salon is the Windows default
    expect(config.authUser).toEqual(SYNTHETIC_AUTH_USER);
    expect(config.posEnabled).toBe(true);
  });

  test('persists across store instances via the storage adapter', () => {
    const storage = makeMapStorage();
    const a = new ShimConfigStore({ storage });
    a.setConfig({ posLanguage: 'vi', allowOversell: true });

    const b = new ShimConfigStore({ storage });
    expect(b.getConfig().posLanguage).toBe('vi');
    expect(b.getConfig().allowOversell).toBe(true);
  });

  test('creates one durable Android machine ID and never rotates it', () => {
    const storage = makeMapStorage();
    const first = new ShimConfigStore({ storage });

    expect(ensureStableMachineId(first, () => 'device-uuid-1')).toBe('android-device-uuid-1');
    expect(ensureStableMachineId(first, () => 'must-not-run')).toBe('android-device-uuid-1');

    const afterRestart = new ShimConfigStore({ storage });
    expect(ensureStableMachineId(afterRestart, () => 'must-not-run')).toBe('android-device-uuid-1');
    expect(afterRestart.getRawConfig().machineId).toBe('android-device-uuid-1');
  });

  test('onConfigUpdated fires on setConfig', () => {
    const store = new ShimConfigStore({ storage: makeMapStorage() });
    let calls = 0;
    store.onConfigUpdated(() => { calls += 1; });
    store.setConfig({ posLanguage: 'en' });
    store.setConfig({ allowOversell: true });
    expect(calls).toBe(2);
  });

  test('sanitizeConfigForRenderer is a pure helper usable without a store', () => {
    const sanitized = sanitizeConfigForRenderer({
      name: 'x',
      serverUrl: '',
      printerProtocol: 'THERMAL',
      printerBaudRate: 9600,
      isPaired: false,
      autoStart: false,
      apiKey: 'leak',
    } as Record<string, unknown> as Record<string, never>);
    expect(sanitized.apiKey).toBe('');
  });
});
