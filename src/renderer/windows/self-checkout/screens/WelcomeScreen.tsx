// Idle / welcome screen. It must be scan-first: a barcode starts the
// session just like the visible start button.
import React, { useCallback, useEffect, useRef } from 'react';
import { ChefHat, CreditCard, Hand, ScanBarcode, ShoppingBasket } from 'lucide-react';
import LanguageSwitch from '../LanguageSwitch';
import { ScLanguage, getScStrings } from '../i18n';

type CatalogDepartment = 'grocery' | 'kitchen';

interface WelcomeScreenProps {
  lang: ScLanguage;
  onLangChange: (lang: ScLanguage) => void;
  onStart: (department?: CatalogDepartment) => void;
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
  const scannerInputRef = useRef<HTMLInputElement>(null);
  const scannerBuffer = useRef<string>('');
  const scannerLastKey = useRef<number>(0);
  const lastScanRef = useRef<{ code: string; at: number } | null>(null);

  const handleScannedCode = useCallback(
    (rawCode: string) => {
      const code = rawCode.trim();
      if (code.length < 4) return;
      const now = Date.now();
      if (lastScanRef.current?.code === code && now - lastScanRef.current.at < 600) return;
      lastScanRef.current = { code, at: now };
      void onScanStart(code);
    },
    [onScanStart],
  );

  const focusScannerInput = useCallback(() => {
    scannerInputRef.current?.focus();
  }, []);

  const handleScannerInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const code = e.currentTarget.value;
      e.currentTarget.value = '';
      handleScannedCode(code);
    },
    [handleScannedCode],
  );

  useEffect(() => {
    focusScannerInput();
    const handler = () => setTimeout(focusScannerInput, 50);
    document.addEventListener('pointerdown', handler);
    const interval = setInterval(focusScannerInput, 1000);
    return () => {
      document.removeEventListener('pointerdown', handler);
      clearInterval(interval);
    };
  }, [focusScannerInput]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.dataset?.scannerCapture === 'true') return;
      const now = Date.now();
      if (now - scannerLastKey.current > 150) {
        scannerBuffer.current = '';
      }
      scannerLastKey.current = now;
      if (e.key === 'Enter') {
        const code = scannerBuffer.current.trim();
        scannerBuffer.current = '';
        handleScannedCode(code);
        return;
      }
      if (e.key.length === 1 && /[0-9A-Za-z\-_]/.test(e.key)) {
        scannerBuffer.current += e.key;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleScannedCode]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onBarcodeScanned?.((barcode: string) => {
      handleScannedCode(barcode);
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [handleScannedCode]);

  return (
    <div className="sc-shell relative flex h-screen w-screen flex-col overflow-hidden select-none">
      <input
        ref={scannerInputRef}
        onKeyDown={handleScannerInputKeyDown}
        inputMode="none"
        data-scanner-capture="true"
        aria-label="Barcode scanner"
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
              Self-checkout
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
            <div className="mt-12 grid max-w-3xl grid-cols-2 gap-5">
              <button
                type="button"
                onClick={() => onStart('grocery')}
                className="sc-action sc-focusable flex min-h-[150px] flex-col items-center justify-center gap-4 px-10 text-4xl shadow-[0_22px_58px_rgba(169,83,58,0.22)]"
              >
                <ShoppingBasket size={52} />
                {t.grocery}
              </button>
              <button
                type="button"
                onClick={() => onStart('kitchen')}
                className="sc-secondary-action sc-focusable flex min-h-[150px] flex-col items-center justify-center gap-4 px-10 text-4xl font-black"
              >
                <ChefHat size={52} />
                {t.kitchen}
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
