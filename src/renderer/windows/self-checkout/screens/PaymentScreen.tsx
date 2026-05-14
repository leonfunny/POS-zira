// Payment overlay. The kiosk app chooses the tender type; the physical
// payment terminal owns card tap/insert and BLIK code entry.
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CreditCard, Loader2, Smartphone, X } from 'lucide-react';
import LanguageSwitch from '../LanguageSwitch';
import { ScLanguage, getScStrings } from '../i18n';
import type { SelfCheckoutMode } from '../self-checkout-model';
import { formatPLN } from '../useScCart';

export type PaymentMethod = 'BLIK' | 'CARD';

interface PaymentScreenProps {
  lang: ScLanguage;
  mode: SelfCheckoutMode;
  totalGrosze: number;
  terminalStatus?: string | null;
  errorText?: string | null;
  onSuccess: (method: PaymentMethod) => void | Promise<void>;
  onCancel: () => void;
  onLangChange: (lang: ScLanguage) => void;
}

export default function PaymentScreen({
  lang,
  mode,
  totalGrosze,
  terminalStatus,
  errorText,
  onSuccess,
  onCancel,
  onLangChange,
}: PaymentScreenProps) {
  const t = getScStrings(lang);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    if (mode !== 'demo' || !method || !processing) return;
    const id = window.setTimeout(() => {
      void onSuccess(method);
    }, 1500);
    return () => window.clearTimeout(id);
  }, [method, mode, onSuccess, processing]);

  const chooseMethod = async (next: PaymentMethod) => {
    if (processing) return;
    if (mode === 'production' && next === 'BLIK') return;
    setMethod(next);
    setProcessing(true);
    if (mode === 'demo') return;
    try {
      await onSuccess(next);
    } catch {
      setProcessing(false);
      setMethod(null);
    }
  };

  const selectedLabel = method === 'BLIK' ? t.blik : method === 'CARD' ? t.card : null;

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/55 p-6 select-none">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="self-checkout-payment-title"
        className="sc-surface flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden"
      >
        <header className="flex items-center justify-between border-b border-[var(--sc-border)] px-6 py-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={processing}
            className="sc-secondary-action sc-focusable flex items-center gap-3 px-5 text-lg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={22} />
            {t.cancel}
          </button>
          <div className="flex items-center gap-3">
            <div className="rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-black uppercase tracking-[0.14em] text-amber-800">
              {mode === 'demo' ? t.demoMode : t.productionMode}
            </div>
            <LanguageSwitch lang={lang} onLangChange={onLangChange} compact />
          </div>
        </header>

        <div className="grid min-h-0 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <main className="min-w-0">
              <h1 id="self-checkout-payment-title" className="text-5xl font-black text-[var(--sc-ink)]">
                {t.paymentTitle}
              </h1>
              <div className="sc-tabular mt-5 text-7xl font-black text-[var(--sc-ink)]">
                {formatPLN(totalGrosze)}
              </div>
              <p className="mt-5 max-w-2xl text-2xl font-semibold leading-9 text-[var(--sc-muted)]">
                {t.paymentTerminalHint}
              </p>

              <div className="mt-8 grid grid-cols-2 gap-5">
                <PaymentMethodButton
                  active={method === 'CARD'}
                  disabled={processing}
                  icon={<CreditCard size={54} />}
                  title={t.payWithCard}
                  body={t.cardTerminalHint}
                  onClick={() => chooseMethod('CARD')}
                />
                <PaymentMethodButton
                  active={method === 'BLIK'}
                  disabled={processing || mode === 'production'}
                  icon={<Smartphone size={54} />}
                  title={t.payWithBlik}
                  body={mode === 'production' ? t.blikProductionUnsupported : t.blikTerminalHint}
                  onClick={() => chooseMethod('BLIK')}
                />
              </div>
            </main>

            <aside className="rounded-3xl border border-[var(--sc-border)] bg-[var(--sc-surface-muted)] p-6">
              <div className="flex h-20 w-20 items-center justify-center rounded-[24px] bg-white text-[var(--sc-info)]">
                {method === 'BLIK' ? <Smartphone size={44} /> : <CreditCard size={44} />}
              </div>
              <h2 className="mt-6 text-3xl font-black text-[var(--sc-ink)]">
                {selectedLabel || t.terminalReadyTitle}
              </h2>
              <p className="mt-4 text-xl font-semibold leading-8 text-[var(--sc-muted)]">
                {processing ? (terminalStatus || t.waitForTerminal) : t.terminalReadyBody}
              </p>
              {processing && (
                <div
                  role="status"
                  className="mt-8 flex items-center gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4 text-xl font-black text-blue-800"
                >
                  <Loader2 size={28} className="animate-spin" />
                  {t.paymentProcessing}
                </div>
              )}
              {errorText && (
                <div
                  role="alert"
                  className="mt-5 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-left text-lg font-black leading-7 text-red-800"
                >
                  <AlertTriangle size={26} className="mt-0.5 shrink-0" />
                  <span>{errorText}</span>
                </div>
              )}
            </aside>
        </div>
      </section>
    </div>
  );
}

function PaymentMethodButton({
  active,
  disabled,
  icon,
  title,
  body,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`sc-focusable min-h-[190px] rounded-[24px] border-2 p-6 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        active
          ? 'border-[var(--sc-success)] bg-emerald-50 text-emerald-800'
          : 'border-[var(--sc-border)] bg-white text-[var(--sc-ink)] hover:border-[var(--sc-primary)] hover:bg-[var(--sc-primary-soft)]'
      }`}
    >
      <div className="text-[var(--sc-primary-deep)]">{icon}</div>
      <div className="mt-8 text-4xl font-black leading-tight">{title}</div>
      <div className="mt-3 text-lg font-bold leading-7 text-[var(--sc-muted)]">
        {body}
      </div>
    </button>
  );
}
