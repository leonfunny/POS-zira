import React, { useEffect, useMemo, useState } from 'react';
import { Language } from '../../../i18n/translations';
import {
  CustomerDisplayServiceCategory,
  CustomerDisplayServiceItem,
  formatDisplayCurrency,
} from '../customer-display-model';
import { Panel } from './CustomerDisplayPrimitives';

interface WalkInServicePickerProps {
  categories: CustomerDisplayServiceCategory[];
  language: Language;
  t: (key: string) => string;
  selectedServiceId?: string;
  onSelectService: (service: CustomerDisplayServiceItem) => void;
}

export default function WalkInServicePicker({
  categories,
  language,
  t,
  selectedServiceId,
  onSelectService,
}: WalkInServicePickerProps) {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(
    categories[0]?.id || '',
  );

  const selectedCategory = useMemo(() => {
    return categories.find((category) => category.id === selectedCategoryId) || categories[0] || null;
  }, [categories, selectedCategoryId]);

  useEffect(() => {
    if (!selectedCategoryId && categories[0]?.id) {
      setSelectedCategoryId(categories[0].id);
    }
  }, [categories, selectedCategoryId]);

  useEffect(() => {
    if (!selectedServiceId || !categories.length) return;

    const owner = categories.find((category) =>
      category.services.some((service) => service.id === selectedServiceId),
    );

    if (owner) setSelectedCategoryId(owner.id);
  }, [categories, selectedServiceId]);

  if (!categories.length) {
    return (
      <Panel className="flex min-h-[320px] items-center justify-center px-8 py-10 text-center">
        <div>
          <div className="text-xl font-semibold text-slate-900">{t('priceList.noServices')}</div>
        </div>
      </Panel>
    );
  }

  return (
    <div className="grid h-full gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Panel className="p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
          {t('customer.categories')}
        </div>
        <div className="mt-4 space-y-2">
          {categories.map((category) => {
            const active = category.id === selectedCategory?.id;

            return (
              <button
                key={category.id}
                onClick={() => setSelectedCategoryId(category.id)}
                className={`flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition-colors ${
                  active
                    ? 'bg-brand-50 text-brand-700'
                    : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                }`}
              >
                <span className="font-medium">{category.name}</span>
                <span className="text-xs uppercase tracking-[0.14em] text-slate-400">
                  {category.services.length}
                </span>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel className="p-4">
        <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              {t('wizard.selectServices')}
            </div>
            <div className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
              {selectedCategory?.name}
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {selectedCategory?.services.map((service) => {
            const active = service.id === selectedServiceId;

            return (
              <button
                key={service.id}
                onClick={() => onSelectService(service)}
                className={`flex w-full items-center justify-between gap-4 rounded-3xl border px-5 py-4 text-left transition-all ${
                  active
                    ? 'border-brand-300 bg-brand-50 shadow-sm'
                    : 'border-slate-200 bg-white hover:border-brand-200 hover:bg-rose-50/40'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-lg font-semibold text-slate-900">{service.name}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <MetaPill>{formatDisplayCurrency(service.price, language)}</MetaPill>
                    {service.duration > 0 && (
                      <MetaPill>{t('customer.duration').replace('{min}', String(service.duration))}</MetaPill>
                    )}
                  </div>
                </div>

                <div className={`rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] ${
                  active
                    ? 'border-brand-300 bg-white text-brand-700'
                    : 'border-slate-200 bg-slate-50 text-slate-500'
                }`}>
                  {active ? t('wizard.selected') : t('wizard.selectServices')}
                </div>
              </button>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function MetaPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
      {children}
    </span>
  );
}
