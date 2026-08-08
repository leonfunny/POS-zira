import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Product, Category } from '../../../../hooks/usePosDb';
import type { PosState, PosAction } from '../../../../hooks/usePosStore';
import type {
  NailTurnBoardResponse,
  NailTurnStaffSummary,
  PosScheduleBookingSummary,
  PosScheduleDayResponse,
  PosScheduleStaffStatus,
  PosScheduleStaffSummary,
  PosScheduleWeekResponse,
} from '../../../../../shared/types';
import PaymentModal from '../../PaymentModal';
import Cart from '../../Cart';
import type { CartItem } from '../../../../hooks/usePosStore';
import SearchBar from '../../SearchBar';
import { resolveName } from '../../../../../shared/catalog-names';
import { isSaleBlockedByStock } from '../../../../../shared/product-stock-tracking';
import type { RestoredCartReconciliation } from '../../../../../shared/billiard-pos-handoff';

interface StaffMember {
  id: string;
  name: string;
  commission_rate: number;
  is_active: number;
}

interface SalonTemplateProps {
  state: PosState;
  dispatch: (action: PosAction) => void;
  t: (key: string) => string;
  language?: string;
  session: PosState['session'];
  onRestoredTenderOutcomeUncertain?: (reconciliation: RestoredCartReconciliation) => void;
}

const PLACEHOLDER_COLORS = [
  'bg-brand-100 text-brand-600',
  'bg-brand-100 text-brand-600',
  'bg-blue-100 text-blue-600',
  'bg-emerald-100 text-emerald-600',
  'bg-amber-100 text-amber-600',
  'bg-orange-100 text-orange-600',
  'bg-teal-100 text-teal-600',
  'bg-brand-100 text-brand-600',
];

function placeholderColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return PLACEHOLDER_COLORS[Math.abs(hash) % PLACEHOLDER_COLORS.length];
}

function turnStatusClasses(status?: string): string {
  switch (status) {
    case 'AVAILABLE':
      return 'border-emerald-200 bg-emerald-50 text-emerald-800';
    case 'BUSY':
      return 'border-blue-200 bg-blue-50 text-blue-800';
    case 'BREAK':
      return 'border-amber-200 bg-amber-50 text-amber-800';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-500';
  }
}

function turnStatusLabel(status?: string): string {
  switch (status) {
    case 'AVAILABLE': return 'Ranh';
    case 'BUSY': return 'Dang lam';
    case 'BREAK': return 'Nghi';
    case 'OFF': return 'Tat';
    default: return status || '-';
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return isoDate(new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0)));
}

function formatTime(value?: string | null, tz?: string): string {
  if (!value) return '--:--';
  return new Date(value).toLocaleTimeString('pl-PL', {
    hour: '2-digit',
    minute: '2-digit',
    // Salon timezone from the API response; device-local when absent.
    ...(tz ? { timeZone: tz } : {}),
  });
}

function formatDayLabel(value?: string | null): string {
  if (!value) return '--';
  const [year, month, day] = value.split('-').map(Number);
  // UTC-noon anchor: the rendered calendar day is stable in every timezone,
  // so no explicit timeZone is needed (was hardcoded Europe/Prague).
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).toLocaleDateString('vi-VN', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
}

function statusBadgeClass(status?: string): string {
  switch (status) {
    case 'CHECKED_IN':
      return 'border-sky-200 bg-sky-50 text-sky-800';
    case 'IN_SERVICE':
      return 'border-blue-200 bg-blue-50 text-blue-800';
    case 'COMPLETED':
    case 'PAID':
      return 'border-emerald-200 bg-emerald-50 text-emerald-800';
    case 'NO_SHOW':
    case 'CANCELLED':
      return 'border-rose-200 bg-rose-50 text-rose-800';
    default:
      return 'border-slate-200 bg-white text-slate-700';
  }
}

function bookingsForStaff(schedule: PosScheduleDayResponse | null, staffId: string): PosScheduleBookingSummary[] {
  return (schedule?.bookings || []).filter((booking) => booking.staff_profile_id === staffId);
}

export default function SalonTemplate({ state, dispatch, t, language, session, onRestoredTenderOutcomeUncertain }: SalonTemplateProps) {
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [nailTurnBoard, setNailTurnBoard] = useState<NailTurnBoardResponse | null>(null);
  const [nailTurnUnavailable, setNailTurnUnavailable] = useState(false);
  const [activeView, setActiveView] = useState<'sale' | 'schedule'>('sale');
  const [scheduleDate, setScheduleDate] = useState(() => isoDate(new Date()));
  const [schedule, setSchedule] = useState<PosScheduleDayResponse | null>(null);
  const [scheduleWeek, setScheduleWeek] = useState<PosScheduleWeekResponse | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleWeekLoading, setScheduleWeekLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleActionId, setScheduleActionId] = useState<string | null>(null);
  const [requestStaffByCheckin, setRequestStaffByCheckin] = useState<Record<string, string>>({});
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPayment, setShowPayment] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const productGridRef = useRef<HTMLDivElement>(null);

  const cart = state.cart;
  const lang = language || 'pl';
  const tip = state.tip ?? 0;
  const currency = t('pos.currency');
  const tOr = useCallback((key: string, fallback: string) => {
    const value = t(key);
    return value !== key ? value : fallback;
  }, [t]);
  const protectedCartBlocked = Boolean(
    state.checkoutDraft.holdRecallPending
    || (state.checkoutDraft.restoredInterruption
      && (state.checkoutDraft.restoredInterruption.persistenceError
        || state.checkoutDraft.restoredInterruption.tenderState !== 'READY')),
  );
  const shiftPaymentOpen = session.isOpen && !protectedCartBlocked;
  const shiftBlockedMessage = !session.isOpen
    ? tOr('pos.shift.openRequired', 'Open a shift to accept payments')
    : state.checkoutDraft.holdRecallPending
      ? 'Held cart recall is still being saved. Wait before paying.'
      : protectedCartBlocked
        ? 'This protected cart requires payment reconciliation. Do not charge again.'
    : undefined;

  const loadNailTurnBoard = useCallback(async () => {
    try {
      const result = await window.electronAPI.pos.nailTurns?.getToday?.();
      if (result?.success && result.board) {
        setNailTurnBoard(result.board);
        setNailTurnUnavailable(false);
        return;
      }
      setNailTurnBoard(null);
      setNailTurnUnavailable(true);
    } catch {
      setNailTurnBoard(null);
      setNailTurnUnavailable(true);
    }
  }, []);

  const loadSchedule = useCallback(async (date = scheduleDate, silent = false) => {
    if (!silent) setScheduleLoading(true);
    setScheduleError(null);
    try {
      const result = await window.electronAPI.pos.schedule?.getToday?.(date);
      if (result?.success && result.schedule) {
        setSchedule(result.schedule);
        setScheduleError(null);
        return;
      }
      setScheduleError(result?.error || 'schedule_unavailable');
    } catch (err: any) {
      setScheduleError(err?.message || 'schedule_failed');
    } finally {
      if (!silent) setScheduleLoading(false);
    }
  }, [scheduleDate]);

  const loadScheduleWeek = useCallback(async (from = scheduleDate) => {
    setScheduleWeekLoading(true);
    setScheduleError(null);
    try {
      const result = await window.electronAPI.pos.schedule?.getWeek?.(from, 7);
      if (result?.success && result.week) {
        setScheduleWeek(result.week);
        const selected = result.week.schedules.find((day: PosScheduleDayResponse) => day.business_date === from)
          || result.week.schedules[0];
        if (selected) {
          setSchedule(selected);
          setScheduleDate(selected.business_date);
        }
        return;
      }
      setScheduleError(result?.error || 'schedule_week_unavailable');
    } catch (err: any) {
      setScheduleError(err?.message || 'schedule_week_failed');
    } finally {
      setScheduleWeekLoading(false);
    }
  }, [scheduleDate]);

  const applyScheduleResult = useCallback((result: any) => {
    if (result?.success && result.schedule) {
      setSchedule(result.schedule);
      setScheduleError(null);
      return true;
    }
    setScheduleError(result?.error || 'schedule_action_failed');
    return false;
  }, []);

  const runScheduleAction = useCallback(async (
    actionId: string,
    action: () => Promise<any>,
  ) => {
    setScheduleActionId(actionId);
    setScheduleError(null);
    try {
      applyScheduleResult(await action());
    } catch (err: any) {
      setScheduleError(err?.message || 'schedule_action_failed');
    } finally {
      setScheduleActionId(null);
    }
  }, [applyScheduleResult]);

  const setStaffStatus = useCallback((staffProfileId: string, status: PosScheduleStaffStatus) => {
    const actionId = `status:${staffProfileId}:${status}`;
    runScheduleAction(actionId, () => window.electronAPI.pos.schedule.setStaffStatus({
      staffProfileId,
      status,
      idempotencyKey: `pos-zira:staff-status:${staffProfileId}:${status}:${Date.now()}`,
    }));
  }, [runScheduleAction]);

  const assignNextCheckin = useCallback((checkin: NonNullable<PosScheduleDayResponse['waiting_checkins']>[number]) => {
    const actionId = `assign:${checkin.id}`;
    runScheduleAction(actionId, () => window.electronAPI.pos.schedule.assignNext({
      checkinLogId: checkin.id,
      bookingId: checkin.booking_id,
      customerName: checkin.customer_name,
      serviceName: checkin.service_name,
      idempotencyKey: `pos-zira:assign-next:${checkin.id}:${Date.now()}`,
    }));
  }, [runScheduleAction]);

  const requestStaffForCheckin = useCallback((checkin: NonNullable<PosScheduleDayResponse['waiting_checkins']>[number]) => {
    const staffProfileId = requestStaffByCheckin[checkin.id];
    if (!staffProfileId) {
      setScheduleError('Chon tho truoc khi request');
      return;
    }
    const actionId = `request:${checkin.id}`;
    runScheduleAction(actionId, () => window.electronAPI.pos.schedule.requestStaff({
      checkinLogId: checkin.id,
      staffProfileId,
      bookingId: checkin.booking_id,
      customerName: checkin.customer_name,
      serviceName: checkin.service_name,
      idempotencyKey: `pos-zira:request-staff:${checkin.id}:${staffProfileId}:${Date.now()}`,
    }));
  }, [requestStaffByCheckin, runScheduleAction]);

  const loadStaff = useCallback(() => {
    window.electronAPI.pos.staff.getAll().then(setStaffList);
  }, []);

  // Load staff and categories once
  useEffect(() => {
    loadStaff();
    const syncStaff = window.electronAPI.pos.sync.staff;
    if (syncStaff) syncStaff().then(loadStaff).catch(() => {});
  }, [loadStaff]);

  useEffect(() => {
    return window.electronAPI.pos.sync.onStaffUpdated?.(() => loadStaff());
  }, [loadStaff]);

  useEffect(() => {
    window.electronAPI.pos.categories.getAll().then(setCategories);
    window.electronAPI.pos.products.getAll().then(setAllProducts);
  }, [catalogRevision]);

  useEffect(() => {
    if (activeCategoryId && !categories.some((category) => category.id === activeCategoryId)) {
      setActiveCategoryId(null);
    }
  }, [activeCategoryId, categories]);

  // Reset product grid scroll when category changes
  useEffect(() => {
    productGridRef.current?.scrollTo({ top: 0 });
  }, [activeCategoryId]);

  // Load filtered products
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let result: Product[];
      if (searchQuery) {
        result = await window.electronAPI.pos.products.search(searchQuery);
        if (activeCategoryId) result = result.filter((p) => p.category_id === activeCategoryId);
      } else if (activeCategoryId) {
        result = await window.electronAPI.pos.products.getByCategory(activeCategoryId);
      } else {
        result = await window.electronAPI.pos.products.getAll();
      }
      if (!cancelled) setProducts(result);
    };
    if (searchQuery) {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(load, 250);
    } else {
      load();
    }
    return () => {
      cancelled = true;
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [activeCategoryId, catalogRevision, searchQuery]);

  // Refresh on sync
  useEffect(() => {
    const unsub = window.electronAPI.pos.sync.onProductsSynced(() => {
      setCatalogRevision((revision) => revision + 1);
    });
    return unsub;
  }, []);

  useEffect(() => {
    loadNailTurnBoard();
    const unsubscribe = window.electronAPI.pos.nailTurns?.onUpdated?.(() => {
      loadNailTurnBoard();
      if (activeView === 'schedule') {
        loadSchedule();
      }
    });
    return unsubscribe || undefined;
  }, [activeView, loadNailTurnBoard, loadSchedule]);

  useEffect(() => {
    if (activeView === 'schedule') {
      loadSchedule(scheduleDate);
    }
  }, [activeView, loadSchedule, scheduleDate]);

  useEffect(() => {
    if (activeView !== 'schedule') return undefined;
    const refresh = () => {
      if (document.visibilityState !== 'hidden') {
        loadSchedule(scheduleDate, true);
      }
    };
    const interval = window.setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [activeView, loadSchedule, scheduleDate]);

  const handleAddProduct = useCallback(
    (product: Product) => {
      if (isSaleBlockedByStock(product, product.available_qty ?? product.in_stock)) return;
      dispatch({
        type: 'cart/addItem',
        payload: {
          id: crypto.randomUUID(),
          variantId: product.id,
          name: product.name,
          name_translations: product.name_translations ?? null,
          sku: product.sku || '',
          price: product.retail_price,
          quantity: 1,
          total: product.retail_price,
          saleUnit: product.sale_unit ?? null,
          sellBy: product.sell_by ?? 'PIECE',
          imageUrl: product.image_url || undefined,
          vatRate: product.vat_rate,
        },
      });
    },
    [dispatch],
  );

  const handleBarcodeScanned = useCallback(async (barcode: string) => {
    const product = await window.electronAPI.pos.products.getByBarcode(barcode);
    if (product) handleAddProduct(product);
  }, [handleAddProduct]);

  const setScheduleDay = useCallback((date: string) => {
    setScheduleDate(date);
    const cachedDay = scheduleWeek?.schedules.find((day) => day.business_date === date);
    if (cachedDay) setSchedule(cachedDay);
    setActiveView('schedule');
  }, [scheduleWeek]);
  const nextTurnStaff = schedule?.next_turn
    ? schedule.staff.find((staff) => staff.staff_profile_id === schedule.next_turn?.staff_profile_id)
    : null;

  return (
    <>
      <div className="flex-1 flex overflow-hidden bg-slate-50">

        {/* ── Left panel ── */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">

          <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3 shrink-0">
            <button
              type="button"
              onClick={() => setActiveView('sale')}
              className={`h-12 rounded-md border px-5 text-sm font-bold transition-colors ${
                activeView === 'sale'
                  ? 'border-brand-500 bg-brand-500 text-white'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              Ban hang
            </button>
            <button
              type="button"
              onClick={() => setActiveView('schedule')}
              className={`h-12 rounded-md border px-5 text-sm font-bold transition-colors ${
                activeView === 'schedule'
                  ? 'border-brand-500 bg-brand-500 text-white'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              Lich tho
            </button>
            {activeView === 'schedule' && (
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setScheduleDay(isoDate(new Date()))}
                  className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  Hom nay
                </button>
                <button
                  type="button"
                  onClick={() => setScheduleDay(addDays(isoDate(new Date()), 1))}
                  className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  Ngay mai
                </button>
                <button
                  type="button"
                  disabled={scheduleWeekLoading}
                  onClick={() => loadScheduleWeek(scheduleDate)}
                  className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {scheduleWeekLoading ? 'Dang tai...' : 'Tuan'}
                </button>
                <input
                  type="date"
                  value={scheduleDate}
                  onChange={(event) => setScheduleDay(event.target.value)}
                  className="h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-bold text-slate-800"
                />
                <button
                  type="button"
                  onClick={() => loadSchedule(scheduleDate)}
                  className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  Refresh
                </button>
              </div>
            )}
          </div>

          {activeView === 'schedule' && scheduleWeek?.schedules?.length ? (
            <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
              <div className="flex gap-2 overflow-x-auto no-scrollbar">
                {scheduleWeek.schedules.map((day) => {
                  const selected = day.business_date === scheduleDate;
                  return (
                    <button
                      key={day.business_date}
                      type="button"
                      onClick={() => setScheduleDay(day.business_date)}
                      className={`min-h-[58px] min-w-[116px] rounded-md border px-3 text-left transition-colors ${
                        selected
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 bg-slate-50 text-slate-800 hover:bg-white'
                      }`}
                    >
                      <div className="text-sm font-black">{formatDayLabel(day.business_date)}</div>
                      <div className={`mt-1 text-[11px] font-bold ${selected ? 'text-slate-200' : 'text-slate-500'}`}>
                        {day.bookings?.length || 0} booking · {day.waiting_checkins?.length || 0} cho
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Toolbar: search + category pills */}
          <div className={`items-center gap-2.5 px-4 pt-4 pb-2 shrink-0 ${activeView === 'sale' ? 'flex' : 'hidden'}`}>
            {/* Search */}
            <div className="w-56 shrink-0">
              <SearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                onBarcodeScanned={handleBarcodeScanned}
                placeholder={t('pos.search') || 'Search services...'}
              />
            </div>

            {/* Category pills */}
            <div className="flex-1 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              <button
                onClick={() => setActiveCategoryId(null)}
                className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-150 cursor-pointer touch-manipulation border ${
                  activeCategoryId === null
                    ? 'bg-brand-500 text-white border-brand-500 shadow-sm'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-brand-300 hover:text-brand-600'
                }`}
              >
                {t('pos.allCategories') || 'All'}
              </button>
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategoryId(activeCategoryId === cat.id ? null : cat.id)}
                  className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-150 cursor-pointer touch-manipulation border ${
                    activeCategoryId === cat.id
                      ? 'text-white shadow-sm'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-brand-300 hover:text-brand-600'
                  }`}
                  style={
                    activeCategoryId === cat.id
                      ? { backgroundColor: cat.color || 'var(--color-brand-500)', borderColor: cat.color || 'var(--color-brand-500)' }
                      : undefined
                  }
                >
                  {resolveName(cat, lang)}
                </button>
              ))}
            </div>
          </div>

          {activeView === 'sale' && nailTurnBoard && !nailTurnUnavailable && (
            <div className="mx-4 mb-2 shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-bold uppercase tracking-normal text-slate-500">
                    {tOr('pos.salon.turnBoard', 'Lượt thợ')}
                  </div>
                  <div className="truncate text-sm font-semibold text-slate-900">
                    {nailTurnBoard.day?.strategy === 'MONEY_BALANCE'
                      ? tOr('pos.salon.moneyBalance', 'Chia theo tiền')
                      : tOr('pos.salon.roundRobin', 'Chia theo vòng')}
                    {typeof nailTurnBoard.day?.half_turn_threshold_pln === 'number'
                      ? ` · Half < ${nailTurnBoard.day.half_turn_threshold_pln.toFixed(0)} ${currency}`
                      : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={loadNailTurnBoard}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  aria-label="Refresh nail turn board"
                  title={tOr('pos.salon.refreshTurns', 'Làm mới lượt thợ')}
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M5 19A8 8 0 0019 8M19 5a8 8 0 00-14 11" />
                  </svg>
                </button>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
                {(nailTurnBoard.staff || []).map((staff: NailTurnStaffSummary) => {
                  const active = (nailTurnBoard.active_assignments || []).find((a) => a.staff_profile_id === staff.staff_profile_id);
                  return (
                    <div
                      key={staff.staff_profile_id}
                      className={`min-w-[148px] rounded-md border px-3 py-2 ${turnStatusClasses(staff.status)}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-bold">{staff.queue_position ? `${staff.queue_position}. ` : ''}{staff.name || '-'}</span>
                        <span className="shrink-0 text-[11px] font-bold uppercase">{turnStatusLabel(staff.status)}</span>
                      </div>
                      <div className="mt-1 truncate text-xs font-semibold opacity-80">
                        {active?.customer_name || `${(staff.revenue_today_pln || 0).toFixed(0)} ${currency}`}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeView === 'schedule' && (
            <div className="flex-1 min-h-0 overflow-hidden px-4 pb-4">
              <div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)] gap-3">
                <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto">
                  <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="mb-2 text-xs font-bold uppercase text-slate-500">Luot tiep theo</div>
                    <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                      <div className="text-lg font-black text-emerald-900">
                        {nextTurnStaff?.name || schedule?.next_turn?.name || 'Chua co'}
                      </div>
                      <div className="mt-1 text-xs font-bold uppercase text-emerald-700">
                        {nextTurnStaff?.status ? turnStatusLabel(nextTurnStaff.status) : 'Next turn'}
                      </div>
                    </div>
                  </section>

                  <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-xs font-bold uppercase text-slate-500">Khach dang cho</div>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-bold text-slate-700">
                        {schedule?.waiting_checkins?.length || 0}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {scheduleLoading && <div className="rounded-md border border-slate-200 p-3 text-sm font-semibold text-slate-500">Dang tai lich...</div>}
                      {scheduleError && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">{scheduleError}</div>}
                      {!scheduleLoading && !scheduleError && (schedule?.waiting_checkins || []).length === 0 && (
                        <div className="rounded-md border border-slate-200 p-3 text-sm font-semibold text-slate-500">Khong co khach cho</div>
                      )}
                      {(schedule?.waiting_checkins || []).map((checkin) => (
                        <div key={checkin.id} className="rounded-md border border-amber-200 bg-amber-50 p-3">
                          <div className="truncate text-sm font-black text-slate-900">{checkin.customer_name || 'Walk-in'}</div>
                          <div className="mt-1 truncate text-xs font-semibold text-slate-600">{checkin.service_name || 'Service'}</div>
                          <div className="mt-2 text-xs font-bold text-amber-800">{formatTime(checkin.checked_in_at, schedule?.salon?.timezone)}</div>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              disabled={scheduleActionId === `assign:${checkin.id}`}
                              onClick={() => assignNextCheckin(checkin)}
                              className="min-h-[44px] rounded-md bg-slate-900 px-3 text-xs font-black text-white disabled:opacity-50"
                            >
                              {scheduleActionId === `assign:${checkin.id}` ? 'Dang gan...' : 'Gan tiep'}
                            </button>
                            <select
                              value={requestStaffByCheckin[checkin.id] || ''}
                              onChange={(event) => setRequestStaffByCheckin((prev) => ({ ...prev, [checkin.id]: event.target.value }))}
                              className="min-h-[44px] rounded-md border border-amber-300 bg-white px-2 text-xs font-bold text-slate-900"
                            >
                              <option value="">Chon tho</option>
                              {(schedule?.staff || []).map((staff) => (
                                <option key={staff.staff_profile_id} value={staff.staff_profile_id}>
                                  {staff.name || 'Staff'}
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            disabled={scheduleActionId === `request:${checkin.id}` || !requestStaffByCheckin[checkin.id]}
                            onClick={() => requestStaffForCheckin(checkin)}
                            className="mt-2 min-h-[44px] w-full rounded-md border border-amber-300 bg-white px-3 text-xs font-black text-amber-900 disabled:opacity-50"
                          >
                            {scheduleActionId === `request:${checkin.id}` ? 'Dang request...' : 'Request tho nay'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="mb-2 text-xs font-bold uppercase text-slate-500">Dang lam</div>
                    <div className="space-y-2">
                      {(schedule?.active_assignments || []).length === 0 && (
                        <div className="rounded-md border border-slate-200 p-3 text-sm font-semibold text-slate-500">Chua co assignment active</div>
                      )}
                      {(schedule?.active_assignments || []).map((assignment) => {
                        const staff = schedule?.staff.find((item) => item.staff_profile_id === assignment.staff_profile_id);
                        return (
                          <div key={assignment.id} className="rounded-md border border-blue-200 bg-blue-50 p-3">
                            <div className="truncate text-sm font-black text-slate-900">{assignment.customer_name || 'Walk-in'}</div>
                            <div className="mt-1 truncate text-xs font-semibold text-slate-600">{assignment.service_name || 'Service'}</div>
                            <div className="mt-2 text-xs font-bold text-blue-800">{staff?.name || 'Staff'} · {formatTime(assignment.assigned_at, schedule?.salon?.timezone)}</div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </aside>

                <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                  <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                    <div>
                      <div className="text-lg font-black text-slate-900">Lich tho</div>
                      <div className="text-xs font-semibold text-slate-500">
                        {schedule?.business_date || scheduleDate} · {schedule?.bookings?.length || 0} booking · timezone {schedule?.salon?.timezone || 'local'}
                      </div>
                    </div>
                    <div className="text-xs font-bold text-slate-500">
                      {schedule?.stale
                        ? `Offline cache ${schedule.cached_at ? formatTime(schedule.cached_at, schedule?.salon?.timezone) : ''}`
                        : schedule?.server_time
                          ? `Sync ${formatTime(schedule.server_time, schedule?.salon?.timezone)}`
                          : 'Chua sync'}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto">
                    <div
                      className="grid min-w-max grid-cols-[72px_repeat(var(--staff-count),220px)]"
                      style={{ '--staff-count': Math.max(schedule?.staff?.length || 1, 1) } as React.CSSProperties}
                    >
                      <div className="sticky left-0 top-0 z-20 border-b border-r border-slate-200 bg-slate-50 p-3 text-xs font-black uppercase text-slate-500">
                        Gio
                      </div>
                      {(schedule?.staff || []).map((staff: PosScheduleStaffSummary) => (
                        <div key={staff.staff_profile_id} className="sticky top-0 z-10 border-b border-r border-slate-200 bg-slate-50 p-3">
                          <div className="truncate text-sm font-black text-slate-900">{staff.queue_position ? `${staff.queue_position}. ` : ''}{staff.name || 'Staff'}</div>
                          <div className={`mt-2 inline-flex rounded-full border px-2 py-1 text-[11px] font-black uppercase ${turnStatusClasses(staff.status)}`}>
                            {turnStatusLabel(staff.status)}
                          </div>
                          <div className="mt-3 grid grid-cols-3 gap-1">
                            {(['AVAILABLE', 'BREAK', 'OFF'] as PosScheduleStaffStatus[]).map((status) => {
                              const active = staff.status === status;
                              const actionId = `status:${staff.staff_profile_id}:${status}`;
                              return (
                                <button
                                  key={status}
                                  type="button"
                                  disabled={active || scheduleActionId === actionId}
                                  onClick={() => setStaffStatus(staff.staff_profile_id, status)}
                                  className={`min-h-[38px] rounded-md border px-1 text-[10px] font-black uppercase ${
                                    active
                                      ? 'border-slate-900 bg-slate-900 text-white'
                                      : 'border-slate-200 bg-white text-slate-700'
                                  } disabled:opacity-60`}
                                >
                                  {status === 'AVAILABLE' ? 'Ranh' : status === 'BREAK' ? 'Nghi' : 'Off'}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      <div className="sticky left-0 z-10 border-r border-slate-200 bg-white">
                        {Array.from({ length: 13 }, (_, idx) => 8 + idx).map((hour) => (
                          <div key={hour} className="h-16 border-b border-slate-100 px-3 py-2 text-xs font-bold text-slate-500">
                            {String(hour).padStart(2, '0')}:00
                          </div>
                        ))}
                      </div>
                      {(schedule?.staff || []).map((staff: PosScheduleStaffSummary) => (
                        <div key={`${staff.staff_profile_id}-body`} className="min-h-[832px] border-r border-slate-100 bg-white p-2">
                          <div className="space-y-2">
                            {bookingsForStaff(schedule, staff.staff_profile_id).length === 0 && (
                              <div className="rounded-md border border-dashed border-slate-200 p-3 text-xs font-semibold text-slate-400">Trong</div>
                            )}
                            {bookingsForStaff(schedule, staff.staff_profile_id).map((booking) => (
                              <div key={booking.id} className={`rounded-md border p-3 shadow-sm ${statusBadgeClass(booking.status)}`}>
                                <div className="text-xs font-black text-slate-500">{formatTime(booking.starts_at, schedule?.salon?.timezone)} - {formatTime(booking.ends_at, schedule?.salon?.timezone)}</div>
                                <div className="mt-1 truncate text-sm font-black text-slate-900">{booking.customer_name || 'Customer'}</div>
                                <div className="mt-1 line-clamp-2 text-xs font-semibold text-slate-600">{booking.service_name || 'Service'}</div>
                                <div className="mt-2 inline-flex rounded-full border border-current px-2 py-0.5 text-[10px] font-black uppercase">
                                  {booking.status || 'BOOKED'}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              </div>
            </div>
          )}

          {/* Service grid */}
          <div ref={productGridRef} className={`flex-1 overflow-y-auto px-4 pb-4 ${activeView === 'sale' ? '' : 'hidden'}`}>
            {products.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-400 text-sm">
                {t('pos.noProducts') || 'No services found'}
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-2.5">
                {products.map((product) => {
                  const colorClass = placeholderColor(product.name);
                  const displayName = resolveName(product, lang) || product.name;
                  return (
                    <div
                      key={product.id}
                      className="bg-white border border-slate-100 rounded-xl overflow-hidden shadow-sm hover:shadow-md hover:border-brand-200 transition-all duration-200 group"
                    >
                      {/* Image / placeholder */}
                      <div className="relative aspect-[3/2] w-full overflow-hidden bg-slate-50">
                        {product.image_url ? (
                          <img
                            src={product.image_url}
                            alt={displayName}
                            loading="lazy"
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                        ) : (
                          <div className={`w-full h-full flex items-center justify-center text-2xl font-bold ${colorClass}`}>
                            {displayName.charAt(0).toUpperCase()}
                          </div>
                        )}
                        {/* Circular add button */}
                        <button
                          onClick={() => handleAddProduct(product)}
                          aria-label={`Add ${displayName}`}
                          className="absolute bottom-1.5 right-1.5 w-8 h-8 bg-brand-500 hover:bg-brand-600 active:bg-brand-700 text-white rounded-full flex items-center justify-center shadow-md active:scale-95 transition-all cursor-pointer touch-manipulation"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                          </svg>
                        </button>
                      </div>

                      {/* Name + price */}
                      <div className="px-2.5 py-2">
                        <div className="text-xs font-medium text-slate-800 leading-snug truncate">
                          {displayName}
                        </div>
                        <div className="text-xs font-bold text-brand-500 mt-0.5">
                          {(product.retail_price / 100).toFixed(2)}&nbsp;{currency}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Right panel: Current Order ── */}
        {/*
          Shared cart. The salon used to render its own panel; the only thing it
          did that the shared one does not is a per-line staff picker, which the
          shared cart already has a seam for (`renderItemExtra`). Keeping one
          implementation means one place to restyle and one place to fix.
        */}
        <div className="w-80 xl:w-[340px] border-l border-slate-200 flex flex-col bg-white shrink-0">
          <Cart
            cart={cart}
            dispatch={dispatch}
            onPay={() => setShowPayment(true)}
            t={t}
            lang={lang}
            shiftOpen={shiftPaymentOpen}
            shiftBlockReason={shiftBlockedMessage}
            tip={tip}
            renderItemExtra={(item: CartItem) => (
              staffList.length > 0 ? (
                <select
                  value={item.staffId || ''}
                  onChange={(e) => {
                    const staff = staffList.find((s) => s.id === e.target.value);
                    if (staff) {
                      dispatch({
                        type: 'cart/setItemStaff',
                        payload: { id: item.id, staffId: staff.id, staffName: staff.name },
                      });
                    }
                  }}
                  aria-label={t('pos.salon.staff') || 'Staff'}
                  className="mt-1 w-full px-2 py-1 text-[11px] bg-slate-50 border border-slate-200 rounded-lg text-slate-500 appearance-none focus:outline-none focus:border-brand-400 cursor-pointer"
                >
                  <option value="">{t('pos.salon.noStaff') || 'No staff'}</option>
                  {staffList.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              ) : null
            )}
          />
        </div>
      </div>

      {showPayment && (
        <PaymentModal
          cart={cart}
          dispatch={dispatch}
          onClose={() => setShowPayment(false)}
          onTenderOutcomeUncertain={(_message, reconciliation) => {
            if (!reconciliation) return;
            setShowPayment(false);
            onRestoredTenderOutcomeUncertain?.(reconciliation);
          }}
          onComplete={() => {
            setShowPayment(false);
            loadNailTurnBoard();
          }}
          t={t}
          shiftId={session.shiftId}
          staffId={session.staffId}
          staffName={session.staffName}
          checkoutDraft={state.checkoutDraft}
          extraOrderFields={{ tip, mode: 'salon' }}
        />
      )}
    </>
  );
}
