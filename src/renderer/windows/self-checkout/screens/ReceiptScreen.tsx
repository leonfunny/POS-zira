import React, { useEffect } from 'react';
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
    const id = window.setTimeout(onComplete, 1400);
    return () => window.clearTimeout(id);
  }, [mode, onComplete]);

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-50 px-8 text-center text-slate-900 select-none">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-10 shadow-sm">
        <div className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          {mode === 'demo' ? t.demoMode : t.productionMode}
        </div>
        <h1 className="mt-4 text-5xl font-black tracking-tight">
          {t.receiptTitle}
        </h1>
        <p className="mt-5 text-2xl text-slate-600">
          {mode === 'demo' ? t.receiptDemoBody : t.receiptProductionBlocked}
        </p>
        <div className="mt-8 text-5xl font-black tabular-nums">
          {formatPLN(totalGrosze)}
        </div>
        <div className="mt-3 text-xl font-semibold text-slate-500">
          {method}
        </div>
      </div>
    </div>
  );
}
