/**
 * Per-line (per-product) manual discounts in the POS cart.
 *
 * Line discounts live on the cart item (`lineDiscountType`/`lineDiscountValue`
 * entered by the cashier, `lineDiscount` = effective grosze), keep `item.total`
 * gross, and aggregate into `cart.lineDiscountTotal`. The whole-receipt
 * discount then applies on top of the line-discounted base.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Electron ──
vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

// ── Mock main-process dependencies ──
vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/main/pos/promo-loader', () => ({
  PromoLoader: class {
    async getImages() { return []; }
  },
}));

vi.mock('../src/main/config/store', () => ({
  getConfigValue: vi.fn((key: string) => {
    if (key === 'customerDisplayIdleTimeout') return 120000;
    if (key === 'customerDisplayPromoInterval') return 5000;
    return undefined;
  }),
}));

import type { CartItem } from '../src/main/pos/pos-store';

let PosStore: typeof import('../src/main/pos/pos-store').PosStore;
beforeEach(async () => {
  vi.useFakeTimers();
  const mod = await import('../src/main/pos/pos-store');
  PosStore = mod.PosStore;
});

function sampleItem(overrides?: Partial<CartItem>): CartItem {
  return {
    id: 'item-1',
    variantId: 'var-1',
    name: 'Test Product',
    sku: 'TP-001',
    price: 1000, // 10.00 PLN
    quantity: 1,
    total: 1000,
    vatRate: 23,
    ...overrides,
  };
}

describe('cart/applyItemDiscount', () => {
  it('applies a percentage discount to one line only', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem({ quantity: 2, total: 2000 }) });
    store.dispatch({ type: 'cart/addItem', payload: sampleItem({ id: 'item-2', variantId: 'var-2', sku: 'TP-002' }) });
    store.dispatch({ type: 'cart/applyItemDiscount', payload: { id: 'item-1', amount: 10, discountType: 'percentage' } });

    const cart = store.getState().cart;
    const line = cart.items.find((i) => i.id === 'item-1')!;
    expect(line.lineDiscount).toBe(200);
    expect(line.lineDiscountType).toBe('percentage');
    expect(line.lineDiscountValue).toBe(10);
    expect(line.total).toBe(2000); // gross stays
    expect(cart.items.find((i) => i.id === 'item-2')!.lineDiscount ?? 0).toBe(0);
    expect(cart.subtotal).toBe(3000);
    expect(cart.lineDiscountTotal).toBe(200);
    expect(cart.total).toBe(2800);
    store.destroy();
  });

  it('clamps a fixed discount to the line total', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem({ quantity: 2, total: 2000 }) });
    store.dispatch({ type: 'cart/applyItemDiscount', payload: { id: 'item-1', amount: 2500, discountType: 'fixed' } });

    const cart = store.getState().cart;
    expect(cart.items[0].lineDiscount).toBe(2000);
    expect(cart.total).toBe(0);
    store.destroy();
  });

  it('rescales a percentage discount when quantity changes', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({ type: 'cart/applyItemDiscount', payload: { id: 'item-1', amount: 10, discountType: 'percentage' } });
    store.dispatch({ type: 'cart/updateQuantity', payload: { id: 'item-1', quantity: 3 } });

    const cart = store.getState().cart;
    expect(cart.items[0].total).toBe(3000);
    expect(cart.items[0].lineDiscount).toBe(300);
    expect(cart.total).toBe(2700);
    store.destroy();
  });

  it('keeps a fixed discount on quantity change but clamps to the smaller line', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem({ quantity: 2, total: 2000 }) });
    store.dispatch({ type: 'cart/applyItemDiscount', payload: { id: 'item-1', amount: 1500, discountType: 'fixed' } });
    store.dispatch({ type: 'cart/updateQuantity', payload: { id: 'item-1', quantity: 1 } });

    const cart = store.getState().cart;
    expect(cart.items[0].total).toBe(1000);
    expect(cart.items[0].lineDiscount).toBe(1000); // clamped from 1500
    expect(cart.total).toBe(0);
    store.destroy();
  });

  it('applies the whole-receipt percentage discount after line discounts', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem({ quantity: 2, total: 2000 }) });
    store.dispatch({ type: 'cart/applyItemDiscount', payload: { id: 'item-1', amount: 10, discountType: 'percentage' } });
    store.dispatch({ type: 'cart/applyDiscount', payload: { amount: 10, discountType: 'percentage' } });

    const cart = store.getState().cart;
    expect(cart.lineDiscountTotal).toBe(200);
    expect(cart.discount).toBe(180); // 10% of (2000 - 200)
    expect(cart.total).toBe(1620);
    store.destroy();
  });

  it('computes VAT per line on the discounted payable amount', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem({ price: 1230, total: 1230 }) });
    store.dispatch({ type: 'cart/applyItemDiscount', payload: { id: 'item-1', amount: 230, discountType: 'fixed' } });

    const cart = store.getState().cart;
    // payable 1000 gross at 23% → VAT = 1000 - 1000*100/123 ≈ 187
    expect(cart.tax).toBe(187);
    store.destroy();
  });

  it('clears a line discount', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({ type: 'cart/applyItemDiscount', payload: { id: 'item-1', amount: 10, discountType: 'percentage' } });
    store.dispatch({ type: 'cart/clearItemDiscount', payload: { id: 'item-1' } });

    const cart = store.getState().cart;
    expect(cart.items[0].lineDiscount ?? 0).toBe(0);
    expect(cart.items[0].lineDiscountType).toBeUndefined();
    expect(cart.lineDiscountTotal).toBe(0);
    expect(cart.total).toBe(1000);
    store.destroy();
  });

  it('refuses to discount a locked line', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem({ locked: true }) });
    store.dispatch({ type: 'cart/applyItemDiscount', payload: { id: 'item-1', amount: 10, discountType: 'percentage' } });
    expect(store.getState().cart.items[0].lineDiscount ?? 0).toBe(0);
    store.destroy();
  });

  it('refuses while a frozen billiard checkout is active', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({
      type: 'checkoutDraft/update',
      payload: { billiard: { origin: {}, clientAttemptId: 'a1' } as any },
    });
    store.dispatch({ type: 'cart/applyItemDiscount', payload: { id: 'item-1', amount: 10, discountType: 'percentage' } });
    expect(store.getState().cart.items[0].lineDiscount ?? 0).toBe(0);
    store.destroy();
  });

  it('drops the line contribution when the item is removed', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({ type: 'cart/addItem', payload: sampleItem({ id: 'item-2', variantId: 'var-2', sku: 'TP-002', price: 500, total: 500 }) });
    store.dispatch({ type: 'cart/applyItemDiscount', payload: { id: 'item-1', amount: 10, discountType: 'percentage' } });
    store.dispatch({ type: 'cart/removeItem', payload: { id: 'item-1' } });

    const cart = store.getState().cart;
    expect(cart.lineDiscountTotal).toBe(0);
    expect(cart.total).toBe(500);
    store.destroy();
  });
});
