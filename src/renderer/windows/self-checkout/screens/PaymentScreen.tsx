// Payment screen. Demo mode may auto-approve; production mode is fail-closed
// until a real payment terminal SDK owns the payment state transition.
import React, { useEffect, useState } from 'react';
import { ScLanguage, getScStrings } from '../i18n';
import type { SelfCheckoutMode } from '../self-checkout-model';
import { formatPLN } from '../useScCart';
import { ManualNumpad } from './ScanScreen';

export type PaymentMethod = 'BLIK' | 'CARD';

interface PaymentScreenProps {
  lang: ScLanguage;
  mode: SelfCheckoutMode;
  totalGrosze: number;
  onSuccess: (method: PaymentMethod) => void;
  onCancel: () => void;
}

export default function PaymentScreen({
  lang,
  mode,
  totalGrosze,
  onSuccess,
  onCancel,
}: PaymentScreenProps) {
  const t = getScStrings(lang);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [blikCode, setBlikCode] = useState('');
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    if (mode !== 'demo' || method !== 'CARD' || !processing) return;
    const id = window.setTimeout(() => {
      onSuccess('CARD');
    }, 1500);
    return () => window.clearTimeout(id);
  }, [method, mode, processing, onSuccess]);

  const submitBlik = () => {
    if (blikCode.length !== 6) return;
    setProcessing(true);
    if (mode === 'demo') {
      window.setTimeout(() => onSuccess('BLIK'), 1200);
    }
  };

  if (mode === 'production') {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-50 px-8 text-center select-none">
        <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-10 shadow-sm">
          <div className="text-sm font-semibold uppercase tracking-wider text-slate-500">
            {t.productionMode}
          </div>
          <h2 className="mt-4 text-4xl font-black text-slate-900">
            {t.closedTitle}
          </h2>
          <p className="mt-5 text-xl text-slate-600">
            {t.receiptProductionBlocked}
          </p>
          <button
            type="button"
            onClick={onCancel}
            className="mt-8 rounded-xl border-2 border-slate-300 bg-white px-6 py-3 text-base font-semibold text-slate-700 hover:bg-slate-50"
          >
            ← {t.back}
          </button>
        </div>
      </div>
    );
  }

  if (!method) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-50 px-8 select-none">
        <h2 className="mb-3 text-3xl font-bold text-slate-600">
          {t.paymentTitle}
        </h2>
        <div className="mb-4 rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold uppercase tracking-wider text-amber-800">
          {t.demoMode}
        </div>
        <p className="mb-12 text-6xl font-black tabular-nums">
          {formatPLN(totalGrosze)}
        </p>
        <div className="grid w-full max-w-3xl grid-cols-2 gap-6">
          <button
            type="button"
            onClick={() => setMethod('BLIK')}
            className="rounded-3xl bg-violet-600 px-6 py-12 text-4xl font-extrabold text-white shadow-xl shadow-violet-600/30 hover:bg-violet-700"
          >
            <div className="mb-2 text-6xl">BLIK</div>
            {t.blik}
          </button>
          <button
            type="button"
            onClick={() => {
              setMethod('CARD');
              setProcessing(true);
            }}
            className="rounded-3xl bg-blue-600 px-6 py-12 text-4xl font-extrabold text-white shadow-xl shadow-blue-600/30 hover:bg-blue-700"
          >
            <div className="mb-2 text-6xl">CARD</div>
            {t.card}
          </button>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="mt-10 rounded-xl border-2 border-slate-300 bg-white px-6 py-3 text-base font-semibold text-slate-700 hover:bg-slate-50"
        >
          ← {t.back}
        </button>
      </div>
    );
  }

  if (method === 'CARD') {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-blue-50 px-8 select-none">
        <div className="mb-6 text-7xl font-black animate-pulse">CARD</div>
        <p className="mb-2 text-3xl font-bold">
          {processing ? '...' : t.card}
        </p>
        <p className="mb-8 text-xl text-slate-500">
          {t.demoMode} - auto-success in 1.5s
        </p>
        <p className="text-5xl font-black tabular-nums">{formatPLN(totalGrosze)}</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-violet-50 px-8 select-none">
      <h2 className="mb-2 text-3xl font-bold">{t.blik}</h2>
      <p className="mb-6 text-xl text-slate-600">{formatPLN(totalGrosze)}</p>
      <div className="mb-4 h-20 w-80 rounded-2xl border-2 border-violet-200 bg-white text-center text-5xl font-mono tabular-nums leading-[80px] tracking-[0.5em]">
        {blikCode || <span className="text-slate-300">______</span>}
      </div>
      <ManualNumpad
        title=""
        value={blikCode}
        onChange={setBlikCode}
        onCancel={() => setMethod(null)}
        onSubmit={submitBlik}
        okLabel={processing ? '...' : t.pay}
        cancelLabel={t.back}
        maxLength={6}
      />
      {processing && (
        <p className="mt-4 text-lg text-violet-600">{t.paymentSuccess}...</p>
      )}
    </div>
  );
}
