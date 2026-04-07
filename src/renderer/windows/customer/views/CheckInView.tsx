import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Language } from '../../../i18n/translations';
import CustomerDisplayShell from '../components/CustomerDisplayShell';
import CustomerBookingCard from '../components/CustomerBookingCard';
import {
  ActionCard,
  DetailRow,
  EmptyState,
  Panel,
} from '../components/CustomerDisplayPrimitives';
import WalkInServicePicker from '../components/WalkInServicePicker';
import {
  CustomerDisplayBooking,
  CustomerDisplayServiceCategory,
  CustomerDisplayServiceItem,
  filterVisibleBookings,
  formatPhoneDigitsForDisplay,
  formatDisplayCurrency,
  summarizeServiceCategories,
  sanitizePhoneDigits,
} from '../customer-display-model';

interface UpsellItem {
  id: string;
  name: string;
  price: number;
  imageUrl?: string;
  description?: string;
}

type Step = 'hub' | 'booking' | 'phone' | 'walkin' | 'upsell' | 'confirmed';
type WalkInStage = 'identity' | 'service';

interface CheckInPayload {
  bookingId?: number;
  customerName: string;
  customerPhone?: string;
  serviceName?: string;
  staffName?: string;
  bookingTime?: string;
  isWalkIn: boolean;
}

interface CheckInViewProps {
  t: (key: string) => string;
  language: Language;
  salonName?: string;
  categories: CustomerDisplayServiceCategory[];
  upsellItems?: UpsellItem[];
  onBrowseServices: () => void;
  onBack: () => void;
  onLanguageChange: (language: Language) => void;
}

const INTERACTION_TIMEOUT_MS = 30_000;
const CONFIRMATION_TIMEOUT_MS = 8_000;
const UPSELL_TIMEOUT_MS = 15_000;

export default function CheckInView({
  t,
  language,
  salonName,
  categories,
  upsellItems = [],
  onBrowseServices,
  onBack,
  onLanguageChange,
}: CheckInViewProps) {
  const [step, setStep] = useState<Step>('hub');
  const [walkInStage, setWalkInStage] = useState<WalkInStage>('identity');
  const [bookings, setBookings] = useState<CustomerDisplayBooking[]>([]);
  const [bookingQuery, setBookingQuery] = useState('');
  const [bookingLoading, setBookingLoading] = useState(false);
  const [phoneDigits, setPhoneDigits] = useState('');
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [phoneResults, setPhoneResults] = useState<{ customers: any[]; bookings: CustomerDisplayBooking[] } | null>(null);
  const [walkInName, setWalkInName] = useState('');
  const [selectedWalkInService, setSelectedWalkInService] = useState<CustomerDisplayServiceItem | null>(null);
  const [pendingCheckIn, setPendingCheckIn] = useState<CheckInPayload | null>(null);
  const [confirmedCheckIn, setConfirmedCheckIn] = useState<CheckInPayload | null>(null);
  const [selectedUpsells, setSelectedUpsells] = useState<string[]>([]);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const upsellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phoneRequestRef = useRef(0);
  const selectedUpsellsRef = useRef<string[]>([]);

  const categorySummaries = useMemo(
    () => summarizeServiceCategories(categories).slice(0, 4),
    [categories],
  );
  const visibleBookings = useMemo(
    () => filterVisibleBookings(bookings, bookingQuery),
    [bookings, bookingQuery],
  );
  const phoneMatches = useMemo(
    () => filterVisibleBookings(phoneResults?.bookings || [], ''),
    [phoneResults],
  );
  const normalizedPhoneDigits = useMemo(
    () => sanitizePhoneDigits(phoneDigits).slice(0, 9),
    [phoneDigits],
  );
  const formattedPhoneDigits = useMemo(
    () => formatPhoneDigitsForDisplay(normalizedPhoneDigits),
    [normalizedPhoneDigits],
  );
  const formatServiceCount = useCallback(
    (count: number) => t('customer.serviceCount').replace('{count}', String(count)),
    [t],
  );
  const formatStartingPrice = useCallback(
    (amount: number) => t('customer.fromPrice').replace('{price}', formatDisplayCurrency(amount, language)),
    [language, t],
  );

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    window.electronAPI.display?.ping?.();

    if (step === 'confirmed' || step === 'upsell') return;

    idleTimerRef.current = setTimeout(() => {
      onBack();
    }, INTERACTION_TIMEOUT_MS);
  }, [onBack, step]);

  useEffect(() => {
    resetIdleTimer();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [resetIdleTimer]);

  useEffect(() => {
    selectedUpsellsRef.current = selectedUpsells;
  }, [selectedUpsells]);

  useEffect(() => {
    if (step !== 'confirmed') return undefined;

    confirmTimerRef.current = setTimeout(() => {
      onBack();
    }, CONFIRMATION_TIMEOUT_MS);

    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, [onBack, step]);

  const submitCheckIn = useCallback(async (
    payload: CheckInPayload,
    upsells: string[] = [],
  ) => {
    await window.electronAPI.display.checkIn({
      ...payload,
      upsellsAdded: upsells.length ? upsells : undefined,
    } as any);

    setConfirmedCheckIn(payload);
    setPendingCheckIn(null);
    setSelectedUpsells([]);
    setStep('confirmed');
  }, []);

  const finishUpsell = useCallback(async (overrideUpsells?: string[]) => {
    if (!pendingCheckIn) return;

    if (upsellTimerRef.current) clearTimeout(upsellTimerRef.current);
    await submitCheckIn(pendingCheckIn, overrideUpsells ?? selectedUpsellsRef.current);
  }, [pendingCheckIn, submitCheckIn]);

  useEffect(() => {
    if (step !== 'upsell') return undefined;

    upsellTimerRef.current = setTimeout(() => {
      void finishUpsell();
    }, UPSELL_TIMEOUT_MS);

    return () => {
      if (upsellTimerRef.current) clearTimeout(upsellTimerRef.current);
    };
  }, [finishUpsell, step]);

  useEffect(() => {
    if (step !== 'phone') return undefined;

    if (normalizedPhoneDigits.length < 3) {
      setPhoneLoading(false);
      setPhoneResults(null);
      return undefined;
    }

    phoneRequestRef.current += 1;
    const requestId = phoneRequestRef.current;
    setPhoneLoading(true);

    const timer = window.setTimeout(async () => {
      try {
        const results = await window.electronAPI.display.searchByPhone(normalizedPhoneDigits);
        if (phoneRequestRef.current === requestId) {
          setPhoneResults(results as any);
        }
      } catch {
        if (phoneRequestRef.current === requestId) {
          setPhoneResults({ customers: [], bookings: [] });
        }
      } finally {
        if (phoneRequestRef.current === requestId) {
          setPhoneLoading(false);
        }
      }
    }, 180);

    return () => window.clearTimeout(timer);
  }, [normalizedPhoneDigits, step]);

  const startBookingLookup = useCallback(async () => {
    resetIdleTimer();
    setStep('booking');
    setBookingLoading(true);

    try {
      const data = await window.electronAPI.display.getBookings();
      setBookings((data || []) as CustomerDisplayBooking[]);
    } catch {
      setBookings([]);
    } finally {
      setBookingLoading(false);
    }
  }, [resetIdleTimer]);

  const startPhoneLookup = useCallback(() => {
    resetIdleTimer();
    setPhoneDigits('');
    setPhoneResults(null);
    setPhoneLoading(false);
    setStep('phone');
  }, [resetIdleTimer]);

  const startWalkIn = useCallback(() => {
    resetIdleTimer();
    setWalkInStage('identity');
    setWalkInName('');
    setSelectedWalkInService(null);
    setStep('walkin');
  }, [resetIdleTimer]);

  const queueCheckIn = useCallback(async (payload: CheckInPayload) => {
    if (upsellItems.length > 0) {
      setPendingCheckIn(payload);
      setSelectedUpsells([]);
      setStep('upsell');
      return;
    }

    await submitCheckIn(payload);
  }, [submitCheckIn, upsellItems.length]);

  const handleBookingCheckIn = useCallback(async (booking: CustomerDisplayBooking) => {
    await queueCheckIn({
      bookingId: booking.id,
      customerName: booking.customerName,
      serviceName: booking.serviceName,
      staffName: booking.staffName,
      bookingTime: booking.from,
      isWalkIn: false,
    });
  }, [queueCheckIn]);

  const handlePhoneCheckIn = useCallback(async (booking: CustomerDisplayBooking) => {
    await queueCheckIn({
      bookingId: booking.id,
      customerName: booking.customerName,
      customerPhone: normalizedPhoneDigits,
      serviceName: booking.serviceName,
      staffName: booking.staffName,
      bookingTime: booking.from,
      isWalkIn: false,
    });
  }, [normalizedPhoneDigits, queueCheckIn]);

  const handleWalkInSubmit = useCallback(async () => {
    if (!walkInName.trim()) return;
    if (categories.length > 0 && !selectedWalkInService) return;

    await queueCheckIn({
      customerName: walkInName.trim(),
      serviceName: selectedWalkInService?.name,
      isWalkIn: true,
    });
  }, [categories.length, queueCheckIn, selectedWalkInService, walkInName]);

  const toggleUpsell = useCallback((id: string) => {
    resetIdleTimer();

    if (upsellTimerRef.current) clearTimeout(upsellTimerRef.current);
    upsellTimerRef.current = setTimeout(() => {
      void finishUpsell();
    }, UPSELL_TIMEOUT_MS);

    setSelectedUpsells((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );
  }, [finishUpsell, resetIdleTimer]);

  const goBackOneLevel = useCallback(() => {
    resetIdleTimer();

    if (step === 'walkin' && walkInStage === 'service') {
      setWalkInStage('identity');
      return;
    }

    if (step === 'phone') {
      setPhoneDigits('');
      setPhoneResults(null);
    }

    setStep('hub');
  }, [resetIdleTimer, step, walkInStage]);

  const screenTitle = step === 'hub'
    ? t('checkin.welcome')
    : step === 'booking'
      ? t('wizard.selectBooking')
      : step === 'phone'
        ? t('checkin.phoneSearch')
        : step === 'walkin'
          ? walkInStage === 'identity'
            ? t('checkin.walkIn')
            : t('wizard.selectServices')
          : step === 'upsell'
            ? t('checkin.upsellTitle')
            : t('checkin.confirmed');

  const screenSubtitle = step === 'hub'
    ? t('customer.explore')
    : step === 'booking'
      ? t('wizard.searchBooking')
      : step === 'phone'
        ? t('checkinTab.searchPhone')
        : step === 'walkin'
          ? walkInStage === 'identity'
            ? t('checkin.walkInPlaceholder')
            : walkInName.trim()
          : step === 'upsell'
            ? pendingCheckIn?.customerName
            : confirmedCheckIn?.customerName;

  return (
    <CustomerDisplayShell
      language={language}
      onLanguageChange={onLanguageChange}
      onHome={onBack}
      onBack={step === 'hub' || step === 'upsell' || step === 'confirmed' ? undefined : goBackOneLevel}
      onInteract={resetIdleTimer}
      salonName={salonName}
      title={screenTitle}
      subtitle={screenSubtitle}
    >
      {step === 'hub' && (
        <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1.15fr)_380px]">
          <Panel className="p-6 lg:p-8">
            <div className="grid gap-5 md:grid-cols-2">
              <ActionCard
                title={t('checkin.phoneSearch')}
                subtitle={t('checkinTab.searchPhone')}
                accent="brand"
                layout="primary"
                icon={<PhoneActionIcon />}
                onClick={startPhoneLookup}
              />
              <ActionCard
                title={t('checkin.iHaveBooking')}
                subtitle={t('wizard.searchBooking')}
                accent="amber"
                layout="primary"
                icon={<BookingActionIcon />}
                onClick={() => { void startBookingLookup(); }}
              />
              <ActionCard
                title={t('checkin.walkIn')}
                subtitle={t('checkin.walkInPlaceholder')}
                accent="slate"
                icon={<WalkInActionIcon />}
                onClick={startWalkIn}
              />
              <ActionCard
                title={t('checkin.browseServices')}
                subtitle={t('priceList.subtitle')}
                accent="brand"
                icon={<BrowseActionIcon />}
                onClick={onBrowseServices}
              />
            </div>
          </Panel>

          <Panel className="flex flex-col p-6">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                {t('priceList.title')}
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <div className="text-4xl font-semibold tracking-tight text-slate-900">
                  {categorySummaries.length}
                </div>
                <div className="pb-1 text-base font-medium text-slate-500">
                  {t('customer.categories')}
                </div>
              </div>
              <div className="mt-2 text-sm leading-6 text-slate-500">
                {t('priceList.subtitle')}
              </div>
            </div>

            <div className="mt-6 space-y-3">
              {categorySummaries.length > 0 ? categorySummaries.map((category) => (
                <div
                  key={category.id}
                  className="rounded-3xl border border-slate-100 bg-slate-50/80 px-4 py-4"
                >
                  <div>
                    <div>
                      <div className="text-lg font-semibold text-slate-900">{category.name}</div>
                      <div className="mt-3 space-y-1 text-sm text-slate-500">
                        <div>{formatServiceCount(category.serviceCount)}</div>
                        <div>{formatStartingPrice(category.startingPrice)}</div>
                      </div>
                    </div>
                  </div>
                </div>
              )) : (
                <EmptyState title={t('priceList.noServices')} />
              )}
            </div>
          </Panel>
        </div>
      )}

      {step === 'booking' && (
        <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Panel className="flex min-h-0 flex-col p-6">
            <label className="block">
              <span className="sr-only">{t('wizard.searchBooking')}</span>
              <input
                value={bookingQuery}
                onChange={(event) => setBookingQuery(event.target.value)}
                placeholder={t('wizard.searchBooking')}
                className="w-full rounded-2xl border border-slate-200 bg-slate-50/80 px-5 py-4 text-lg text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-brand-300 focus:bg-white"
              />
            </label>

            <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1">
              {bookingLoading ? (
                <div className="grid gap-3">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="h-28 animate-pulse rounded-[28px] bg-white/80" />
                  ))}
                </div>
              ) : visibleBookings.length > 0 ? (
                <div className="grid gap-4">
                  {visibleBookings.map((booking) => (
                    <CustomerBookingCard
                      key={booking.id}
                      booking={booking}
                      language={language}
                      actionLabel={t('checkin.imHere')}
                      onAction={() => { void handleBookingCheckIn(booking); }}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  title={t('checkin.noResults')}
                  action={(
                    <button
                      onClick={startWalkIn}
                      className="rounded-2xl border border-brand-200 bg-brand-50 px-5 py-3 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-100"
                    >
                      {t('wizard.continueWalkIn')}
                    </button>
                  )}
                />
              )}
            </div>
          </Panel>

          <Panel className="p-6">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              {t('wizard.selectBooking')}
            </div>
            <div className="mt-3 text-4xl font-semibold tracking-tight text-slate-900">
              {visibleBookings.length}
            </div>
            <div className="mt-1 text-sm text-slate-500">{t('checkin.iHaveBooking')}</div>

            <div className="mt-6 space-y-2">
              <DetailRow label={t('checkin.phoneSearch')} value={t('checkinTab.searchPhone')} />
              <DetailRow label={t('checkin.walkIn')} value={t('wizard.continueWalkIn')} />
            </div>

            <button
              onClick={startWalkIn}
              className="mt-8 w-full rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition-colors hover:border-brand-200 hover:text-brand-700"
            >
              {t('wizard.continueWalkIn')}
            </button>
          </Panel>
        </div>
      )}

      {step === 'phone' && (
        <div className="grid flex-1 gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
          <Panel className="p-6">
            <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 px-5 py-5 text-center">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                {t('checkin.phoneSearch')}
              </div>
              <div
                className={`mt-3 text-3xl font-semibold tracking-[0.18em] ${
                  normalizedPhoneDigits ? 'text-slate-900' : 'text-slate-300'
                }`}
              >
                {formattedPhoneDigits || '123 456 789'}
              </div>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-3">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((key) => {
                if (!key) return <div key="empty" />;

                if (key === 'del') {
                  return (
                    <button
                      key={key}
                      onClick={() => setPhoneDigits((current) => current.slice(0, -1))}
                      className="rounded-3xl border border-slate-200 bg-white py-5 text-lg font-semibold text-slate-700 transition-colors hover:border-brand-200 hover:text-brand-700"
                    >
                      Del
                    </button>
                  );
                }

                return (
                  <button
                    key={key}
                    onClick={() => setPhoneDigits((current) => `${sanitizePhoneDigits(current)}${key}`.slice(0, 9))}
                    className="rounded-3xl border border-slate-200 bg-white py-5 text-2xl font-semibold text-slate-900 transition-colors hover:border-brand-200 hover:bg-brand-50"
                  >
                    {key}
                  </button>
                );
              })}
            </div>

            <button
              onClick={startWalkIn}
              className="mt-5 w-full rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3 text-sm font-semibold text-slate-600 transition-colors hover:border-brand-200 hover:text-brand-700"
            >
              {t('checkin.continueAsWalkIn')}
            </button>
          </Panel>

          <Panel className="flex min-h-0 flex-col p-6">
            <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  {t('checkin.phoneSearch')}
                </div>
                <div className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
                  {normalizedPhoneDigits.length >= 3 ? phoneMatches.length : 0}
                </div>
              </div>
              {phoneLoading && (
                <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {t('pos.loading')}
                </div>
              )}
            </div>

            <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1">
              {normalizedPhoneDigits.length < 3 ? (
                <EmptyState title={t('checkin.phonePlaceholder')} />
              ) : phoneMatches.length > 0 ? (
                <div className="grid gap-4">
                  {phoneMatches.map((booking) => (
                    <CustomerBookingCard
                      key={booking.id}
                      booking={booking}
                      language={language}
                      actionLabel={t('checkin.imHere')}
                      onAction={() => { void handlePhoneCheckIn(booking); }}
                    />
                  ))}
                </div>
              ) : !phoneLoading ? (
                <EmptyState
                  title={t('checkin.noPhoneMatch')}
                  action={(
                    <button
                      onClick={startWalkIn}
                      className="rounded-2xl border border-brand-200 bg-brand-50 px-5 py-3 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-100"
                    >
                      {t('checkin.continueAsWalkIn')}
                    </button>
                  )}
                />
              ) : null}
            </div>
          </Panel>
        </div>
      )}

      {step === 'walkin' && walkInStage === 'identity' && (
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

              <button
                onClick={() => setWalkInStage('service')}
                disabled={!walkInName.trim()}
                className="mt-6 inline-flex rounded-2xl bg-brand-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {t('wizard.continue')}
              </button>
            </div>
          </Panel>

          <Panel className="p-6">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              {t('priceList.title')}
            </div>
            <div className="mt-4 space-y-3">
              {categorySummaries.map((category) => (
                <div key={category.id} className="rounded-3xl border border-slate-100 bg-slate-50/80 px-4 py-4">
                  <div className="text-lg font-semibold text-slate-900">{category.name}</div>
                  <div className="mt-3 space-y-1 text-sm text-slate-500">
                    <div>{formatServiceCount(category.serviceCount)}</div>
                    <div>{formatStartingPrice(category.startingPrice)}</div>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {step === 'walkin' && walkInStage === 'service' && (
        <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-h-0">
            <WalkInServicePicker
              categories={categories}
              language={language}
              t={t}
              selectedServiceId={selectedWalkInService?.id}
              onSelectService={setSelectedWalkInService}
            />
          </div>

          <Panel className="flex flex-col p-6">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              {t('checkin.walkIn')}
            </div>
            <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
              {walkInName}
            </div>

            <div className="mt-6 space-y-2">
              <DetailRow label={t('checkin.walkIn')} value={walkInName} />
              {selectedWalkInService && (
                <DetailRow
                  label={t('wizard.selectServices')}
                  value={selectedWalkInService.name}
                />
              )}
            </div>

            <button
              onClick={() => { void handleWalkInSubmit(); }}
              disabled={categories.length > 0 && !selectedWalkInService}
              className="mt-auto rounded-2xl bg-brand-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {t('checkin.checkInButton')}
            </button>
          </Panel>
        </div>
      )}

      {step === 'upsell' && pendingCheckIn && (
        <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Panel className="min-h-0 p-6">
            <div className="grid gap-4 md:grid-cols-2">
              {upsellItems.map((item) => {
                const active = selectedUpsells.includes(item.id);

                return (
                  <button
                    key={item.id}
                    onClick={() => toggleUpsell(item.id)}
                    className={`rounded-[28px] border p-5 text-left transition-all ${
                      active
                        ? 'border-brand-300 bg-brand-50 shadow-sm'
                        : 'border-slate-200 bg-white hover:border-brand-200 hover:bg-rose-50/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-lg font-semibold text-slate-900">{item.name}</div>
                        {item.description && (
                          <div className="mt-2 text-sm leading-6 text-slate-500">{item.description}</div>
                        )}
                      </div>
                      <div className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${
                        active ? 'bg-white text-brand-700' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {active ? t('checkin.upsellAdded') : formatDisplayCurrency(item.price, language)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel className="flex flex-col p-6">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              {t('checkin.confirmed')}
            </div>
            <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
              {pendingCheckIn.customerName}
            </div>

            <div className="mt-6 space-y-2">
              {pendingCheckIn.serviceName && (
                <DetailRow label={t('wizard.selectServices')} value={pendingCheckIn.serviceName} />
              )}
              <DetailRow label={t('checkin.upsellTitle')} value={String(selectedUpsells.length)} />
            </div>

            <div className="mt-auto space-y-3">
              <button
                onClick={() => { void finishUpsell(); }}
                className="w-full rounded-2xl bg-brand-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-brand-700"
              >
                {t('checkin.checkInButton')}
              </button>
              <button
                onClick={() => {
                  setSelectedUpsells([]);
                  void finishUpsell([]);
                }}
                className="w-full rounded-2xl border border-slate-200 bg-white px-6 py-3 text-base font-semibold text-slate-700 transition-colors hover:border-brand-200 hover:text-brand-700"
              >
                {t('checkin.upsellSkip')}
              </button>
            </div>
          </Panel>
        </div>
      )}

      {step === 'confirmed' && confirmedCheckIn && (
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
              <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700">
                {confirmedCheckIn.customerName}
              </span>
              {confirmedCheckIn.serviceName && (
                <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700">
                  {confirmedCheckIn.serviceName}
                </span>
              )}
              {confirmedCheckIn.staffName && (
                <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700">
                  {t('checkin.withStaff').replace('{name}', confirmedCheckIn.staffName)}
                </span>
              )}
            </div>
          </Panel>
        </div>
      )}
    </CustomerDisplayShell>
  );
}

function PhoneActionIcon() {
  return (
    <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.5 3.5h11a2 2 0 012 2v13a2 2 0 01-2 2h-11a2 2 0 01-2-2v-13a2 2 0 012-2z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.5h6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M11 17.5h2" />
    </svg>
  );
}

function BookingActionIcon() {
  return (
    <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3v3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 3v3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 5h12a2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2z" />
    </svg>
  );
}

function WalkInActionIcon() {
  return (
    <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="12" cy="6" r="3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 21l1.5-5 2.5-2.5 1.5 1.5L13 17.5 14 21" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 11.5l2-2 3 1 2.5-1" />
    </svg>
  );
}

function BrowseActionIcon() {
  return (
    <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6.5h16" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 12h10" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 17.5h8" />
      <circle cx="18" cy="17.5" r="2.5" />
    </svg>
  );
}

function ConfirmedIcon() {
  return (
    <svg className="h-9 w-9" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}
