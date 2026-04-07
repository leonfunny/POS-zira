import React, { useEffect, useState } from 'react';
import { Language, languageNames } from '../../../i18n/translations';
import { formatDisplayDate, formatDisplayTime } from '../customer-display-model';

const DISPLAY_LANGUAGES: Language[] = ['en', 'pl', 'vi', 'uk', 'ru', 'zh', 'tr'];

interface CustomerDisplayShellProps {
  children: React.ReactNode;
  language: Language;
  onLanguageChange: (language: Language) => void;
  salonName?: string;
  title: string;
  subtitle?: string;
  onHome?: () => void;
  onBack?: () => void;
  onInteract?: () => void;
}

function useLiveClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  return now;
}

export default function CustomerDisplayShell({
  children,
  language,
  onLanguageChange,
  salonName,
  title,
  subtitle,
  onHome,
  onBack,
  onInteract,
}: CustomerDisplayShellProps) {
  const now = useLiveClock();
  const [languageOpen, setLanguageOpen] = useState(false);

  useEffect(() => {
    if (!languageOpen) return undefined;

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLanguageOpen(false);
    };

    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [languageOpen]);

  return (
    <div
      className="relative min-h-screen overflow-hidden bg-gradient-to-br from-rose-50 via-[#fffdfa] to-amber-50 text-slate-900"
      onPointerDown={onInteract}
    >
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-20 top-20 h-72 w-72 rounded-full bg-brand-200/30 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-96 w-96 rounded-full bg-amber-200/30 blur-3xl" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.5)_1px,transparent_1px)] bg-[size:40px_40px] opacity-30" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="relative z-30 border-b border-white/70 bg-white/80 px-8 py-5 backdrop-blur-xl">
          <div className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-6">
            <div className="flex min-w-0 items-center gap-3">
              {onHome && (
                <button
                  onClick={onHome}
                  className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700"
                  aria-label="Home"
                >
                  <HomeIcon />
                </button>
              )}
              {onBack && (
                <button
                  onClick={onBack}
                  className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700"
                  aria-label="Back"
                >
                  <BackIcon />
                </button>
              )}

              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-brand-500">
                  {salonName || 'Zira AI'}
                </div>
                <div className="mt-1 flex min-w-0 items-end gap-3">
                  <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-900">
                    {title}
                  </h1>
                  {subtitle && (
                    <span className="hidden truncate text-sm text-slate-500 md:block">
                      {subtitle}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="hidden rounded-2xl border border-slate-200 bg-white px-4 py-2 text-right shadow-sm md:block">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  {formatDisplayDate(now, language)}
                </div>
                <div className="text-lg font-semibold tabular-nums text-slate-800">
                  {formatDisplayTime(now.toISOString(), language)}
                </div>
              </div>

              <div className="relative">
                <button
                  onClick={() => setLanguageOpen((open) => !open)}
                  className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700"
                  aria-label="Change language"
                >
                  <GlobeIcon />
                </button>

                {languageOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setLanguageOpen(false)}
                    />
                    <div className="absolute right-0 top-[calc(100%+0.5rem)] z-[70] min-w-[180px] rounded-2xl border border-slate-200 bg-white p-1 shadow-xl">
                      {DISPLAY_LANGUAGES.map((entry) => (
                        <button
                          key={entry}
                          onClick={() => {
                            setLanguageOpen(false);
                            onLanguageChange(entry);
                          }}
                          className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
                            language === entry
                              ? 'bg-brand-50 text-brand-700'
                              : 'text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          <span className="font-medium">{languageNames[entry]}</span>
                          <span className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
                            {entry}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>

        <main className="relative z-10 flex-1 px-8 py-8">
          <div className="mx-auto flex h-full w-full max-w-[1440px] flex-col">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function HomeIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 10.75L12 3l9 7.75" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.5 9.75V21h13V9.75" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.8 2.6 4.5 5.7 4.5 9S14.8 18.4 12 21c-2.8-2.6-4.5-5.7-4.5-9S9.2 5.6 12 3z" />
    </svg>
  );
}
