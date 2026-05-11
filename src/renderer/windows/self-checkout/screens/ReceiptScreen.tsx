import React, { useEffect } from 'react';
import { CheckCircle2, FileText, Loader2, Printer } from 'lucide-react';
import { ScLanguage, getScStrings } from '../i18n';
import type { SelfCheckoutMode } from '../self-checkout-model';
import { formatPLN } from '../useScCart';
import type { PaymentMethod } from './PaymentScreen';

interface ReceiptScreenProps {
  lang: ScLanguage;
  mode: SelfCheckoutMode;
  method: PaymentMethod;
  totalGrosze: number;
  onComplete: () => void;
}

export default function ReceiptScreen({
  lang,
  mode,
  method,
  totalGrosze,
  onComplete,
}: ReceiptScreenProps) {
  const t = getScStrings(lang);

  useEffect(() => {
    if (mode !== 'demo') return;
    const id = window.setTimeout(onComplete, 1800);
    return () => window.clearTimeout(id);
  }, [mode, onComplete]);

  return (
    <div className="sc-shell flex h-screen w-screen items-center justify-center px-8 text-center text-[var(--sc-ink)] select-none">
      <section className="sc-surface w-full max-w-3xl p-12">
        <div className="mx-auto flex h-28 w-28 items-center justify-center rounded-[32px] bg-emerald-50 text-[var(--sc-success)]">
          <Printer size={68} />
        </div>
        <div className="mt-8 inline-flex items-center gap-3 rounded-full border border-amber-200 bg-amber-50 px-5 py-3 text-sm font-black uppercase tracking-[0.14em] text-amber-800">
          {mode === 'demo' ? t.demoMode : t.productionMode}
        </div>
        <h1 className="mt-7 text-6xl font-black tracking-tight">
          {t.receiptTitle}
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-2xl leading-9 text-[var(--sc-muted)]">
          {mode === 'demo' ? t.receiptDemoBody : t.receiptProductionBlocked}
        </p>

        <div className="mt-9 space-y-3 text-left">
          <ReceiptStep icon={<CheckCircle2 size={24} />} label={t.paymentSuccess} done />
          <ReceiptStep icon={<FileText size={24} />} label={mode === 'demo' ? t.receiptDemoBody : t.receiptTitle} done={mode === 'demo'} />
          <ReceiptStep icon={<Loader2 size={24} className="animate-spin" />} label={t.thankYouSub} done={false} />
        </div>

        <div className="mt-9 flex items-center justify-between border-t border-[var(--sc-border)] pt-6">
          <div className="text-left">
            <div className="text-sm font-black uppercase tracking-[0.12em] text-[var(--sc-muted)]">
              {method}
            </div>
            <div className="text-lg font-bold text-[var(--sc-muted)]">
              {t.total}
            </div>
          </div>
          <div className="sc-tabular text-5xl font-black">
            {formatPLN(totalGrosze)}
          </div>
        </div>
      </section>
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
    <div className={`flex items-center gap-4 rounded-2xl border px-5 py-4 text-lg font-black ${
      done
        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
        : 'border-[var(--sc-border)] bg-[var(--sc-surface-muted)] text-[var(--sc-muted)]'
    }`}>
      {icon}
      <span>{label}</span>
    </div>
  );
}
