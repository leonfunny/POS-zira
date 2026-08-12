import React, { useState, useEffect, useCallback } from 'react';
// URL assets keep the shared component browser-native and visible to Vite
// without teaching the Android source-boundary scanner to import binaries.
const BANNERS = [
  new URL('../../assets/banners/banner-1.jpg', import.meta.url).href,
  new URL('../../assets/banners/banner-2.jpg', import.meta.url).href,
  new URL('../../assets/banners/banner-3.jpg', import.meta.url).href,
  new URL('../../assets/banners/banner-4.jpg', import.meta.url).href,
];
const ROTATE_MS = 4000;

interface Props {
  t: (key: string) => string;
  onBooking: () => void;
  onWalkIn: () => void;
  onViewPrices: () => void;
  bookingCount: number;
}

export default function EntryScreen({ t, onBooking, onWalkIn, onViewPrices, bookingCount }: Props) {
  const [activeIdx, setActiveIdx] = useState(0);

  const next = useCallback(() => setActiveIdx((i) => (i + 1) % BANNERS.length), []);

  useEffect(() => {
    const id = setInterval(next, ROTATE_MS);
    return () => clearInterval(id);
  }, [next]);

  return (
    <div className="h-full flex flex-col px-6">

      {/* Carousel banner — stays at top */}
      <div className="w-full relative overflow-hidden rounded-2xl shadow-sm shrink-0" style={{ paddingTop: '15.625%' }}>
        {BANNERS.map((src, i) => (
          <img
            key={i}
            src={src}
            alt={`Banner ${i + 1}`}
            className={`absolute top-0 right-0 bottom-0 left-0 w-full h-full object-cover transition-opacity duration-700 ${
              i === activeIdx ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ))}
        {/* Dots */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex space-x-2">
          {BANNERS.map((_, i) => (
            <button
              key={i}
              onClick={() => setActiveIdx(i)}
              className={`w-2 h-2 rounded-full transition-all duration-300 cursor-pointer ${
                i === activeIdx ? 'bg-white w-5' : 'bg-white/50'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Content — close to banner, space below for future use */}
      <div className="flex flex-col items-center space-y-6 mt-6">

        {/* Action cards */}
        <div className="w-full grid grid-cols-5 gap-6">

          {/* I have an appointment (secondary) */}
          <button
            onClick={onBooking}
            className="col-span-2 group relative flex flex-col items-center justify-center p-8 bg-white rounded-3xl border border-slate-200 hover:border-brand-300 hover:shadow-xl active:scale-[0.97] transition-all duration-300 text-center overflow-hidden"
          >
            <div className="absolute top-0 right-0 bottom-0 left-0 rounded-3xl border-2 border-transparent group-hover:border-brand-200/60 transition-colors pointer-events-none" />

            {/* Icon */}
            <div className="mb-5 w-16 h-16 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-brand-500 transition-all duration-500">
              <svg className="w-7 h-7 text-brand-500 group-hover:text-white transition-colors duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
              </svg>
            </div>

            {/* Text */}
            <div className="relative">
              <h2 className="text-xl font-bold text-slate-800 mb-2">{t('wizard.hasBooking')}</h2>
              <p className="text-slate-400 text-xs leading-relaxed max-w-[200px] mx-auto">
                {t('wizard.hasBookingDesc')}
              </p>
            </div>

            {/* CTA */}
            <div className="mt-5 flex items-center space-x-2 text-brand-500 font-semibold group-hover:translate-x-1.5 transition-transform duration-200">
              <span className="text-[10px] uppercase tracking-widest">{t('wizard.findMyBooking')}</span>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </div>
          </button>

          {/* Choose services (primary) */}
          <button
            onClick={onWalkIn}
            className="col-span-3 group relative flex flex-col items-center justify-center p-8 bg-brand-600 rounded-3xl border border-brand-700 hover:bg-brand-700 hover:shadow-xl active:scale-[0.97] transition-all duration-300 text-center overflow-hidden"
          >
            <div className="absolute top-0 right-0 bottom-0 left-0 rounded-3xl border-2 border-transparent group-hover:border-brand-400/30 transition-colors pointer-events-none" />

            {/* Icon */}
            <div className="mb-5 w-16 h-16 rounded-full bg-white/15 flex items-center justify-center group-hover:bg-white/25 transition-all duration-500">
              <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
              </svg>
            </div>

            {/* Text */}
            <div className="relative">
              <h2 className="text-2xl font-bold text-white mb-2">{t('wizard.walkIn')}</h2>
              <p className="text-white/70 text-sm leading-relaxed max-w-[260px] mx-auto">
                {t('wizard.walkInDesc')}
              </p>
            </div>

            {/* CTA */}
            <div className="mt-5 flex items-center space-x-2 text-white font-semibold group-hover:translate-x-1.5 transition-transform duration-200">
              <span className="text-xs uppercase tracking-widest">{t('wizard.getStarted')}</span>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </div>
          </button>

        </div>

        {/* Browse prices button — prominent */}
        <button
          onClick={onViewPrices}
          className="flex items-center space-x-3 px-8 py-3.5 bg-white rounded-2xl border border-stone-200 hover:border-brand-300 hover:shadow-lg active:scale-[0.97] transition-all duration-200 cursor-pointer"
        >
          <svg className="w-5 h-5 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" />
          </svg>
          <span className="text-sm font-semibold text-stone-700">{t('priceList.viewPrices')}</span>
          <svg className="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>

        {/* Booking count hint */}
        {bookingCount > 0 && (
          <div className="flex items-center space-x-2 px-5 py-2.5 bg-brand-50 rounded-full border border-brand-100">
            <span className="w-2 h-2 rounded-full bg-brand-500 animate-pulse" />
            <span className="text-[11px] font-bold uppercase tracking-widest text-brand-700">
              {bookingCount} {t('wizard.bookingsToday')}
            </span>
          </div>
        )}
      </div>

    </div>
  );
}
