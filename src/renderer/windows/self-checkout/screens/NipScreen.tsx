// NIP entry screen. Polish B2B customer can request a VAT invoice by
// providing the company NIP (10 digits). MUST be entered before
// payment / fiscal print — paragon fiskalny is final once printed.
import React, { useState } from 'react';
import { ScLanguage, getScStrings } from '../i18n';
import { ManualNumpad } from './ScanScreen';

interface NipScreenProps {
  lang: ScLanguage;
  initialNip?: string | null;
  onSkip: () => void;
  onConfirm: (nip: string) => void;
  onBack: () => void;
}

export default function NipScreen({
  lang,
  initialNip,
  onSkip,
  onConfirm,
  onBack,
}: NipScreenProps) {
  const t = getScStrings(lang);
  const [value, setValue] = useState(initialNip ?? '');

  const isValid = value.length === 10 && /^\d{10}$/.test(value);

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-50 select-none">
      <div className="mx-auto w-full max-w-md rounded-3xl bg-white p-8 shadow-xl">
        <h2 className="mb-2 text-3xl font-bold text-center">{t.nipTitle}</h2>
        <p className="mb-6 text-center text-base text-slate-500">
          {t.addNipButton}
        </p>
        <div className="mb-4 h-20 rounded-2xl border-2 border-slate-200 bg-slate-50 text-center text-4xl font-mono tabular-nums leading-[80px] tracking-widest">
          {value || <span className="text-slate-300">{t.nipPlaceholder}</span>}
        </div>
        <ManualNumpad
          title=""
          value={value}
          onChange={setValue}
          onCancel={onBack}
          onSubmit={() => isValid && onConfirm(value)}
          okLabel={t.pay}
          cancelLabel={t.back}
          maxLength={10}
        />
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onSkip}
            className="rounded-xl border-2 border-slate-200 py-4 text-lg font-semibold text-slate-700 hover:bg-slate-50"
          >
            {t.cancel}
          </button>
          <button
            type="button"
            onClick={() => isValid && onConfirm(value)}
            disabled={!isValid}
            className="rounded-xl bg-emerald-600 py-4 text-lg font-bold text-white hover:bg-emerald-700 disabled:bg-slate-300"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
