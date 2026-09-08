// @vitest-environment happy-dom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Simulate } from 'react-dom/test-utils';
import RestaurantTemplate from '../src/renderer/components/pos/templates/restaurant/RestaurantTemplate';
import { PosStore, type PosAction, type PosState } from '../src/main/pos/pos-store';
import { canChangeRestaurantContext } from '../src/shared/pos-mode';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../src/main/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../src/main/pos/promo-loader', () => ({ PromoLoader: class { async getImages() { return []; } } }));
vi.mock('../src/main/config/store', () => ({ getConfigValue: vi.fn() }));
vi.mock('../src/renderer/components/pos/CategoryTabs', () => ({ default: () => <div>Categories</div> }));
vi.mock('../src/renderer/components/pos/SearchBar', () => ({ default: () => <div>Search</div> }));
vi.mock('../src/renderer/components/pos/templates/restaurant/RestaurantMenu', () => ({
  RestaurantCategoryRail: () => <div>Categories</div>,
  default: ({ products, onAddProduct }: any) => (
    <button onClick={() => onAddProduct(products[0])}>Add product</button>
  ),
}));
vi.mock('../src/renderer/components/pos/Cart', () => ({ default: ({ onPay }: any) => <button onClick={() => onPay()}>Pay</button> }));
vi.mock('../src/renderer/components/pos/PaymentModal', () => ({ default: ({ extraOrderFields }: any) => (
  <div data-payment>{JSON.stringify(extraOrderFields)}</div>
) }));
vi.mock('../src/renderer/components/pos/templates/restaurant/TableMap', () => ({ default: ({ tables, onSelectTable }: any) => (
  <div data-tables>{tables.map((table: any) => <button key={table.id} onClick={() => onSelectTable(table.id)}>{table.name}</button>)}</div>
) }));

let root: Root;
let host: HTMLDivElement;
let store: PosStore;
let barcodeHandlerRef: { current: ((barcode: string) => Promise<void>) | null };
const dispatch = vi.fn();
const tableRows = [
  { id: 't1', name: 'Table 1', status: 'free' },
  { id: 't2', name: 'Table 2', status: 'free' },
];
async function mount(tables: Promise<unknown[]>, isOpen = true, initial: Partial<PosState> = {}, scaleConfig?: any, restaurantChecks?: any) {
  barcodeHandlerRef = { current: null };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  store = new PosStore();
  (store as any).state = { ...store.getState(), ...initial, session: { isOpen, shiftId: 'shift', staffId: 'staff' } };
  (window as any).electronAPI = { pos: {
    restaurantChecks,
    dispatch: vi.fn(),
    tables: { getActive: vi.fn(() => tables), updateStatus: vi.fn(async () => {}), clearTable: vi.fn(async () => {}), setCovers: vi.fn(async () => ({ success: true })) },
    categories: { getAll: vi.fn(async () => []) },
    products: { getAll: vi.fn(async () => [{ id: 'coffee', name: 'Coffee', retail_price: 1000, track_stock: false }]), getByBarcode: vi.fn(async () => ({ id: 'coffee', name: 'Coffee', retail_price: 1000, track_stock: false })) },
    scale: { readWeight: vi.fn(async () => ({ success: true, stable: true, weightKg: 0.35 })) },
    sync: { onProductsSynced: vi.fn(() => () => {}) },
  } };
  function Harness() {
    const [state, setState] = useState(store.getState());
    dispatch.mockImplementation((action: PosAction) => {
      store.dispatch(action);
      setState(store.getState());
    });
    vi.mocked(window.electronAPI.pos.dispatch).mockImplementation(async (action: any) => {
      if (action.type === 'table/setActive' && !canChangeRestaurantContext(store.getState(), action.payload.tableId, action.payload.orderType)) {
        return { success: false, error: 'Context rejected' };
      }
      dispatch(action);
      return { success: true };
    });
    return <RestaurantTemplate state={state} dispatch={dispatch} t={(key) => key} session={state.session} barcodeHandlerRef={barcodeHandlerRef} scaleConfig={scaleConfig} />;
  }
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
const payment = () => JSON.parse(host.querySelector('[data-payment]')!.textContent!);
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  store?.destroy();
  host?.remove();
  dispatch.mockClear();
});

describe('Restaurant counter and table sales', () => {
  it('does not mark a table occupied merely by selecting it when local checks are available', async () => {
    const api = { list: vi.fn(async () => ({ success: true, checks: [], activeId: null })) };
    await mount(Promise.resolve(tableRows), true, {}, undefined, api);
    await click('Table 1');
    expect(store.getState().activeTable).toBe('t1');
    expect(window.electronAPI.pos.tables.updateStatus).not.toHaveBeenCalled();
  });
  it('keeps the cart after a failed save and allows a subsequent successful save', async () => {
    const api = {
      list: vi.fn(async () => ({ success: true, checks: [], activeId: null })),
      saveCurrent: vi.fn(async () => ({ success: false, error: 'Disk unavailable' })),
    };
    await mount(Promise.resolve([]), true, {}, undefined, api);
    await click('Add product'); await click('Save check');
    expect(store.getState().cart.items).toHaveLength(1);
    expect(host.textContent).toContain('Disk unavailable');
    api.saveCurrent.mockImplementationOnce(async () => {
      dispatch({ type: 'cart/clear' });
      return { success: true, error: '' };
    });
    await click('Save check');
    expect(store.getState().cart.items).toHaveLength(0);
    expect(host.textContent).toContain('No saved checks');
  });
  it('blocks payment and repeated saves while the save acknowledgment is pending', async () => {
    let finish!: (value: any) => void;
    const api = {
      list: vi.fn(async () => ({ success: true, checks: [], activeId: null })),
      saveCurrent: vi.fn(() => new Promise(resolve => { finish = resolve; })),
    };
    await mount(Promise.resolve([]), true, {}, undefined, api);
    await click('Add product');
    const save = [...host.querySelectorAll('button')].find(node => node.textContent === 'Save check')!;
    await act(async () => save.click());
    await act(async () => save.click());
    await click('Pay');
    expect(api.saveCurrent).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-payment]')).toBeNull();
    expect(store.getState().cart.items).toHaveLength(1);
    await act(async () => finish({ success: false, error: 'Disk unavailable' }));
  });
  it('does not treat a failed checks listing as an empty restaurant', async () => {
    const api = { list: vi.fn(async () => ({ success: false, error: 'Cannot read checks' })) };
    await mount(Promise.resolve([]), true, {}, undefined, api);
    expect(host.textContent).not.toContain('Add product');
    expect(store.getState().cart.items).toHaveLength(0);
    expect(host.textContent).toContain('Cannot read checks');
    api.list.mockResolvedValueOnce({ success: true, checks: [], activeId: null } as any);
    await click('Retry'); await click('Add product');
    expect(store.getState().cart.items).toHaveLength(1);
  });
  const weightedProduct = { id: 'food', name: 'Food', retail_price: 1000, sell_by: 'WEIGHT', sale_unit: 'kg', track_stock: false } as any;
  const enterWeight = async (value: string) => {
    const input = document.querySelector<HTMLInputElement>('[role=dialog] input')!;
    expect(input).not.toBeNull();
    await act(async () => Simulate.change(input, { target: { value } } as any));
    await act(async () => Simulate.submit(document.querySelector('[role=dialog] form')!));
  };
  it('accepts manual comma-decimal weight and retains course when the scale is disabled', async () => {
    await mount(Promise.resolve(tableRows)); await click('Table 1'); await click('pos.restaurant.main');
    vi.mocked(window.electronAPI.pos.products.getByBarcode).mockResolvedValueOnce(weightedProduct);
    await act(async () => barcodeHandlerRef.current!('1234'));
    await enterWeight('0,350');
    expect(store.getState().cart.items[0]).toMatchObject({ quantity: 0.35, total: 350, course: 2 });
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });
  it('keeps invalid manual weight and dispatch errors editable without adding an item', async () => {
    await mount(Promise.resolve([]));
    vi.mocked(window.electronAPI.pos.products.getByBarcode).mockResolvedValueOnce(weightedProduct);
    await act(async () => barcodeHandlerRef.current!('1234'));
    for (const value of ['0', '-1', '1.0001', '1000', '0.35oops']) {
      await enterWeight(value);
      expect(store.getState().cart.items).toHaveLength(0);
    }
    vi.mocked(window.electronAPI.pos.dispatch).mockResolvedValueOnce({ success: false, error: 'Cannot save item' });
    await enterWeight('0.35');
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('Cannot save item');
    await enterWeight('0.35');
    expect(store.getState().cart.items).toHaveLength(1);
  });
  it('does not let scans replace a pending manual weight prompt or start payment', async () => {
    await mount(Promise.resolve([])); await click('Add product');
    vi.mocked(window.electronAPI.pos.products.getByBarcode).mockResolvedValueOnce(weightedProduct);
    await act(async () => barcodeHandlerRef.current!('1234'));
    await act(async () => barcodeHandlerRef.current!('5678'));
    await click('Pay');
    expect(host.querySelector('[data-payment]')).toBeNull();
    expect(window.electronAPI.pos.products.getByBarcode).toHaveBeenCalledTimes(1);
    await click('Cancel');
    expect(store.getState().cart.items).toHaveLength(1);
  });
  it('discards old barcode results even after switching A to B and back to A', async () => {
    await mount(Promise.resolve(tableRows)); await click('Table 1');
    let finish!: (product: any) => void;
    vi.mocked(window.electronAPI.pos.products.getByBarcode).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = barcodeHandlerRef.current!('1234'); });
    await click('Table 2'); await click('Table 1');
    await act(async () => { finish(weightedProduct); await pending; });
    expect(store.getState().cart.items).toHaveLength(0);
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(host.textContent).not.toContain('Scale is disabled');
  });
  it('discards a delayed scale reading after changing table context', async () => {
    await mount(Promise.resolve(tableRows), true, {}, { enabled: true }); await click('Table 1');
    vi.mocked(window.electronAPI.pos.products.getByBarcode).mockResolvedValueOnce(weightedProduct);
    let finish!: (result: any) => void;
    vi.mocked(window.electronAPI.pos.scale.readWeight).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = barcodeHandlerRef.current!('1234'); });
    await click('Table 2'); await click('Table 1');
    await act(async () => { finish({ success: true, stable: true, weightKg: 0.35 }); await pending; });
    expect(store.getState().cart.items).toHaveLength(0);
  });
  it('offers manual entry after a scale connection error', async () => {
    await mount(Promise.resolve([]), true, {}, { enabled: true });
    vi.mocked(window.electronAPI.pos.products.getByBarcode).mockResolvedValueOnce(weightedProduct);
    vi.mocked(window.electronAPI.pos.scale.readWeight).mockRejectedValueOnce(new Error('Cable disconnected'));
    await act(async () => barcodeHandlerRef.current!('1234'));
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('Cable disconnected');
    await enterWeight('0.350');
    expect(store.getState().cart.items[0]).toMatchObject({ quantity: 0.35, total: 350 });
  });
  it('locks a submitted manual weight until the dispatch acknowledgment arrives', async () => {
    await mount(Promise.resolve([]));
    vi.mocked(window.electronAPI.pos.products.getByBarcode).mockResolvedValueOnce(weightedProduct);
    await act(async () => barcodeHandlerRef.current!('1234'));
    let finish!: (result: any) => void;
    vi.mocked(window.electronAPI.pos.dispatch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await enterWeight('0.35');
    const calls = vi.mocked(window.electronAPI.pos.dispatch).mock.calls.length;
    await act(async () => Simulate.submit(document.querySelector('[role=dialog] form')!));
    await click('Cancel');
    expect(window.electronAPI.pos.dispatch).toHaveBeenCalledTimes(calls);
    expect(document.querySelector<HTMLInputElement>('[role=dialog] input')?.disabled).toBe(true);
    await act(async () => finish({ success: true }));
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });
  it('routes barcode through table selection and preserves the selected course', async () => {
    await mount(Promise.resolve(tableRows));
    await act(async () => barcodeHandlerRef.current!('1234'));
    expect(window.electronAPI.pos.products.getByBarcode).not.toHaveBeenCalled();
    expect(store.getState().cart.items).toHaveLength(0);
    await click('Table 1'); await click('pos.restaurant.main');
    await act(async () => barcodeHandlerRef.current!('1234'));
    expect(store.getState().cart.items[0]).toMatchObject({ variantId: 'coffee', course: 2 });
    expect(window.electronAPI.pos.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ restaurantContext: { tableId: 't1', orderType: 'dine_in' } }));
  });
  it('ignores a delayed barcode result after changing tables', async () => {
    await mount(Promise.resolve(tableRows)); await click('Table 1');
    let finish!: (product: any) => void;
    vi.mocked(window.electronAPI.pos.products.getByBarcode).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = barcodeHandlerRef.current!('1234'); });
    await click('Table 2');
    await act(async () => { finish({ id: 'coffee', retail_price: 1000, track_stock: false }); await pending; });
    expect(store.getState().cart.items).toHaveLength(0);
  });
  it('does not add products while the payment screen is open', async () => {
    await mount(Promise.resolve([])); await click('Add product'); await click('Pay');
    await act(async () => barcodeHandlerRef.current!('1234'));
    expect(store.getState().cart.items[0].quantity).toBe(1);
    expect(window.electronAPI.pos.products.getByBarcode).not.toHaveBeenCalled();
  });
  it('uses measured weight instead of one kilogram', async () => {
    await mount(Promise.resolve([]), true, {}, { enabled: true });
    vi.mocked(window.electronAPI.pos.products.getByBarcode).mockResolvedValueOnce({ id: 'food', name: 'Food', retail_price: 1000, sell_by: 'WEIGHT', sale_unit: 'kg', track_stock: false } as any);
    await act(async () => barcodeHandlerRef.current!('1234'));
    expect(store.getState().cart.items[0]).toMatchObject({ quantity: 0.35, total: 350, saleUnit: 'kg' });
  });
  it('does not silently sell one kilogram when the scale is unavailable', async () => {
    await mount(Promise.resolve([]));
    vi.mocked(window.electronAPI.pos.products.getByBarcode).mockResolvedValueOnce({ id: 'food', name: 'Food', retail_price: 1000, sell_by: 'WEIGHT', sale_unit: 'kg', track_stock: false } as any);
    await act(async () => barcodeHandlerRef.current!('1234'));
    expect(store.getState().cart.items).toHaveLength(0);
    expect(host.textContent).toContain('Scale is disabled');
  });
  it('keeps the guest draft after a failed save and blocks payment until retry', async () => {
    await mount(Promise.resolve(tableRows)); await click('Table 1'); await click('Add product');
    await act(async () => Simulate.change(host.querySelector('input[type=number]')!, { target: { value: '3' } } as any));
    await click('Pay'); expect(host.querySelector('[data-payment]')).toBeNull();
    vi.mocked(window.electronAPI.pos.tables.setCovers).mockRejectedValueOnce(new Error('Write failed'));
    await click('pos.ok'); expect(host.textContent).toContain('Write failed');
    expect(host.querySelector<HTMLInputElement>('input[type=number]')!.value).toBe('3');
    await click('Pay'); expect(host.querySelector('[data-payment]')).toBeNull();
    await click('pos.ok'); await click('Pay');
    expect(payment().covers).toBe(3);
  });
  it.each(['-1', '1.5', ''])('rejects invalid guest count %j', async value => {
    await mount(Promise.resolve(tableRows)); await click('Table 1');
    await act(async () => Simulate.change(host.querySelector('input[type=number]')!, { target: { value } } as any));
    await click('pos.ok');
    expect(window.electronAPI.pos.tables.setCovers).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Enter a whole number');
  });
  it('shows products and takes payment with no tables, keeping dining options visible', async () => {
    await mount(Promise.resolve([]));
    expect(host.querySelector('[data-tables]')).toBeNull();
    expect(host.textContent).toContain('Categories');
    await click('pos.restaurant.takeout');
    await click('Add product');
    expect(store.getState().cart.items[0]).toMatchObject({ variantId: 'coffee', course: undefined });
    await click('Pay');
    expect(payment()).toMatchObject({ table_id: null, order_type: 'takeout' });
  });
  it.each(['takeout', 'delivery'])('allows %s without selecting a table even when tables exist', async (type) => {
    await mount(Promise.resolve(tableRows));
    await click(`pos.restaurant.${type}`);
    await click('Add product');
    await click('Pay');
    expect(payment()).toMatchObject({ table_id: null, order_type: type });
    expect(window.electronAPI.pos.tables.updateStatus).not.toHaveBeenCalled();
  });
  it('still requires an open shift for payment', async () => {
    await mount(Promise.resolve([]), false);
    await click('Add product');
    await click('Pay');
    expect(host.querySelector('[data-payment]')).toBeNull();
  });
  it('requires a table only for dine-in with configured tables', async () => {
    await mount(Promise.resolve(tableRows));
    expect(host.textContent).toContain('pos.restaurant.selectTable');
    expect(host.textContent).not.toContain('Add product');
    await click('Table 1');
    await click('Add product');
    await click('Pay');
    expect(payment()).toMatchObject({ table_id: 't1', order_type: 'dine_in' });
  });
  it('never moves table A items to table B or to a takeout sale', async () => {
    await mount(Promise.resolve(tableRows));
    await click('Table 1');
    await click('Add product');
    await click('Table 2');
    await click('pos.restaurant.takeout');
    expect(store.getState().activeTable).toBe('t1');
    expect(host.querySelector('[role=alert]')?.textContent).toContain('pos.restaurant.finishCurrentSale');
    expect(window.electronAPI.pos.tables.updateStatus).toHaveBeenCalledTimes(1);
    await click('Pay');
    expect(payment()).toMatchObject({ table_id: 't1', order_type: 'dine_in' });
  });
  it('allows switching after the current cart is explicitly cleared', async () => {
    await mount(Promise.resolve(tableRows));
    await click('Table 1');
    await click('Add product');
    await act(async () => dispatch({ type: 'cart/clear' }));
    await click('Table 2');
    expect(store.getState().activeTable).toBe('t2');
  });
  it('honors a restored shared table instead of resetting to an unselected local table', async () => {
    await mount(Promise.resolve(tableRows), true, { activeTable: 't2' });
    await click('Add product');
    await click('Pay');
    expect(payment().table_id).toBe('t2');
  });
  it('does not mark a table occupied when the authoritative dispatch rejects it', async () => {
    await mount(Promise.resolve(tableRows));
    vi.mocked(window.electronAPI.pos.dispatch).mockResolvedValueOnce({ success: false, error: 'Context rejected' });
    await click('Table 1');
    expect(store.getState().activeTable).toBeNull();
    expect(window.electronAPI.pos.tables.updateStatus).not.toHaveBeenCalled();
    expect(host.querySelector('[role=alert]')?.textContent).toBe('Context rejected');
  });
  it('does not enable counter sales before table loading finishes', async () => {
    await mount(new Promise(() => {}));
    expect(host.textContent).not.toContain('Add product');
    await click('Pay');
    expect(host.querySelector('[data-payment]')).toBeNull();
  });
  it('shows retry on table lookup failure and allows sales only after a successful retry', async () => {
    await mount(Promise.reject(new Error('Table lookup failed')));
    expect(host.textContent).toContain('Table lookup failed');
    expect(host.textContent).not.toContain('Add product');
    vi.mocked(window.electronAPI.pos.tables.getActive).mockResolvedValueOnce([]);
    await click('Retry');
    expect(host.textContent).toContain('Add product');
  });
});
