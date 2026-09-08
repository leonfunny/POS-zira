// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: { fiscalOnCashSale: 'ask' } }) }));
import PaymentModal from '../src/renderer/components/pos/PaymentModal';
import { getTranslation } from '../src/renderer/i18n/translations';

describe('payment close guard', () => {
  let host: HTMLDivElement;
  let root: Root;
  let close: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  let print: ReturnType<typeof vi.fn>;
  const t = getTranslation('en');
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    close = vi.fn();
    create = vi.fn(async () => ({ success: true, id: 'order' }));
    print = vi.fn(async () => ({ success: true, receiptPrinted: true }));
    (window as any).electronAPI = {
      onBarcodeScanned: () => () => {},
      pos: { payment: { hasFiscalPrinter: async () => ({ configured: true }), printReceiptAndOpenDrawer: print }, orders: { create }, sync: { orders: async () => {} }, ksef: { getConfig: async () => ({ success: true, config: { enabled: false } }) } },
    };
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const mount = async (onBeforeTender?: (orderId: string, token: string) => Promise<void>) => {
    const cart: any = { items: [{ id: 'item', variantId: 'item', name: 'Item', price: 1000, quantity: 1, lineTotal: 1000, vatRate: 23 }], subtotal: 1000, total: 1000, discount: 0, tax: 0 };
    await act(async () => root.render(<PaymentModal cart={cart} dispatch={() => {}} onClose={close} t={t} shiftId="shift" staffId="staff" staffName="Cashier" initialCashAmountGrosze={1000} initialPaymentPreflightToken="preflight" onBeforeTender={onBeforeTender} />));
  };
  const escape = async () => { await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); };
  const pay = async () => {
    const button = [...host.querySelectorAll('button')].find(node => node.textContent?.startsWith(t('pos.payment.complete')))!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
  };
  it('allows Escape before submitting a payment', async () => {
    await mount(); await escape();
    expect(close).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
  });
  it('waits for the durable restaurant boundary before creating an order and ignores duplicate clicks', async () => {
    let release!: () => void;
    const boundary = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    await mount(boundary);
    await pay();
    expect(boundary).toHaveBeenCalledOnce();
    expect(boundary.mock.calls[0]).toEqual([expect.any(String), 'preflight']);
    expect(create).not.toHaveBeenCalled();
    await escape();
    expect(close).not.toHaveBeenCalled();
    const button = [...host.querySelectorAll('button')].find(node => node.textContent?.startsWith(t('pos.payment.complete')));
    if (button) await act(async () => button.click());
    expect(boundary).toHaveBeenCalledOnce();
    await act(async () => release());
    expect(create).toHaveBeenCalledOnce();
  });
  it('does not retry or create an order after an uncertain restaurant boundary reply', async () => {
    const boundary = vi.fn(async () => { throw new Error('IPC reply lost'); });
    await mount(boundary); await pay();
    expect(create).not.toHaveBeenCalled();
    expect(host.textContent).toContain(t('pos.restaurant.paymentReconciliation'));
    const button = [...host.querySelectorAll('button')].find(node => node.textContent?.startsWith(t('pos.payment.complete')));
    if (button) await act(async () => button.click());
    expect(boundary).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });
  it('blocks Escape while the fiscal decision is pending', async () => {
    await mount(); await pay();
    expect(host.querySelector('#fiscal-prompt-title')).not.toBeNull();
    await escape(); await escape();
    expect(close).not.toHaveBeenCalled(); expect(create).toHaveBeenCalledOnce();
  });
  it('blocks Escape during receipt recovery', async () => {
    print.mockResolvedValue({ success: false, receiptPrinted: false, error: 'Printer offline' });
    await mount(); await pay(); await escape();
    expect(create).toHaveBeenCalledOnce(); expect(print).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
  it('owns focus and Tab navigation while the fiscal choice is open', async () => {
    await mount(); await pay();
    const fiscal = host.querySelector<HTMLElement>('[aria-labelledby="fiscal-prompt-title"]')!;
    const payment = host.querySelector('[aria-labelledby="payment-modal-title"]')!;
    expect(fiscal.contains(document.activeElement)).toBe(true);
    expect(payment.hasAttribute('inert')).toBe(true);
    expect(payment.getAttribute('aria-hidden')).toBe('true');
    const buttons = [...fiscal.querySelectorAll('button')];
    // happy-dom has no layout; supply visibility rectangles for the real focus handler.
    buttons.forEach(button => { vi.spyOn(button, 'getClientRects').mockReturnValue([{}] as any); });
    const tab = async (shiftKey = false) => {
      await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })); });
    };
    await tab(); expect(document.activeElement).toBe(buttons[0]);
    await tab(true); expect(document.activeElement).toBe(buttons[1]);
    await tab(); expect(document.activeElement).toBe(buttons[0]);
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(close).not.toHaveBeenCalled();
    await act(async () => buttons[0].click());
    expect(close).toHaveBeenCalledOnce();
  });

});
