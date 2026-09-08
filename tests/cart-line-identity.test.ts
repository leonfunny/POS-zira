import { afterEach, describe, expect, it, vi } from 'vitest';
import { PosStore, type CartItem } from '../src/main/pos/pos-store';
import { createInitialState, posReducer } from '../src/renderer/android-pos/shim/pos-store';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../src/main/logger', () => ({ default: { info() {}, warn() {}, debug() {} } }));
vi.mock('../src/main/pos/promo-loader', () => ({ PromoLoader: class { async getImages() { return []; } } }));
vi.mock('../src/main/config/store', () => ({ getConfigValue: () => undefined }));
vi.mock('../src/main/database/repos/product-repo', () => ({ productRepo: { getById: () => null } }));

const stores: PosStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.destroy()); });
const line = (overrides: Partial<CartItem> = {}): CartItem => ({
  id: 'one', variantId: 'coffee', name: 'Coffee', sku: 'coffee',
  quantity: 1, price: 1000, total: 1000, vatRate: 23, course: 1, ...overrides,
});

describe.each(['Windows', 'Android'])('%s cart line identity', (platform) => {
  function add(first: CartItem, second: CartItem) {
    if (platform === 'Windows') {
      const store = new PosStore();
      stores.push(store);
      store.dispatch({ type: 'cart/addItem', payload: first });
      store.dispatch({ type: 'cart/addItem', payload: second });
      return store.getState().cart;
    }
    let state = createInitialState();
    state = posReducer(state, { type: 'cart/addItem', payload: first });
    return posReducer(state, { type: 'cart/addItem', payload: second }).cart;
  }

  it.each([true, false])('keeps a regular drink separate from a noted drink (noted first: %s)', (notedFirst) => {
    const noted = line({ notes: 'No sugar' });
    const plain = line({ id: 'two' });
    const cart = notedFirst ? add(noted, plain) : add(plain, noted);
    expect(cart.items).toHaveLength(2);
    expect(cart.items.map(item => item.quantity)).toEqual([1, 1]);
    expect(cart.total).toBe(2000);
  });

  it.each([
    { price: 1200 }, { vatRate: 8 }, { course: 2 }, { staffId: 'other' },
    { sellBy: 'WEIGHT', saleUnit: 'kg' },
    { lineDiscountType: 'percentage', lineDiscountValue: 10 },
    { lineDiscountType: 'fixed', lineDiscountValue: 100 },
  ] as Partial<CartItem>[])('does not merge different sale terms %j', (changes) => {
    expect(add(line(changes), line({ id: 'two' })).items).toHaveLength(2);
  });

  it.each([[undefined, '  '], ['No sugar', ' No sugar ']])('merges equivalent notes %j / %j', (first, second) => {
    const cart = add(line({ notes: first }), line({ id: 'two', notes: second }));
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(2);
  });

  it('does not collapse two fixed per-line discounts into one', () => {
    const discount = { lineDiscountType: 'fixed' as const, lineDiscountValue: 100 };
    const cart = add(line(discount), line({ id: 'two', ...discount }));
    expect(cart.items).toHaveLength(2);
    expect(cart.total).toBe(1800);
  });
});
