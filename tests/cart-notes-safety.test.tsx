// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Cart from '../src/renderer/components/pos/Cart';
import type { CartState } from '../src/renderer/hooks/usePosStore';

vi.mock('../src/renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: {} }) }));
let host: HTMLDivElement; let root: Root;
const pay = vi.fn(); const dispatch = vi.fn(); const draft = vi.fn();
let cart: CartState;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  cart = { items: [{ id: 'tea', variantId: 'tea', sku: '', name: 'Tea', price: 1000, quantity: 1, total: 1000 }], total: 1000, subtotal: 1000, discount: 0, tax: 0 };
  pay.mockReset(); dispatch.mockReset(); draft.mockReset();
  dispatch.mockResolvedValue({ success: true });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async () => { await act(async () => root.render(<Cart cart={cart} dispatch={dispatch} onPay={pay} t={key => key} onNotesDraftStateChange={draft} />)); };
const button = (text: string) => [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
const edit = async () => {
  await click('Notes');
  await act(async () => Simulate.change(host.querySelector('textarea')!, { target: { value: 'No sugar' } } as any));
};
const clickPay = async () => { await act(async () => host.querySelector<HTMLButtonElement>('.pos-pay-button')!.click()); };

describe('real Cart note editor', () => {
  it('blocks payment with an unsaved note, and cancel unblocks it', async () => {
    await render(); await edit(); await clickPay();
    expect(pay).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Save or cancel the edited notes');
    expect(draft).toHaveBeenLastCalledWith(true);
    await click('Cancel'); await clickPay();
    expect(pay).toHaveBeenCalledOnce();
  });
  it('keeps failed notes editable and blocks payment until retry succeeds', async () => {
    dispatch.mockResolvedValueOnce({ success: false, error: 'Disk unavailable' });
    await render(); await edit(); await click('OK');
    expect(host.querySelector('textarea')?.value).toBe('No sugar');
    expect(host.textContent).toContain('Disk unavailable');
    await clickPay(); expect(pay).not.toHaveBeenCalled();
    await click('OK');
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'cart/setItemNotes', payload: { id: 'tea', notes: 'No sugar' } });
    expect(host.querySelector('textarea')).toBeNull();
  });
  it('blocks payment and duplicate saves while the write is pending', async () => {
    let finish!: (value: { success: boolean }) => void;
    dispatch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await edit();
    const save = button('OK');
    await act(async () => { save.click(); save.click(); });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(host.querySelector('textarea')?.disabled).toBe(true);
    await clickPay(); expect(pay).not.toHaveBeenCalled();
    await act(async () => finish({ success: true }));
  });
  it('does not scroll to the bottom when an existing quantity is edited', async () => {
    await render();
    const scroller = host.querySelector<HTMLElement>('.pos-cart-scroll')!;
    const scroll = vi.spyOn(scroller, 'scrollTo');
    cart = { ...cart, items: [{ ...cart.items[0], quantity: 2, total: 2000 }] };
    await render();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(scroll).not.toHaveBeenCalled();
  });
});
