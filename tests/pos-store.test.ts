/**
 * Unit tests for POS store state transitions and reducer logic.
 *
 * We mock Electron + main-process dependencies so we can import the
 * PosStore class in a plain Node/Vitest environment.
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

// ── Import after mocks ──
import type { PosAction, CartItem, PosState } from '../src/main/pos/pos-store';

// Use dynamic import to ensure mocks are applied
let PosStore: typeof import('../src/main/pos/pos-store').PosStore;
beforeEach(async () => {
  vi.useFakeTimers();
  const mod = await import('../src/main/pos/pos-store');
  PosStore = mod.PosStore;
});

// Helper: create a sample cart item
function sampleItem(overrides?: Partial<CartItem>): CartItem {
  return {
    id: 'item-1',
    variantId: 'var-1',
    name: 'Test Product',
    sku: 'TP-001',
    price: 1000,   // 10.00 PLN
    quantity: 1,
    total: 1000,
    vatRate: 23,
    ...overrides,
  };
}

describe('PosStore initial state', () => {
  it('starts in idle display mode with empty cart', () => {
    const store = new PosStore();
    const state = store.getState();
    expect(state.display.mode).toBe('idle');
    expect(state.cart.items).toEqual([]);
    expect(state.cart.total).toBe(0);
    expect(state.session.isOpen).toBe(false);
    store.destroy();
  });
});

describe('Cart operations', () => {
  it('adds an item and switches display to cart mode', () => {
    const store = new PosStore();
    const item = sampleItem();
    store.dispatch({ type: 'cart/addItem', payload: item });
    const state = store.getState();
    expect(state.cart.items).toHaveLength(1);
    expect(state.cart.total).toBe(1000);
    expect(state.display.mode).toBe('cart');
    store.destroy();
  });

  it('merges same variant into existing line item', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({ type: 'cart/addItem', payload: sampleItem({ id: 'item-2' }) });
    const state = store.getState();
    expect(state.cart.items).toHaveLength(1);
    expect(state.cart.items[0].quantity).toBe(2);
    expect(state.cart.items[0].total).toBe(2000);
    store.destroy();
  });

  it('does NOT merge items with different staff (salon mode)', () => {
    const store = new PosStore();
    store.dispatch({
      type: 'cart/addItem',
      payload: sampleItem({ staffId: 'staff-A', staffName: 'Alice' }),
    });
    store.dispatch({
      type: 'cart/addItem',
      payload: sampleItem({ id: 'item-2', staffId: 'staff-B', staffName: 'Bob' }),
    });
    const state = store.getState();
    expect(state.cart.items).toHaveLength(2);
    store.destroy();
  });

  it('does NOT merge items with different course (restaurant mode)', () => {
    const store = new PosStore();
    store.dispatch({
      type: 'cart/addItem',
      payload: sampleItem({ course: 1 }),
    });
    store.dispatch({
      type: 'cart/addItem',
      payload: sampleItem({ id: 'item-2', course: 2 }),
    });
    const state = store.getState();
    expect(state.cart.items).toHaveLength(2);
    store.destroy();
  });

  it('removes an item and goes back to idle when cart is empty', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({ type: 'cart/removeItem', payload: { id: 'item-1' } });
    const state = store.getState();
    expect(state.cart.items).toHaveLength(0);
    expect(state.display.mode).toBe('idle');
    store.destroy();
  });

  it('updates quantity and recalculates total', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({ type: 'cart/updateQuantity', payload: { id: 'item-1', quantity: 3 } });
    const state = store.getState();
    expect(state.cart.items[0].quantity).toBe(3);
    expect(state.cart.items[0].total).toBe(3000);
    expect(state.cart.total).toBe(3000);
    store.destroy();
  });

  it('setting quantity to 0 removes the item', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({ type: 'cart/updateQuantity', payload: { id: 'item-1', quantity: 0 } });
    const state = store.getState();
    expect(state.cart.items).toHaveLength(0);
    store.destroy();
  });

  it('clears the entire cart', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({ type: 'cart/addItem', payload: sampleItem({ id: 'item-2', variantId: 'var-2' }) });
    store.dispatch({ type: 'cart/clear' });
    const state = store.getState();
    expect(state.cart.items).toHaveLength(0);
    expect(state.cart.total).toBe(0);
    store.destroy();
  });

  it('applies discount without exceeding subtotal', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({ type: 'cart/applyDiscount', payload: { amount: 500 } });
    expect(store.getState().cart.total).toBe(500);
    // Discount larger than subtotal gets clamped
    store.dispatch({ type: 'cart/applyDiscount', payload: { amount: 9999 } });
    expect(store.getState().cart.total).toBe(0);
    store.destroy();
  });

  it('sets item notes', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({ type: 'cart/setItemNotes', payload: { id: 'item-1', notes: 'Extra hot' } });
    expect(store.getState().cart.items[0].notes).toBe('Extra hot');
    store.destroy();
  });

  it('sets custom item price', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({ type: 'cart/setItemPrice', payload: { id: 'item-1', price: 500 } });
    const item = store.getState().cart.items[0];
    expect(item.price).toBe(500);
    expect(item.total).toBe(500);
    store.destroy();
  });

  it('calculates VAT correctly for 23% rate', () => {
    const store = new PosStore();
    // 1230 grosze gross at 23% VAT
    store.dispatch({
      type: 'cart/addItem',
      payload: sampleItem({ price: 1230, total: 1230, vatRate: 23 }),
    });
    const state = store.getState();
    // VAT = 1230 - round(1230 * 100 / 123) = 1230 - 1000 = 230
    expect(state.cart.tax).toBe(230);
    store.destroy();
  });
});

describe('Session management', () => {
  it('opens a shift', () => {
    const store = new PosStore();
    store.dispatch({
      type: 'session/open',
      payload: { shiftId: 'shift-1', staffId: 'staff-1', staffName: 'Alice' },
    });
    const session = store.getState().session;
    expect(session.isOpen).toBe(true);
    expect(session.shiftId).toBe('shift-1');
    expect(session.staffName).toBe('Alice');
    store.destroy();
  });

  it('closing shift resets cart and display', () => {
    const store = new PosStore();
    store.dispatch({
      type: 'session/open',
      payload: { shiftId: 'shift-1', staffId: 'staff-1', staffName: 'Alice' },
    });
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    store.dispatch({ type: 'session/close' });
    const state = store.getState();
    expect(state.session.isOpen).toBe(false);
    expect(state.cart.items).toHaveLength(0);
    expect(state.display.mode).toBe('idle');
    expect(state.activeTable).toBeNull();
    expect(state.activeCustomer).toBeNull();
    store.destroy();
  });
});

describe('Display state transitions', () => {
  it('explicit display/setMode changes mode', () => {
    const store = new PosStore();
    store.dispatch({
      type: 'display/setMode',
      payload: { mode: 'thankyou', lastOrderTotal: 5000 },
    });
    expect(store.getState().display.mode).toBe('thankyou');
    expect(store.getState().display.lastOrderTotal).toBe(5000);
    store.destroy();
  });

  it('handleTouch transitions from idle to interactive', () => {
    const store = new PosStore();
    expect(store.getState().display.mode).toBe('idle');
    store.handleTouch();
    expect(store.getState().display.mode).toBe('interactive');
    store.destroy();
  });

  it('handleTouch does nothing when in cart mode', () => {
    const store = new PosStore();
    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });
    expect(store.getState().display.mode).toBe('cart');
    store.handleTouch();
    expect(store.getState().display.mode).toBe('cart');
    store.destroy();
  });
});

describe('Table and customer selection', () => {
  it('sets active table', () => {
    const store = new PosStore();
    store.dispatch({ type: 'table/setActive', payload: { tableId: 'table-5' } });
    expect(store.getState().activeTable).toBe('table-5');
    store.destroy();
  });

  it('selects and clears customer', () => {
    const store = new PosStore();
    store.dispatch({
      type: 'customer/select',
      payload: { id: 'cust-1', name: 'ACME Corp', nip: '1234567890' },
    });
    expect(store.getState().activeCustomer?.name).toBe('ACME Corp');
    store.dispatch({ type: 'customer/clear' });
    expect(store.getState().activeCustomer).toBeNull();
    store.destroy();
  });
});

describe('Tip management', () => {
  it('sets and clears tip', () => {
    const store = new PosStore();
    store.dispatch({ type: 'tip/set', payload: { amount: 500 } });
    expect(store.getState().tip).toBe(500);
    store.dispatch({ type: 'tip/clear' });
    expect(store.getState().tip).toBe(0);
    store.destroy();
  });
});
