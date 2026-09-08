// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PricePopup, DiscountPopup } from '../src/renderer/components/pos/Cart';
import Modal from '../src/renderer/components/shared/Modal';

describe('cart price and discount dialog interaction', () => {
  let host: HTMLDivElement; let root: Root;
  let close: ReturnType<typeof vi.fn>; let apply: ReturnType<typeof vi.fn>; let update: ReturnType<typeof vi.fn>;
  const tOr = (_key: string, fallback: string) => fallback;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    close = vi.fn(); apply = vi.fn(); update = vi.fn(async () => {});
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const price = () => <PricePopup item={{ id: 'line', price: 700, name: 'Tea' } as any} currency="PLN" onApply={apply} onUpdateBackendPrice={update} onClose={close} tOr={tOr} />;
  const discount = () => <DiscountPopup subtotal={5000} currentDiscount={0} currency="PLN" onApplyFixed={apply} onApplyPercent={apply} onClear={() => {}} onClose={close} tOr={tOr} />;
  const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!;
  const key = async (value: string, target: Element = document.activeElement!) => {
    await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));
  };

  it('does not apply a price merely because Enter was pressed on another control', async () => {
    await act(async () => root.render(price()));
    button('Cancel').focus(); await key('Enter');
    expect(apply).not.toHaveBeenCalled();
    await act(async () => button('Cancel').click()); expect(close).toHaveBeenCalledOnce();
  });
  it('locks cancellation, edits and duplicate backend updates until saving completes', async () => {
    let finish!: () => void;
    update.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => root.render(price()));
    const save = button('Update backend price');
    await act(async () => { save.click(); save.click(); });
    expect(update).toHaveBeenCalledOnce();
    expect(host.querySelector('fieldset')?.disabled).toBe(true);
    await key('Escape');
    await act(async () => host.querySelector<HTMLElement>('[aria-hidden="true"]')!.click());
    await act(async () => button('Apply price').click());
    expect(close).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    await act(async () => finish()); expect(close).toHaveBeenCalledOnce();
  });
  it('shows a failed update and permits retry with the same price', async () => {
    update.mockRejectedValueOnce(new Error('Network unavailable'));
    await act(async () => root.render(price()));
    await act(async () => button('Update backend price').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Network unavailable');
    expect(host.querySelector('fieldset')?.disabled).toBe(false); expect(close).not.toHaveBeenCalled();
    await act(async () => button('Update backend price').click());
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'line' }), 700);
    expect(close).toHaveBeenCalledOnce();
  });
  it.each(['price', 'discount'])('lets only the top dialog consume Escape above %s', async kind => {
    const childClose = vi.fn();
    await act(async () => root.render(<>{kind === 'price' ? price() : discount()}<Modal title="Child" zLayer="nested" onClose={childClose}>Child</Modal></>));
    await key('Escape');
    expect(childClose).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  });
  it('applies custom discount Enter only from its own input', async () => {
    await act(async () => root.render(discount()));
    const input = host.querySelector('input')!;
    await act(async () => Simulate.change(input, { target: { value: '12' } } as any));
    const external = document.createElement('input'); document.body.append(external);
    try {
      external.focus(); await key('Enter'); expect(apply).not.toHaveBeenCalled();
      await act(async () => input.focus()); await key('Enter'); expect(apply).toHaveBeenCalledExactlyOnceWith(1200);
    } finally { external.remove(); }
  });
});
