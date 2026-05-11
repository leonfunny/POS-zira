// Idle / welcome screen. Start button, scan-to-start, payment notice,
// and language switcher.
import React, { useEffect, useRef } from 'react';
import { ScLanguage, SC_LANGUAGES, getScStrings } from '../i18n';

interface WelcomeScreenProps {
  lang: ScLanguage;
  onLangChange: (lang: ScLanguage) => void;
  onStart: () => void;
  onScanStart: (ean: string) => Promise<void> | void;
}

export default function WelcomeScreen({
  lang,
  onLangChange,
  onStart,
  onScanStart,
}: WelcomeScreenProps) {
  const t = getScStrings(lang);
  const scannerBuffer = useRef<string>('');
  const scannerLastKey = useRef<number>(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const now = Date.now();
      if (now - scannerLastKey.current > 80) {
        scannerBuffer.current = '';
      }
      scannerLastKey.current = now;
      if (e.key === 'Enter') {
        const code = scannerBuffer.current.trim();
        scannerBuffer.current = '';
        if (code.length >= 4) void onScanStart(code);
        return;
      }
      if (e.key.length === 1 && /[0-9A-Za-z\-_]/.test(e.key)) {
        scannerBuffer.current += e.key;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onScanStart]);

  return (
    <div className="relative flex h-screen w-screen flex-col items-center justify-center bg-gradient-to-br from-emerald-50 via-white to-amber-50 text-slate-900 select-none">
      {/* Language switcher — top-right, big touch targets */}
      <div className="absolute top-6 right-6 flex gap-2">
        {SC_LANGUAGES.map((l) => (
          <button
            key={l.code}
            type="button"
            onClick={() => onLangChange(l.code)}
            className={`flex h-14 w-20 items-center justify-center rounded-2xl border-2 text-3xl transition-colors ${
              l.code === lang
                ? 'border-emerald-600 bg-emerald-50'
                : 'border-slate-200 bg-white hover:border-slate-300'
            }`}
            aria-label={l.label}
          >
            {l.flag}
          </button>
        ))}
      </div>

      <div className="text-center">
        <h1 className="mb-4 text-7xl font-black tracking-tight">
          {t.welcomeTitle}
        </h1>
        <p className="mb-16 text-3xl text-slate-600">{t.welcomeSubtitle}</p>
        <button
          type="button"
          onClick={onStart}
          className="rounded-3xl bg-emerald-600 px-20 py-10 text-4xl font-bold text-white shadow-2xl shadow-emerald-600/40 transition-all hover:bg-emerald-700 hover:scale-105 active:scale-100"
        >
          {t.startButton}
        </button>
      </div>

      <p className="absolute bottom-10 text-lg text-slate-500">
        💳 {t.paymentNotice}
      </p>
    </div>
  );
}
