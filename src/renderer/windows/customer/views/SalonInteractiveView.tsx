import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Language } from '../../../i18n/translations';
import CustomerDisplayShell from '../components/CustomerDisplayShell';
import { DetailRow, EmptyState, Panel } from '../components/CustomerDisplayPrimitives';
import {
  CustomerDisplayServiceCategory,
  CustomerDisplayServiceItem,
  formatDisplayCurrency,
  summarizeServiceCategories,
} from '../customer-display-model';

type BrowseView = 'catalog' | 'category' | 'handoff' | 'confirmed';

interface SalonInteractiveViewProps {
  t: (key: string) => string;
  language: Language;
  categories: CustomerDisplayServiceCategory[];
  salonName?: string;
  onHome: () => void;
  onReturnToCheckIn: () => void;
  onBack: () => void;
  onLanguageChange: (language: Language) => void;
}

const INTERACTION_TIMEOUT_MS = 30_000;
const CONFIRMATION_TIMEOUT_MS = 8_000;

export default function SalonInteractiveView({
  t,
  language,
  categories,
  salonName,
  onHome,
  onReturnToCheckIn,
  onBack,
  onLanguageChange,
}: SalonInteractiveViewProps) {
  const [view, setView] = useState<BrowseView>('catalog');
  const [selectedCategoryId, setSelectedCategoryId] = useState(categories[0]?.id || '');
  const [searchQuery, setSearchQuery] = useState('');
  const [walkInName, setWalkInName] = useState('');
  const [selectedService, setSelectedService] = useState<CustomerDisplayServiceItem | null>(null);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const categorySummaries = useMemo(
    () => summarizeServiceCategories(categories),
    [categories],
  );
  const selectedCategory = useMemo(
    () => categories.find((category) => category.id === selectedCategoryId) || categories[0] || null,
    [categories, selectedCategoryId],
  );
  const visibleServices = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const services = selectedCategory?.services || [];
    if (!query) return services;
    return services.filter((service) => service.name.toLowerCase().includes(query));
  }, [searchQuery, selectedCategory]);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    window.electronAPI.display?.ping?.();

    if (view === 'confirmed') return;

    idleTimerRef.current = setTimeout(() => {
      onBack();
    }, INTERACTION_TIMEOUT_MS);
  }, [onBack, view]);

  useEffect(() => {
    resetIdleTimer();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [resetIdleTimer]);

  useEffect(() => {
    if (view !== 'confirmed') return undefined;

    confirmTimerRef.current = setTimeout(() => {
      onBack();
    }, CONFIRMATION_TIMEOUT_MS);

    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, [onBack, view]);

  useEffect(() => {
    if (!selectedCategoryId && categories[0]?.id) {
      setSelectedCategoryId(categories[0].id);
    }
  }, [categories, selectedCategoryId]);

  const goBackOneLevel = useCallback(() => {
    resetIdleTimer();

    if (view === 'handoff') {
      setView('category');
      return;
    }

    if (view === 'category') {
      setSearchQuery('');
      setView('catalog');
    }
  }, [resetIdleTimer, view]);

  const startCategory = useCallback((categoryId: string) => {
    resetIdleTimer();
    setSelectedCategoryId(categoryId);
    setSearchQuery('');
    setView('category');
  }, [resetIdleTimer]);

  const startWalkInHandoff = useCallback((service: CustomerDisplayServiceItem) => {
    resetIdleTimer();
    setSelectedService(service);
    setWalkInName('');
    setView('handoff');
  }, [resetIdleTimer]);

  const submitWalkIn = useCallback(async () => {
    if (!selectedService || !walkInName.trim()) return;

    await window.electronAPI.display.checkIn({
      customerName: walkInName.trim(),
      serviceName: selectedService.name,
      isWalkIn: true,
    } as any);

    setView('confirmed');
  }, [selectedService, walkInName]);

  const title = view === 'catalog'
    ? t('priceList.title')
    : view === 'category'
      ? selectedCategory?.name || t('priceList.title')
      : view === 'handoff'
        ? t('checkin.walkIn')
        : t('checkin.confirmed');

  const subtitle = view === 'catalog'
    ? t('priceList.subtitle')
    : view === 'category'
      ? t('priceList.search')
      : view === 'handoff'
        ? selectedService?.name
        : walkInName.trim();
  const formatServiceCount = useCallback(
    (count: number) => t('customer.serviceCount').replace('{count}', String(count)),
    [t],
  );
  const formatStartingPrice = useCallback(
    (amount: number) => t('customer.fromPrice').replace('{price}', formatDisplayCurrency(amount, language)),
    [language, t],
  );

  return (
    <CustomerDisplayShell
      language={language}
      onLanguageChange={onLanguageChange}
      onHome={onHome}
      onBack={
        view === 'confirmed'
          ? undefined
          : view === 'catalog'
            ? onReturnToCheckIn
            : goBackOneLevel
      }
      onInteract={resetIdleTimer}
      salonName={salonName}
      title={title}
      subtitle={subtitle}
    >
      {view === 'catalog' && (
        <div className="flex flex-1">
          <Panel className="w-full p-6 lg:p-8">
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-slate-100 pb-5">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  {t('customer.categories')}
                </div>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <div className="text-5xl font-semibold tracking-tight text-slate-900">
                    {categorySummaries.length}
                  </div>
                  <div className="pb-1 text-lg font-medium text-slate-500">
                    {t('customer.categories')}
                  </div>
                </div>
                <div className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                  {t('priceList.subtitle')}
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {categorySummaries.map((category) => (
                <button
                  key={category.id}
                  onClick={() => startCategory(category.id)}
                  className="rounded-[28px] border border-slate-200 bg-white p-5 text-left shadow-[0_16px_40px_rgba(15,23,42,0.05)] transition-all hover:-translate-y-1 hover:border-brand-200 hover:bg-rose-50/50"
                >
                  <div>
                    <div className="text-lg font-semibold text-slate-900">{category.name}</div>
                    <div className="mt-3 space-y-1 text-sm text-slate-500">
                      <div>{formatServiceCount(category.serviceCount)}</div>
                      <div>{formatStartingPrice(category.startingPrice)}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {view === 'category' && (
        <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Panel className="flex min-h-0 flex-col p-6">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('priceList.search')}
              className="w-full rounded-2xl border border-slate-200 bg-slate-50/80 px-5 py-4 text-lg text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-brand-300 focus:bg-white"
            />

            <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1">
              {visibleServices.length > 0 ? (
                <div className="grid gap-4">
                  {visibleServices.map((service) => (
                    <div
                      key={service.id}
                      className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-[0_16px_40px_rgba(15,23,42,0.05)]"
                    >
                      <div className="flex items-start justify-between gap-5">
                        <div className="min-w-0">
                          <div className="text-xl font-semibold text-slate-900">{service.name}</div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Pill>{formatDisplayCurrency(service.price, language)}</Pill>
                            {service.duration > 0 && (
                              <Pill>{t('customer.duration').replace('{min}', String(service.duration))}</Pill>
                            )}
                          </div>
                        </div>

                        <button
                          onClick={() => startWalkInHandoff(service)}
                          className="rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
                        >
                          {t('checkin.continueAsWalkIn')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title={t('priceList.noResults')} />
              )}
            </div>
          </Panel>

          <Panel className="flex flex-col p-6">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              {selectedCategory?.name}
            </div>
            <div className="mt-2 text-4xl font-semibold tracking-tight text-slate-900">
              {visibleServices.length}
            </div>
            <div className="mt-1 text-sm text-slate-500">{t('wizard.selectServices')}</div>

            <div className="mt-6 space-y-2">
              <DetailRow label={t('priceList.title')} value={selectedCategory?.name || '-'} />
              <DetailRow label={t('customer.categories')} value={String(categorySummaries.length)} />
            </div>
          </Panel>
        </div>
      )}

      {view === 'handoff' && selectedService && (
        <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Panel className="p-6 lg:p-8">
            <div className="max-w-2xl">
              <div className="text-sm font-medium text-slate-500">{t('checkin.walkInName')}</div>
              <input
                value={walkInName}
                onChange={(event) => setWalkInName(event.target.value)}
                placeholder={t('checkin.walkInPlaceholder')}
                className="mt-4 w-full rounded-[24px] border border-slate-200 bg-slate-50/80 px-6 py-5 text-2xl text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-brand-300 focus:bg-white"
              />

              <div className="mt-8 rounded-[28px] border border-slate-200 bg-slate-50/80 p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  {t('wizard.selectServices')}
                </div>
                <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
                  {selectedService.name}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Pill>{formatDisplayCurrency(selectedService.price, language)}</Pill>
                  {selectedService.duration > 0 && (
                    <Pill>{t('customer.duration').replace('{min}', String(selectedService.duration))}</Pill>
                  )}
                </div>
              </div>
            </div>
          </Panel>

          <Panel className="flex flex-col p-6">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              {t('checkin.walkIn')}
            </div>
            <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
              {selectedService.name}
            </div>

            <div className="mt-6 space-y-2">
              <DetailRow label={t('wizard.selectServices')} value={selectedService.name} />
              <DetailRow label={t('checkin.walkInName')} value={walkInName.trim() || '-'} />
            </div>

            <button
              onClick={() => { void submitWalkIn(); }}
              disabled={!walkInName.trim()}
              className="mt-auto rounded-2xl bg-brand-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {t('checkin.checkInButton')}
            </button>
          </Panel>
        </div>
      )}

      {view === 'confirmed' && selectedService && (
        <div className="flex flex-1 items-center justify-center">
          <Panel className="w-full max-w-3xl px-8 py-10 text-center">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-brand-50 text-brand-600">
              <ConfirmedIcon />
            </div>
            <div className="mt-6 text-4xl font-semibold tracking-tight text-slate-900">
              {t('checkin.confirmed')}
            </div>
            <div className="mt-3 text-lg text-slate-500">{t('checkin.pleaseWait')}</div>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              {walkInName.trim() && (
                <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700">
                  {walkInName.trim()}
                </span>
              )}
              <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700">
                {selectedService.name}
              </span>
            </div>
          </Panel>
        </div>
      )}
    </CustomerDisplayShell>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
      {children}
    </span>
  );
}

function ConfirmedIcon() {
  return (
    <svg className="h-9 w-9" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}
