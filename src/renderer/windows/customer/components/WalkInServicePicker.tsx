import React, { useEffect, useMemo, useRef } from 'react';
import { Language } from '../../../i18n/translations';
import {
  CustomerDisplayServiceCategory,
  CustomerDisplayServiceItem,
  formatDisplayCurrency,
} from '../customer-display-model';
import { EmptyState, Panel } from './CustomerDisplayPrimitives';

interface WalkInServicePickerProps {
  categories: CustomerDisplayServiceCategory[];
  language: Language;
  t: (key: string) => string;
  selectedCategoryId: string;
  searchQuery: string;
  categoryMenuOpen: boolean;
  selectedServiceIds: string[];
  onSelectCategory: (categoryId: string) => void;
  onToggleCategoryMenu: () => void;
  onSearchFocus: () => void;
  onToggleService: (service: CustomerDisplayServiceItem) => void;
}

export default function WalkInServicePicker({
  categories,
  language,
  t,
  selectedCategoryId,
  searchQuery,
  categoryMenuOpen,
  selectedServiceIds,
  onSelectCategory,
  onToggleCategoryMenu,
  onSearchFocus,
  onToggleService,
}: WalkInServicePickerProps) {
  const selectedCategory = useMemo(() => {
    return categories.find((category) => category.id === selectedCategoryId) || categories[0] || null;
  }, [categories, selectedCategoryId]);

  const visibleServices = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const services = selectedCategory?.services || [];
    if (!query) return services;
    return services.filter((service) => service.name.toLowerCase().includes(query));
  }, [searchQuery, selectedCategory]);

  const serviceListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    serviceListRef.current?.scrollTo(0, 0);
  }, [selectedCategoryId]);

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
    <Panel className="flex min-h-0 flex-col p-6">
      <div
        className="relative flex items-center gap-3"
        data-customer-display-checkin-walkin-category-toolbar="true"
      >
        <div className="relative w-[220px] shrink-0">
          <button
            type="button"
            onClick={onToggleCategoryMenu}
            data-customer-display-checkin-walkin-category-trigger="true"
            className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left shadow-[0_10px_24px_rgba(15,23,42,0.04)] transition-colors hover:border-brand-200 hover:bg-rose-50/60"
          >
            <span className="truncate text-sm font-semibold text-slate-900">
              {selectedCategory?.name || t('customer.categories')}
            </span>
            <span className={`ml-3 shrink-0 text-slate-400 transition-transform ${categoryMenuOpen ? 'rotate-180' : ''}`}>
              <ChevronDownIcon />
            </span>
          </button>

          {categoryMenuOpen && (
            <div
              className="absolute left-0 top-[calc(100%+0.5rem)] z-10 w-full rounded-[24px] border border-slate-200 bg-white p-2 shadow-[0_24px_60px_rgba(15,23,42,0.12)]"
              data-customer-display-checkin-walkin-category-menu="true"
            >
              <div className="space-y-1">
                {categories.map((category) => {
                  const active = category.id === selectedCategory?.id;

                  return (
                    <button
                      key={category.id}
                      type="button"
                      onClick={() => onSelectCategory(category.id)}
                      className={`flex w-full items-center justify-between rounded-2xl px-3 py-3 text-left transition-colors ${
                        active
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className="min-w-0 pr-3">
                        <span className="block truncate text-sm font-semibold">{category.name}</span>
                      </span>
                      <span className="shrink-0 text-xs font-semibold text-slate-400">
                        {category.services.length}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <input
          value={searchQuery}
          readOnly
          onFocus={onSearchFocus}
          onPointerDown={onSearchFocus}
          data-customer-display-text-input="true"
          data-customer-display-checkin-walkin-search-input="true"
          placeholder={t('priceList.search')}
          className="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50/80 px-4 text-base text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-brand-300 focus:bg-white"
        />
      </div>

      <div
        ref={serviceListRef}
        className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1"
        data-customer-display-checkin-walkin-service-list="true"
      >
        {visibleServices.length > 0 ? (
          <div className="grid gap-4">
            {visibleServices.map((service) => {
              const active = selectedServiceIds.includes(service.id);

              return (
                <div
                  key={service.id}
                  className={`rounded-[28px] border p-5 shadow-[0_16px_40px_rgba(15,23,42,0.05)] transition-colors ${
                    active
                      ? 'border-brand-300 bg-brand-50/70'
                      : 'border-slate-200 bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-5">
                    <div className="min-w-0">
                      <div className="text-xl font-semibold text-slate-900">{service.name}</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <MetaPill>{formatDisplayCurrency(service.price, language)}</MetaPill>
                        {service.duration > 0 && (
                          <MetaPill>{t('customer.duration').replace('{min}', String(service.duration))}</MetaPill>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => onToggleService(service)}
                      className={`rounded-2xl px-5 py-3 text-sm font-semibold transition-colors ${
                        active
                          ? 'border border-brand-300 bg-white text-brand-700 hover:bg-brand-50'
                          : 'bg-brand-600 text-white hover:bg-brand-700'
                      }`}
                    >
                      {active ? t('wizard.selected') : t('wizard.selectServices')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState title={t('priceList.noResults')} />
        )}
      </div>
    </Panel>
  );
}

function MetaPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
      {children}
    </span>
  );
}

function ChevronDownIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}
