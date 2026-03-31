import { useState, useCallback, useEffect, useRef } from 'react';
import { BooksyBookingSummary } from '../../shared/types';

export type WizardStep =
  | 'entry'
  | 'booking-list'
  | 'booking-detail'
  | 'phone-entry'
  | 'customer-found'
  | 'new-customer'
  | 'service-select'
  | 'confirm'
  | 'done';

export type WizardFlow = 'booking' | 'walkin' | null;

export interface SalonCustomerData {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  birthday?: string;
  notes?: string;
  preferred_staff_id?: string;
  preferred_staff_name?: string;
  visit_count: number;
  last_visit_at?: string;
  last_service_name?: string;
}

export interface ServiceItem {
  id: string;
  name: string;
  retail_price: number;
  category_id?: string;
}

export interface StaffItem {
  id: string;
  name: string;
}

export interface CategoryItem {
  id: string;
  name: string;
}

export interface SelectedService {
  id: string;
  name: string;
  price: number;
  duration?: number;
}

export interface ServiceRecommendation {
  service_name: string;
  service_id: string | null;
  count: number;
}

export interface WizardState {
  step: WizardStep;
  flow: WizardFlow;
  selectedBooking: BooksyBookingSummary | null;
  phoneNumber: string;
  customer: SalonCustomerData | null;
  isNewCustomer: boolean;
  newCustomerForm: { name: string; phone: string; birthday: string; notes: string };
  selectedServices: SelectedService[];
  selectedStaff: StaffItem | null;
  recommendations: ServiceRecommendation[];
  bestsellers: ServiceRecommendation[];
  todayBookings: BooksyBookingSummary[];
  staffList: StaffItem[];
  services: ServiceItem[];
  categories: CategoryItem[];
  checkins: any[];
  stats: { total: number; waiting: number; inService: number; completed: number; noShow: number; walkIns: number };
  isLoading: boolean;
  isSubmitting: boolean;
  errorMessage: string | null;
}

const initialState: WizardState = {
  step: 'entry',
  flow: null,
  selectedBooking: null,
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

export function useCheckinWizard() {
  const [state, setState] = useState<WizardState>(initialState);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stateRef = useRef<WizardState>(state);
  stateRef.current = state;

  const update = useCallback((patch: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  // Load checkins + stats
  const loadCheckins = useCallback(async () => {
    try {
      const [checkins, stats] = await Promise.all([
        window.electronAPI.checkin.getToday(),
        window.electronAPI.checkin.getStats(),
      ]);
      update({ checkins, stats });
    } catch (e) {
      console.error('[Wizard] Failed to load checkins:', e);
    }
  }, [update]);

  // Load bookings
  const loadBookings = useCallback(async () => {
    try {
      const data = await window.electronAPI.booksy.getBookings();
      update({ todayBookings: data || [] });
    } catch (e) {
      console.error('[Wizard] Failed to load bookings:', e);
    }
  }, [update]);

  // Load services + staff + categories
  const loadCatalog = useCallback(async () => {
    try {
      const [products, categories, staff] = await Promise.all([
        window.electronAPI.pos.products.getAll(),
        window.electronAPI.pos.categories.getAll(),
        window.electronAPI.pos.staff.getAll(),
      ]);
      update({
        services: products.map((p: any) => ({ id: p.id, name: p.name, retail_price: p.retail_price, category_id: p.category_id })),
        categories: categories.map((c: any) => ({ id: c.id, name: c.name })),
        staffList: staff.map((s: any) => ({ id: s.id, name: s.name })),
      });
    } catch (e) {
      console.error('[Wizard] Failed to load catalog:', e);
    }
  }, [update]);

  // Initial load + polling
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

  // Navigation
  const goTo = useCallback((step: WizardStep) => update({ step }), [update]);

  const reset = useCallback(() => {
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    setState((prev) => ({
      ...initialState,
      todayBookings: prev.todayBookings,
      staffList: prev.staffList,
      services: prev.services,
      categories: prev.categories,
      checkins: prev.checkins,
      stats: prev.stats,
    }));
  }, []);

  const clearError = useCallback(() => {
    update({ errorMessage: null });
  }, [update]);

  // Flow A: Booking
  const selectBookingFlow = useCallback(() => {
    update({ flow: 'booking', step: 'booking-list' });
  }, [update]);

  const selectBooking = useCallback((booking: BooksyBookingSummary) => {
    update({ selectedBooking: booking, step: 'booking-detail' });
  }, [update]);

  const confirmBookingCheckin = useCallback(async (booking: BooksyBookingSummary, staffName?: string, staffId?: string) => {
    if (stateRef.current.isSubmitting) return;
    update({ isSubmitting: true, errorMessage: null });
    const id = `ci-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      await window.electronAPI.checkin.createWithCustomer({
        id,
        customer_name: booking.customerName,
        service_name: booking.serviceName,
        staff_name: staffName || booking.staffName,
        staff_id: staffId,
        booking_id: booking.id.toString(),
        booking_source: 'booksy',
        is_walkin: 0,
      });
      update({ step: 'done', isSubmitting: false });
      await loadCheckins();
      doneTimerRef.current = setTimeout(reset, 8000);
    } catch (e) {
      console.error('[Wizard] Booking check-in failed:', e);
      update({ isSubmitting: false, errorMessage: 'Check-in failed. Please try again.' });
    }
  }, [update, loadCheckins, reset]);

  // Flow B: Walk-in
  const selectWalkInFlow = useCallback(() => {
    update({ flow: 'walkin', step: 'phone-entry' });
  }, [update]);

  const lookupPhone = useCallback(async (phone: string) => {
    update({ phoneNumber: phone, isLoading: true, errorMessage: null });
    try {
      const customer = await window.electronAPI.salonCustomer.getByPhone(phone);
      if (customer) {
        const recommendations = await window.electronAPI.salonCustomer.getRecommendations(customer.id);
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
      console.error('[Wizard] Phone lookup failed:', e);
      update({
        isLoading: false,
        errorMessage: 'Phone lookup failed. Please try again.',
      });
    }
  }, [update]);

  const skipPhone = useCallback(() => {
    update({
      phoneNumber: '',
      customer: null,
      isNewCustomer: true,
      newCustomerForm: { name: '', phone: '', birthday: '', notes: '' },
      step: 'new-customer',
    });
  }, [update]);

  const createCustomer = useCallback(async (form: { name: string; phone: string; birthday?: string; notes?: string }) => {
    try {
      const id = `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const result = await window.electronAPI.salonCustomer.create({
        id,
        name: form.name || 'Guest',
        phone: form.phone || undefined,
        birthday: form.birthday || undefined,
        notes: form.notes || undefined,
      });
      if (result.success && result.data) {
        const bestsellers = await window.electronAPI.servicePopularity.get();
        update({
          customer: result.data,
          isNewCustomer: false,
          bestsellers: bestsellers || [],
          recommendations: [],  // clear any recommendations from a previous customer lookup
          step: 'service-select',
        });
      }
    } catch (e) {
      console.error('[Wizard] Create customer failed:', e);
      update({ errorMessage: 'Failed to create customer profile. Please try again.' });
    }
  }, [update]);

  const goToServiceSelect = useCallback(async () => {
    let bestsellers: any[] = [];
    try {
      bestsellers = await window.electronAPI.servicePopularity.get();
    } catch { /* ignore */ }
    update({ bestsellers: bestsellers || [], step: 'service-select' });
  }, [update]);

  const addService = useCallback((svc: SelectedService) => {
    setState((prev) => ({
      ...prev,
      selectedServices: [...prev.selectedServices, svc],
    }));
  }, []);

  const removeService = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      selectedServices: prev.selectedServices.filter((s) => s.id !== id),
    }));
  }, []);

  const selectStaff = useCallback((staff: StaffItem | null) => {
    update({ selectedStaff: staff });
  }, [update]);

  const goToConfirm = useCallback(() => {
    update({ step: 'confirm' });
  }, [update]);

  const confirmWalkIn = useCallback(async () => {
    if (stateRef.current.isSubmitting) return;
    const { customer, selectedServices, selectedStaff } = stateRef.current;
    update({ isSubmitting: true, errorMessage: null });
    const id = `ci-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const serviceName = selectedServices.map((s) => s.name).join(', ') || undefined;
    const serviceId = selectedServices[0]?.id;
    try {
      await window.electronAPI.checkin.createWithCustomer({
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
      update({ step: 'done', isSubmitting: false });
      await loadCheckins();
      doneTimerRef.current = setTimeout(reset, 8000);
    } catch (e) {
      console.error('[Wizard] Walk-in check-in failed:', e);
      update({ isSubmitting: false, errorMessage: 'Check-in failed. Please try again.' });
    }
  }, [update, loadCheckins, reset]);

  // Checkin log actions (from queue panel)
  const startService = useCallback(async (id: string) => {
    if (stateRef.current.isSubmitting) return;
    update({ isSubmitting: true, errorMessage: null });
    try {
      await window.electronAPI.checkin.startService(id);
      await loadCheckins();
    } catch (e) {
      console.error('[Wizard] startService failed:', e);
      update({ errorMessage: 'Failed to start service. Please try again.' });
    } finally {
      update({ isSubmitting: false });
    }
  }, [update, loadCheckins]);

  const completeCheckin = useCallback(async (id: string) => {
    if (stateRef.current.isSubmitting) return;
    update({ isSubmitting: true, errorMessage: null });
    try {
      await window.electronAPI.checkin.complete(id);
      await loadCheckins();
    } catch (e) {
      console.error('[Wizard] completeCheckin failed:', e);
      update({ errorMessage: 'Failed to complete check-in. Please try again.' });
    } finally {
      update({ isSubmitting: false });
    }
  }, [update, loadCheckins]);

  const markNoShow = useCallback(async (id: string) => {
    if (stateRef.current.isSubmitting) return;
    update({ isSubmitting: true, errorMessage: null });
    try {
      await window.electronAPI.checkin.markNoShow(id);
      await loadCheckins();
    } catch (e) {
      console.error('[Wizard] markNoShow failed:', e);
      update({ errorMessage: 'Failed to mark no-show. Please try again.' });
    } finally {
      update({ isSubmitting: false });
    }
  }, [update, loadCheckins]);

  return {
    state,
    goTo,
    reset,
    clearError,
    // Flow A
    selectBookingFlow,
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
