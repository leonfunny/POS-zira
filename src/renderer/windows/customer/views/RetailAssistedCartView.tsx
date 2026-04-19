import React from 'react';
import type { CartState } from '../../../hooks/usePosStore';
import type { Language } from '../../../i18n/translations';
import { formatDisplayCurrency } from '../customer-display-model';

interface RetailAssistedCartViewProps {
  cart: CartState;
  t: (key: string) => string;
  language: Language;
  paymentStatus?: string;
}

export default function RetailAssistedCartView({ cart, t, language, paymentStatus }: RetailAssistedCartViewProps) {
  const rows = cart.items.slice(-8);

  return (
    <div className="flex h-screen bg-slate-50 text-slate-950">
      <section className="flex min-w-0 flex-1 flex-col px-10 py-8">
        <header className="mb-6">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            {t('customer.retail.cartTitle')}
          </div>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">
            {t('customer.retail.cartSubtitle')}
          </h1>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          {rows.length === 0 ? (
            <div className="flex h-full items-center justify-center px-8 text-center text-3xl font-semibold text-slate-500">
              {t('customer.retail.idleSubtitle')}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {rows.map((item) => (
                <div key={item.id} className="grid grid-cols-[1fr_110px_180px] items-center gap-6 px-8 py-5">
                  <div className="min-w-0">
                    <div className="truncate text-3xl font-semibold text-slate-950">{item.name}</div>
                    {item.sku && <div className="mt-1 truncate text-base text-slate-500">{item.sku}</div>}
                  </div>
                  <div className="text-right text-3xl font-semibold tabular-nums text-slate-700">x{item.quantity}</div>
                  <div className="text-right text-3xl font-semibold tabular-nums text-slate-950">
                    {formatDisplayCurrency(item.total, language)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <aside className="flex w-[420px] shrink-0 flex-col border-l border-slate-200 bg-white px-8 py-8">
        <div className="flex-1">
          <div className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            {t('customer.retail.total')}
          </div>
          <div className="mt-4 text-right text-6xl font-bold tabular-nums text-brand-700">
            {formatDisplayCurrency(cart.total, language)}
          </div>
          {cart.discount > 0 && (
            <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-5 text-2xl font-semibold text-emerald-700">
              <span>{t('customer.discount')}</span>
              <span className="tabular-nums">-{formatDisplayCurrency(cart.discount, language)}</span>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-5">
          <div className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            {t('customer.retail.paymentStatus')}
          </div>
          <div className="mt-3 text-2xl font-semibold text-slate-900">
            {paymentStatus || t('customer.retail.paymentPrompt')}
          </div>
        </div>
      </aside>
    </div>
  );
}
