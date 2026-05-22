import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Language } from '../../../i18n/translations';
import TouchKeyboard from '../../../components/shared/TouchKeyboard';
import CustomerDisplayShell from '../components/CustomerDisplayShell';
import CustomerBookingCard from '../components/CustomerBookingCard';
import {
  ActionCard,
  DetailRow,
  EmptyState,
  Panel,
} from '../components/CustomerDisplayPrimitives';
import WalkInServicePicker from '../components/WalkInServicePicker';
import ConfirmedReceiptView from '../components/ConfirmedReceiptView';
import {
  CustomerDisplayBooking,
  CustomerDisplayServiceCategory,
  CustomerDisplayServiceItem,
  filterVisibleBookings,
  formatPhoneDigitsForDisplay,
  formatDisplayCurrency,
  formatDisplayTime,
  summarizeServiceCategories,
  sanitizePhoneDigits,
} from '../customer-display-model';
import {
  getCustomerTouchKeyboardInset as getSharedCustomerTouchKeyboardInset,
  shouldDismissCustomerTouchKeyboard as shouldDismissSharedCustomerTouchKeyboard,
} from '../customer-touch-keyboard';

interface UpsellItem {
  id: string;
  name: string;
  price: number;
  imageUrl?: string;
  description?: string;
}

type Step = 'hub' | 'booking' | 'phone' | 'walkin' | 'upsell' | 'confirmed';
type WalkInStage = 'identity' | 'service' | 'review';
export type CustomerTouchKeyboardTarget = 'bookingSearch' | 'walkInName' | 'walkInServiceSearch' | null;

interface CheckInPayload {
  bookingId?: number;
  customerName: string;
  customerPhone?: string;
  serviceName?: string;
  serviceLabel?: string;
  services?: CustomerDisplayServiceItem[];
  staffName?: string;
  bookingTime?: string;
  totalPrice?: number;
  approxDurationMinutes?: number;
  isWalkIn: boolean;
}

interface CheckInViewProps {
  t: (key: string) => string;
  language: Language;
  salonName?: string;
  categories: CustomerDisplayServiceCategory[];
  upsellItems?: UpsellItem[];
  onBrowseServices: (categoryId?: string) => void;
  onBack: () => void;
  onLanguageChange: (language: Language) => void;
}

const INTERACTION_TIMEOUT_MS = 90_000;
const CONFIRMATION_TIMEOUT_MS = 8_000;
const UPSELL_TIMEOUT_MS = 15_000;
export function getAutoOpenCustomerKeyboardTarget(
  step: Step,
  walkInStage: WalkInStage,
): CustomerTouchKeyboardTarget {
  if (step === 'booking') return 'bookingSearch';
  if (step === 'walkin' && walkInStage === 'identity') return 'walkInName';
  return null;
}

export function shouldDismissCustomerTouchKeyboard(target: Element | null): boolean {
  return shouldDismissSharedCustomerTouchKeyboard(target);
}

export function getCustomerTouchKeyboardInset(target: CustomerTouchKeyboardTarget): number {
  return getSharedCustomerTouchKeyboardInset(target);
}

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
  const [selectedWalkInServices, setSelectedWalkInServices] = useState<CustomerDisplayServiceItem[]>([]);
  const [walkInSelectedCategoryId, setWalkInSelectedCategoryId] = useState(categories[0]?.id || '');
  const [walkInServiceSearchQuery, setWalkInServiceSearchQuery] = useState('');
  const [walkInCategoryMenuOpen, setWalkInCategoryMenuOpen] = useState(false);
  const [selectedBookingId, setSelectedBookingId] = useState<number | null>(null);
  const [selectedPhoneBookingId, setSelectedPhoneBookingId] = useState<number | null>(null);
  const [pendingCheckIn, setPendingCheckIn] = useState<CheckInPayload | null>(null);
  const [confirmedCheckIn, setConfirmedCheckIn] = useState<CheckInPayload | null>(null);
  const [selectedUpsells, setSelectedUpsells] = useState<string[]>([]);
  const [checkInError, setCheckInError] = useState<string | null>(null);
  const [hubActionsHeight, setHubActionsHeight] = useState<number | null>(null);
  const [keyboardTarget, setKeyboardTarget] = useState<CustomerTouchKeyboardTarget>(null);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const upsellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phoneRequestRef = useRef(0);
  const selectedUpsellsRef = useRef<string[]>([]);
  const hubActionsRef = useRef<HTMLDivElement | null>(null);
  const bookingQueryRef = useRef<HTMLInputElement | null>(null);
  const walkInNameRef = useRef<HTMLInputElement | null>(null);

  const categorySummaries = useMemo(
    () => summarizeServiceCategories(categories),
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
  const selectedBooking = useMemo(
    () => visibleBookings.find((booking) => booking.id === selectedBookingId) || null,
    [selectedBookingId, visibleBookings],
  );
  const selectedPhoneBooking = useMemo(
    () => phoneMatches.find((booking) => booking.id === selectedPhoneBookingId) || null,
    [phoneMatches, selectedPhoneBookingId],
  );
  const selectedWalkInServiceIds = useMemo(
    () => selectedWalkInServices.map((service) => service.id),
    [selectedWalkInServices],
  );
  const selectedWalkInServiceLabel = useMemo(
    () => selectedWalkInServices.map((service) => service.name.trim()).filter(Boolean).join(', '),
    [selectedWalkInServices],
  );
  const selectedWalkInTotalPrice = useMemo(
    () => selectedWalkInServices.reduce((total, service) => total + service.price, 0),
    [selectedWalkInServices],
  );
  const selectedWalkInDuration = useMemo(
    () => selectedWalkInServices.reduce((total, service) => total + service.duration, 0),
    [selectedWalkInServices],
  );
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

  useEffect(() => {
    if (step !== 'hub') {
      setHubActionsHeight(null);
      return undefined;
    }

    const element = hubActionsRef.current;
    if (!element) return undefined;

    const syncHeight = () => {
      const nextHeight = Math.ceil(element.getBoundingClientRect().height);
      setHubActionsHeight((current) => (current === nextHeight ? current : nextHeight));
    };

    syncHeight();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncHeight);
      return () => window.removeEventListener('resize', syncHeight);
    }

    const observer = new ResizeObserver(() => {
      syncHeight();
    });

    observer.observe(element);
    window.addEventListener('resize', syncHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncHeight);
    };
  }, [step]);

  useEffect(() => {
    if (!walkInSelectedCategoryId && categories[0]?.id) {
      setWalkInSelectedCategoryId(categories[0].id);
      return;
    }

    if (walkInSelectedCategoryId && !categories.some((category) => category.id === walkInSelectedCategoryId)) {
      setWalkInSelectedCategoryId(categories[0]?.id || '');
    }
  }, [categories, walkInSelectedCategoryId]);

  useEffect(() => {
    const nextKeyboardTarget = getAutoOpenCustomerKeyboardTarget(step, walkInStage);
    setKeyboardTarget(nextKeyboardTarget);

    if (!nextKeyboardTarget) return undefined;

    const nextInput = nextKeyboardTarget === 'bookingSearch'
      ? bookingQueryRef.current
      : walkInNameRef.current;
    const timer = window.setTimeout(() => {
      nextInput?.focus();
    }, 120);

    return () => window.clearTimeout(timer);
  }, [step, walkInStage]);

  const submitCheckIn = useCallback(async (
    payload: CheckInPayload,
    upsells: string[] = [],
  ) => {
    setCheckInError(null);
    try {
      const result = await window.electronAPI.display.checkIn({
        ...payload,
        upsellsAdded: upsells.length ? upsells : undefined,
      } as any);

      if (!result?.success) {
        setCheckInError(result?.error || t('customer.checkInFailed'));
        return;
      }
    } catch (error: any) {
      setCheckInError(error?.message || t('customer.checkInFailed'));
      return;
    }

    setConfirmedCheckIn(payload);
    setPendingCheckIn(null);
    setSelectedUpsells([]);
    setStep('confirmed');
  }, [t]);

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

  useEffect(() => {
    if (step !== 'booking') return;

    if (!visibleBookings.length) {
      setSelectedBookingId(null);
      return;
    }

    setSelectedBookingId((current) =>
      visibleBookings.some((booking) => booking.id === current)
        ? current
        : visibleBookings[0].id,
    );
  }, [step, visibleBookings]);

  useEffect(() => {
    if (step !== 'phone') return;

    if (!phoneMatches.length) {
      setSelectedPhoneBookingId(null);
      return;
    }

    setSelectedPhoneBookingId((current) =>
      phoneMatches.some((booking) => booking.id === current)
        ? current
        : phoneMatches[0].id,
    );
  }, [phoneMatches, step]);

  const startBookingLookup = useCallback(async () => {
    resetIdleTimer();
    setCheckInError(null);
    setStep('booking');
    setBookingLoading(true);
    setSelectedBookingId(null);

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
    setCheckInError(null);
    setPhoneDigits('');
    setPhoneResults(null);
    setPhoneLoading(false);
    setSelectedPhoneBookingId(null);
    setStep('phone');
  }, [resetIdleTimer]);

  const startWalkIn = useCallback(() => {
    resetIdleTimer();
    setCheckInError(null);
    setWalkInStage('identity');
    setWalkInName('');
    setSelectedWalkInServices([]);
    setWalkInSelectedCategoryId(categories[0]?.id || '');
    setWalkInServiceSearchQuery('');
    setWalkInCategoryMenuOpen(false);
    setStep('walkin');
  }, [categories, resetIdleTimer]);

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
      serviceLabel: booking.serviceName,
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
      serviceLabel: booking.serviceName,
      staffName: booking.staffName,
      bookingTime: booking.from,
      isWalkIn: false,
    });
  }, [normalizedPhoneDigits, queueCheckIn]);

  const toggleSelectedWalkInService = useCallback((service: CustomerDisplayServiceItem) => {
    resetIdleTimer();
    setSelectedWalkInServices((current) => {
      const alreadySelected = current.some((entry) => entry.id === service.id);
      if (alreadySelected) {
        return current.filter((entry) => entry.id !== service.id);
      }

      return [...current, service];
    });
  }, [resetIdleTimer]);

  const selectWalkInCategory = useCallback((categoryId: string) => {
    resetIdleTimer();
    setWalkInSelectedCategoryId(categoryId);
    setWalkInServiceSearchQuery('');
    setWalkInCategoryMenuOpen(false);
  }, [resetIdleTimer]);

  const openWalkInServiceStage = useCallback(() => {
    resetIdleTimer();
    setWalkInServiceSearchQuery('');
    setWalkInCategoryMenuOpen(false);
    setWalkInStage('service');
  }, [resetIdleTimer]);

  const openWalkInReviewStage = useCallback(() => {
    resetIdleTimer();
    setWalkInCategoryMenuOpen(false);
    setWalkInStage('review');
  }, [resetIdleTimer]);

  const handleWalkInSubmit = useCallback(async () => {
    if (!walkInName.trim()) return;
    if (categories.length > 0 && selectedWalkInServices.length === 0) return;

    await queueCheckIn({
      customerName: walkInName.trim(),
      serviceName: selectedWalkInServiceLabel || undefined,
      serviceLabel: selectedWalkInServiceLabel || undefined,
      services: selectedWalkInServices,
      totalPrice: selectedWalkInTotalPrice,
      approxDurationMinutes: selectedWalkInDuration > 0 ? selectedWalkInDuration : undefined,
      isWalkIn: true,
    });
  }, [
    categories.length,
    queueCheckIn,
    selectedWalkInDuration,
    selectedWalkInServiceLabel,
    selectedWalkInServices,
    selectedWalkInTotalPrice,
    walkInName,
  ]);

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

    if (step === 'walkin' && walkInStage === 'review') {
      setWalkInStage('service');
      return;
    }

    if (step === 'walkin' && walkInStage === 'service') {
      setWalkInServiceSearchQuery('');
      setWalkInCategoryMenuOpen(false);
      setWalkInStage('identity');
      return;
    }

    if (step === 'phone') {
      setPhoneDigits('');
      setPhoneResults(null);
    }

    setStep('hub');
  }, [resetIdleTimer, step, walkInStage]);

  const showTouchKeyboardFor = useCallback((target: Exclude<CustomerTouchKeyboardTarget, null>) => {
    resetIdleTimer();
    setKeyboardTarget(target);
  }, [resetIdleTimer]);

  const dismissTouchKeyboard = useCallback(() => {
    setKeyboardTarget(null);
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);

  const toggleWalkInCategoryMenu = useCallback(() => {
    resetIdleTimer();
    if (keyboardTarget) {
      dismissTouchKeyboard();
    }
    setWalkInCategoryMenuOpen((current) => !current);
  }, [dismissTouchKeyboard, keyboardTarget, resetIdleTimer]);

  const handleTouchKeyboardKey = useCallback((key: string) => {
    resetIdleTimer();

    if (keyboardTarget === 'bookingSearch') {
      setBookingQuery((current) => current + key);
      return;
    }

    if (keyboardTarget === 'walkInServiceSearch') {
      setWalkInServiceSearchQuery((current) => current + key);
      return;
    }

    if (keyboardTarget === 'walkInName') {
      setWalkInName((current) => current + key);
    }
  }, [keyboardTarget, resetIdleTimer]);

  const handleTouchKeyboardBackspace = useCallback(() => {
    resetIdleTimer();

    if (keyboardTarget === 'bookingSearch') {
      setBookingQuery((current) => current.slice(0, -1));
      return;
    }

    if (keyboardTarget === 'walkInServiceSearch') {
      setWalkInServiceSearchQuery((current) => current.slice(0, -1));
      return;
    }

    if (keyboardTarget === 'walkInName') {
      setWalkInName((current) => current.slice(0, -1));
    }
  }, [keyboardTarget, resetIdleTimer]);

  const handleTouchKeyboardDone = useCallback(() => {
    resetIdleTimer();
    dismissTouchKeyboard();
  }, [dismissTouchKeyboard, resetIdleTimer]);

  const handleCustomerDisplayPointerDown = useCallback((event: React.PointerEvent) => {
    const target = event.target as Element | null;
    if (
      walkInCategoryMenuOpen
      && target
      && !target.closest('[data-customer-display-checkin-walkin-category-menu="true"]')
      && !target.closest('[data-customer-display-checkin-walkin-category-trigger="true"]')
    ) {
      setWalkInCategoryMenuOpen(false);
    }

    if (!keyboardTarget) return;
    if (!shouldDismissCustomerTouchKeyboard(target)) return;

    dismissTouchKeyboard();
  }, [dismissTouchKeyboard, keyboardTarget, walkInCategoryMenuOpen]);

  const screenTitle = step === 'hub'
    ? t('checkin.welcome')
    : step === 'booking'
      ? t('wizard.selectBooking')
      : step === 'phone'
        ? t('checkin.phoneSearch')
        : step === 'walkin'
          ? walkInStage === 'identity'
            ? t('checkin.walkIn')
            : walkInStage === 'review'
              ? t('wizard.confirmation')
              : t('wizard.selectServices')
          : step === 'upsell'
            ? t('checkin.upsellTitle')
            : t('checkin.confirmed');

  const screenSubtitle = step === 'hub'
    ? t('customer.explore')
    : step === 'booking'
      ? ''
      : step === 'phone'
        ? t('checkinTab.searchPhone')
        : step === 'walkin'
          ? walkInStage === 'identity'
            ? t('checkin.walkInPlaceholder')
            : formatServiceCount(selectedWalkInServices.length)
          : step === 'upsell'
            ? pendingCheckIn?.customerName
            : confirmedCheckIn?.customerName;
  const hubCategoryPanelStyle = hubActionsHeight
    ? ({ '--hub-actions-height': `${hubActionsHeight}px` } as React.CSSProperties)
    : undefined;
  const keyboardInset = getCustomerTouchKeyboardInset(keyboardTarget);
  const confirmedServices = confirmedCheckIn?.services || [];

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
      <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden" onPointerDown={handleCustomerDisplayPointerDown}>
        {checkInError && (
          <div
            className="mb-4 shrink-0 rounded-2xl border border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-red-700"
            data-customer-display-checkin-error="true"
          >
            {checkInError}
          </div>
        )}
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          style={{
            paddingBottom: keyboardInset > 0 ? `${keyboardInset}px` : undefined,
            transition: 'padding-bottom 0.3s ease',
          }}
        >
          {step === 'hub' && (
            <div
              className="grid min-h-0 flex-1 gap-6 lg:items-start lg:grid-cols-[minmax(0,1.15fr)_380px]"
              data-customer-display-hub="hub"
            >
          <div ref={hubActionsRef} data-customer-display-hub-actions="actions">
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
                  onClick={() => onBrowseServices()}
                />
              </div>
            </Panel>
          </div>

          <Panel
            className="flex flex-col overflow-hidden p-6 lg:h-[var(--hub-actions-height)] lg:max-h-[var(--hub-actions-height)]"
            style={hubCategoryPanelStyle}
            data-customer-display-hub-categories="panel"
          >
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

            <div
              className="mt-6 space-y-3 pr-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
              data-customer-display-hub-category-list="scroll"
            >
              {categorySummaries.length > 0 ? categorySummaries.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => onBrowseServices(category.id)}
                  className="w-full rounded-3xl border border-slate-100 bg-slate-50/80 px-4 py-4 text-left transition-colors hover:border-brand-200 hover:bg-brand-50/60 active:bg-brand-100/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                >
                  <div className="text-lg font-semibold text-slate-900">{category.name}</div>
                  <div className="mt-3 space-y-1 text-sm text-slate-500">
                    <div>{formatServiceCount(category.serviceCount)}</div>
                    <div>{formatStartingPrice(category.startingPrice)}</div>
                  </div>
                </button>
              )) : (
                <EmptyState title={t('priceList.noServices')} />
              )}
            </div>
          </Panel>
            </div>
          )}

          {step === 'booking' && (
            <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <Panel className="flex min-h-0 flex-col p-6">
                <label className="block">
                  <span className="sr-only">{t('wizard.searchBooking')}</span>
                  <input
                    ref={bookingQueryRef}
                    value={bookingQuery}
                    readOnly
                    onFocus={() => showTouchKeyboardFor('bookingSearch')}
                    onPointerDown={() => showTouchKeyboardFor('bookingSearch')}
                    data-customer-display-text-input="true"
                    placeholder={t('wizard.searchBooking')}
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50/80 px-5 py-4 text-lg text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-brand-300 focus:bg-white"
                  />
                </label>

                <div
                  className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1"
                  data-customer-display-checkin-booking-list="true"
                >
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
                          selected={booking.id === selectedBooking?.id}
                          selectedLabel={t('wizard.selected')}
                          idleLabel={t('wizard.selectBooking')}
                          onSelect={() => setSelectedBookingId(booking.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <EmptyState title={t('checkin.noResults')} />
                  )}
                </div>
              </Panel>

              <Panel
                className="flex min-h-0 flex-col p-6"
                data-customer-display-checkin-booking-review="true"
              >
                {selectedBooking ? (
                  <>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t('wizard.bookingDetail')}
                    </div>
                    <div className="mt-3 text-4xl font-semibold tracking-tight text-slate-900">
                      {formatDisplayTime(selectedBooking.from, language)}
                    </div>

                    <div className="mt-6 rounded-[28px] border border-slate-100 bg-slate-50/80 p-5">
                      <div className="text-2xl font-semibold tracking-tight text-slate-900">
                        {selectedBooking.customerName}
                      </div>
                      <div className="mt-4 space-y-2">
                        <DetailRow label={t('wizard.service')} value={selectedBooking.serviceName} />
                        <DetailRow label={t('wizard.staff')} value={selectedBooking.staffName || '-'} />
                        <DetailRow
                          label={t('wizard.time')}
                          value={formatDisplayTime(selectedBooking.from, language) || '-'}
                        />
                      </div>
                    </div>

                    <button
                      onClick={() => { void handleBookingCheckIn(selectedBooking); }}
                      className="mt-auto rounded-2xl bg-brand-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-brand-700"
                    >
                      {t('checkin.checkInButton')}
                    </button>
                  </>
                ) : visibleBookings.length > 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center text-center">
                    <div className="text-sm text-slate-400">{t('wizard.selectBooking')}</div>
                  </div>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center text-center">
                    <button
                      onClick={startWalkIn}
                      className="rounded-2xl border border-brand-200 bg-brand-50 px-6 py-3 text-base font-semibold text-brand-700 transition-colors hover:bg-brand-100"
                    >
                      {t('wizard.continueWalkIn')}
                    </button>
                  </div>
                )}
              </Panel>
            </div>
          )}

          {step === 'phone' && (
            <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
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

              <Panel
                className="flex min-h-0 flex-col p-6"
                data-customer-display-checkin-phone-selection="true"
              >
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

                {normalizedPhoneDigits.length < 3 ? (
                  <div className="mt-5 min-h-0 flex-1">
                    <EmptyState title={t('checkin.phonePlaceholder')} />
                  </div>
                ) : phoneMatches.length > 0 ? (
                  <>
                    <div
                      className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1"
                      data-customer-display-checkin-phone-list="true"
                    >
                      <div className="grid gap-4">
                        {phoneMatches.map((booking) => (
                          <CustomerBookingCard
                            key={booking.id}
                            booking={booking}
                            language={language}
                            selected={booking.id === selectedPhoneBooking?.id}
                            selectedLabel={t('wizard.selected')}
                            idleLabel={t('wizard.selectBooking')}
                            onSelect={() => setSelectedPhoneBookingId(booking.id)}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="mt-6 rounded-[28px] border border-slate-100 bg-slate-50/80 p-5">
                      {selectedPhoneBooking ? (
                        <>
                          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                            {t('wizard.bookingDetail')}
                          </div>
                          <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
                            {selectedPhoneBooking.customerName}
                          </div>
                          <div className="mt-4 space-y-2">
                            <DetailRow label={t('wizard.service')} value={selectedPhoneBooking.serviceName} />
                            <DetailRow label={t('wizard.staff')} value={selectedPhoneBooking.staffName || '-'} />
                            <DetailRow
                              label={t('wizard.time')}
                              value={formatDisplayTime(selectedPhoneBooking.from, language) || '-'}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="text-sm leading-6 text-slate-500">
                          {t('wizard.selectBooking')}
                        </div>
                      )}
                    </div>

                    <button
                      onClick={() => {
                        if (selectedPhoneBooking) {
                          void handlePhoneCheckIn(selectedPhoneBooking);
                        }
                      }}
                      disabled={!selectedPhoneBooking}
                      className="mt-6 rounded-2xl bg-brand-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      {t('checkin.checkInButton')}
                    </button>
                  </>
                ) : !phoneLoading ? (
                  <div className="mt-5 min-h-0 flex-1">
                    <EmptyState title={t('checkin.noPhoneMatch')} />
                  </div>
                ) : null}
              </Panel>
            </div>
          )}

          {step === 'walkin' && walkInStage === 'identity' && (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Panel className="w-full max-w-[640px] p-8 lg:p-12">
                <div className="flex flex-col items-center text-center">
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-brand-100 to-brand-50 text-brand-600 shadow-sm">
                    <WalkInActionIcon />
                  </div>

                  <h2 className="mt-6 text-4xl font-semibold tracking-tight text-slate-900">
                    {t('checkin.welcome')}
                  </h2>
                  <p className="mt-3 text-lg text-slate-500">
                    {t('checkin.walkInPlaceholder')}
                  </p>

                  <div className="mt-8 w-full">
                    <label className="mb-3 block text-left text-sm font-semibold uppercase tracking-[0.16em] text-slate-400">
                      {t('checkin.walkInName')}
                    </label>
                    <input
                      ref={walkInNameRef}
                      value={walkInName}
                      readOnly
                      onFocus={() => showTouchKeyboardFor('walkInName')}
                      onPointerDown={() => showTouchKeyboardFor('walkInName')}
                      data-customer-display-text-input="true"
                      placeholder={t('checkin.walkInPlaceholder')}
                      className="w-full rounded-[24px] border border-slate-200 bg-slate-50/80 px-6 py-5 text-center text-2xl font-medium text-slate-900 outline-none transition-colors placeholder:text-slate-300 focus:border-brand-300 focus:bg-white"
                    />
                  </div>

                  <button
                    onClick={openWalkInServiceStage}
                    disabled={!walkInName.trim()}
                    className="mt-6 w-full rounded-2xl bg-brand-600 px-6 py-4 text-lg font-semibold text-white shadow-[0_12px_30px_rgba(236,72,153,0.25)] transition-all hover:bg-brand-700 hover:shadow-[0_16px_40px_rgba(236,72,153,0.3)] active:translate-y-0.5 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:shadow-none"
                  >
                    {t('wizard.continue')}
                  </button>

                  <div className="mt-8 flex items-center gap-2 text-sm">
                    <span className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">1</span>
                      <span className="font-semibold text-slate-700">{t('checkin.walkInName')}</span>
                    </span>
                    <span className="text-slate-300">———</span>
                    <span className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-500">2</span>
                      <span className="text-slate-400">{t('wizard.selectServices')}</span>
                    </span>
                    <span className="text-slate-300">———</span>
                    <span className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-500">3</span>
                      <span className="text-slate-400">{t('checkin.confirmed')}</span>
                    </span>
                  </div>
                </div>
              </Panel>
            </div>
          )}

          {step === 'walkin' && walkInStage === 'service' && (
            <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <WalkInServicePicker
                categories={categories}
                language={language}
                t={t}
                selectedCategoryId={walkInSelectedCategoryId}
                searchQuery={walkInServiceSearchQuery}
                categoryMenuOpen={walkInCategoryMenuOpen}
                selectedServiceIds={selectedWalkInServiceIds}
                onSelectCategory={selectWalkInCategory}
                onToggleCategoryMenu={toggleWalkInCategoryMenu}
                onSearchFocus={() => setKeyboardTarget('walkInServiceSearch')}
                onToggleService={toggleSelectedWalkInService}
              />

              <Panel
                className="flex min-h-0 flex-col overflow-hidden p-6"
                data-customer-display-checkin-walkin-summary="true"
              >
                <div
                  className="min-h-0 flex-1 overflow-y-auto pr-1"
                  data-customer-display-checkin-walkin-basket="true"
                >
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {t('checkin.walkIn')}
                  </div>
                  <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
                    {walkInName}
                  </div>
                  <div className="mt-1 text-sm text-slate-500">
                    {formatServiceCount(selectedWalkInServices.length)}
                  </div>

                  <div className="mt-6 space-y-2">
                    <DetailRow label={t('checkin.walkInName')} value={walkInName || '-'} />
                    <DetailRow
                      label={t('customer.approxTime')}
                      value={selectedWalkInDuration > 0 ? formatApproximateTime(selectedWalkInDuration) : '-'}
                    />
                  </div>

                  <div className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {t('customer.selectedServices')}
                  </div>

                  <div className="mt-4">
                    {selectedWalkInServices.length > 0 ? (
                      <div className="space-y-2">
                        {selectedWalkInServices.map((service) => (
                          <div
                            key={service.id}
                            className="flex items-center gap-3 rounded-2xl border border-slate-100 bg-slate-50/80 px-3 py-3"
                          >
                            <div className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                              {service.name}
                            </div>
                            <div className="shrink-0 text-sm font-semibold text-slate-600">
                              {formatDisplayCurrency(service.price, language)}
                            </div>
                            <button
                              type="button"
                              onClick={() => toggleSelectedWalkInService(service)}
                              aria-label={t('common.remove')}
                              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 active:scale-95"
                            >
                              <CheckinRemoveIcon />
                            </button>
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
                    value={formatDisplayCurrency(selectedWalkInTotalPrice, language)}
                  />
                </div>

                <button
                  onClick={openWalkInReviewStage}
                  disabled={categories.length > 0 && selectedWalkInServices.length === 0}
                  className="mt-6 shrink-0 rounded-2xl bg-brand-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {t('wizard.continue')}
                </button>
              </Panel>
            </div>
          )}

          {step === 'walkin' && walkInStage === 'review' && (
            <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <Panel className="flex min-h-0 flex-col p-6 lg:p-8">
                <div className="flex min-h-0 max-w-2xl flex-1 flex-col">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {t('checkin.walkInName')}
                  </div>
                  <div className="mt-3 rounded-[24px] border border-slate-200 bg-slate-50/80 px-6 py-5 text-2xl font-medium text-slate-900">
                    {walkInName.trim() || '-'}
                  </div>

                  <div className="mt-8 flex min-h-0 flex-1 flex-col rounded-[28px] border border-slate-200 bg-slate-50/80 p-5">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t('customer.selectedServices')}
                    </div>
                    <div className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                      {selectedWalkInServices.length > 0 ? (
                        selectedWalkInServices.map((service) => (
                          <div
                            key={service.id}
                            className="flex items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-white px-4 py-3"
                          >
                            <div className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900">
                              {service.name}
                            </div>
                            <div className="shrink-0 text-sm font-semibold text-slate-600">
                              {formatDisplayCurrency(service.price, language)}
                            </div>
                          </div>
                        ))
                      ) : (
                        <EmptyState title={t('wizard.selectServices')} />
                      )}
                    </div>
                    <div className="mt-4 border-t border-slate-100 pt-4">
                      <DetailRow
                        label={t('wizard.total')}
                        value={formatDisplayCurrency(selectedWalkInTotalPrice, language)}
                      />
                    </div>
                  </div>
                </div>
              </Panel>

              <Panel className="flex min-h-0 flex-col p-6">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  {t('checkin.walkIn')}
                </div>
                <div className="mt-2 text-4xl font-semibold tracking-tight text-slate-900">
                  {selectedWalkInServices.length}
                </div>
                <div className="mt-1 text-sm text-slate-500">{t('customer.selectedServices')}</div>

                <div className="mt-6 space-y-2">
                  <DetailRow label={t('checkin.walkInName')} value={walkInName.trim() || '-'} />
                  <DetailRow
                    label={t('customer.approxTime')}
                    value={selectedWalkInDuration > 0 ? formatApproximateTime(selectedWalkInDuration) : '-'}
                  />
                </div>

                <div className="mt-auto shrink-0 border-t border-slate-100 pt-4">
                  <DetailRow
                    label={t('wizard.total')}
                    value={formatDisplayCurrency(selectedWalkInTotalPrice, language)}
                  />
                </div>

                <button
                  onClick={() => { void handleWalkInSubmit(); }}
                  disabled={!walkInName.trim() || (categories.length > 0 && selectedWalkInServices.length === 0)}
                  className="mt-6 shrink-0 rounded-2xl bg-brand-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {t('checkin.checkInButton')}
                </button>
              </Panel>
            </div>
          )}

          {step === 'upsell' && pendingCheckIn && (
            <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
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
              {pendingCheckIn.services?.length ? (
                <>
                  <DetailRow
                    label={t('customer.selectedServices')}
                    value={formatServiceCount(pendingCheckIn.services.length)}
                  />
                  <DetailRow
                    label={t('wizard.total')}
                    value={pendingCheckIn.totalPrice != null ? formatDisplayCurrency(pendingCheckIn.totalPrice, language) : '-'}
                  />
                </>
              ) : pendingCheckIn.serviceLabel ? (
                <DetailRow label={t('wizard.service')} value={pendingCheckIn.serviceLabel} />
              ) : pendingCheckIn.serviceName ? (
                <DetailRow label={t('wizard.service')} value={pendingCheckIn.serviceName} />
              ) : null}
              {pendingCheckIn.approxDurationMinutes ? (
                <DetailRow
                  label={t('customer.approxTime')}
                  value={formatApproximateTime(pendingCheckIn.approxDurationMinutes)}
                />
              ) : null}
              {pendingCheckIn.staffName && (
                <DetailRow label={t('wizard.staff')} value={pendingCheckIn.staffName} />
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
            <ConfirmedReceiptView
              t={t}
              language={language}
              customerName={confirmedCheckIn.customerName}
              services={confirmedServices}
              totalPrice={confirmedCheckIn.totalPrice ?? null}
              approxDurationMinutes={confirmedCheckIn.approxDurationMinutes ?? null}
              serviceLabel={confirmedCheckIn.serviceLabel}
              serviceName={confirmedCheckIn.serviceName}
              staffName={confirmedCheckIn.staffName}
              bookingTime={confirmedCheckIn.bookingTime}
              customerPhone={confirmedCheckIn.customerPhone}
              rootAttr="data-customer-display-checkin-confirmed-receipt"
              summaryAttr="data-customer-display-checkin-confirmed-summary"
              scrollAttr="data-customer-display-checkin-confirmed-detail-scroll"
            />
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

function CheckinRemoveIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M18 6L6 18" />
    </svg>
  );
}
