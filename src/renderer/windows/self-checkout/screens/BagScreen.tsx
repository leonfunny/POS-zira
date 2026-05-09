// Bag fee toggle. Polish bag-fee law (≥0.20 zł per single-use bag) —
// shop must explicitly offer or the cashier (here, the customer) has
// to confirm whether they bought one. Two big buttons: yes adds a
// bag-fee line to the cart, no proceeds straight to payment.
import React from 'react';
import { ScLanguage, getScStrings } from '../i18n';
import { formatPLN } from '../useScCart';

interface BagScreenProps {
  lang: ScLanguage;
  bagFeeGrosze: number;
  onYes: () => void;
  onNo: () => void;
  onBack: () => void;
}

export default function BagScreen({
  lang,
  bagFeeGrosze,
  onYes,
  onNo,
  onBack,
}: BagScreenProps) {
  const t = getScStrings(lang);
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-50 px-8 select-none">
      <h2 className="mb-2 text-5xl font-extrabold text-center">
        🛍️ {t.bagQuestion}
      </h2>
      <p className="mb-12 text-2xl text-slate-500 text-center">
        {formatPLN(bagFeeGrosze)} / {t.bagYes.toLowerCase()}
      </p>
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <button
          type="button"
          onClick={onYes}
          className="rounded-3xl bg-emerald-600 px-8 py-8 text-3xl font-bold text-white shadow-lg shadow-emerald-600/30 hover:bg-emerald-700"
        >
          ✓ {t.bagYes}
        </button>
        <button
          type="button"
          onClick={onNo}
          className="rounded-3xl border-4 border-slate-300 bg-white px-8 py-8 text-3xl font-bold text-slate-800 hover:border-slate-400 hover:bg-slate-50"
        >
          {t.bagNo}
        </button>
      </div>
      <button
        type="button"
        onClick={onBack}
        className="mt-10 rounded-xl px-6 py-3 text-base font-semibold text-slate-500 hover:text-slate-700"
      >
        ← {t.back}
      </button>
    </div>
  );
}
