import React, { useState, useMemo } from 'react';
import type { CheckinBookingSummary } from './runtime';
import { translateCheckinError } from './checkin-error-message';

function formatTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(11, 16);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isLate(booking: CheckinBookingSummary): boolean {
  const bookingTime = new Date(booking.from);
  return bookingTime < new Date() && (booking.status === 'BOOKED' || booking.status === 'PENDING');
}

interface Props {
  t: (key: string) => string;
  bookings: CheckinBookingSummary[];
  checkins: any[];
  onSelect: (booking: CheckinBookingSummary) => void;
  onBack: () => void;
  remoteSearch?: {
    query: string;
    loading: boolean;
    error: string | null;
    onSearch: (query: string) => void;
  };
}

export default function BookingListScreen({ t, bookings, checkins, onSelect, onBack, remoteSearch }: Props) {
  const [localSearch, setLocalSearch] = useState('');
  const search = remoteSearch?.query ?? localSearch;

  const activeBookings = useMemo(() => {
    return bookings
      .filter((b) => b.status === 'BOOKED' || b.status === 'PENDING')
      .sort((a, b) => {
        // Sort by proximity to now
        const aDiff = Math.abs(new Date(a.from).getTime() - Date.now());
        const bDiff = Math.abs(new Date(b.from).getTime() - Date.now());
        return aDiff - bDiff;
      });
  }, [bookings]);

  const filtered = useMemo(() => {
    if (remoteSearch) return activeBookings;
    if (!search.trim()) return activeBookings;
    const q = search.toLowerCase();
    return activeBookings.filter(
      (b) =>
        b.customerName.toLowerCase().includes(q) ||
        b.serviceName?.toLowerCase().includes(q) ||
        b.staffName?.toLowerCase().includes(q),
    );
  }, [activeBookings, remoteSearch, search]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center space-x-3 mb-3">
        <button onClick={onBack} className="flex min-h-12 min-w-12 items-center justify-center hover:bg-slate-100 rounded-lg transition-colors">
          <svg className="w-5 h-5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <h2 className="text-lg font-semibold text-slate-800">{t('wizard.selectBooking')}</h2>
        <span className="text-sm text-slate-500">({filtered.length})</span>
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => {
          if (remoteSearch) remoteSearch.onSearch(e.target.value);
          else setLocalSearch(e.target.value);
        }}
        placeholder={t('wizard.searchBooking')}
        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-300 mb-3"
        autoFocus
        data-testid="checkin-booking-search"
      />

      {/* List */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {remoteSearch && search.trim().normalize('NFKC').length < 2 ? (
          <div className="flex items-center justify-center h-40 px-6 text-center text-sm text-slate-500" data-testid="checkin-booking-search-prompt">
            {t('wizard.bookingSearchPrompt')}
          </div>
        ) : remoteSearch?.loading ? (
          <div className="flex items-center justify-center h-40 text-sm font-medium text-slate-500" role="status">
            {t('wizard.bookingSearchLoading')}
          </div>
        ) : remoteSearch?.error ? (
          <div className="flex items-center justify-center h-40 px-6 text-center text-sm font-medium text-red-700" role="alert">
            {translateCheckinError(remoteSearch.error, t)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-slate-400">
            {t('wizard.noBookings')}
          </div>
        ) : (
          filtered.map((b) => {
            const alreadyCheckedIn = checkins.some((c: any) => c.booking_id === b.id.toString());
            const late = isLate(b);
            return (
              <button
                key={b.id}
                onClick={() => !alreadyCheckedIn && onSelect(b)}
                disabled={alreadyCheckedIn}
                className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
                  alreadyCheckedIn
                    ? 'bg-slate-50 border-slate-100 opacity-50 cursor-not-allowed'
                    : 'bg-white border-slate-200 hover:border-brand-300 hover:shadow-sm cursor-pointer'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-sm font-semibold text-slate-800">
                        {formatTime(b.from)}
                      </span>
                      <span className="text-sm font-medium text-slate-700 truncate">
                        {b.customerName}
                      </span>
                      {late && (
                        <span className="px-1.5 py-0.5 text-[10px] font-bold bg-red-100 text-red-600 rounded">
                          {t('wizard.late')}
                        </span>
                      )}
                      {alreadyCheckedIn && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-100 text-emerald-600 rounded">
                          {t('wizard.checkedIn')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 truncate">
                      {b.serviceName} &middot; {b.staffName}
                    </div>
                  </div>
                  {!alreadyCheckedIn && (
                    <svg className="w-5 h-5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
