import React, { useEffect, useRef, useState } from 'react';

const METHODS = ['CASH', 'CARD', 'BLIK', 'BANK_TRANSFER'];
const normalize = (value: string | null) => value === 'TRANSFER' ? 'BANK_TRANSFER' : value || '';
type Props = {
  orderId: string;
  currentMethod: string | null;
  t: (key: string) => string;
  ensureMirrored: () => Promise<boolean>;
  onUpdated: () => void;
};

export default function PaymentMethodCorrectionPanel({ orderId, currentMethod, t, ensureMirrored, onUpdated }: Props) {
  const [method, setMethod] = useState(normalize(currentMethod));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => setMethod(normalize(currentMethod)), [currentMethod]);
  const label = (key: string) => t(`pos.paymentCorrection.${key}`);
  const errorMessage = (code?: string) => {
    const key = `pos.paymentCorrection.${code || 'FAILED'}`;
    const translated = t(key);
    return translated && translated !== key ? translated : label('FAILED');
  };
  const methodLabel = (value: string) => t(`pos.payment.${value === 'BANK_TRANSFER' ? 'transfer' : value.toLowerCase()}`);
  const preview = async () => {
    if (!(await ensureMirrored())) throw new Error('SYNC_REQUIRED');
    const result = await window.electronAPI.pos.orders.mutate(orderId, { type: 'payment-preview' });
    if (!result.success || !result.preview?.version) throw new Error(result.code || 'FAILED');
    return result.preview;
  };
  const save = async (selected: string, retry?: Record<string, unknown>) => {
    if (inFlight.current || (!retry && (pending || selected === method))) return;
    inFlight.current = true; setBusy(true); setMessage('');
    try {
      let request = retry;
      if (!request) {
        const fresh = await preview();
        if (normalize(fresh.paymentMethod) !== method) {
          setMethod(normalize(fresh.paymentMethod));
          if (mounted.current) onUpdated();
          throw new Error('STALE_PAYMENT');
        }
        if (!fresh.allowed) throw new Error(fresh.blockedCode || 'FAILED');
        request = { type: 'payment', mutationId: crypto.randomUUID(), expectedVersion: fresh.version,
          paymentMethod: selected, reason: 'Quick payment method correction (POS)' };
        setPending(request);
      }
      const result = await window.electronAPI.pos.orders.mutate(orderId, request);
      if (!result.success) throw new Error(result.code || 'FAILED');
      setMethod(selected); setPending(null); setMessage(label('saved'));
      if (mounted.current) onUpdated();
    } catch (error) { setMessage(errorMessage(error instanceof Error ? error.message : undefined)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const fresh = await preview();
      setMethod(normalize(fresh.paymentMethod)); setPending(null); setMessage('');
      if (mounted.current) onUpdated();
    } catch (error) { setMessage(errorMessage(error instanceof Error ? error.message : undefined)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <section className="rounded-lg border border-slate-200 bg-white p-3">
    <label className="flex items-center justify-between gap-3 text-sm font-bold">
      {label('method')}
      <select aria-label={label('title')} aria-busy={busy} value={method}
        onChange={event => void save(event.target.value)} disabled={busy || !!pending || !METHODS.includes(method)}
        className="min-h-12 rounded-lg border border-slate-300 bg-white px-3 text-base disabled:opacity-50">
        {!METHODS.includes(method) && <option value={method}>{method || label('method')}</option>}
        {METHODS.map(value => <option key={value} value={value}>{methodLabel(value)}</option>)}
      </select>
    </label>
    {message && <p role="status" className="mt-2 text-sm font-medium">{message}</p>}
    {pending && <div className="mt-2 flex gap-3">
      <button type="button" onClick={() => void save(String(pending.paymentMethod), pending)} disabled={busy} className="min-h-12 rounded-lg bg-blue-700 px-4 font-bold text-white">{label('retry')}</button>
      <button type="button" onClick={() => void refresh()} disabled={busy} className="min-h-12 px-3 underline">{label('refresh')}</button>
    </div>}
  </section>;
}
