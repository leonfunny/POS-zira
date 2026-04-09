import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Language } from '../../../i18n/translations';
import TouchKeyboard from '../../../components/shared/TouchKeyboard';
import CustomerDisplayShell from '../components/CustomerDisplayShell';
import { DetailRow, EmptyState, Panel } from '../components/CustomerDisplayPrimitives';
import {
  CustomerDisplayServiceCategory,
  CustomerDisplayServiceItem,
  formatDisplayCurrency,
  summarizeServiceCategories,
} from '../customer-display-model';
import {
  getCustomerTouchKeyboardInset,
  shouldDismissCustomerTouchKeyboard,
} from '../customer-touch-keyboard';

type BrowseView = 'catalog' | 'category' | 'handoff' | 'confirmed';
type InteractiveTouchKeyboardTarget = 'browseSearch' | 'browseWalkInName' | null;

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

function getAutoOpenInteractiveKeyboardTarget(view: BrowseView): InteractiveTouchKeyboardTarget {
  if (view === 'handoff') return 'browseWalkInName';
  return null;
}

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
  const [selectedServices, setSelectedServices] = useState<CustomerDisplayServiceItem[]>([]);
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const [keyboardTarget, setKeyboardTarget] = useState<InteractiveTouchKeyboardTarget>(null);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const walkInNameRef = useRef<HTMLInputElement | null>(null);

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
  const selectedServicesLabel = useMemo(() => {
    const names = selectedServices
      .map((service) => service.name.trim())
      .filter((name) => name.length > 0);
    return names.length > 0 ? names.join(', ') : '';
  }, [selectedServices]);
  const selectedServicesTotal = useMemo(
    () => selectedServices.reduce((total, service) => total + service.price, 0),
    [selectedServices],
  );
  const selectedServicesDuration = useMemo(
    () => selectedServices.reduce((total, service) => total + service.duration, 0),
    [selectedServices],
  );
  const keyboardInset = getCustomerTouchKeyboardInset(keyboardTarget);

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

  useEffect(() => {
    const nextKeyboardTarget = getAutoOpenInteractiveKeyboardTarget(view);
    setKeyboardTarget(nextKeyboardTarget);

    if (!nextKeyboardTarget) return undefined;

    const nextInput = nextKeyboardTarget === 'browseSearch'
      ? searchInputRef.current
      : walkInNameRef.current;
    const timer = window.setTimeout(() => {
      nextInput?.focus();
    }, 120);

    return () => window.clearTimeout(timer);
  }, [view]);

  const dismissTouchKeyboard = useCallback(() => {
    setKeyboardTarget(null);
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);

  const handleCustomerDisplayPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    resetIdleTimer();
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (
      categoryMenuOpen
      && !target.closest('[data-customer-display-category-menu="true"]')
      && !target.closest('[data-customer-display-category-trigger="true"]')
    ) {
      setCategoryMenuOpen(false);
    }

    if (keyboardTarget && shouldDismissCustomerTouchKeyboard(target)) {
      dismissTouchKeyboard();
    }
  }, [categoryMenuOpen, dismissTouchKeyboard, keyboardTarget, resetIdleTimer]);

  const handleTouchKeyboardKey = useCallback((key: string) => {
    resetIdleTimer();

    if (keyboardTarget === 'browseSearch') {
      setSearchQuery((current) => `${current}${key}`);
      return;
    }

    if (keyboardTarget === 'browseWalkInName') {
      setWalkInName((current) => `${current}${key}`);
    }
  }, [keyboardTarget, resetIdleTimer]);

  const handleTouchKeyboardBackspace = useCallback(() => {
    resetIdleTimer();

    if (keyboardTarget === 'browseSearch') {
      setSearchQuery((current) => current.slice(0, -1));
      return;
    }

    if (keyboardTarget === 'browseWalkInName') {
      setWalkInName((current) => current.slice(0, -1));
    }
  }, [keyboardTarget, resetIdleTimer]);

  const handleTouchKeyboardDone = useCallback(() => {
    resetIdleTimer();
    dismissTouchKeyboard();
  }, [dismissTouchKeyboard, resetIdleTimer]);

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
    setCategoryMenuOpen(false);
    setView('category');
  }, [resetIdleTimer]);

  const selectBrowseCategory = useCallback((categoryId: string) => {
    resetIdleTimer();
    setSelectedCategoryId(categoryId);
    setSearchQuery('');
    setCategoryMenuOpen(false);
  }, [resetIdleTimer]);

  const toggleCategoryMenu = useCallback(() => {
    resetIdleTimer();
    if (keyboardTarget) {
      dismissTouchKeyboard();
    }
    setCategoryMenuOpen((current) => !current);
  }, [dismissTouchKeyboard, keyboardTarget, resetIdleTimer]);

  const toggleSelectedService = useCallback((service: CustomerDisplayServiceItem) => {
    resetIdleTimer();
    setSelectedServices((current) => {
      const alreadySelected = current.some((entry) => entry.id === service.id);
      if (alreadySelected) {
        return current.filter((entry) => entry.id !== service.id);
      }

      return [...current, service];
    });
  }, [resetIdleTimer]);

  const removeSelectedService = useCallback((serviceId: string) => {
    resetIdleTimer();
    if (selectedServices.length === 1) {
      setSelectedServices([]);
      setView('category');
      return;
    }

    setSelectedServices((current) => current.filter((service) => service.id !== serviceId));
  }, [resetIdleTimer, selectedServices.length]);

  const continueToWalkInHandoff = useCallback(() => {
    if (selectedServices.length === 0) return;
    resetIdleTimer();
    setView('handoff');
  }, [resetIdleTimer, selectedServices.length]);

  const submitWalkIn = useCallback(async () => {
    if (selectedServices.length === 0 || !walkInName.trim()) return;

    await window.electronAPI.display.checkIn({
      customerName: walkInName.trim(),
      serviceName: selectedServicesLabel || undefined,
      services: selectedServices,
      isWalkIn: true,
    } as any);

    setView('confirmed');
  }, [selectedServices, selectedServicesLabel, walkInName]);

  const formatServiceCount = useCallback(
    (count: number) => t('customer.serviceCount').replace('{count}', String(count)),
    [t],
  );
  const formatStartingPrice = useCallback(
    (amount: number) => t('customer.fromPrice').replace('{price}', formatDisplayCurrency(amount, language)),
    [language, t],
  );
  const formatApproximateTime = useCallback(
    (minutes: number) => `~${t('customer.duration').replace('{min}', String(minutes))}`,
    [t],
  );
  const approximateTimeValue = selectedServicesDuration > 0
    ? formatApproximateTime(selectedServicesDuration)
    : '-';
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
        ? formatServiceCount(selectedServices.length)
        : walkInName.trim();

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
      <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden" onPointerDown={handleCustomerDisplayPointerDown}>
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          style={{
            paddingBottom: keyboardInset > 0 ? `${keyboardInset}px` : undefined,
            transition: 'padding-bottom 0.3s ease',
          }}
        >
          {view === 'catalog' && (
            <div className="flex min-h-0 flex-1">
              <Panel className="w-full overflow-y-auto p-6 lg:p-8">
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
            <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <Panel className="flex min-h-0 flex-col p-6">
                <div
                  className="relative flex items-center gap-3"
                  data-customer-display-category-toolbar="true"
                >
                  <div className="relative w-[220px] shrink-0">
                    <button
                      type="button"
                      onClick={toggleCategoryMenu}
                      data-customer-display-category-trigger="true"
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
                        data-customer-display-category-menu="true"
                      >
                        <div className="space-y-1">
                          {categorySummaries.map((category) => {
                            const active = category.id === selectedCategory?.id;

                            return (
                              <button
                                key={category.id}
                                type="button"
                                onClick={() => selectBrowseCategory(category.id)}
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
                                  {category.serviceCount}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  <input
                    ref={searchInputRef}
                    value={searchQuery}
                    readOnly
                    onFocus={() => {
                      setCategoryMenuOpen(false);
                      setKeyboardTarget('browseSearch');
                    }}
                    onPointerDown={() => {
                      setCategoryMenuOpen(false);
                      setKeyboardTarget('browseSearch');
                    }}
                    data-customer-display-text-input="true"
                    placeholder={t('priceList.search')}
                    className="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50/80 px-4 text-base text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-brand-300 focus:bg-white"
                  />
                </div>

                <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1">
                  {visibleServices.length > 0 ? (
                    <div className="grid gap-4">
                      {visibleServices.map((service) => {
                        const active = selectedServices.some((entry) => entry.id === service.id);

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
                                  <Pill>{formatDisplayCurrency(service.price, language)}</Pill>
                                  {service.duration > 0 && (
                                    <Pill>{t('customer.duration').replace('{min}', String(service.duration))}</Pill>
                                  )}
                                </div>
                              </div>

                              <button
                                onClick={() => toggleSelectedService(service)}
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

              <Panel className="flex min-h-0 flex-col overflow-hidden p-6">
                <div
                  className="min-h-0 flex-1 overflow-y-auto pr-1"
                  data-customer-display-basket-summary-scroll="true"
                >
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {selectedCategory?.name}
                  </div>
                  <div className="mt-2 text-4xl font-semibold tracking-tight text-slate-900">
                    {selectedServices.length}
                  </div>
                  <div className="mt-1 text-sm text-slate-500">{t('customer.selectedServices')}</div>

                  <div className="mt-6 space-y-2">
                    <DetailRow label={t('priceList.title')} value={selectedCategory?.name || '-'} />
                    <DetailRow label={t('customer.categories')} value={String(categorySummaries.length)} />
                  </div>

                  <div className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {t('customer.selectedServices')}
                  </div>

                  <div className="mt-4">
                    {selectedServices.length > 0 ? (
                      <div className="space-y-2">
                        {selectedServices.map((service) => (
                          <div
                            key={service.id}
                            className="flex items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-slate-50/80 px-4 py-3"
                          >
                            <div className="min-w-0 text-sm font-medium text-slate-900">{service.name}</div>
                            <div className="shrink-0 text-sm font-semibold text-slate-600">
                              {formatDisplayCurrency(service.price, language)}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyState title={t('wizard.selectServices')} />
                    )}
                  </div>
                </div>

                <div className="mt-4 shrink-0 border-t border-slate-100 pt-4">
                  <DetailRow
                    label={t('wizard.total')}
                    value={formatDisplayCurrency(selectedServicesTotal, language)}
                  />
                </div>

                <button
                  onClick={continueToWalkInHandoff}
                  disabled={selectedServices.length === 0}
                  className="mt-6 shrink-0 rounded-2xl bg-brand-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {t('checkin.continueAsWalkIn')}
                </button>
              </Panel>
            </div>
          )}

          {view === 'handoff' && selectedServices.length > 0 && (
            <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <Panel className="flex min-h-0 flex-col p-6 lg:p-8">
                <div className="flex min-h-0 max-w-2xl flex-1 flex-col">
                  <div className="text-sm font-medium text-slate-500">{t('checkin.walkInName')}</div>
                  <input
                    ref={walkInNameRef}
                    value={walkInName}
                    readOnly
                    onFocus={() => setKeyboardTarget('browseWalkInName')}
                    onPointerDown={() => setKeyboardTarget('browseWalkInName')}
                    data-customer-display-text-input="true"
                    placeholder={t('checkin.walkInPlaceholder')}
                    className="mt-4 w-full rounded-[24px] border border-slate-200 bg-slate-50/80 px-6 py-5 text-2xl text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-brand-300 focus:bg-white"
                  />

                  <div className="mt-8 flex min-h-0 flex-1 flex-col rounded-[28px] border border-slate-200 bg-slate-50/80 p-5">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t('customer.selectedServices')}
                    </div>

                    <div
                      className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1"
                      data-customer-display-selected-services-scroll="true"
                    >
                      {selectedServices.map((service) => (
                        <div
                          key={service.id}
                          className="flex items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-white px-4 py-3"
                        >
                          <div className="min-w-0 text-base font-semibold tracking-tight text-slate-900">
                            {service.name}
                          </div>
                          <div className="flex shrink-0 items-center gap-3">
                            <div className="text-sm font-semibold text-slate-600">
                              {formatDisplayCurrency(service.price, language)}
                            </div>
                            <button
                              type="button"
                              onClick={() => removeSelectedService(service.id)}
                              aria-label={t('common.remove')}
                              data-customer-display-selected-service-remove="true"
                              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-500 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
                            >
                              <RemoveIcon />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-4 border-t border-slate-100 pt-4">
                      <DetailRow
                        label={t('wizard.total')}
                        value={formatDisplayCurrency(selectedServicesTotal, language)}
                      />
                    </div>
                  </div>
                </div>
              </Panel>

              <Panel className="flex min-h-0 flex-col p-6" data-customer-display-handoff-summary="true">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  {t('checkin.walkIn')}
                </div>
                <div className="mt-2 text-4xl font-semibold tracking-tight text-slate-900">
                  {selectedServices.length}
                </div>
                <div className="mt-1 text-sm text-slate-500">{t('customer.selectedServices')}</div>

                <div className="mt-6 space-y-2">
                  <DetailRow label={t('customer.selectedServices')} value={formatServiceCount(selectedServices.length)} />
                  <DetailRow label={t('checkin.walkInName')} value={walkInName.trim() || '-'} />
                  <DetailRow
                    label={t('wizard.total')}
                    value={formatDisplayCurrency(selectedServicesTotal, language)}
                  />
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

          {view === 'confirmed' && selectedServices.length > 0 && (
            <div className="min-h-0 flex-1">
              <Panel className="h-full w-full overflow-hidden p-0">
                <div className="grid h-full min-h-0 lg:grid-cols-[minmax(0,1.35fr)_340px]">
                  <div
                    className="relative overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(253,230,230,0.9),_transparent_42%),linear-gradient(135deg,rgba(255,250,250,0.96),rgba(255,247,239,0.94)_56%,rgba(255,244,210,0.9))] p-8 lg:p-10"
                    data-customer-display-confirmed-receipt="true"
                  >
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/55 to-transparent" />
                    <div className="relative flex h-full min-h-0 flex-col">
                      <div className="inline-flex items-center gap-3 self-start rounded-full border border-white/80 bg-white/76 px-4 py-2 shadow-sm">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-b from-rose-50 to-orange-50 text-brand-600">
                          <ConfirmedIcon />
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-brand-500">
                            {t('checkin.confirmed')}
                          </div>
                          <div className="text-sm font-medium text-slate-500">
                            {t('checkin.pleaseWait')}
                          </div>
                        </div>
                      </div>

                      <div className="mt-8">
                        <div className="text-5xl font-semibold tracking-tight text-slate-900">
                          {walkInName.trim() || t('checkin.walkIn')}
                        </div>
                        <div className="mt-3 max-w-2xl text-lg leading-7 text-slate-500">
                          Your request has been received. The front desk can now see your selected services and total.
                        </div>
                      </div>

                      <div className="mt-8 grid gap-3 sm:grid-cols-3">
                        <ReceiptMetric
                          label={t('customer.selectedServices')}
                          value={String(selectedServices.length)}
                        />
                        <ReceiptMetric
                          label={t('wizard.total')}
                          value={formatDisplayCurrency(selectedServicesTotal, language)}
                        />
                        <ReceiptMetric
                          label={t('customer.approxTime')}
                          value={approximateTimeValue}
                        />
                      </div>

                      <div className="mt-8 flex min-h-0 flex-1 flex-col rounded-[30px] border border-white/85 bg-white/72 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.05)] backdrop-blur-sm">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                              {t('customer.selectedServices')}
                            </div>
                            <div className="mt-2 text-sm text-slate-500">
                              Review of the services included in this walk-in.
                            </div>
                          </div>
                        </div>

                        <div
                          className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1"
                          data-customer-display-confirmed-services-scroll="true"
                        >
                          <div className="space-y-2">
                            {selectedServices.map((service) => (
                              <div
                                key={service.id}
                                className="flex items-center justify-between gap-4 rounded-2xl border border-slate-100 bg-white/88 px-4 py-3"
                              >
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-slate-900">{service.name}</div>
                                  {service.duration > 0 && (
                                    <div className="mt-1 text-xs font-medium text-slate-500">
                                      {t('customer.duration').replace('{min}', String(service.duration))}
                                    </div>
                                  )}
                                </div>
                                <div className="shrink-0 text-sm font-semibold text-slate-600">
                                  {formatDisplayCurrency(service.price, language)}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="mt-5 border-t border-slate-100 pt-4">
                          <div className="space-y-2">
                            <DetailRow
                              label={t('wizard.total')}
                              value={formatDisplayCurrency(selectedServicesTotal, language)}
                            />
                            <DetailRow
                              label={t('customer.approxTime')}
                              value={approximateTimeValue}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div
                    className="flex flex-col justify-between border-l border-white/70 bg-white/72 p-6 lg:p-8"
                    data-customer-display-confirmed-metrics="true"
                  >
                    <div>
                      <div className="flex h-20 w-20 items-center justify-center rounded-[28px] bg-gradient-to-br from-rose-50 via-white to-amber-50 text-brand-600 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
                        <ConfirmedIcon />
                      </div>
                      <div className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                        Walk-in receipt
                      </div>
                      <div className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">
                        {t('checkin.confirmed')}
                      </div>
                      <div className="mt-3 text-sm leading-6 text-slate-500">
                        Please stay nearby. Staff will call you when your station is ready.
                      </div>
                    </div>

                    <div className="mt-8 space-y-4">
                      <StatusCard
                        title={t('customer.selectedServices')}
                        value={formatServiceCount(selectedServices.length)}
                      />
                      <StatusCard
                        title={t('customer.approxTime')}
                        value={approximateTimeValue}
                      />
                      <StatusCard
                        title={t('wizard.total')}
                        value={formatDisplayCurrency(selectedServicesTotal, language)}
                      />
                    </div>

                    <div className="mt-8 rounded-[24px] border border-amber-100 bg-gradient-to-br from-amber-50/90 to-white px-5 py-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                        Next step
                      </div>
                      <div className="mt-2 text-sm leading-6 text-slate-600">
                        Relax in the waiting area. Your service list and request total have already been sent.
                      </div>
                    </div>
                  </div>
                </div>
              </Panel>
            </div>
          )}
        </div>

        <div className="absolute bottom-0 left-0 right-0 z-20" data-customer-display-touch-keyboard="true">
          <TouchKeyboard
            visible={keyboardTarget !== null}
            mode="alpha"
            onKey={handleTouchKeyboardKey}
            onBackspace={handleTouchKeyboardBackspace}
            onDone={handleTouchKeyboardDone}
          />
        </div>
      </div>
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

function RemoveIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M18 6L6 18" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ReceiptMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[24px] border border-white/80 bg-white/78 px-5 py-4 shadow-[0_12px_32px_rgba(15,23,42,0.04)]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{label}</div>
      <div className="mt-2 text-xl font-semibold tracking-tight text-slate-900">{value}</div>
    </div>
  );
}

function StatusCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-[24px] border border-slate-100 bg-white/82 px-5 py-4 shadow-[0_12px_32px_rgba(15,23,42,0.04)]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{title}</div>
      <div className="mt-2 text-lg font-semibold text-slate-900">{value}</div>
    </div>
  );
}
