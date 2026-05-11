import React, { useState } from 'react';
import { ScLanguage, getScStrings } from '../i18n';
import { isValidPolishNip, normalizeNip } from '../self-checkout-model';
import { ScCartItem, formatPLN } from '../useScCart';
import { ManualNumpad } from './ScanScreen';

interface SummaryScreenProps {
  lang: ScLanguage;
  cartItems: ScCartItem[];
  totalGrosze: number;
  customerNip: string | null;
  bagFeeGrosze: number;
  hasBagFee: boolean;
  onSetBagFee: (enabled: boolean) => void;
  onSetNip: (nip: string | null) => void;
  onBack: () => void;
  onPay: () => void;
  onCallStaff: () => void;
  onAbandon: () => void;
}

export default function SummaryScreen({
  lang,
  cartItems,
  totalGrosze,
  customerNip,
  bagFeeGrosze,
  hasBagFee,
  onSetBagFee,
  onSetNip,
  onBack,
  onPay,
  onCallStaff,
  onAbandon,
}: SummaryScreenProps) {
  const t = getScStrings(lang);
  const [nipOpen, setNipOpen] = useState(false);
  const [nipValue, setNipValue] = useState(customerNip ?? '');
  const products = cartItems.filter((item) => !item.isBagFee);
  const validNip = isValidPolishNip(nipValue);

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-50 text-slate-900 select-none">
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
        <button
          type="button"
          onClick={onBack}
          className="rounded-xl border-2 border-slate-300 bg-white px-5 py-3 text-base font-semibold text-slate-700 hover:bg-slate-100"
        >
          ← {t.back}
        </button>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCallStaff}
            className="rounded-xl border-2 border-amber-300 bg-amber-50 px-5 py-3 text-base font-semibold text-amber-800 hover:bg-amber-100"
          >
            {t.callStaff}
          </button>
          <button
            type="button"
            onClick={onAbandon}
            className="rounded-xl border-2 border-red-200 bg-red-50 px-5 py-3 text-base font-semibold text-red-700 hover:bg-red-100"
          >
            {t.abandon}
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_420px] gap-4 p-4">
        <section className="min-h-0 rounded-2xl bg-white shadow-sm">
          <div className="border-b border-slate-200 px-6 py-4 text-2xl font-bold">
            {t.summaryTitle}
          </div>
          <div className="max-h-full overflow-y-auto">
            <ul className="divide-y divide-slate-100">
              {cartItems.map((item) => (
                <li key={item.variantId + (item.isBagFee ? '-bag' : '')} className="grid grid-cols-[1fr_90px_150px] items-center gap-4 px-6 py-4">
                  <div className="min-w-0">
                    <div className="truncate text-xl font-semibold">{item.name}</div>
                    <div className="mt-1 text-sm text-slate-500">
                      {formatPLN(item.price)}{item.sku ? ` · ${item.sku}` : ''}
                    </div>
                  </div>
                  <div className="text-right text-xl font-semibold tabular-nums">
                    x{item.quantity}
                  </div>
                  <div className="text-right text-xl font-bold tabular-nums">
                    {formatPLN(item.price * item.quantity)}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <aside className="flex min-h-0 flex-col rounded-2xl bg-white p-5 shadow-sm">
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 p-4">
              <div className="text-sm font-semibold uppercase tracking-wider text-slate-500">
                {t.bagQuestion}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onSetBagFee(true)}
                  className={`rounded-xl px-4 py-4 text-lg font-bold ${
                    hasBagFee
                      ? 'bg-emerald-600 text-white'
                      : 'border-2 border-slate-200 bg-white text-slate-700'
                  }`}
                >
                  {t.bagYes}
                </button>
                <button
                  type="button"
                  onClick={() => onSetBagFee(false)}
                  className={`rounded-xl px-4 py-4 text-lg font-bold ${
                    !hasBagFee
                      ? 'bg-slate-900 text-white'
                      : 'border-2 border-slate-200 bg-white text-slate-700'
                  }`}
                >
                  {t.bagNo}
                </button>
              </div>
              <div className="mt-2 text-sm text-slate-500">
                {formatPLN(bagFeeGrosze)}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 p-4">
              <div className="text-sm font-semibold uppercase tracking-wider text-slate-500">
                {t.nipTitle}
              </div>
              <div className="mt-3 text-lg font-semibold">
                {customerNip || t.noNip}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setNipValue(customerNip ?? '');
                    setNipOpen(true);
                  }}
                  className="rounded-xl border-2 border-slate-200 bg-white px-4 py-3 text-base font-semibold text-slate-700"
                >
                  {t.addNipButton}
                </button>
                <button
                  type="button"
                  onClick={() => onSetNip(null)}
                  disabled={!customerNip}
                  className="rounded-xl border-2 border-slate-200 bg-white px-4 py-3 text-base font-semibold text-slate-700 disabled:opacity-40"
                >
                  {t.remove}
                </button>
              </div>
            </div>
          </div>

          <div className="mt-auto border-t border-slate-200 pt-5">
            <div className="mb-4 flex items-baseline justify-between">
              <span className="text-xl font-semibold text-slate-600">
                {t.total}
              </span>
              <span className="text-4xl font-black tabular-nums">
                {formatPLN(totalGrosze)}
              </span>
            </div>
            <button
              type="button"
              onClick={onPay}
              disabled={products.length === 0}
              className="w-full rounded-xl bg-emerald-600 py-5 text-2xl font-bold text-white shadow-lg shadow-emerald-600/30 hover:bg-emerald-700 disabled:bg-slate-300 disabled:shadow-none"
            >
              {t.pay}
            </button>
          </div>
        </aside>
      </div>

      {nipOpen && (
        <ManualNumpad
          title={t.nipTitle}
          value={nipValue}
          onChange={(next) => setNipValue(normalizeNip(next))}
          onCancel={() => setNipOpen(false)}
          onSubmit={() => {
            if (!validNip) return;
            onSetNip(normalizeNip(nipValue));
            setNipOpen(false);
          }}
          okLabel={validNip ? 'OK' : t.nipInvalid}
          cancelLabel={t.back}
          maxLength={10}
        />
      )}
    </div>
  );
}
