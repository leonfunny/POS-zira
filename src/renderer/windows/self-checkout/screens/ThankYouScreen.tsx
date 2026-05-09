// Thank-you screen. Auto-returns to welcome after 8 seconds.
import React, { useEffect } from 'react';
import { ScLanguage, getScStrings } from '../i18n';
import { formatPLN } from '../useScCart';

interface ThankYouScreenProps {
  lang: ScLanguage;
  totalGrosze: number;
  onReset: () => void;
}

export default function ThankYouScreen({
  lang,
  totalGrosze,
  onReset,
}: ThankYouScreenProps) {
  const t = getScStrings(lang);
  useEffect(() => {
    const id = setTimeout(onReset, 8000);
    return () => clearTimeout(id);
  }, [onReset]);

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-gradient-to-br from-emerald-100 via-emerald-50 to-amber-50 px-8 select-none">
      <div className="mb-6 text-[12rem] leading-none">✓</div>
      <h1 className="mb-3 text-7xl font-black text-emerald-800">
        {t.thankYouTitle}
      </h1>
      <p className="mb-10 text-2xl text-slate-600 text-center max-w-2xl">
        {t.thankYouSub}
      </p>
      <p className="text-4xl font-bold text-slate-800 tabular-nums">
        {formatPLN(totalGrosze)}
      </p>
      <button
        type="button"
        onClick={onReset}
        className="mt-12 rounded-xl border-2 border-emerald-300 bg-white px-8 py-3 text-base font-semibold text-emerald-700 hover:bg-emerald-50"
      >
        {t.startButton} →
      </button>
    </div>
  );
}
