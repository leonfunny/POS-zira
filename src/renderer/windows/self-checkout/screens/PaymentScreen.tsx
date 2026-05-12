// Payment screen. Demo mode may auto-approve; production mode is fail-closed
// until a real payment terminal SDK owns the payment state transition.
import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, CreditCard, Loader2, Smartphone } from 'lucide-react';
import { ScLanguage, getScStrings } from '../i18n';
import type { SelfCheckoutMode } from '../self-checkout-model';
import { formatPLN } from '../useScCart';

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

  useEffect(() => {
    if (mode !== 'demo' || method !== 'BLIK' || !processing) return;
    const id = window.setTimeout(() => onSuccess('BLIK'), 1200);
    return () => window.clearTimeout(id);
  }, [method, mode, onSuccess, processing]);

  const submitBlik = () => {
    if (blikCode.length !== 6 || processing) return;
    setProcessing(true);
  };

  if (mode === 'production') {
    return (
      <div className="sc-shell flex h-screen w-screen items-center justify-center px-8 text-center select-none">
        <section className="sc-surface w-full max-w-3xl p-12">
          <div className="mx-auto flex h-28 w-28 items-center justify-center rounded-[32px] bg-red-50 text-[var(--sc-danger)]">
            <AlertTriangle size={68} />
          </div>
          <div className="mt-8 text-sm font-black uppercase tracking-[0.16em] text-[var(--sc-danger)]">
            {t.productionMode}
          </div>
          <h2 className="mt-4 text-5xl font-black text-[var(--sc-ink)]">
            {t.closedTitle}
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-2xl leading-9 text-[var(--sc-muted)]">
            {t.receiptProductionBlocked}
          </p>
          <button
            type="button"
            onClick={onCancel}
            className="sc-secondary-action sc-focusable mt-9 inline-flex items-center gap-3 px-8 text-lg"
          >
            <ArrowLeft size={22} />
            {t.back}
          </button>
        </section>
      </div>
    );
  }

  if (method === 'CARD') {
    return (
      <ProcessingPayment
        label={t.card}
        badge={t.demoMode}
        amount={formatPLN(totalGrosze)}
        icon={<CreditCard size={82} />}
      />
    );
  }

  if (method === 'BLIK') {
    return (
      <div className="sc-shell flex h-screen w-screen flex-col overflow-hidden select-none">
        <header className="flex items-center justify-between border-b border-[var(--sc-border)] bg-white/95 px-8 py-4">
          <button
            type="button"
            onClick={() => {
              if (!processing) {
                setMethod(null);
                setBlikCode('');
              }
            }}
            disabled={processing}
            className="sc-secondary-action sc-focusable flex items-center gap-3 px-5 text-lg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeft size={22} />
            {t.back}
          </button>
          <div className="rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-black uppercase tracking-[0.14em] text-amber-800">
            {t.demoMode}
          </div>
        </header>
        <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_430px] gap-6 p-8">
          <section className="sc-surface flex flex-col justify-center p-10">
            <div className="flex h-28 w-28 items-center justify-center rounded-[32px] bg-violet-50 text-violet-700">
              <Smartphone size={72} />
            </div>
            <h1 className="mt-8 text-6xl font-black text-[var(--sc-ink)]">
              {t.blik}
            </h1>
            <p className="mt-4 text-3xl font-black text-[var(--sc-muted)]">
              {formatPLN(totalGrosze)}
            </p>
            <div className="sc-tabular mt-10 h-24 max-w-md rounded-3xl border-2 border-[var(--sc-border)] bg-white px-6 text-center text-5xl font-black leading-[92px] tracking-[0.32em] text-[var(--sc-ink)]">
              {blikCode || <span className="text-[var(--sc-border)]">______</span>}
            </div>
            {processing && (
              <div className="mt-8 flex items-center gap-3 text-2xl font-black text-violet-700">
                <Loader2 size={28} className="animate-spin" />
                {t.paymentSuccess}...
              </div>
            )}
          </section>

          <BlikPad
            value={blikCode}
            disabled={processing}
            payLabel={t.pay}
            onChange={setBlikCode}
            onSubmit={submitBlik}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="sc-shell flex h-screen w-screen flex-col overflow-hidden select-none">
      <header className="flex items-center justify-between border-b border-[var(--sc-border)] bg-white/95 px-8 py-4">
        <button
          type="button"
          onClick={onCancel}
          className="sc-secondary-action sc-focusable flex items-center gap-3 px-5 text-lg"
        >
          <ArrowLeft size={22} />
          {t.back}
        </button>
        <div className="rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-black uppercase tracking-[0.14em] text-amber-800">
          {t.demoMode}
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-8 pb-10">
        <section className="w-full max-w-5xl text-center">
          <h1 className="text-5xl font-black text-[var(--sc-ink)]">
            {t.paymentTitle}
          </h1>
          <div className="sc-tabular mt-7 text-7xl font-black text-[var(--sc-ink)]">
            {formatPLN(totalGrosze)}
          </div>
          <div className="mt-12 grid grid-cols-2 gap-6">
            <button
              type="button"
              onClick={() => setMethod('BLIK')}
              className="sc-focusable min-h-[220px] rounded-[28px] border-2 border-violet-200 bg-violet-50 p-8 text-left text-violet-800 transition-colors hover:border-violet-400 hover:bg-violet-100"
            >
              <Smartphone size={58} />
              <div className="mt-8 text-5xl font-black">BLIK</div>
              <div className="mt-3 text-2xl font-bold">{t.blik}</div>
            </button>
            <button
              type="button"
              onClick={() => {
                setMethod('CARD');
                setProcessing(true);
              }}
              className="sc-focusable min-h-[220px] rounded-[28px] border-2 border-blue-200 bg-blue-50 p-8 text-left text-blue-800 transition-colors hover:border-blue-400 hover:bg-blue-100"
            >
              <CreditCard size={58} />
              <div className="mt-8 text-5xl font-black">CARD</div>
              <div className="mt-3 text-2xl font-bold">{t.card}</div>
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

function ProcessingPayment({
  icon,
  label,
  badge,
  amount,
}: {
  icon: React.ReactNode;
  label: string;
  badge: string;
  amount: string;
}) {
  return (
    <div className="sc-shell flex h-screen w-screen items-center justify-center px-8 text-center select-none">
      <section className="sc-surface w-full max-w-3xl p-12">
        <div className="mx-auto flex h-32 w-32 items-center justify-center rounded-[34px] bg-blue-50 text-blue-700">
          {icon}
        </div>
        <div className="mt-8 inline-flex items-center gap-3 rounded-full border border-amber-200 bg-amber-50 px-5 py-3 text-sm font-black uppercase tracking-[0.14em] text-amber-800">
          {badge}
        </div>
        <h1 className="mt-7 text-6xl font-black text-[var(--sc-ink)]">
          {label}
        </h1>
        <div className="sc-tabular mt-6 text-6xl font-black text-[var(--sc-ink)]">
          {amount}
        </div>
        <div className="mt-8 flex items-center justify-center gap-3 text-2xl font-black text-blue-700">
          <Loader2 size={30} className="animate-spin" />
          ...
        </div>
      </section>
    </div>
  );
}

function BlikPad({
  value,
  disabled,
  payLabel,
  onChange,
  onSubmit,
}: {
  value: string;
  disabled: boolean;
  payLabel: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
}) {
  const keys = ['1','2','3','4','5','6','7','8','9','<','0','OK'];
  const press = (key: string) => {
    if (disabled) return;
    if (key === '<') onChange(value.slice(0, -1));
    else if (key === 'OK') onSubmit();
    else if (value.length < 6) onChange(value + key);
  };
  return (
    <aside className="sc-surface p-5">
      <div className="grid h-full grid-cols-3 gap-3">
        {keys.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => press(key)}
            disabled={disabled || (key === 'OK' && value.length !== 6)}
            className={`sc-focusable rounded-2xl text-3xl font-black transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              key === 'OK'
                ? 'bg-[var(--sc-success)] text-white hover:bg-emerald-800'
                : 'border-2 border-[var(--sc-border)] bg-white text-[var(--sc-ink)] hover:bg-[var(--sc-surface-muted)]'
            }`}
          >
            {key === '<' ? 'Del' : key === 'OK' ? payLabel : key}
          </button>
        ))}
      </div>
    </aside>
  );
}
