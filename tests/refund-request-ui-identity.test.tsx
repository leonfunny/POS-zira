// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrderHistoryModal from '../src/renderer/components/pos/OrderHistoryModal';
import { translations } from '../src/renderer/i18n/translations';
import { toRefundBackendPayload } from '../src/shared/refund-backend-payload';
vi.mock('../src/renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: { showNonFiscalOrders: true } }) }));
let host: HTMLDivElement; let root: Root; let api: any;
const t = (key: string) => translations.en[key] || key;
const order = { id: 'local-order', backend_id: 'server-order', order_number: 'ORDER-EXACT', status: 'COMPLETED', mode: 'restaurant',
  subtotal: 2000, total: 2000, tax: 0, discount: 0, payment_amount: 2000, change_amount: 0, payment_method: 'CASH',
  staff_name: 'Cashier', created_at: '2026-09-08T09:00:00Z', synced: 1, source: 'POS' };
const item = (id: string) => ({ id, order_id: 'local-order', name: 'Same tea', variant_id: 'same-product', price: 1000,
  quantity: 1, total: 1000, vat_rate: 0, restaurant_line_id: 'not-the-server-id' });
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim().startsWith(text));
  expect(button, `button ${text}`).toBeTruthy(); await act(async () => button!.click());
};
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api = { pos: { orders: {
    getHistory: vi.fn().mockResolvedValue({ orders: [order], total: 1 }),
    getServerList: vi.fn().mockResolvedValue({ source: 'unconfigured', orders: [], items: {}, total: 0 }),
    getDetail: vi.fn().mockResolvedValue({ order, items: [item('local-a'), item('local-b')] }),
    getRefundDetail: vi.fn().mockResolvedValue({ success: true, detail: { order, items: [item('server-b'), item('server-a')] } }),
    refund: vi.fn().mockResolvedValue({ success: false, error: 'test boundary only' }),
  }, sync: { onOrderSynced: vi.fn(() => vi.fn()), onOrderSyncFailed: vi.fn(() => vi.fn()) }, payment: { getReconcilableFiscalAttempt: vi.fn().mockResolvedValue({ attempt: null }),
    getPrintAttempts: vi.fn().mockResolvedValue({ attempts: [] }), getLatestFiscalAttempt: vi.fn().mockResolvedValue({ attempt: null }) } } };
  (window as any).electronAPI = api;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe('actual refund panel exact identity selection', () => {
  it.each(['FULL', 'PARTIAL'])('retains fresh reversed server IDs in %s selection', async type => {
    await act(async () => root.render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen={true} />));
    await click('ORDER-EXACT'); await click('Refund Order');
    expect(api.pos.orders.getRefundDetail).toHaveBeenCalledWith('local-order');
    if (type === 'PARTIAL') {
      await click('Partial Refund');
      const plus = [...host.querySelectorAll('button')].filter(b => b.textContent?.trim() === '+');
      expect(plus).toHaveLength(2);
      await act(async () => plus[1].click());
    }
    await click('Review refund'); await click('Confirm Refund');
    expect(api.pos.orders.refund).toHaveBeenCalledTimes(1);
    const [id, request] = api.pos.orders.refund.mock.calls[0];
    expect(id).toBe('local-order');
    expect(request.lines.map((l: any) => l.orderItemId)).toEqual(type === 'FULL' ? ['server-b', 'server-a'] : ['server-a']);
    expect(request.type).toBe(type);
    const backend = toRefundBackendPayload(request);
    expect(backend.items.map((l: any) => l.orderItemId)).toEqual(request.lines.map((l: any) => l.orderItemId));
    expect(backend).not.toHaveProperty('lines');
    expect(backend.amount).toBe(type === 'FULL' ? 20 : 10);
  });
  it.each(['onOrderSynced', 'onOrderSyncFailed'])('does not replace authoritative refund IDs on %s history refresh', async event => {
    await act(async () => root.render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen={true} />));
    await click('ORDER-EXACT'); await click('Refund Order');
    const listener = api.pos.sync[event].mock.calls.at(-1)[0];
    await act(async () => listener({ orderId: 'local-order' }));
    expect(api.pos.orders.getDetail.mock.calls.length).toBeGreaterThan(1);
    await click('Review refund'); await click('Confirm Refund');
    expect(api.pos.orders.refund.mock.calls[0][1].lines.map((l: any) => l.orderItemId)).toEqual(['server-b', 'server-a']);
  });
  it('reloads authoritative server detail for Refund Next instead of reopening local IDs', async () => {
    api.pos.orders.refund.mockResolvedValueOnce({ success: true, refundAmount: 10, totalRefundedAmount: 10, status: 'PARTIAL_REFUND' });
    await act(async () => root.render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen={true} />));
    await click('ORDER-EXACT'); await click('Refund Order'); await click('Partial Refund');
    const plus = [...host.querySelectorAll('button')].filter(b => b.textContent?.trim() === '+');
    await act(async () => plus[1].click()); await click('Review refund'); await click('Confirm Refund');
    const refundedLine = { orderItemId: 'server-a', variantId: 'same-product', name: 'Same tea', quantity: 1, unitPrice: 1000, refundAmount: 1000 };
    api.pos.orders.getRefundDetail.mockResolvedValueOnce({ success: true, detail: {
      order: { ...order, status: 'PARTIAL_REFUND', refund_amount: 1000, refund_lines: JSON.stringify([refundedLine]) },
      items: [item('server-a'), item('server-b')],
    } });
    await click(t('pos.refund.refundNext'));
    expect(api.pos.orders.getRefundDetail).toHaveBeenCalledTimes(2);
    await click('Review refund'); await click('Confirm Refund');
    expect(api.pos.orders.refund.mock.calls[1][1].lines.map((l: any) => l.orderItemId)).toEqual(['server-b']);
  });
});
