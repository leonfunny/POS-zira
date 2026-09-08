// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import PaymentMethodCorrectionPanel from '../src/renderer/components/pos/PaymentMethodCorrectionPanel';
import { translations } from '../src/renderer/i18n/translations';

describe('history payment correction', () => {
  let host: HTMLDivElement; let root: Root;
  const mutate = vi.fn(); const updated = vi.fn();
  const click = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
    expect(button).toBeTruthy();
    await act(async () => { button.click(); });
  };
  const edit = async () => {
    await click('Change payment method');
    await act(async () => {
      Simulate.change(host.querySelector('select')!, { target: { value: 'CARD' } } as any);
      Simulate.change(host.querySelector('input')!, { target: { value: 'Wrong button' } } as any);
    });
  };
  beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    mutate.mockReset(); updated.mockReset();
    mutate.mockResolvedValue({success:true,preview:{allowed:true,version:'server-snapshot',paymentMethod:'CASH'}});
    (window as any).electronAPI = {pos:{orders:{mutate}}};
    await act(async () => root.render(<PaymentMethodCorrectionPanel orderId="order-1" t={k => translations.en[k] || k} ensureMirrored={async()=>true} onUpdated={updated} />));
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it('requires a reason and sends only the method and server version, never new amounts', async () => {
    await click('Change payment method');
    expect([...host.querySelectorAll('button')].find(b=>b.textContent==='Confirm change')?.disabled).toBe(true);
    await act(async () => {
      Simulate.change(host.querySelector('select')!,{target:{value:'CARD'}} as any);
      Simulate.change(host.querySelector('input')!,{target:{value:'Wrong button'}} as any);
    });
    mutate.mockResolvedValueOnce({success:true});
    await click('Confirm change');
    expect(mutate.mock.calls[1]).toEqual(['order-1',{
      type:'payment',mutationId:expect.any(String),expectedVersion:'server-snapshot',paymentMethod:'CARD',reason:'Wrong button',
    }]);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('updated and synchronized');
  });
  it('keeps the same mutation ID and freezes inputs after an uncertain response', async () => {
    await edit(); mutate.mockRejectedValueOnce(new Error('network'));
    await click('Confirm change');
    const original = mutate.mock.calls[1][1];
    expect(host.querySelector('input')!.disabled).toBe(true);
    mutate.mockResolvedValueOnce({success:true}); await click('Retry same change');
    expect(mutate.mock.calls[2][1]).toEqual(original);
  });
  it('shows a protected-payment reason and provides no save action',async()=>{
    mutate.mockResolvedValueOnce({success:true,preview:{version:'v',allowed:false,blockedCode:'TERMINAL_PAYMENT'}});
    await click('Change payment method');
    expect(host.textContent).toContain('terminal or gateway');
    expect(host.querySelector('select')).toBeNull();
  });
  it('requires refresh after a stale version without reporting success',async()=>{
    await edit();mutate.mockResolvedValueOnce({success:false,code:'STALE_PAYMENT'});await click('Confirm change');
    expect(host.textContent).toContain('another device');expect(updated).not.toHaveBeenCalled();
  });
  it('has translated correction messages in every supported POS locale',()=>{
    const keys=Object.keys(translations.en).filter(k=>k.startsWith('pos.paymentCorrection.'));
    for(const values of Object.values(translations)) for(const key of keys) expect(values[key]).toBeTruthy();
  });
});
