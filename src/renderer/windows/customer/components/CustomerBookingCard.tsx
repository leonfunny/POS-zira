import React from 'react';
import { Language } from '../../../i18n/translations';
import {
  CustomerDisplayBooking,
  formatDisplayTime,
} from '../customer-display-model';

interface CustomerBookingCardProps {
  booking: CustomerDisplayBooking;
  language: Language;
  selected?: boolean;
  selectedLabel?: string;
  idleLabel?: string;
  onSelect: () => void;
}

export default function CustomerBookingCard({
  booking,
  language,
  selected = false,
  selectedLabel = 'Selected',
  idleLabel = 'Review',
  onSelect,
}: CustomerBookingCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`w-full rounded-[28px] border p-5 text-left shadow-[0_16px_40px_rgba(15,23,42,0.06)] transition-all ${
        selected
          ? 'border-brand-300 bg-brand-50/80'
          : 'border-white/80 bg-white/92 hover:border-brand-200 hover:bg-rose-50/35'
      }`}
    >
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <div className="text-sm font-semibold uppercase tracking-[0.16em] text-brand-500">
            {formatDisplayTime(booking.from, language)}
          </div>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
            {booking.customerName}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Pill>{booking.serviceName}</Pill>
            {booking.staffName && <Pill>{booking.staffName}</Pill>}
          </div>
        </div>

        <div
          className={`inline-flex shrink-0 items-center rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] ${
            selected
              ? 'border-brand-300 bg-white text-brand-700'
              : 'border-slate-200 bg-slate-50 text-slate-500'
          }`}
        >
          {selected ? selectedLabel : idleLabel}
        </div>
      </div>
    </button>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
      {children}
    </span>
  );
}
