import React from 'react';
import type { Language } from '../../../i18n/translations';
import { formatDisplayCurrency } from '../customer-display-model';

interface RetailAssistedThankYouViewProps {
  lastOrderTotal?: number;
  t: (key: string) => string;
  language: Language;
}

export default function RetailAssistedThankYouView({ lastOrderTotal, t, language }: RetailAssistedThankYouViewProps) {
  return (
    <div className="flex h-screen items-center justify-center bg-slate-50 px-10 text-slate-950">
      <div className="w-full max-w-4xl rounded-lg border border-slate-200 bg-white p-12 text-center shadow-sm">
        <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full border-2 border-emerald-200 bg-emerald-50 text-emerald-600">
          <svg className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="mt-8 text-6xl font-semibold tracking-tight">{t('customer.retail.thankYou')}</h1>
        <p className="mt-5 text-3xl text-slate-600">{t('customer.retail.thankYouSubtitle')}</p>
        {lastOrderTotal != null && lastOrderTotal > 0 && (
          <div className="mt-10 text-6xl font-bold tabular-nums text-brand-700">
            {formatDisplayCurrency(lastOrderTotal, language)}
          </div>
        )}
      </div>
    </div>
  );
}
