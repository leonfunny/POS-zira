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
    await act(async () => {
      Simulate.change(host.querySelector('select')!, { target: { value: 'CARD' } } as any);
    });
  };
  beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    mutate.mockReset(); updated.mockReset();
    mutate.mockResolvedValue({success:true,preview:{allowed:true,version:'server-snapshot',paymentMethod:'CASH'}});
    (window as any).electronAPI = {pos:{orders:{mutate}}};
    await act(async () => root.render(<PaymentMethodCorrectionPanel orderId="order-1" currentMethod="CASH" t={k => translations.en[k] || k} ensureMirrored={async()=>true} onUpdated={updated} />));
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it('saves immediately without reason input or confirmation, using a fresh server version', async () => {
    expect(host.querySelector('input')).toBeNull();
    expect(host.querySelector('button')).toBeNull();
    await edit();
    expect(mutate.mock.calls[1]).toEqual(['order-1', {
      type: 'payment', mutationId: expect.any(String), expectedVersion: 'server-snapshot',
      paymentMethod: 'CARD', reason: 'Quick payment method correction (POS)',
    }]);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(host.querySelector('select')!.value).toBe('CARD');
  });
  it('retries the identical request after an uncertain response', async () => {
    mutate.mockResolvedValueOnce({success:true,preview:{allowed:true,version:'v',paymentMethod:'CASH'}})
      .mockRejectedValueOnce(new Error('network'));
    await edit();
    const original = mutate.mock.calls[1][1];
    expect(host.querySelector('select')!.disabled).toBe(true);
    mutate.mockResolvedValueOnce({success:true}); await click('Retry same change');
    expect(mutate.mock.calls[2][1]).toEqual(original);
  });
  it('blocks protected payments without issuing a write', async () => {
    mutate.mockResolvedValueOnce({success:true,preview:{version:'v',paymentMethod:'CASH',allowed:false,blockedCode:'TERMINAL_PAYMENT'}});
    await edit();
    expect(host.textContent).toContain('terminal or gateway');
    expect(mutate).toHaveBeenCalledTimes(1); expect(updated).not.toHaveBeenCalled();
  });
  it('does not overwrite a method already changed on the web', async () => {
    mutate.mockResolvedValueOnce({success:true,preview:{version:'v',paymentMethod:'BLIK',allowed:true}});
    await edit();
    expect(host.textContent).toContain('another device');
    expect(mutate).toHaveBeenCalledTimes(1); expect(host.querySelector('select')!.value).toBe('BLIK');
  });
  it('retains the old method if the server rejects a concurrent update', async () => {
    mutate.mockResolvedValueOnce({success:true,preview:{version:'v',paymentMethod:'CASH',allowed:true}})
      .mockResolvedValueOnce({success:false,code:'STALE_PAYMENT'});
    await edit();
    expect(host.textContent).toContain('another device'); expect(updated).not.toHaveBeenCalled();
    expect(host.querySelector('select')!.value).toBe('CASH');
  });
  it('has translated correction messages in every supported POS locale',()=>{
    const keys=Object.keys(translations.en).filter(k=>k.startsWith('pos.paymentCorrection.'));
    for(const values of Object.values(translations)) for(const key of keys) expect(values[key]).toBeTruthy();
  });
});
