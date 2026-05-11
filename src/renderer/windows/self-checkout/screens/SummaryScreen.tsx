import React, { useState } from 'react';
import { ArrowLeft, Hand, ReceiptText, ShoppingBag, Trash2 } from 'lucide-react';
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
    <div className="sc-shell flex h-screen w-screen flex-col overflow-hidden select-none">
      <header className="flex items-center justify-between border-b border-[var(--sc-border)] bg-white/95 px-8 py-4">
        <button
          type="button"
          onClick={onBack}
          className="sc-secondary-action sc-focusable flex items-center gap-3 px-5 text-lg"
        >
          <ArrowLeft size={22} />
          {t.back}
        </button>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCallStaff}
            className="sc-secondary-action sc-focusable flex items-center gap-2 px-5 text-base text-amber-800"
          >
            <Hand size={20} />
            {t.callStaff}
          </button>
          <button
            type="button"
            onClick={onAbandon}
            className="sc-danger-action sc-focusable px-5 text-base"
          >
            {t.abandon}
          </button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_430px] gap-5 p-5">
        <section className="sc-surface min-h-0 overflow-hidden">
          <div className="flex items-center gap-3 border-b border-[var(--sc-border)] px-6 py-5">
            <ReceiptText size={30} className="text-[var(--sc-primary-deep)]" />
            <div>
              <h1 className="text-3xl font-black text-[var(--sc-ink)]">
                {t.summaryTitle}
              </h1>
              <p className="text-base font-semibold text-[var(--sc-muted)]">
                {products.length} {t.items}
              </p>
            </div>
          </div>
          <div className="max-h-full overflow-y-auto">
            <ul className="divide-y divide-[var(--sc-border)]">
              {cartItems.map((item) => (
                <li key={item.variantId + (item.isBagFee ? '-bag' : '')} className="grid grid-cols-[minmax(0,1fr)_90px_170px] items-center gap-4 px-6 py-5">
                  <div className="min-w-0">
                    <div className="text-2xl font-black leading-snug text-[var(--sc-ink)]">
                      {item.name}
                    </div>
                    <div className="mt-1 text-base font-semibold text-[var(--sc-muted)]">
                      {formatPLN(item.price)}{item.sku ? ` · ${item.sku}` : ''}
                    </div>
                  </div>
                  <div className="sc-tabular text-right text-2xl font-black text-[var(--sc-ink)]">
                    x{item.quantity}
                  </div>
                  <div className="sc-tabular text-right text-2xl font-black text-[var(--sc-ink)]">
                    {formatPLN(item.price * item.quantity)}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <aside className="sc-surface flex min-h-0 flex-col p-5">
          <div className="space-y-4">
            <section className="sc-surface-flat p-4">
              <div className="flex items-center gap-3">
                <ShoppingBag size={26} className="text-[var(--sc-primary-deep)]" />
                <h2 className="text-xl font-black text-[var(--sc-ink)]">
                  {t.bagQuestion}
                </h2>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => onSetBagFee(true)}
                  className={`sc-focusable min-h-[64px] rounded-2xl px-4 text-xl font-black ${
                    hasBagFee
                      ? 'bg-[var(--sc-success)] text-white'
                      : 'border-2 border-[var(--sc-border)] bg-white text-[var(--sc-ink)]'
                  }`}
                >
                  {t.bagYes}
                </button>
                <button
                  type="button"
                  onClick={() => onSetBagFee(false)}
                  className={`sc-focusable min-h-[64px] rounded-2xl px-4 text-xl font-black ${
                    !hasBagFee
                      ? 'bg-[var(--sc-ink)] text-white'
                      : 'border-2 border-[var(--sc-border)] bg-white text-[var(--sc-ink)]'
                  }`}
                >
                  {t.bagNo}
                </button>
              </div>
              <div className="mt-3 text-base font-bold text-[var(--sc-muted)]">
                {formatPLN(bagFeeGrosze)}
              </div>
            </section>

            <section className="sc-surface-flat p-4">
              <div className="text-sm font-black uppercase tracking-[0.12em] text-[var(--sc-muted)]">
                {t.nipTitle}
              </div>
              <div className="mt-3 min-h-[32px] text-xl font-black text-[var(--sc-ink)]">
                {customerNip || t.noNip}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setNipValue(customerNip ?? '');
                    setNipOpen(true);
                  }}
                  className="sc-secondary-action sc-focusable px-3 text-base"
                >
                  {t.addNipButton}
                </button>
                <button
                  type="button"
                  onClick={() => onSetNip(null)}
                  disabled={!customerNip}
                  className="sc-secondary-action sc-focusable flex items-center justify-center gap-2 px-3 text-base disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 size={18} />
                  {t.remove}
                </button>
              </div>
            </section>
          </div>

          <div className="mt-auto border-t border-[var(--sc-border)] pt-5">
            <div className="mb-5 flex items-end justify-between gap-4">
              <span className="text-xl font-black text-[var(--sc-muted)]">
                {t.total}
              </span>
              <span className="sc-tabular text-5xl font-black tracking-tight text-[var(--sc-ink)]">
                {formatPLN(totalGrosze)}
              </span>
            </div>
            <button
              type="button"
              onClick={onPay}
              disabled={products.length === 0}
              className="sc-action sc-action-success sc-focusable flex w-full items-center justify-center text-2xl"
            >
              {t.pay}
            </button>
          </div>
        </aside>
      </main>

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
