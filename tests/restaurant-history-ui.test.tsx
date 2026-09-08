// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrderHistoryModal from '../src/renderer/components/pos/OrderHistoryModal';
import { RestaurantHistoryHeader, RestaurantHistoryLine } from '../src/renderer/components/pos/RestaurantHistoryMetadata';
import { translations } from '../src/renderer/i18n/translations';

vi.mock('../src/renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: { showNonFiscalOrders: true } }) }));
let host: HTMLDivElement;
let root: Root;
let api: any;
const t = (key: string) => translations.en[key] || key;
const order = (id = 'local-a') => ({ id, backend_id: `server-${id}`, order_number: id, status: 'COMPLETED', mode: 'restaurant', table_id: 'T-1', covers: 0, order_type: 'dine_in', subtotal: 2000, total: 2000, tax: 0, discount: 0, payment_amount: 2000, change_amount: 0, payment_method: 'CASH', staff_name: 'Cashier', created_at: '2026-09-08T09:00:00Z', synced: 1 });
const item = (id: string, notes: string) => ({ id, order_id: 'local-a', name: 'Tea', variant_id: 'tea', sku: 'TEA', price: 1000, quantity: 1, total: 1000, vat_rate: 0, notes, course: 2 });
const render = async (element: React.ReactElement) => { await act(async () => root.render(element)); };
const clickOrder = async (id: string) => {
  const button = [...host.querySelectorAll('button')].find(button => button.textContent?.includes(id));
  expect(button).toBeTruthy();
  await act(async () => button!.click());
};

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api = { pos: {
    orders: {
      getHistory: vi.fn().mockResolvedValue({ orders: [order()], total: 1 }),
      getServerList: vi.fn().mockResolvedValue({ source: 'unconfigured', orders: [], items: {}, total: 0 }),
      getDetail: vi.fn().mockResolvedValue({ order: order(), items: [item('line-a', 'No sugar'), item('line-b', 'Extra ice')] }),
    },
    sync: {},
    payment: { getReconcilableFiscalAttempt: vi.fn().mockResolvedValue({ attempt: null }), getPrintAttempts: vi.fn().mockResolvedValue({ attempts: [] }), getLatestFiscalAttempt: vi.fn().mockResolvedValue({ attempt: null }) },
  } };
  (window as any).electronAPI = api;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe('restaurant history metadata', () => {
  it('shows zero covers, explicit table ID and service type, without inventing a table name', async () => {
    await render(<RestaurantHistoryHeader order={order()} t={t} />);
    expect(host.textContent).toContain('Covers: 0');
    expect(host.textContent).toContain('Tables · ID: T-1');
    expect(host.textContent).toContain('Dine In');
  });
  it('does not present missing or invalid metadata as defaults', async () => {
    await render(<><RestaurantHistoryHeader order={{ mode: 'restaurant', covers: -1, order_type: 'bad' }} t={t} /><RestaurantHistoryLine mode="restaurant" item={{ course: NaN, notes: ' ' }} t={t} /></>);
    expect(host.textContent).toBe('');
  });
  it.each(['__proto__', 'constructor', 'toString'])('does not treat inherited key %s as a service type', async (order_type) => {
    await render(<RestaurantHistoryHeader order={{ mode: 'restaurant', order_type }} t={t} />);
    expect(host.textContent).toBe('');
  });
  it('hides restaurant-only fields for other POS modes and stale takeaway table IDs', async () => {
    await render(<><RestaurantHistoryHeader order={{ ...order(), mode: 'retail' }} t={t} /><RestaurantHistoryLine mode="billiard" item={{ course: 2, notes: 'Hidden' }} t={t} /></>);
    expect(host.textContent).toBe('');
    await render(<RestaurantHistoryHeader order={{ ...order(), order_type: 'takeout' }} t={t} />);
    expect(host.textContent).toContain('Takeout');
    expect(host.textContent).not.toContain('T-1');
  });
  it('escapes notes, keeps line breaks and displays an unlabelled valid course by number', async () => {
    const notes = '<img src=x onerror=alert(1)>\nNo sugar';
    await render(<RestaurantHistoryLine mode="restaurant" item={{ notes, course: 9 }} t={t} />);
    expect(host.textContent).toContain(notes);
    expect(host.textContent).toContain('Course: 9');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.whitespace-pre-wrap')).not.toBeNull();
  });
  it.each(Object.keys(translations))('has translated labels in %s', async (locale) => {
    const dict = translations[locale as keyof typeof translations];
    for (const key of ['pos.restaurant.tables', 'pos.restaurant.covers', 'pos.restaurant.course', 'pos.restaurant.main', 'pos.restaurant.dineIn', 'pos.restaurant.takeout', 'pos.restaurant.delivery']) {
      expect(dict[key]).toBeTruthy();
    }
  });
});

describe('actual shared history screen', () => {
  it('saves the selected method from the compact header without printing, then reflects inbound sync', async () => {
    vi.useFakeTimers();
    try {
      let current = order();
      api.pos.orders.getDetail.mockImplementation(async () => ({ order: current, items: [item('line-a', '')] }));
      api.pos.orders.mutate = vi.fn(async (_id: string, request: any) => {
        if (request.type === 'payment-preview') return { success: true, preview: { allowed: true, version: 'snapshot', paymentMethod: current.payment_method } };
        current = { ...current, payment_method: request.paymentMethod };
        return { success: true };
      });
      api.pos.payment.reprintReceipt = vi.fn();
      await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen={false} />);
      await clickOrder('local-a');
      const panel = host.querySelector('section[aria-label="Change payment method"]')!;
      expect(panel).toBeTruthy();
      expect(panel.closest('div.flex.shrink-0.items-center')?.parentElement?.textContent).toContain('local-a');
      await act(async () => Simulate.change(panel.querySelector('select')!, { target: { value: 'CARD' } } as any));
      const save = [...panel.querySelectorAll('button')].find(b => b.textContent === 'Save')!;
      await act(async () => save.click());
      expect(api.pos.orders.mutate.mock.calls[1][1].paymentMethod).toBe('CARD');
      expect(panel.querySelector('select')!.value).toBe('CARD');
      expect(api.pos.payment.reprintReceipt).not.toHaveBeenCalled();
      current = { ...current, payment_method: 'BLIK' };
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(panel.querySelector('select')!.value).toBe('BLIK');
    } finally { vi.useRealTimers(); }
  });
  it('reports unavailable local history instead of presenting a failure as an empty result', async () => {
    api.pos.orders.getHistory.mockRejectedValue(new Error('Fiscal-only history is not supported on this Android device.'));
    await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen={false} />);
    expect(host.textContent).toContain('Fiscal-only history is not supported on this Android device.');
    expect(host.textContent).not.toContain(t('pos.history.noOrders'));
  });
  it('keeps local duplicate-product IDs and notes when the server lists the same order', async () => {
    const local = order();
    api.pos.orders.getServerList.mockResolvedValue({ source: 'server', total: 1, orders: [{ ...local, id: local.backend_id, _origin: 'server' }], items: { [local.backend_id]: [item('server-item-a', 'WRONG SERVER NOTE')] } });
    await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen={false} />);
    await clickOrder('local-a');
    expect(api.pos.orders.getDetail).toHaveBeenCalledWith('local-a');
    const rows = [...host.querySelectorAll('[data-testid="restaurant-history-line"]')];
    expect(rows.map(row => row.textContent)).toEqual(['Course: MainNo sugar', 'Course: MainExtra ice']);
    expect(host.textContent).not.toContain('WRONG SERVER NOTE');
    expect(host.textContent).toContain('Covers: 0');
  });
  it('shows server-only detail without requesting unrelated local detail', async () => {
    api.pos.orders.getHistory.mockResolvedValue({ orders: [], total: 0 });
    api.pos.orders.getServerList.mockResolvedValue({ source: 'server', total: 1, orders: [{ ...order('server-only'), _origin: 'server' }], items: { 'server-only': [item('server-item', '')] } });
    await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen={false} />);
    await clickOrder('server-only');
    expect(api.pos.orders.getDetail).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Tea');
  });
  it('does not label an old server mirror default course as proven historical metadata', async () => {
    api.pos.orders.getDetail.mockResolvedValue({ order: { ...order(), source: 'SERVER' }, items: [item('unlinked', 'Unproven note')] });
    await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen={false} />);
    await clickOrder('local-a');
    expect(host.textContent).toContain('Tea');
    expect(host.querySelector('[data-testid="restaurant-history-line"]')).toBeNull();
    expect(host.textContent).not.toContain('Unproven note');
  });
  it('shows proven server-mirror notes on the exact linked duplicate-product row', async () => {
    api.pos.orders.getDetail.mockResolvedValue({ order: { ...order(), source: 'SERVER' }, items: [
      { ...item('server-b', 'Extra ice'), restaurant_line_id: 'local-b', course: 4 },
      { ...item('server-a', 'No sugar'), restaurant_line_id: 'local-a' },
    ] });
    await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen={false} />);
    await clickOrder('local-a');
    expect([...host.querySelectorAll('[data-testid="restaurant-history-line"]')].map(row => row.textContent))
      .toEqual(['Course: DrinksExtra ice', 'Course: MainNo sugar']);
  });
  it('requires verified line provenance for server-list rows too', async () => {
    api.pos.orders.getHistory.mockResolvedValue({ orders: [], total: 0 });
    api.pos.orders.getServerList.mockResolvedValue({ source: 'server', total: 1, orders: [{ ...order('server-only'), _origin: 'server' }], items: { 'server-only': [
      item('old', 'Unproven note'),
      { ...item('linked', 'No sugar'), restaurant_line_id: 'local-a' },
    ] } });
    await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen={false} />);
    await clickOrder('server-only');
    expect([...host.querySelectorAll('[data-testid="restaurant-history-line"]')].map(row => row.textContent))
      .toEqual(['Course: MainNo sugar']);
    expect(host.textContent).not.toContain('Unproven note');
  });
  it('does not let an older detail request replace the newly selected order', async () => {
    let resolveA!: (value: any) => void;
    api.pos.orders.getHistory.mockResolvedValue({ orders: [order('A'), order('B')], total: 2 });
    api.pos.orders.getDetail.mockImplementation((id: string) => id === 'A' ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve({ order: order('B'), items: [item('b', 'Newest selection')] }));
    await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen={false} />);
    await clickOrder('A'); await clickOrder('B');
    await act(async () => resolveA({ order: order('A'), items: [item('a', 'Stale selection')] }));
    expect(host.textContent).toContain('Newest selection');
    expect(host.textContent).not.toContain('Stale selection');
  });
  it('shows the same preparation notes in the refund selection without merging duplicate products', async () => {
    const detail = { order: order(), items: [item('line-a', 'No sugar'), item('line-b', 'Extra ice')] };
    api.pos.orders.getRefundDetail = vi.fn().mockResolvedValue({ success: true, detail });
    await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen />);
    await clickOrder('local-a');
    await clickOrder('Refund Order');
    const modal = host.querySelector('[role="dialog"][aria-labelledby]');
    expect(modal).not.toBeNull();
    expect([...modal!.querySelectorAll('[data-testid="restaurant-history-line"]')].map(row => row.textContent))
      .toEqual(['Course: MainNo sugar', 'Course: MainExtra ice']);
  });
  it.each(['success', 'failure'])('ignores a stale refund-detail %s after selecting another order', async outcome => {
    let finish!: (value: any) => void;
    api.pos.orders.getHistory.mockResolvedValue({ orders: [order('A'), order('B')], total: 2 });
    api.pos.orders.getDetail.mockImplementation(async (id: string) => ({ order: order(id), items: [item(id, `Note ${id}`)] }));
    api.pos.orders.getRefundDetail = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen />);
    await clickOrder('A'); await clickOrder('Refund Order'); await clickOrder(t('pos.history.title')); await clickOrder('B');
    await act(async () => finish(outcome === 'success'
      ? { success: true, detail: { order: order('A'), items: [item('a', 'Stale refund detail')] } }
      : { success: false, error: 'Stale refund error' }));
    expect(host.textContent).toContain('Note B');
    expect(host.textContent).not.toContain('Stale refund');
    expect(host.querySelector('[role="dialog"][aria-labelledby]')).toBeNull();
  });
  it('does not continue refund loading after a server mirror finishes for an old selection', async () => {
    let finish!: (value: any) => void;
    api.pos.orders.getHistory.mockResolvedValue({ orders: [order('B')], total: 1 });
    api.pos.orders.getServerList.mockResolvedValue({ source: 'server', total: 1,
      orders: [{ ...order('server-A'), _origin: 'server' }], items: { 'server-A': [item('a', '')] } });
    api.pos.orders.getDetail.mockImplementation(async (id: string) => ({ order: order(id), items: [item(id, `Note ${id}`)] }));
    api.pos.orders.mirrorFromServer = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    api.pos.orders.getRefundDetail = vi.fn().mockResolvedValue({ success: true,
      detail: { order: order('server-A'), items: [item('a', 'Stale refund detail')] } });
    await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen />);
    await clickOrder('server-A'); await clickOrder('Refund Order'); await clickOrder(t('pos.history.title')); await clickOrder('B');
    await act(async () => finish({ success: true, localOrderId: 'server-A' }));
    expect(api.pos.orders.getRefundDetail).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Note B');
    expect(host.querySelector('[role="dialog"][aria-labelledby]')).toBeNull();
  });
  it.each(['local-original', 'server-A'])('shows preserved local sale %s before continuing an old server action', async localId => {
    api.pos.orders.getHistory.mockResolvedValue({ orders: [], total: 0 });
    api.pos.orders.getServerList.mockResolvedValue({ source: 'server', total: 1,
      orders: [{ ...order('server-A'), _origin: 'server' }], items: { 'server-A': [item('a', '')] } });
    api.pos.orders.mirrorFromServer = vi.fn().mockResolvedValue({ success: true, localOrderId: localId });
    api.pos.orders.getDetail.mockImplementation(async (id: string) => id === localId
      ? { order: { ...order(localId), source: 'POS', status: 'PARTIAL_REFUND' }, items: [item('local-line', 'Preserved local note')] } : null);
    api.pos.payment.reprintReceipt = vi.fn();
    await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen />);
    await clickOrder('server-A'); await clickOrder('Print order');
    expect(api.pos.orders.getDetail).toHaveBeenCalledWith(localId);
    expect(host.textContent).toContain('Preserved local note');
    expect(api.pos.payment.reprintReceipt).not.toHaveBeenCalled();
  });
  it('surfaces unsupported Android refund printing without invoking sale printing', async () => {
    const refunded = { ...order(), status: 'REFUNDED', refund_amount: 2000 };
    const error = 'Refund receipt printing is not available on Android yet. No receipt was printed.';
    api.pos.orders.getDetail.mockResolvedValue({ order: refunded, items: [item('line-a', 'No sugar')] });
    api.pos.payment.printRefundReceipt = vi.fn().mockResolvedValue({ success: false, receiptPrinted: false, error });
    api.pos.payment.reprintReceipt = vi.fn();
    await render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen={false} />);
    await clickOrder('local-a'); await clickOrder('Print order');
    expect(api.pos.payment.printRefundReceipt).toHaveBeenCalledWith('local-a');
    expect(api.pos.payment.reprintReceipt).not.toHaveBeenCalled();
    expect(host.textContent).toContain(error);
  });
});
