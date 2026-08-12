import { useState, useCallback, useEffect, useRef } from 'react';
import {
  useCheckinRuntime,
  type CategoryItem,
  type CheckinBookingSummary,
  type CheckinQueueItem,
  type CheckinStats,
  type SalonCustomerData,
  type SelectedService,
  type ServiceItem,
  type ServiceRecommendation,
  type StaffItem,
} from '../components/checkin/runtime';
import rlog from '../utils/logger';

export const CHECKIN_WIZARD_STEPS = [
  'entry',
  'price-list',
  'booking-list',
  'booking-detail',
  'phone-entry',
  'customer-found',
  'new-customer',
  'service-select',
  'confirm',
  'done',
] as const;

export type WizardStep = (typeof CHECKIN_WIZARD_STEPS)[number];

export type WizardFlow = 'booking' | 'walkin' | null;

export type {
  CategoryItem,
  SalonCustomerData,
  SelectedService,
  ServiceItem,
  ServiceRecommendation,
  StaffItem,
} from '../components/checkin/runtime';

export interface WizardState {
  step: WizardStep;
  flow: WizardFlow;
  selectedBooking: CheckinBookingSummary | null;
  bookingSearchQuery: string;
  bookingSearchLoading: boolean;
  bookingSearchError: string | null;
  phoneNumber: string;
  customer: SalonCustomerData | null;
  isNewCustomer: boolean;
  newCustomerForm: { name: string; phone: string; birthday: string; notes: string };
  selectedServices: SelectedService[];
  selectedStaff: StaffItem | null;
  recommendations: ServiceRecommendation[];
  bestsellers: ServiceRecommendation[];
  todayBookings: CheckinBookingSummary[];
  staffList: StaffItem[];
  services: ServiceItem[];
  categories: CategoryItem[];
  checkins: CheckinQueueItem[];
  stats: CheckinStats;
  isLoading: boolean;
  isSubmitting: boolean;
  errorMessage: string | null;
}

const initialState: WizardState = {
  step: 'entry',
  flow: null,
  selectedBooking: null,
  bookingSearchQuery: '',
  bookingSearchLoading: false,
  bookingSearchError: null,
  phoneNumber: '',
  customer: null,
  isNewCustomer: false,
  newCustomerForm: { name: '', phone: '', birthday: '', notes: '' },
  selectedServices: [],
  selectedStaff: null,
  recommendations: [],
  bestsellers: [],
  todayBookings: [],
  staffList: [],
  services: [],
  categories: [],
  checkins: [],
  stats: { total: 0, waiting: 0, inService: 0, completed: 0, noShow: 0, walkIns: 0 },
  isLoading: false,
  isSubmitting: false,
  errorMessage: null,
};

interface WizardSnapshot {
  scopeKey: string;
  state: WizardState;
}

interface SubmitAttempt {
  fingerprint: string;
  id: string;
}

// Keep only the most recent authenticated scope. This preserves the historical
// Windows remount behavior without retaining/restoring customer PII after the
// runtime changes salon or authenticated user.
let _snapshot: WizardSnapshot | null = null;
const anonymousRuntimeScopes = new WeakMap<object, string>();
let anonymousRuntimeScopeSequence = 0;

function getRuntimeScopeKey(runtime: object, explicitScopeKey?: string): string {
  if (explicitScopeKey) return explicitScopeKey;
  let key = anonymousRuntimeScopes.get(runtime);
  if (!key) {
    anonymousRuntimeScopeSequence += 1;
    key = `runtime-${anonymousRuntimeScopeSequence}`;
    anonymousRuntimeScopes.set(runtime, key);
  }
  return key;
}

function restoreState(scopeKey: string): WizardState {
  if (_snapshot?.scopeKey === scopeKey) {
    return { ..._snapshot.state, isLoading: false, isSubmitting: false, errorMessage: null };
  }
  _snapshot = null;
  return initialState;
}

function createAttemptId(): string {
  return `ci-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useCheckinWizard() {
  const runtime = useCheckinRuntime();
  const sessionScopeKey = getRuntimeScopeKey(runtime, runtime.session?.scopeKey);
  const [scopedState, setScopedState] = useState(() => {
    return { scopeKey: sessionScopeKey, state: restoreState(sessionScopeKey) };
  });
  // Never expose the previous scope's customer data, even for the render which
  // observes a provider/session change before its effects run.
  const state = scopedState.scopeKey === sessionScopeKey ? scopedState.state : initialState;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bookingSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const scopeKeyRef = useRef(sessionScopeKey);
  const submitInFlightRef = useRef(false);
  const inactivityExpiredDuringSubmitRef = useRef(false);
  const preserveAttemptAfterPrivacyResetRef = useRef(false);
  const bookingAttemptRef = useRef<SubmitAttempt | null>(null);
  const walkInAttemptRef = useRef<SubmitAttempt | null>(null);
  const performResetRef = useRef<() => void>(() => undefined);
  const checkinsRequestRef = useRef(0);
  const bookingsRequestRef = useRef(0);
  const catalogRequestRef = useRef(0);
  const lookupRequestRef = useRef(0);
  const customerCreateRequestRef = useRef(0);
  const customerCreateInFlightRef = useRef(false);
  const customerCreateAttemptRef = useRef<SubmitAttempt | null>(null);
  const popularityRequestRef = useRef(0);
  const bookingSearchRequestRef = useRef(0);

  const stateRef = useRef<WizardState>(state);
  stateRef.current = state;

  const setState = useCallback((updater: (previous: WizardState) => WizardState) => {
    setScopedState((previous) => {
      if (previous.scopeKey !== sessionScopeKey) return previous;
      return { ...previous, state: updater(previous.state) };
    });
  }, [sessionScopeKey]);

  const update = useCallback((patch: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, [setState]);

  const isCurrentGeneration = useCallback((generation: number) => {
    return mountedRef.current
      && generationRef.current === generation
      && scopeKeyRef.current === sessionScopeKey;
  }, [sessionScopeKey]);

  useEffect(() => {
    if (scopedState.scopeKey === sessionScopeKey) return;
    generationRef.current += 1;
    scopeKeyRef.current = sessionScopeKey;
    submitInFlightRef.current = false;
    inactivityExpiredDuringSubmitRef.current = false;
    preserveAttemptAfterPrivacyResetRef.current = false;
    bookingAttemptRef.current = null;
    walkInAttemptRef.current = null;
    customerCreateAttemptRef.current = null;
    customerCreateInFlightRef.current = false;
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    if (bookingSearchTimerRef.current) clearTimeout(bookingSearchTimerRef.current);
    const nextState = restoreState(sessionScopeKey);
    _snapshot = { scopeKey: sessionScopeKey, state: nextState };
    setScopedState({ scopeKey: sessionScopeKey, state: nextState });
  }, [scopedState.scopeKey, sessionScopeKey]);

  useEffect(() => {
    if (scopedState.scopeKey === sessionScopeKey) {
      _snapshot = { scopeKey: sessionScopeKey, state: scopedState.state };
    }
  }, [scopedState, sessionScopeKey]);

  // Load checkins + stats
  const loadCheckins = useCallback(async () => {
    if (!runtime.presentation.showQueue && !runtime.presentation.showStats) return;
    const generation = generationRef.current;
    const request = ++checkinsRequestRef.current;
    try {
      const [checkins, stats] = await Promise.all([
        runtime.checkins.getToday(),
        runtime.checkins.getStats(),
      ]);
      if (isCurrentGeneration(generation) && checkinsRequestRef.current === request) {
        update({ checkins, stats });
      }
    } catch (e) {
      if (isCurrentGeneration(generation)) rlog.error('[Wizard] Failed to load checkins:', e);
    }
  }, [runtime, update, isCurrentGeneration]);

  // Load bookings
  const loadBookings = useCallback(async () => {
    // A customer kiosk may only use the capped server-side search surface.
    // Never fall back to the broad Windows/Booksy download.
    if (runtime.presentation.audience === 'customer-kiosk') {
      if (typeof runtime.bookings.search !== 'function') {
        rlog.error('[Wizard] Customer kiosk booking search is unavailable; broad booking load refused.');
        update({
          todayBookings: [],
          bookingSearchLoading: false,
          bookingSearchError: 'Booking search is unavailable. Please see reception.',
        });
      }
      return;
    }
    if (runtime.bookings.search) return;
    const generation = generationRef.current;
    const request = ++bookingsRequestRef.current;
    try {
      const data = await runtime.bookings.getToday();
      if (isCurrentGeneration(generation) && bookingsRequestRef.current === request) {
        update({ todayBookings: data || [] });
      }
    } catch (e) {
      if (isCurrentGeneration(generation)) rlog.error('[Wizard] Failed to load bookings:', e);
    }
  }, [runtime, update, isCurrentGeneration]);

  // Load services + staff + categories
  const loadCatalog = useCallback(async () => {
    const generation = generationRef.current;
    const request = ++catalogRequestRef.current;
    try {
      const [services, categories, staffList] = await Promise.all([
        runtime.catalog.getServices(),
        runtime.catalog.getCategories(),
        runtime.catalog.getStaff(),
      ]);
      if (isCurrentGeneration(generation) && catalogRequestRef.current === request) {
        update({ services, categories, staffList });
      }
    } catch (e) {
      if (isCurrentGeneration(generation)) rlog.error('[Wizard] Failed to load catalog:', e);
    }
  }, [runtime, update, isCurrentGeneration]);

  // Initial load + polling
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      if (bookingSearchTimerRef.current) clearTimeout(bookingSearchTimerRef.current);
      submitInFlightRef.current = false;
      customerCreateInFlightRef.current = false;
      inactivityExpiredDuringSubmitRef.current = false;
    };
  }, []);

  useEffect(() => {
    loadCheckins();
    loadBookings();
    loadCatalog();
    pollRef.current = setInterval(() => {
      loadBookings();
      loadCheckins();
    }, 30000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    };
  }, [loadCheckins, loadBookings, loadCatalog]);

  const reset = useCallback(() => {
    // A request may already have committed even though its response is still
    // pending. Keep both the wizard payload and attempt ID until that outcome
    // is known so a retry can replay the same idempotent mutation.
    if (submitInFlightRef.current || customerCreateInFlightRef.current || stateRef.current.isSubmitting) return;
    generationRef.current += 1;
    submitInFlightRef.current = false;
    inactivityExpiredDuringSubmitRef.current = false;
    preserveAttemptAfterPrivacyResetRef.current = false;
    bookingAttemptRef.current = null;
    walkInAttemptRef.current = null;
    customerCreateAttemptRef.current = null;
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    if (bookingSearchTimerRef.current) clearTimeout(bookingSearchTimerRef.current);
    setState((prev) => ({
      ...initialState,
      // A customer-operated kiosk must not retain search results containing
      // names after returning to the entry screen. Staff/Windows keeps its
      // preloaded daily list because that screen is not a public session.
      todayBookings: runtime.presentation.audience === 'customer-kiosk' ? [] : prev.todayBookings,
      staffList: prev.staffList,
      services: prev.services,
      categories: prev.categories,
      checkins: runtime.presentation.audience === 'customer-kiosk' ? [] : prev.checkins,
      stats: runtime.presentation.audience === 'customer-kiosk' ? initialState.stats : prev.stats,
    }));
  }, [runtime.presentation.audience, setState]);
  performResetRef.current = reset;

  const armInactivityReset = useCallback(() => {
    const timeoutMs = runtime.session?.inactivityResetMs;
    if (!timeoutMs) return;
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(() => {
      if (submitInFlightRef.current || customerCreateInFlightRef.current || stateRef.current.isSubmitting) {
        // The server may already have committed, so retain the immutable
        // attempt refs privately for an idempotent retry. Do clear all visible
        // customer data immediately: a stalled network response must not leave
        // the previous customer's name/phone on an unattended kiosk.
        inactivityExpiredDuringSubmitRef.current = true;
        preserveAttemptAfterPrivacyResetRef.current = true;
        setState((prev) => ({
          ...initialState,
          staffList: prev.staffList,
          services: prev.services,
          categories: prev.categories,
        }));
        return;
      }
      performResetRef.current();
    }, timeoutMs);
  }, [runtime.session?.inactivityResetMs, setState]);

  const releaseSubmitLock = useCallback(() => {
    submitInFlightRef.current = false;
    const privacyReset = inactivityExpiredDuringSubmitRef.current;
    inactivityExpiredDuringSubmitRef.current = false;
    return privacyReset;
  }, []);

  useEffect(() => {
    if (!runtime.session?.inactivityResetMs) return;
    const onActivity = () => armInactivityReset();
    document.addEventListener('pointerdown', onActivity);
    document.addEventListener('touchstart', onActivity);
    document.addEventListener('keydown', onActivity);
    armInactivityReset();
    return () => {
      document.removeEventListener('pointerdown', onActivity);
      document.removeEventListener('touchstart', onActivity);
      document.removeEventListener('keydown', onActivity);
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, [runtime.session?.inactivityResetMs, armInactivityReset]);

  // Navigation
  const goTo = useCallback((step: WizardStep) => {
    armInactivityReset();
    update({ step });
  }, [armInactivityReset, update]);

  const clearError = useCallback(() => {
    armInactivityReset();
    update({ errorMessage: null });
  }, [armInactivityReset, update]);

  // Flow A: Booking
  const selectBookingFlow = useCallback(() => {
    armInactivityReset();
    if (!preserveAttemptAfterPrivacyResetRef.current) bookingAttemptRef.current = null;
    update({
      flow: 'booking',
      step: 'booking-list',
      bookingSearchQuery: '',
      bookingSearchLoading: false,
      bookingSearchError: null,
      ...(runtime.bookings.search ? { todayBookings: [] } : {}),
    });
  }, [armInactivityReset, runtime.bookings.search, update]);

  const searchBookings = useCallback((query: string) => {
    armInactivityReset();
    const rawQuery = String(query ?? '');
    const normalized = rawQuery.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const request = ++bookingSearchRequestRef.current;
    const generation = generationRef.current;
    if (!runtime.bookings.search) return;
    if (bookingSearchTimerRef.current) {
      clearTimeout(bookingSearchTimerRef.current);
      bookingSearchTimerRef.current = null;
    }
    if (normalized.length < 2) {
      update({
        bookingSearchQuery: rawQuery,
        bookingSearchLoading: false,
        bookingSearchError: null,
        todayBookings: [],
      });
      return;
    }
    update({
      // Preserve what the customer typed. Trimming this controlled value made
      // a trailing space disappear before a multi-word name could be entered.
      bookingSearchQuery: rawQuery,
      bookingSearchLoading: true,
      bookingSearchError: null,
      todayBookings: [],
    });
    bookingSearchTimerRef.current = setTimeout(() => {
      bookingSearchTimerRef.current = null;
      void runtime.bookings.search!(normalized).then((bookings) => {
        if (!isCurrentGeneration(generation) || bookingSearchRequestRef.current !== request) return;
        update({
          todayBookings: (bookings || []).slice(0, 8),
          bookingSearchLoading: false,
        });
      }).catch((error) => {
        if (!isCurrentGeneration(generation) || bookingSearchRequestRef.current !== request) return;
        rlog.error('[Wizard] Booking search failed:', error);
        update({
          todayBookings: [],
          bookingSearchLoading: false,
          bookingSearchError: 'Booking search failed. Please try again or see reception.',
        });
      });
    }, 300);
  }, [armInactivityReset, isCurrentGeneration, runtime.bookings, update]);

  const selectBooking = useCallback((booking: CheckinBookingSummary) => {
    armInactivityReset();
    if (!preserveAttemptAfterPrivacyResetRef.current) bookingAttemptRef.current = null;
    update({ selectedBooking: booking, step: 'booking-detail' });
  }, [armInactivityReset, update]);

  const confirmBookingCheckin = useCallback(async (booking: CheckinBookingSummary, staffName?: string, staffId?: string) => {
    armInactivityReset();
    if (submitInFlightRef.current || stateRef.current.isSubmitting) return;
    submitInFlightRef.current = true;
    const generation = generationRef.current;
    update({ isSubmitting: true, errorMessage: null });
    const fingerprint = JSON.stringify([
      booking.id,
      booking.customerName,
      booking.serviceName,
      staffName || booking.staffName || '',
      staffId || '',
    ]);
    if (bookingAttemptRef.current?.fingerprint !== fingerprint) {
      bookingAttemptRef.current = { fingerprint, id: createAttemptId() };
    }
    const id = bookingAttemptRef.current.id;
    preserveAttemptAfterPrivacyResetRef.current = false;
    try {
      const result = await runtime.checkins.createWithCustomer({
        id,
        customer_name: booking.customerName,
        service_name: booking.serviceName,
        staff_name: staffName || booking.staffName,
        staff_id: staffId,
        booking_id: booking.id.toString(),
        booking_source: booking.source === 'booksy' ? 'booksy' : undefined,
        expected_booked_staff_profile_id: booking.source === 'zira'
          ? (booking.staffProfileId ?? null)
          : undefined,
        is_walkin: 0,
      });
      if (!isCurrentGeneration(generation)) return;
      if (releaseSubmitLock()) return;
      update({ step: 'done', isSubmitting: false });
      await loadCheckins();
      if (!isCurrentGeneration(generation)) return;
      // Print check-in confirmation (fire-and-forget)
      runtime.checkins.printConfirmation?.({
        bookingNumber: result?.bookingNumber,
        customerName: booking.customerName,
        services: booking.serviceName ? [{ name: booking.serviceName, price: 0 }] : [],
        staffName: staffName || booking.staffName,
        checkinTime: new Date().toISOString(),
      }).catch((e: any) => rlog.warn('[Wizard] Check-in print failed:', e));
      doneTimerRef.current = setTimeout(reset, 8000);
    } catch (e) {
      if (!isCurrentGeneration(generation)) return;
      if (releaseSubmitLock()) return;
      rlog.error('[Wizard] Booking check-in failed:', e);
      update({
        isSubmitting: false,
        errorMessage: String(e).includes('BOOKING_STAFF_CHANGED')
          ? 'This appointment changed. Search again or see reception before checking in.'
          : 'Check-in failed. Please try again.',
      });
    }
  }, [runtime, update, loadCheckins, reset, armInactivityReset, releaseSubmitLock, isCurrentGeneration]);

  // Flow B: Walk-in
  const selectWalkInFlow = useCallback(() => {
    armInactivityReset();
    if (!preserveAttemptAfterPrivacyResetRef.current) walkInAttemptRef.current = null;
    update({ flow: 'walkin', step: 'phone-entry' });
  }, [armInactivityReset, update]);

  const lookupPhone = useCallback(async (phone: string) => {
    armInactivityReset();
    const generation = generationRef.current;
    const request = ++lookupRequestRef.current;
    update({ phoneNumber: phone, isLoading: true, errorMessage: null });
    try {
      const customer = await runtime.customers.getByPhone(phone);
      if (!isCurrentGeneration(generation) || lookupRequestRef.current !== request) return;
      if (customer) {
        let recommendations: ServiceRecommendation[] = [];
        try {
          recommendations = await runtime.customers.getRecommendations?.(customer.id) || [];
        } catch (error) {
          // Recommendations are an enhancement; an Android kiosk without this
          // endpoint must still complete the exact-phone flow.
          rlog.warn('[Wizard] Customer recommendations unavailable:', error);
        }
        if (!isCurrentGeneration(generation) || lookupRequestRef.current !== request) return;
        update({
          customer,
          isNewCustomer: false,
          recommendations,
          step: 'customer-found',
          isLoading: false,
        });
      } else {
        update({
          customer: null,
          isNewCustomer: true,
          newCustomerForm: { name: '', phone, birthday: '', notes: '' },
          step: 'new-customer',
          isLoading: false,
        });
      }
    } catch (e) {
      if (!isCurrentGeneration(generation) || lookupRequestRef.current !== request) return;
      rlog.error('[Wizard] Phone lookup failed:', e);
      update({
        isLoading: false,
        errorMessage: 'Phone lookup failed. Please try again.',
      });
    }
  }, [runtime, update, armInactivityReset, isCurrentGeneration]);

  const skipPhone = useCallback(() => {
    armInactivityReset();
    update({
      phoneNumber: '',
      customer: null,
      isNewCustomer: true,
      newCustomerForm: { name: '', phone: '', birthday: '', notes: '' },
      step: 'new-customer',
    });
  }, [armInactivityReset, update]);

  const createCustomer = useCallback(async (form: { name: string; phone: string; birthday?: string; notes?: string; marketingConsent?: boolean }) => {
    if (customerCreateInFlightRef.current || stateRef.current.isSubmitting) return;
    customerCreateInFlightRef.current = true;
    armInactivityReset();
    const generation = generationRef.current;
    const request = ++customerCreateRequestRef.current;
    const fingerprint = JSON.stringify([
      form.name.trim(), form.phone.trim(), form.birthday || '', form.notes || '', form.marketingConsent === true,
    ]);
    if (customerCreateAttemptRef.current?.fingerprint !== fingerprint) {
      customerCreateAttemptRef.current = { fingerprint, id: createAttemptId() };
    }
    const id = customerCreateAttemptRef.current.id;
    preserveAttemptAfterPrivacyResetRef.current = false;
    update({ isSubmitting: true, errorMessage: null });
    try {
      const result = await runtime.customers.create({
        id,
        name: form.name || 'Guest',
        phone: form.phone || undefined,
        birthday: form.birthday || undefined,
        notes: form.notes || undefined,
        marketing_consent: form.marketingConsent,
      });
      if (!isCurrentGeneration(generation) || customerCreateRequestRef.current !== request) return;
      if (inactivityExpiredDuringSubmitRef.current) return;
      if (result.success && result.data) {
        let bestsellers: ServiceRecommendation[] = [];
        try {
          bestsellers = await runtime.servicePopularity.get?.() || [];
        } catch (error) {
          rlog.warn('[Wizard] Service popularity unavailable:', error);
        }
        if (!isCurrentGeneration(generation) || customerCreateRequestRef.current !== request) return;
        update({
          customer: result.data,
          isNewCustomer: false,
          bestsellers: bestsellers || [],
          recommendations: [],  // clear any recommendations from a previous customer lookup
          step: 'service-select',
          isSubmitting: false,
        });
      }
    } catch (e) {
      if (!isCurrentGeneration(generation) || customerCreateRequestRef.current !== request) return;
      if (inactivityExpiredDuringSubmitRef.current) return;
      rlog.error('[Wizard] Create customer failed:', e);
      update({ isSubmitting: false, errorMessage: 'Failed to create customer profile. Please try again.' });
    } finally {
      customerCreateInFlightRef.current = false;
      const privacyReset = inactivityExpiredDuringSubmitRef.current;
      inactivityExpiredDuringSubmitRef.current = false;
      if (!privacyReset && isCurrentGeneration(generation) && customerCreateRequestRef.current === request) {
        update({ isSubmitting: false });
      }
    }
  }, [runtime, update, armInactivityReset, isCurrentGeneration]);

  const goToServiceSelect = useCallback(async () => {
    armInactivityReset();
    const generation = generationRef.current;
    const request = ++popularityRequestRef.current;
    let bestsellers: any[] = [];
    try {
      bestsellers = await runtime.servicePopularity.get?.() || [];
    } catch { /* ignore */ }
    if (isCurrentGeneration(generation) && popularityRequestRef.current === request) {
      update({ bestsellers: bestsellers || [], step: 'service-select' });
    }
  }, [runtime, update, armInactivityReset, isCurrentGeneration]);

  const addService = useCallback((svc: SelectedService) => {
    armInactivityReset();
    setState((prev) => ({
      ...prev,
      selectedServices: runtime.presentation.maxSelectedServices === 1
        ? [svc]
        : [...prev.selectedServices, svc],
    }));
  }, [armInactivityReset, runtime.presentation.maxSelectedServices, setState]);

  const removeService = useCallback((id: string) => {
    armInactivityReset();
    setState((prev) => ({
      ...prev,
      selectedServices: prev.selectedServices.filter((s) => s.id !== id),
    }));
  }, [armInactivityReset, setState]);

  const selectStaff = useCallback((staff: StaffItem | null) => {
    armInactivityReset();
    update({ selectedStaff: staff });
  }, [armInactivityReset, update]);

  const goToConfirm = useCallback(() => {
    armInactivityReset();
    update({ step: 'confirm' });
  }, [armInactivityReset, update]);

  const confirmWalkIn = useCallback(async () => {
    armInactivityReset();
    if (submitInFlightRef.current || stateRef.current.isSubmitting) return;
    submitInFlightRef.current = true;
    const generation = generationRef.current;
    const { customer, selectedServices, selectedStaff } = stateRef.current;
    update({ isSubmitting: true, errorMessage: null });
    const serviceName = selectedServices.map((s) => s.name).join(', ') || undefined;
    const serviceId = selectedServices[0]?.id;
    const fingerprint = JSON.stringify([
      customer?.id || '',
      customer?.name || 'Guest',
      customer?.phone || '',
      selectedServices.map((service) => [service.id, service.name, service.price, service.duration]),
      selectedStaff?.id || '',
      selectedStaff?.name || '',
    ]);
    if (walkInAttemptRef.current?.fingerprint !== fingerprint) {
      walkInAttemptRef.current = { fingerprint, id: createAttemptId() };
    }
    const id = walkInAttemptRef.current.id;
    preserveAttemptAfterPrivacyResetRef.current = false;
    try {
      const result = await runtime.checkins.createWithCustomer({
        id,
        customer_name: customer?.name || 'Guest',
        customer_phone: customer?.phone || undefined,
        customer_id: customer?.id || undefined,
        service_name: serviceName,
        service_id: serviceId,
        staff_name: selectedStaff?.name || undefined,
        staff_id: selectedStaff?.id || undefined,
        is_walkin: 1,
        services_json: selectedServices.length > 0 ? JSON.stringify(selectedServices) : undefined,
      });
      if (!isCurrentGeneration(generation)) return;
      if (releaseSubmitLock()) return;
      update({ step: 'done', isSubmitting: false });
      await loadCheckins();
      if (!isCurrentGeneration(generation)) return;
      // Print check-in confirmation (fire-and-forget)
      runtime.checkins.printConfirmation?.({
        bookingNumber: result?.bookingNumber,
        customerName: customer?.name || customer?.phone || 'Guest',
        customerPhone: customer?.phone,
        customerNotes: customer?.notes || undefined,
        services: selectedServices.map((s) => ({ name: s.name, price: s.price || 0 })),
        staffName: selectedStaff?.name,
        checkinTime: new Date().toISOString(),
      }).catch((e: any) => rlog.warn('[Wizard] Check-in print failed:', e));
      doneTimerRef.current = setTimeout(reset, 8000);
    } catch (e) {
      if (!isCurrentGeneration(generation)) return;
      if (releaseSubmitLock()) return;
      rlog.error('[Wizard] Walk-in check-in failed:', e);
      update({ isSubmitting: false, errorMessage: 'Check-in failed. Please try again.' });
    }
  }, [runtime, update, loadCheckins, reset, armInactivityReset, releaseSubmitLock, isCurrentGeneration]);

  // Checkin log actions (from queue panel)
  const startService = useCallback(async (id: string) => {
    if (!runtime.presentation.allowStatusMutations) return;
    armInactivityReset();
    if (submitInFlightRef.current || stateRef.current.isSubmitting) return;
    submitInFlightRef.current = true;
    const generation = generationRef.current;
    update({ isSubmitting: true, errorMessage: null });
    try {
      await runtime.checkins.startService(id);
      if (!isCurrentGeneration(generation)) return;
      await loadCheckins();
    } catch (e) {
      if (!isCurrentGeneration(generation)) return;
      rlog.error('[Wizard] startService failed:', e);
      update({ errorMessage: 'Failed to start service. Please try again.' });
    } finally {
      if (isCurrentGeneration(generation)) {
        releaseSubmitLock();
        update({ isSubmitting: false });
      }
    }
  }, [runtime, update, loadCheckins, armInactivityReset, releaseSubmitLock, isCurrentGeneration]);

  const completeCheckin = useCallback(async (id: string) => {
    if (!runtime.presentation.allowStatusMutations) return;
    armInactivityReset();
    if (submitInFlightRef.current || stateRef.current.isSubmitting) return;
    submitInFlightRef.current = true;
    const generation = generationRef.current;
    update({ isSubmitting: true, errorMessage: null });
    try {
      await runtime.checkins.complete(id);
      if (!isCurrentGeneration(generation)) return;
      await loadCheckins();
    } catch (e) {
      if (!isCurrentGeneration(generation)) return;
      rlog.error('[Wizard] completeCheckin failed:', e);
      update({ errorMessage: 'Failed to complete check-in. Please try again.' });
    } finally {
      if (isCurrentGeneration(generation)) {
        releaseSubmitLock();
        update({ isSubmitting: false });
      }
    }
  }, [runtime, update, loadCheckins, armInactivityReset, releaseSubmitLock, isCurrentGeneration]);

  const markNoShow = useCallback(async (id: string) => {
    if (!runtime.presentation.allowStatusMutations) return;
    armInactivityReset();
    if (submitInFlightRef.current || stateRef.current.isSubmitting) return;
    submitInFlightRef.current = true;
    const generation = generationRef.current;
    update({ isSubmitting: true, errorMessage: null });
    try {
      await runtime.checkins.markNoShow(id);
      if (!isCurrentGeneration(generation)) return;
      await loadCheckins();
    } catch (e) {
      if (!isCurrentGeneration(generation)) return;
      rlog.error('[Wizard] markNoShow failed:', e);
      update({ errorMessage: 'Failed to mark no-show. Please try again.' });
    } finally {
      if (isCurrentGeneration(generation)) {
        releaseSubmitLock();
        update({ isSubmitting: false });
      }
    }
  }, [runtime, update, loadCheckins, armInactivityReset, releaseSubmitLock, isCurrentGeneration]);

  return {
    state,
    presentation: runtime.presentation,
    goTo,
    reset,
    clearError,
    // Flow A
    selectBookingFlow,
    searchBookings,
    selectBooking,
    confirmBookingCheckin,
    // Flow B
    selectWalkInFlow,
    lookupPhone,
    skipPhone,
    createCustomer,
    goToServiceSelect,
    addService,
    removeService,
    selectStaff,
    goToConfirm,
    confirmWalkIn,
    // Checkin log
    startService,
    completeCheckin,
    markNoShow,
    loadCheckins,
  };
}
