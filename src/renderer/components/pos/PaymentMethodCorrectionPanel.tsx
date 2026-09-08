import React, { useEffect, useRef, useState } from 'react';

const METHODS = ['CASH', 'CARD', 'BLIK', 'BANK_TRANSFER'] as const;
type Preview = { version: string; paymentMethod: string; allowed: boolean; blockedCode?: string };

type Props = {
  orderId: string;
  t: (key: string) => string;
  ensureMirrored: () => Promise<boolean>;
  onUpdated: () => void;
};

export default function PaymentMethodCorrectionPanel({ orderId, t, ensureMirrored, onUpdated }: Props) {
  const [opened, setOpened] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [method, setMethod] = useState('CASH');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const label = (key: string) => t(`pos.paymentCorrection.${key}`);
  const errorMessage = (code?: string) => {
    const key = `pos.paymentCorrection.${code || 'FAILED'}`;
    const translated = t(key);
    return translated && translated !== key ? translated : label('FAILED');
  };
  const methodLabel = (value: string) => t(`pos.payment.${value === 'BANK_TRANSFER' || value === 'TRANSFER' ? 'transfer' : value.toLowerCase()}`);

  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOpened(true); setBusy(true); setMessage(''); setPreview(null);
    try {
      if (!(await ensureMirrored())) { setMessage(errorMessage('SYNC_REQUIRED')); return; }
      const result = await window.electronAPI.pos.orders.mutate(orderId, { type: 'payment-preview' });
      if (!result.success || !result.preview?.version) { setMessage(errorMessage(result.code)); return; }
      setPreview(result.preview);
      setMethod(result.preview.paymentMethod === 'TRANSFER' ? 'BANK_TRANSFER' : result.preview.paymentMethod);
      setPending(null);
      if (!result.preview.allowed) setMessage(errorMessage(result.preview.blockedCode));
    } catch { setMessage(errorMessage()); }
    finally { inFlight.current = false; setBusy(false); }
  };

  const save = async () => {
    if (inFlight.current || !preview?.allowed || reason.trim().length < 3 || method === (preview.paymentMethod === 'TRANSFER' ? 'BANK_TRANSFER' : preview.paymentMethod)) return;
    inFlight.current = true; setBusy(true); setMessage('');
    const request = pending || { type: 'payment', mutationId: crypto.randomUUID(), expectedVersion: preview.version, paymentMethod: method, reason: reason.trim() };
    setPending(request);
    try {
      const result = await window.electronAPI.pos.orders.mutate(orderId, request);
      if (!result.success) { setMessage(errorMessage(result.code)); return; }
      setPending(null); setPreview(null); setReason(''); setMessage(label('saved'));
      if (mounted.current) onUpdated();
    } catch { setMessage(errorMessage()); }
    finally { inFlight.current = false; setBusy(false); }
  };

  return <section className="rounded-lg border border-slate-200 bg-white p-4">
    <button type="button" onClick={load} disabled={busy} className="min-h-12 w-full rounded-lg bg-slate-900 px-4 font-bold text-white disabled:opacity-50">
      {busy ? label('working') : opened ? label('refresh') : label('title')}
    </button>
    {opened && <>
      <p className="mt-3 text-sm text-slate-600">{label('hint')}</p>
      {preview?.allowed && <>
        <p className="mt-3 text-sm">{label('current')}: <strong>{methodLabel(preview.paymentMethod)}</strong></p>
        <label className="mt-3 block text-sm font-bold">{label('method')}
          <select value={method} onChange={e => setMethod(e.target.value)} disabled={busy || !!pending} className="mt-1 min-h-12 w-full rounded-lg border px-3">
            {METHODS.map(value => <option key={value} value={value}>{methodLabel(value)}</option>)}
          </select>
        </label>
        <label className="mt-3 block text-sm font-bold">{label('reason')}
          <input value={reason} onChange={e => setReason(e.target.value)} maxLength={500} disabled={busy || !!pending} className="mt-1 min-h-12 w-full rounded-lg border px-3" />
        </label>
        <button type="button" onClick={save} disabled={busy || reason.trim().length < 3 || method === (preview.paymentMethod === 'TRANSFER' ? 'BANK_TRANSFER' : preview.paymentMethod)} className="mt-3 min-h-12 w-full rounded-lg bg-blue-700 px-4 font-bold text-white disabled:opacity-50">
          {pending ? label('retry') : label('save')}
        </button>
      </>}
      {message && <p role="status" className="mt-3 text-sm font-medium">{message}</p>}
    </>}
  </section>;
}
