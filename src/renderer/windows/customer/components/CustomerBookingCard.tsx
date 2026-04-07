import React from 'react';
import { Language } from '../../../i18n/translations';
import {
  CustomerDisplayBooking,
  formatDisplayTime,
} from '../customer-display-model';

interface CustomerBookingCardProps {
  booking: CustomerDisplayBooking;
  language: Language;
  actionLabel: string;
  onAction: () => void;
}

export default function CustomerBookingCard({
  booking,
  language,
  actionLabel,
  onAction,
}: CustomerBookingCardProps) {
  return (
    <div className="rounded-[28px] border border-white/80 bg-white/92 p-5 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
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

        <button
          onClick={onAction}
          className="inline-flex shrink-0 items-center rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700"
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
      {children}
    </span>
  );
}
