import React, { useState } from 'react';
import { ScanBarcode } from 'lucide-react';
import { Language } from '../i18n/translations';
import { useTranslation } from '../i18n/useTranslation';
import GrocerySelfCheckoutPanel from './pos/GrocerySelfCheckoutPanel';
import KitchenSelfOrderPanel from './pos/KitchenSelfOrderPanel';

interface SelfCheckoutTabProps {
  language: Language;
}

export default function SelfCheckoutTab({ language: uiLanguage }: SelfCheckoutTabProps) {
  const { t } = useTranslation(uiLanguage);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const justSaved = Boolean(savedAt && Date.now() - savedAt < 2000);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex items-start justify-between gap-6">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-[var(--sand-200)] bg-white px-3 py-1 text-xs font-bold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
            <ScanBarcode size={14} className="text-[var(--primary-deep)]" />
            {t('selfCheckout.badge')}
          </div>
          <h1 className="text-3xl font-black tracking-tight text-[var(--ink)]">
            {t('selfCheckout.title')}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--ink-muted)]">
            {t('selfCheckout.subtitle')}
          </p>
        </div>
        {justSaved && (
          <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
            {t('selfCheckout.saved')}
          </div>
        )}
      </header>

      <GrocerySelfCheckoutPanel
        language={uiLanguage}
        onSaved={() => setSavedAt(Date.now())}
      />
      <KitchenSelfOrderPanel
        language={uiLanguage}
        onSaved={() => setSavedAt(Date.now())}
      />
    </div>
  );
}
