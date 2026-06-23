// Idle / welcome screen. It must be scan-first: a barcode starts the
// session just like the visible start button.
import React from 'react';
import { CreditCard, Hand, ScanBarcode, ShoppingBasket } from 'lucide-react';
import LanguageSwitch from '../LanguageSwitch';
import { ScLanguage, getScStrings } from '../i18n';
import { useScannerCapture } from '../useScannerCapture';

interface WelcomeScreenProps {
  lang: ScLanguage;
  onLangChange: (lang: ScLanguage) => void;
  onStart: () => void;
  onScanStart: (ean: string) => Promise<void> | void;
  onCallStaff?: () => void;
}

export default function WelcomeScreen({
  lang,
  onLangChange,
  onStart,
  onScanStart,
  onCallStaff,
}: WelcomeScreenProps) {
  const t = getScStrings(lang);
  const { scannerInputRef, handleScannerInputKeyDown } = useScannerCapture({
    onScan: onScanStart,
  });

  return (
    <div className="sc-shell relative flex h-screen w-screen flex-col overflow-hidden select-none">
      <input
        ref={scannerInputRef}
        onKeyDown={handleScannerInputKeyDown}
        inputMode="none"
        data-scanner-capture="true"
        aria-label={t.barcodeScannerLabel}
        tabIndex={-1}
        className="pointer-events-none fixed h-px w-px opacity-0"
      />
      <header className="flex items-center justify-between px-10 py-8">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--sc-primary)] text-3xl font-black text-white">
            Z
          </div>
          <div>
            <div className="text-lg font-black uppercase tracking-[0.18em] text-[var(--sc-primary-deep)]">
              Zira AI
            </div>
            <div className="text-base font-semibold text-[var(--sc-muted)]">
              {t.kioskName}
            </div>
          </div>
        </div>

        <LanguageSwitch lang={lang} onLangChange={onLangChange} />
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px] gap-8 px-10 pb-10">
        <section className="flex min-h-0 items-center justify-center">
          <div className="w-full max-w-4xl">
            <div className="mb-8 inline-flex items-center gap-3 rounded-full border border-emerald-200 bg-emerald-50 px-5 py-3 text-lg font-black text-emerald-800">
              <ShoppingBasket size={24} />
              {t.welcomeTitle}
            </div>
            <h1 className="max-w-4xl text-6xl font-black leading-[1.03] text-[var(--sc-ink)]">
              {t.startButton}
            </h1>
            <p className="mt-6 max-w-2xl text-3xl font-semibold leading-snug text-[var(--sc-muted)]">
              {t.welcomeSubtitle}
            </p>
            <div className="mt-12 max-w-3xl">
              <button
                type="button"
                onClick={onStart}
                className="sc-action sc-focusable flex min-h-[150px] w-full flex-col items-center justify-center gap-4 px-10 text-4xl shadow-[0_22px_58px_rgba(169,83,58,0.22)]"
              >
                <ShoppingBasket size={52} />
                {t.startButton}
              </button>
            </div>
          </div>
        </section>

        <aside className="sc-surface flex flex-col justify-between p-7">
          <div>
            <div className="sc-attract-pulse flex h-20 w-20 items-center justify-center rounded-3xl bg-[var(--sc-primary-soft)] text-[var(--sc-primary-deep)]">
              <ScanBarcode size={42} />
            </div>
            <h2 className="mt-8 text-3xl font-black text-[var(--sc-ink)]">
              {t.scanPrompt}
            </h2>
            <p className="mt-3 text-xl leading-8 text-[var(--sc-muted)]">
              {t.scanHint}
            </p>
          </div>

          <div className="rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-muted)] p-5">
            <div className="mb-3 flex items-center gap-3 text-lg font-black text-[var(--sc-ink)]">
              <CreditCard size={24} className="text-[var(--sc-info)]" />
              {t.paymentNotice}
            </div>
            <p className="text-base leading-6 text-[var(--sc-muted)]">
              {`${t.cash} / ${t.card} / ${t.blik}`}
            </p>
          </div>

          {onCallStaff && (
            <button
              type="button"
              onClick={onCallStaff}
              className="sc-help-action sc-focusable mt-5 flex items-center justify-center gap-2 px-5 text-base"
            >
              <Hand size={20} />
              {t.callStaff}
            </button>
          )}
        </aside>
      </main>
    </div>
  );
}
