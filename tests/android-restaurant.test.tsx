// @vitest-environment happy-dom
import React, { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installShim, __resetShimForTest, ShimConfigStore } from '../src/renderer/android-pos/shim';
import { resolvePosMode, resolveAndroidSalonMode } from '../src/renderer/android-pos/shim/config-store';
import RestaurantTemplate from '../src/renderer/components/pos/templates/restaurant/RestaurantTemplate';
import { getTranslation } from '../src/renderer/i18n/translations';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

// No money/network/printer side effects. All menu/cart/state components and
// the Android adapter are real; this records the payment boundary's payload.
vi.mock('../src/renderer/components/pos/PaymentModal', () => ({ default: ({ extraOrderFields, dispatch, onComplete }: any) => (
  <div data-payment={JSON.stringify(extraOrderFields)}><button onClick={async () => {
    await dispatch({ type: 'cart/completeCheckout' }); onComplete();
  }}>Complete fixture payment</button></div>
) }));
const t = getTranslation('en');
function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
}
const item = { id: 'line', variantId: 'coffee', name: 'Coffee fixture', price: 1200, quantity: 1, total: 1200, vatRate: 8 };
function setup() {
  __resetShimForTest();
  const configStore = new ShimConfigStore({ storage: memoryStorage(), seed: { posMode: 'restaurant', salonId: 'a' } });
  return installShim({ configStore, transport: {
    getProducts: async () => [{ id: 'coffee', name: 'Coffee fixture', retail_price: 1200, in_stock: 20, track_stock: false, category_id: 'drinks' }] as any,
    getCategories: async () => [{ id: 'drinks', name: 'Drinks' }] as any,
  } });
}
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); __resetShimForTest(); });
async function click(text: string) {
  const button = [...host!.querySelectorAll('button')].find(b => b.textContent?.includes(text));
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}

describe('Android restaurant adapter and shared screen', () => {
  it('keeps restaurant after boot and config reload', () => {
    const storage = memoryStorage();
    const config = new ShimConfigStore({ storage });
    config.setConfig({ posMode: 'restaurant' });
    expect(resolvePosMode(new ShimConfigStore({ storage }).getConfig())).toBe('restaurant');
    expect(resolvePosMode(null, { suggestedPosMode: 'restaurant' })).toBe('restaurant');
  });
  it('acknowledges context changes and stores takeout/delivery', async () => {
    const { api } = setup();
    for (const orderType of ['takeout', 'delivery', 'dine_in']) {
      expect(await api.pos.dispatch({ type: 'table/setActive', payload: { tableId: null, orderType } })).toEqual({ success: true });
      expect((await api.pos.getState()).checkoutDraft.restaurant.orderType).toBe(orderType);
    }
  });
  it('remembers restaurant only for its salon and honors a new salon suggestion', async () => {
    const { api, configStore } = setup();
    await api.saveConfig({ posMode: 'restaurant' });
    const a = configStore.getRawConfig();
    expect(resolveAndroidSalonMode(a, 'a').posMode).toBe('restaurant');
    expect(resolveAndroidSalonMode(a, 'b').posMode).toBe('salon');
    const b = { ...a, salonId: 'b', ...resolveAndroidSalonMode(a, 'b', 'retail') };
    expect(b.posMode).toBe('retail');
    expect(resolveAndroidSalonMode(b, 'a').posMode).toBe('restaurant');
    expect(resolveAndroidSalonMode(a, 'new-restaurant', 'restaurant').posMode).toBe('restaurant');
  });
  it('does not change the mode while a sale is in progress', async () => {
    const { api, configStore } = setup();
    await api.pos.dispatch({ type: 'cart/addItem', payload: item });
    await expect(api.setConfig({ posMode: 'salon' })).rejects.toThrow('Finish');
    expect(configStore.getConfig().posMode).toBe('restaurant');
  });
  it('rejects context switches and stale product lookups with a live cart', async () => {
    const { api } = setup();
    await api.pos.dispatch({ type: 'cart/addItem', payload: item });
    expect((await api.pos.dispatch({ type: 'table/setActive', payload: { tableId: null, orderType: 'delivery' } })).success).toBe(false);
    expect((await api.pos.dispatch({ type: 'cart/addItem', payload: { ...item, id: 'stale' }, restaurantContext: { tableId: null, orderType: 'takeout' } })).success).toBe(false);
    expect((await api.pos.getState()).cart.items).toHaveLength(1);
    expect((await api.pos.getState()).cart.total).toBe(1200);
  });
  it('clears a completed cart without closing the independent shift', async () => {
    const { api } = setup();
    await api.pos.dispatch({ type: 'session/open', payload: { shiftId: 'local-shift', staffId: 'staff', staffName: 'Staff' } });
    await api.pos.dispatch({ type: 'cart/addItem', payload: item });
    await api.pos.dispatch({ type: 'tip/set', payload: { amount: 200 } });
    await api.pos.dispatch({ type: 'cart/completeCheckout' });
    const state = await api.pos.getState();
    expect(state.cart.items).toHaveLength(0); expect(state.tip).toBe(0);
    expect(state.session.shiftId).toBe('local-shift'); expect(state.session.isOpen).toBe(true);
  });
  it('does not present unsupported tables as working table service', async () => {
    const { api } = setup();
    expect(api.pos.restaurantService).toBe('counter-only');
    await expect(api.pos.tables.getActive()).resolves.toEqual([]);
    await expect(api.pos.tables.updateStatus('desktop-table', 'occupied')).rejects.toThrow();
    expect((await api.pos.tables.setCovers('desktop-table', 2)).success).toBe(false);
    expect((await api.pos.dispatch({ type: 'table/setActive', payload: { tableId: 'desktop-table' } })).success).toBe(false);
    expect(api.pos.restaurantChecks).toBeUndefined();
  });
  it('mounts the shared dark restaurant screen and sells a takeout fixture', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const { api, posStore } = setup();
    await api.pos.dispatch({ type: 'session/open', payload: { shiftId: 'local-shift', staffId: 'staff', staffName: 'Staff' } });
    function Harness() {
      const [state, setState] = useState(posStore.getState());
      useEffect(() => posStore.onStateChanged(setState), []);
      return <RestaurantTemplate state={state as any} session={state.session} dispatch={api.pos.dispatch} t={t} />;
    }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<Harness />));
    expect(host.querySelector('.restaurant-categories')).not.toBeNull();
    expect(host.querySelector('.restaurant-order')).not.toBeNull();
    const tile = host.querySelector<HTMLElement>('.restaurant-product')!;
    expect(tile).not.toBeNull(); expect(tile.classList.contains('bg-white')).toBe(false);
    expect(tile.style.getPropertyValue('--restaurant-category-color')).not.toBe('');
    expect(host.textContent).toContain(t('pos.restaurant.counterOnlyDevice'));
    await click(t('pos.restaurant.takeout'));
    await act(async () => host!.querySelector<HTMLElement>('.restaurant-product')!.click());
    expect(posStore.getState().cart.items).toHaveLength(1);
    await act(async () => host!.querySelector<HTMLButtonElement>('.pos-pay-button')!.click());
    expect(JSON.parse(host.querySelector('[data-payment]')!.getAttribute('data-payment')!)).toMatchObject({ mode: 'restaurant', order_type: 'takeout', table_id: null });
    await click('Complete fixture payment');
    expect(posStore.getState().cart.items).toHaveLength(0);
  });
  it('shows real Android checks and saves/recalls through the shared screen', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const db = await initAndroidDb({ locateFile: null, persistence: new MemoryAndroidPersistence() });
    const { transport, configStore } = setup();
    configStore.setConfig({ salonId: 'a', authUser: { id: 'staff', salonId: 'a', role: 'STAFF' } as any });
    const { api, posStore } = installShim({ reinstall: true, configStore, transport: { ...transport, getRestaurantDatabase: async () => db } });
    function Harness() {
      const [state, setState] = useState(posStore.getState());
      useEffect(() => posStore.onStateChanged(setState), []);
      return <RestaurantTemplate state={state as any} session={state.session} dispatch={api.pos.dispatch} t={t} />;
    }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<Harness />));
    expect(host.textContent).not.toContain(t('pos.restaurant.counterOnlyDevice'));
    expect(host.textContent).toContain('Checks');
    await act(async () => host!.querySelector<HTMLElement>('.restaurant-product')!.click());
    expect(posStore.getState().cart.items).toHaveLength(1);
    await click('Save check');
    expect(posStore.getState().cart.items).toHaveLength(0);
    const checks = await api.pos.restaurantChecks.list(); expect(checks.checks).toHaveLength(1);
    await act(async () => host!.querySelector<HTMLButtonElement>('.restaurant-check-card')!.click());
    expect(posStore.getState().cart.items[0].name).toBe('Coffee fixture');
    expect(host.querySelector('.restaurant-categories')).not.toBeNull();
    await db.flush();
  });
  it('shows cached layout status and clears it after a successful retry', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const { api, posStore } = setup();
    api.pos.tables.getSyncStatus = vi.fn().mockResolvedValue({ source: 'cache', syncedAt: '2026-09-08T00:00:00Z' });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    const state = posStore.getState();
    await act(async () => root!.render(<RestaurantTemplate state={state as any} session={state.session} dispatch={api.pos.dispatch} t={t} />));
    expect(host.textContent).toContain(t('pos.restaurant.cachedLayout'));
    api.pos.tables.getSyncStatus.mockResolvedValue({ source: 'server', syncedAt: '2026-09-08T00:01:00Z' });
    await click(t('common.retry'));
    expect(host.textContent).not.toContain(t('pos.restaurant.cachedLayout'));
  });
  it('shows a table fetch error instead of enabling counter sales on an unknown layout', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const { api, posStore } = setup();
    api.pos.tables.getActive = vi.fn().mockRejectedValue(new Error('Table layout unavailable'));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    const state = posStore.getState();
    await act(async () => root!.render(<RestaurantTemplate state={state as any} session={state.session} dispatch={api.pos.dispatch} t={t} />));
    expect(host.textContent).toContain('Table layout unavailable');
    const product = host.querySelector<HTMLElement>('.restaurant-product');
    if (product) await act(async () => product.click());
    expect(posStore.getState().cart.items).toEqual([]);
    expect(host.textContent).toContain(t('common.retry'));
  });
});
