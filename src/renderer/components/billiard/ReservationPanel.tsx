import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { humanizeBilliardError } from './utils';
import {
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Loader2,
  Phone,
  Plus,
  RefreshCw,
  UserRound,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useBilliardApi } from '../../hooks/useBilliardApi';
import {
  buildBilliardBookingStartsAt,
  type NormalizedBilliardAvailability,
  type NormalizedBilliardBooking,
} from '../../../shared/billiard-contract';

interface TableInfo {
  id: string;
  name: string;
}

interface ReservationPanelProps {
  language: Language;
  tables: TableInfo[];
  onClose: () => void;
  onCheckedIn?: () => Promise<void> | void;
}

function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return localDateKey(value);
}

function formatMoney(value: number, currency = 'PLN'): string {
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency }).format(value);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '--:--'
    : new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function statusTone(status: string): string {
  if (status === 'BOOKED') return 'border-blue-200 bg-blue-50 text-blue-700';
  if (status === 'CHECKED_IN') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

export function ReservationPanel({
  language,
  tables,
  onClose,
  onCheckedIn,
}: ReservationPanelProps) {
  const { t } = useTranslation(language);
  const { bookingsApi } = useBilliardApi();
  const today = localDateKey();
  const reservationLoadFailed = t('billiard.reservationLoadFailed');
  const availabilityFailed = t('billiard.availabilityFailed');

  const [date, setDate] = useState(today);
  const [bookings, setBookings] = useState<NormalizedBilliardBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const bookingsRequestGeneration = useRef(0);
  const currentBookingsDate = useRef(date);
  currentBookingsDate.current = date;

  const [formOpen, setFormOpen] = useState(false);
  const [resourceId, setResourceId] = useState(tables[0]?.id || '');
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [durationHours, setDurationHours] = useState(1);
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [guestCount, setGuestCount] = useState(1);
  const [notes, setNotes] = useState('');
  const [availability, setAvailability] = useState<NormalizedBilliardAvailability | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadBookings = useCallback(async () => {
    // An action handler may retain an older callback after the user changes
    // dates. Do not let that stale closure start a new authoritative request.
    if (date !== currentBookingsDate.current) return;
    const requestGeneration = ++bookingsRequestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const nextBookings = await bookingsApi.list(date);
      if (
        requestGeneration !== bookingsRequestGeneration.current
        || date !== currentBookingsDate.current
      ) return;
      setBookings(nextBookings);
    } catch (err: any) {
      if (
        requestGeneration !== bookingsRequestGeneration.current
        || date !== currentBookingsDate.current
      ) return;
      setError(err?.message || reservationLoadFailed);
    } finally {
      if (
        requestGeneration === bookingsRequestGeneration.current
        && date === currentBookingsDate.current
      ) {
        setLoading(false);
      }
    }
  }, [bookingsApi, date, reservationLoadFailed]);

  useEffect(() => {
    void loadBookings();
    return () => {
      bookingsRequestGeneration.current += 1;
    };
  }, [loadBookings]);

  useEffect(() => {
    if (!formOpen || !resourceId) {
      setAvailability(null);
      return;
    }
    let cancelled = false;
    setAvailabilityLoading(true);
    setSelectedHour(null);
    bookingsApi.availability(resourceId, date)
      .then((result) => {
        if (!cancelled) setAvailability(result);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || availabilityFailed);
      })
      .finally(() => {
        if (!cancelled) setAvailabilityLoading(false);
      });
    return () => { cancelled = true; };
  }, [availabilityFailed, bookingsApi, date, formOpen, resourceId]);

  const sameDaySlots = useMemo(() => {
    const result: NormalizedBilliardAvailability['slots'] = [];
    let previousHour = -1;
    for (const slot of availability?.slots || []) {
      const hour = Number(slot.hour.slice(0, 2));
      // The current backend omits the date on cross-midnight slots. Stop at
      // the wrap so the POS can never create a booking on the wrong date.
      if (previousHour >= 0 && hour <= previousHour) break;
      previousHour = hour;
      result.push(slot);
    }
    return result;
  }, [availability]);

  const selectedRangeValid = useMemo(() => {
    if (selectedHour === null) return false;
    for (let offset = 0; offset < durationHours; offset++) {
      const expected = selectedHour + offset;
      if (expected > 23) return false;
      const slot = sameDaySlots.find((candidate) => Number(candidate.hour.slice(0, 2)) === expected);
      if (!slot?.available) return false;
    }
    return true;
  }, [durationHours, sameDaySlots, selectedHour]);

  const resetForm = () => {
    setResourceId(tables[0]?.id || '');
    setSelectedHour(null);
    setDurationHours(1);
    setCustomerName('');
    setPhone('');
    setGuestCount(1);
    setNotes('');
    setAvailability(null);
  };

  const closeForm = () => {
    setFormOpen(false);
    resetForm();
  };

  const handleCreate = async () => {
    if (!resourceId || selectedHour === null || !selectedRangeValid || !customerName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await bookingsApi.create({
        resourceId,
        startsAt: buildBilliardBookingStartsAt(date, selectedHour),
        durationHours,
        customerName: customerName.trim(),
        phone: phone.trim() || undefined,
        guestCount,
        notes: notes.trim() || undefined,
      });
      closeForm();
      await loadBookings();
    } catch (err: any) {
      setError(err?.message || t('billiard.reservationCreateFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async (booking: NormalizedBilliardBooking) => {
    if (!window.confirm(t('billiard.cancelReservationConfirm'))) return;
    setActionId(booking.id);
    setError(null);
    try {
      await bookingsApi.cancel(booking.id);
      await loadBookings();
    } catch (err: any) {
      setError(err?.message || t('billiard.reservationCancelFailed'));
    } finally {
      setActionId(null);
    }
  };

  const handleCheckIn = async (booking: NormalizedBilliardBooking) => {
    if (!window.confirm(t('billiard.checkInConfirm'))) return;
    setActionId(booking.id);
    setError(null);
    try {
      await bookingsApi.checkIn(booking.id, { guestCount: booking.guestCount });
      await Promise.all([loadBookings(), Promise.resolve(onCheckedIn?.())]);
    } catch (err: any) {
      setError(humanizeBilliardError(err?.message ?? '', t) || t('billiard.checkInFailed'));
    } finally {
      setActionId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-slate-950/50 p-4 flex items-center justify-center"
      style={{ bottom: 'var(--touch-keyboard-inset, 0px)' }}
    >
      <section className="w-full max-w-5xl max-h-full bg-white rounded-xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden">
        <header className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <CalendarClock className="w-5 h-5 text-brand-600 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-slate-900">{t('billiard.reservations')}</h2>
              <p className="text-xs text-slate-500">{t('billiard.reservationsHint')}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100" aria-label={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setDate(shiftDate(date, -1))} className="h-9 w-9 border border-slate-300 rounded-lg grid place-items-center hover:bg-slate-50">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input
            type="date"
            min={today}
            value={date}
            onChange={(event) => setDate(event.target.value || today)}
            className="h-9 px-3 rounded-lg border border-slate-300 text-sm tabular-nums"
          />
          <button type="button" onClick={() => setDate(shiftDate(date, 1))} className="h-9 w-9 border border-slate-300 rounded-lg grid place-items-center hover:bg-slate-50">
            <ChevronRight className="w-4 h-4" />
          </button>
          <button type="button" onClick={loadBookings} disabled={loading} className="h-9 px-3 rounded-lg border border-slate-300 text-sm font-medium flex items-center gap-1.5 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {t('common.refresh')}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => {
              setResourceId((current) => current || tables[0]?.id || '');
              setFormOpen(true);
            }}
            disabled={tables.length === 0}
            className="h-9 px-3 rounded-lg bg-brand-600 text-white text-sm font-semibold flex items-center gap-1.5 hover:bg-brand-700 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            {t('billiard.newReservation')}
          </button>
        </div>

        {error && (
          <div className="mx-4 mt-3 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700 flex items-start justify-between gap-3">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="h-48 grid place-items-center text-slate-500"><Loader2 className="w-6 h-6 animate-spin" /></div>
          ) : bookings.length === 0 ? (
            <div className="h-48 rounded-xl border border-dashed border-slate-300 grid place-items-center text-center text-slate-500">
              <div><CalendarClock className="w-8 h-8 mx-auto mb-2 opacity-40" /><p className="text-sm">{t('billiard.noReservations')}</p></div>
            </div>
          ) : (
            <div className="space-y-2">
              {bookings.map((booking) => {
                const actionable = booking.status === 'BOOKED' || booking.status === 'PENDING';
                const busy = actionId === booking.id;
                return (
                  <article key={booking.id} className="rounded-xl border border-slate-200 p-3 flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="w-28 shrink-0">
                      <p className="text-lg font-bold tabular-nums text-slate-900">{formatTime(booking.startsAt)}</p>
                      <p className="text-xs text-slate-500">{formatTime(booking.endsAt)}</p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-slate-900 truncate">{booking.customerName}</p>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${statusTone(booking.status)}`}>
                          {booking.status}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                        <span className="font-medium text-slate-700">{booking.tableName}</span>
                        <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" />{booking.guestCount}</span>
                        {booking.phone && <span className="flex items-center gap-1"><Phone className="w-3.5 h-3.5" />{booking.phone}</span>}
                        {booking.totalPrice > 0 && <span>{formatMoney(booking.totalPrice)}</span>}
                      </div>
                    </div>
                    {actionable && (
                      <div className="flex items-center gap-2 shrink-0">
                        <button type="button" disabled={busy} onClick={() => handleCancel(booking)} className="h-8 px-3 rounded-lg border border-red-200 text-red-700 text-xs font-medium flex items-center gap-1 hover:bg-red-50 disabled:opacity-50">
                          <XCircle className="w-4 h-4" />{t('common.cancel')}
                        </button>
                        {booking.status === 'BOOKED' && (
                          <button type="button" disabled={busy} onClick={() => handleCheckIn(booking)} className="h-8 px-3 rounded-lg bg-emerald-600 text-white text-xs font-semibold flex items-center gap-1 hover:bg-emerald-700 disabled:opacity-50">
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                            {t('billiard.checkIn')}
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>

        {formOpen && (
          <div className="absolute inset-0 z-10 bg-slate-950/40 p-4 grid place-items-center">
            <div className="w-full max-w-2xl max-h-full overflow-y-auto bg-white rounded-xl shadow-xl border border-slate-200">
              <div className="px-4 py-3 border-b flex items-center justify-between">
                <h3 className="font-semibold text-slate-900">{t('billiard.newReservation')}</h3>
                <button type="button" onClick={closeForm} className="p-1.5 rounded-lg hover:bg-slate-100"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-4 space-y-4">
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="text-sm font-medium text-slate-700">
                    {t('billiard.table')}
                    <select value={resourceId} onChange={(event) => setResourceId(event.target.value)} className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-300 bg-white">
                      {tables.map((table) => <option key={table.id} value={table.id}>{table.name}</option>)}
                    </select>
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    {t('billiard.duration')}
                    <select value={durationHours} onChange={(event) => setDurationHours(Number(event.target.value))} className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-300 bg-white">
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((hours) => <option key={hours} value={hours}>{hours}h</option>)}
                    </select>
                  </label>
                </div>

                <div>
                  <p className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-1.5"><Clock3 className="w-4 h-4" />{t('billiard.availableTimes')}</p>
                  {availabilityLoading ? (
                    <div className="h-20 grid place-items-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
                  ) : sameDaySlots.length === 0 ? (
                    <p className="text-sm text-slate-500 py-4">{t('billiard.noAvailableTimes')}</p>
                  ) : (
                    <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                      {sameDaySlots.map((slot) => {
                        const hour = Number(slot.hour.slice(0, 2));
                        const selected = selectedHour !== null && hour >= selectedHour && hour < selectedHour + durationHours;
                        return (
                          <button
                            key={slot.hour}
                            type="button"
                            disabled={!slot.available}
                            onClick={() => setSelectedHour(hour)}
                            className={`rounded-lg border px-2 py-2 text-xs text-center transition-colors ${selected
                              ? 'border-brand-600 bg-brand-50 text-brand-700 font-semibold'
                              : slot.available
                                ? 'border-slate-300 hover:bg-slate-50 text-slate-700'
                                : 'border-slate-200 bg-slate-100 text-slate-400 line-through'}`}
                          >
                            <span className="block text-sm tabular-nums">{slot.hour}</span>
                            {slot.price > 0 && <span className="block mt-0.5">{formatMoney(slot.price, availability?.currency)}</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {selectedHour !== null && !selectedRangeValid && <p className="mt-2 text-xs text-red-600">{t('billiard.timeRangeUnavailable')}</p>}
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="text-sm font-medium text-slate-700">
                    <span className="flex items-center gap-1.5"><UserRound className="w-4 h-4" />{t('billiard.customerName')} *</span>
                    <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-300" />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    <span className="flex items-center gap-1.5"><Phone className="w-4 h-4" />{t('billiard.phone')}</span>
                    <input value={phone} onChange={(event) => setPhone(event.target.value)} className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-300" />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    {t('billiard.guests')}
                    <input type="number" min={1} max={20} value={guestCount} onChange={(event) => setGuestCount(Math.min(20, Math.max(1, Number(event.target.value) || 1)))} className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-300" />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    {t('billiard.notes')}
                    <input value={notes} onChange={(event) => setNotes(event.target.value)} className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-300" />
                  </label>
                </div>
              </div>
              <div className="px-4 py-3 border-t flex justify-end gap-2">
                <button type="button" onClick={closeForm} disabled={saving} className="h-9 px-4 rounded-lg border border-slate-300 text-sm font-medium hover:bg-slate-50">{t('common.cancel')}</button>
                <button type="button" onClick={handleCreate} disabled={saving || !customerName.trim() || !selectedRangeValid} className="h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-semibold flex items-center gap-1.5 hover:bg-brand-700 disabled:opacity-50">
                  {saving && <Loader2 className="w-4 h-4 animate-spin" />}{t('common.save')}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
