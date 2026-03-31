import React from 'react';

interface Props {
  t: (key: string) => string;
  onBooking: () => void;
  onWalkIn: () => void;
  bookingCount: number;
}

export default function EntryScreen({ t, onBooking, onWalkIn, bookingCount }: Props) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-6 gap-10">

      {/* Cards */}
      <div className="w-full grid grid-cols-2 gap-8">

        {/* Has Booking */}
        <button
          onClick={onBooking}
          className="group relative flex flex-col items-center justify-center p-10 bg-slate-100 rounded-3xl border border-slate-200 hover:border-brand-300 hover:shadow-xl active:scale-[0.97] transition-all duration-300 text-center overflow-hidden"
        >
          <div className="absolute inset-0 rounded-3xl border-2 border-transparent group-hover:border-brand-200/60 transition-colors pointer-events-none" />

          {/* Icon */}
          <div className="mb-7 w-20 h-20 rounded-full bg-white flex items-center justify-center shadow-sm group-hover:bg-brand-500 transition-all duration-500">
            <svg className="w-9 h-9 text-brand-500 group-hover:text-white transition-colors duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
            </svg>
          </div>

          {/* Text */}
          <div className="relative">
            <span className="text-[10px] uppercase tracking-[0.2em] text-slate-400 font-semibold block mb-2">
              {t('wizard.title')}
            </span>
            <h2 className="text-3xl font-bold text-slate-800 mb-3">{t('wizard.hasBooking')}</h2>
            <p className="text-slate-500 text-sm leading-relaxed max-w-[220px] mx-auto">
              {bookingCount} {t('wizard.bookingsToday')}
            </p>
          </div>

          {/* CTA */}
          <div className="mt-7 flex items-center gap-2 text-brand-500 font-semibold group-hover:translate-x-1.5 transition-transform duration-200">
            <span className="text-xs uppercase tracking-widest">{t('wizard.readyToCheckin')}</span>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </div>
        </button>

        {/* Walk-in */}
        <button
          onClick={onWalkIn}
          className="group relative flex flex-col items-center justify-center p-10 bg-slate-100 rounded-3xl border border-slate-200 hover:border-purple-300 hover:shadow-xl active:scale-[0.97] transition-all duration-300 text-center overflow-hidden"
        >
          <div className="absolute inset-0 rounded-3xl border-2 border-transparent group-hover:border-purple-200/60 transition-colors pointer-events-none" />

          {/* Icon */}
          <div className="mb-7 w-20 h-20 rounded-full bg-white flex items-center justify-center shadow-sm group-hover:bg-purple-500 transition-all duration-500">
            <svg className="w-9 h-9 text-purple-500 group-hover:text-white transition-colors duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
            </svg>
          </div>

          {/* Text */}
          <div className="relative">
            <span className="text-[10px] uppercase tracking-[0.2em] text-slate-400 font-semibold block mb-2">
              New Arrival
            </span>
            <h2 className="text-3xl font-bold text-slate-800 mb-3">{t('wizard.walkIn')}</h2>
            <p className="text-slate-500 text-sm leading-relaxed max-w-[220px] mx-auto">
              {t('wizard.walkInDesc')}
            </p>
          </div>

          {/* CTA */}
          <div className="mt-7 flex items-center gap-2 text-purple-500 font-semibold group-hover:translate-x-1.5 transition-transform duration-200">
            <span className="text-xs uppercase tracking-widest">{t('wizard.noAppointmentNeeded')}</span>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </div>
        </button>

      </div>

      {/* Stats hint */}
      <div className="flex flex-col items-center gap-3">
        {bookingCount > 0 && (
          <div className="flex items-center gap-2 px-5 py-2.5 bg-brand-50 rounded-full border border-brand-100">
            <span className="w-2 h-2 rounded-full bg-brand-500 animate-pulse" />
            <span className="text-[11px] font-bold uppercase tracking-widest text-brand-700">
              {bookingCount} {t('wizard.bookingsToday')}
            </span>
          </div>
        )}
        <p className="text-[10px] text-slate-400 uppercase tracking-[0.2em]">Touch an option to begin</p>
      </div>

    </div>
  );
}
