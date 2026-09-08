// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrderHistoryModal from '../src/renderer/components/pos/OrderHistoryModal';
import { translations } from '../src/renderer/i18n/translations';
import { buildOrdersNamespace } from '../src/renderer/android-pos/shim/stubs';

vi.mock('../src/renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: { showNonFiscalOrders: true } }) }));
let host: HTMLDivElement; let root: Root; let api: any;
const t = (key: string) => translations.en[key] || key;
const order = (id = 'order-A') => ({ id, backend_id: `server-${id}`, order_number: id, status: 'COMPLETED', mode: 'restaurant',
  subtotal: 1000, total: 1000, tax: 0, discount: 0, payment_amount: 1000, change_amount: 0, payment_method: 'CASH',
  staff_name: 'Cashier', created_at: '2026-09-08T09:00:00Z', synced: 1, source: 'POS' });
const detail = (id = 'order-A') => ({ order: order(id), items: [{ id: `line-${id}`, order_id: id,
  name: 'Tea', variant_id: 'tea', price: 1000, quantity: 1, total: 1000, vat_rate: 0 }] });
const pending = { success: false, reconciliation: { requestId: 'original-request', status: 'UNKNOWN' }, error: 'Outcome unknown' };
const render = async () => { await act(async () => root.render(<OrderHistoryModal onClose={vi.fn()} t={t} shiftOpen />)); };
const button = (text: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.trim().startsWith(text));
const click = async (text: string) => { expect(button(text), text).toBeTruthy(); await act(async () => button(text)!.click()); };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api = { pos: { orders: {
    getHistory: vi.fn().mockResolvedValue({ orders: [order()], total: 1 }),
    getServerList: vi.fn().mockResolvedValue({ source: 'unconfigured', orders: [], items: {}, total: 0 }),
    getDetail: vi.fn(async (id: string) => detail(id)),
    getRefundDetail: vi.fn().mockResolvedValue(pending),
    reconcileRefund: vi.fn().mockResolvedValue({ success: false, requiresReconciliation: true, error: 'Still pending' }),
    refund: vi.fn(),
  }, sync: {}, payment: {
    getReconcilableFiscalAttempt: vi.fn().mockResolvedValue({ attempt: null }),
    getPrintAttempts: vi.fn().mockResolvedValue({ attempts: [] }), getLatestFiscalAttempt: vi.fn().mockResolvedValue({ attempt: null }),
    printRefundReceipt: vi.fn(), reprintReceipt: vi.fn(), printFiscalReceipt: vi.fn(),
  } } };
  (window as any).electronAPI = api;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe('explicit Android refund reconciliation UI', () => {
  it('shows a pending original request from a read without auto-refund or reconcile', async () => {
    await render(); await click('order-A');
    expect(host.querySelector('[data-testid="refund-reconciliation"]')?.textContent).toContain('original-request');
    expect(host.textContent).toContain('Verify whether cash was already returned');
    expect(button('Refund Order')?.disabled).toBe(true);
    expect(api.pos.orders.reconcileRefund).not.toHaveBeenCalled(); expect(api.pos.orders.refund).not.toHaveBeenCalled();
  });

  it('explicitly retries only the original ID, retaining the warning on failure', async () => {
    await render(); await click('order-A'); await click('Check original refund'); await click('Check original refund');
    expect(api.pos.orders.reconcileRefund.mock.calls).toEqual([['order-A', 'original-request'], ['order-A', 'original-request']]);
    expect(host.textContent).toContain('Still pending');
    expect(api.pos.orders.refund).not.toHaveBeenCalled(); expect(api.pos.payment.printRefundReceipt).not.toHaveBeenCalled();
  });

  it('refreshes reconciled detail without opening payout/success/printing dialogs', async () => {
    await render(); await click('order-A');
    api.pos.orders.getRefundDetail.mockResolvedValue({ success: true, detail: detail() });
    api.pos.orders.reconcileRefund.mockResolvedValue({ success: true, reconciled: true });
    await click('Check original refund');
    expect(api.pos.orders.reconcileRefund).toHaveBeenCalledWith('order-A', 'original-request');
    expect(host.querySelector('[data-testid="refund-reconciliation"]')).toBeNull();
    expect(host.textContent).toContain('No cash was paid and no receipt was printed by this check');
    expect(host.querySelector('[role="dialog"][aria-labelledby]')).toBeNull();
    expect(api.pos.orders.getHistory.mock.calls.length).toBeGreaterThan(1);
    expect(api.pos.orders.refund).not.toHaveBeenCalled();
    for (const method of ['printRefundReceipt', 'reprintReceipt', 'printFiscalReceipt']) expect(api.pos.payment[method]).not.toHaveBeenCalled();
  });

  it('closes an uncertain refund form and loads the durable original request', async () => {
    api.pos.orders.getRefundDetail.mockResolvedValue({ success: true, detail: detail() });
    api.pos.orders.refund.mockImplementation(async () => {
      api.pos.orders.getRefundDetail.mockResolvedValue(pending);
      return { success: false, requiresReconciliation: true, refundRequestId: 'original-request', error: 'Response lost' };
    });
    await render(); await click('order-A'); await click('Refund Order');
    await click('Review refund'); await click('Confirm Refund');
    expect(host.querySelector('[role="dialog"][aria-labelledby]')).toBeNull();
    expect(host.querySelector('[data-testid="refund-reconciliation"]')?.textContent).toContain('original-request');
    expect(api.pos.orders.refund).toHaveBeenCalledTimes(1);
    expect(api.pos.orders.reconcileRefund).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'])('ignores stale reconcile %s after selection changes', async outcome => {
    api.pos.orders.getHistory.mockResolvedValue({ orders: [order('order-A'), order('order-B')], total: 2 });
    api.pos.orders.getRefundDetail.mockImplementation(async (id: string) => id === 'order-A' ? pending : { success: true, detail: detail(id) });
    let finish!: (value: any) => void;
    api.pos.orders.reconcileRefund.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await click('order-A'); await click('Check original refund');
    await click(t('pos.history.title')); await click('order-B');
    await act(async () => finish(outcome === 'success' ? { success: true, reconciled: true } : { success: false, error: 'Stale error' }));
    expect(host.querySelector('[data-testid="refund-reconciliation"]')).toBeNull();
    expect(host.textContent).not.toContain('Stale error'); expect(host.textContent).not.toContain('Original refund reconciled');
    expect(api.pos.orders.refund).not.toHaveBeenCalled();
  });

  it('does not change Windows selection behavior when the optional method is absent', async () => {
    delete api.pos.orders.reconcileRefund;
    await render(); await click('order-A');
    expect(api.pos.orders.getRefundDetail).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="refund-reconciliation"]')).toBeNull();
  });

  it('shim exposes reconciliation only when a real transport supplies it', async () => {
    expect(buildOrdersNamespace({ transport: {} } as never).reconcileRefund).toBeUndefined();
    const reconcileRefund = vi.fn().mockResolvedValue({ success: false, refundRequestId: 'original' });
    const getRefundDetail = vi.fn().mockResolvedValue(pending);
    const namespace = buildOrdersNamespace({ transport: { reconcileRefund, getRefundDetail } } as never);
    expect(await namespace.getRefundDetail('A')).toEqual(pending);
    await namespace.reconcileRefund!('A', 'original');
    expect(reconcileRefund).toHaveBeenCalledWith('A', 'original');
  });

  it('does not dispatch twice for rapid clicks before React rerenders', async () => {
    let finish!: (value: any) => void;
    api.pos.orders.reconcileRefund.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await click('order-A');
    const action = button('Check original refund')!;
    await act(async () => { action.click(); action.click(); });
    expect(api.pos.orders.reconcileRefund).toHaveBeenCalledTimes(1);
    await act(async () => finish({ success: false, error: 'Still pending' }));
  });

  it('does not invent an actionable request ID when uncertainty lacks one and detail reload fails', async () => {
    api.pos.orders.getRefundDetail.mockResolvedValue({ success: true, detail: detail() });
    api.pos.orders.refund.mockImplementation(async () => {
      api.pos.orders.getRefundDetail.mockResolvedValue({ success: false, error: 'Cannot read original request' });
      return { success: false, requiresReconciliation: true, error: 'Outcome unknown' };
    });
    await render(); await click('order-A'); await click('Refund Order');
    await click('Review refund'); await click('Confirm Refund');
    expect(host.querySelector('[data-testid="refund-reconciliation"]')).not.toBeNull();
    expect(button('Check original refund')).toBeUndefined();
    expect(button('Refund Order')?.disabled).toBe(true);
    expect(api.pos.orders.reconcileRefund).not.toHaveBeenCalled();
  });

  it.each([true, false])('shows a non-blocking stock warning only when initial confirmed refund needs refresh (%s)', async stockRefreshRequired => {
    api.pos.orders.getRefundDetail.mockResolvedValue({ success: true, detail: detail() });
    api.pos.orders.refund.mockResolvedValue({ success: true, refundAmount: 10, totalRefundedAmount: 10,
      status: 'REFUNDED', receiptPrinted: false, stockRefreshRequired });
    await render(); await click('order-A'); await click('Refund Order');
    await click('Review refund'); await click('Confirm Refund');
    const warning = host.querySelector('[data-testid="refund-stock-refresh-warning"]');
    if (stockRefreshRequired) {
      expect(warning?.textContent).toContain('Refund confirmed, but stock has not refreshed');
      expect(warning?.textContent).toContain('Sync stock before trusting the counts');
      expect(warning?.textContent).toContain('Do not retry the refund');
    } else expect(warning).toBeNull();
    expect(button(t('pos.refund.close'))?.disabled).toBe(false);
    expect(api.pos.orders.refund).toHaveBeenCalledTimes(1);
    expect(api.pos.orders.reconcileRefund).not.toHaveBeenCalled();
    expect(api.pos.payment.printRefundReceipt).not.toHaveBeenCalled();
  });

  it('warns about stale stock after reconciliation without repeating refund or printing', async () => {
    await render(); await click('order-A');
    api.pos.orders.getRefundDetail.mockResolvedValue({ success: true, detail: detail() });
    api.pos.orders.reconcileRefund.mockResolvedValue({ success: true, reconciled: true, stockRefreshRequired: true });
    await click('Check original refund');
    expect(host.querySelector('[data-testid="refund-stock-refresh-warning"]')?.textContent)
      .toContain('Do not retry the refund');
    expect(host.querySelector('[data-testid="refund-reconciliation"]')).toBeNull();
    expect(host.querySelector('[role="dialog"][aria-labelledby]')).toBeNull();
    expect(api.pos.orders.reconcileRefund).toHaveBeenCalledTimes(1);
    expect(api.pos.orders.refund).not.toHaveBeenCalled();
    expect(api.pos.payment.printRefundReceipt).not.toHaveBeenCalled();
  });
});
