import React, { useEffect } from 'react';
import { CheckCircle2, FileText, Loader2, Printer } from 'lucide-react';
import LanguageSwitch from '../LanguageSwitch';
import { ScLanguage, getScStrings } from '../i18n';
import type { SelfCheckoutMode } from '../self-checkout-model';
import { formatPLN } from '../useScCart';
import type { PaymentMethod } from './PaymentScreen';

interface ReceiptScreenProps {
  lang: ScLanguage;
  mode: SelfCheckoutMode;
  method: PaymentMethod;
  totalGrosze: number;
  receiptPrinted?: boolean;
  onComplete: () => void;
  onLangChange: (lang: ScLanguage) => void;
}

export default function ReceiptScreen({
  lang,
  mode,
  method,
  totalGrosze,
  receiptPrinted = true,
  onComplete,
  onLangChange,
}: ReceiptScreenProps) {
  const t = getScStrings(lang);

  useEffect(() => {
    if (!receiptPrinted) return;
    const id = window.setTimeout(onComplete, 1800);
    return () => window.clearTimeout(id);
  }, [onComplete, receiptPrinted]);

  return (
    <div className="sc-shell flex h-screen w-screen flex-col text-[var(--sc-ink)] select-none">
      <header className="flex justify-end px-8 py-4">
        <LanguageSwitch lang={lang} onLangChange={onLangChange} compact />
      </header>
      <main className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 pb-6 text-center">
        <section className="sc-surface sc-receipt-panel w-full max-w-3xl p-8">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-[24px] bg-emerald-50 text-[var(--sc-success)]">
            <Printer size={52} />
          </div>
          <div className="mt-5 inline-flex items-center gap-3 rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-amber-800">
            {mode === 'demo' ? t.demoMode : t.productionMode}
          </div>
          <h1 className="mt-5 text-5xl font-black">
            {t.receiptTitle}
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-xl leading-8 text-[var(--sc-muted)]">
            {mode === 'demo'
              ? t.receiptDemoBody
              : receiptPrinted
                ? t.thankYouSub
                : t.receiptPrintFailed}
          </p>

          <div className="mt-6 space-y-2 text-left">
            <ReceiptStep icon={<CheckCircle2 size={24} />} label={t.paymentSuccess} done />
            <ReceiptStep
              icon={<FileText size={24} />}
              label={mode === 'demo' ? t.receiptDemoBody : t.receiptTitle}
              done={mode === 'demo' || receiptPrinted}
            />
            <ReceiptStep
              icon={<Loader2 size={24} className={receiptPrinted ? 'animate-spin' : ''} />}
              label={receiptPrinted ? t.thankYouSub : t.callStaff}
              done={false}
            />
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-[var(--sc-border)] pt-5">
            <div className="text-left">
              <div className="text-sm font-black uppercase tracking-[0.12em] text-[var(--sc-muted)]">
                {method}
              </div>
              <div className="text-lg font-bold text-[var(--sc-muted)]">
                {t.total}
              </div>
            </div>
            <div className="sc-tabular text-4xl font-black">
              {formatPLN(totalGrosze)}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function ReceiptStep({
  icon,
  label,
  done,
}: {
  icon: React.ReactNode;
  label: string;
  done: boolean;
}) {
  return (
    <div className={`flex items-center gap-4 rounded-2xl border px-4 py-3 text-base font-black ${
      done
        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
        : 'border-[var(--sc-border)] bg-[var(--sc-surface-muted)] text-[var(--sc-muted)]'
    }`}>
      {icon}
      <span>{label}</span>
    </div>
  );
}
