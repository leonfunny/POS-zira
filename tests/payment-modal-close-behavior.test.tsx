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
  const mount = async () => {
    const cart: any = { items: [{ id: 'item', variantId: 'item', name: 'Item', price: 1000, quantity: 1, lineTotal: 1000, vatRate: 23 }], subtotal: 1000, total: 1000, discount: 0, tax: 0 };
    await act(async () => root.render(<PaymentModal cart={cart} dispatch={() => {}} onClose={close} t={t} shiftId="shift" staffId="staff" staffName="Cashier" initialCashAmountGrosze={1000} initialPaymentPreflightToken="preflight" />));
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
});
