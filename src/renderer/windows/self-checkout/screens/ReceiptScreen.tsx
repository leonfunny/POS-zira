import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDown, CheckCircle2, FileText, Hand, Printer } from 'lucide-react';
import LanguageSwitch from '../LanguageSwitch';
import { ScLanguage, getScStrings } from '../i18n';
import type { SelfCheckoutMode } from '../self-checkout-model';
import { formatPLN } from '../useScCart';
import type { PaymentMethod } from './PaymentScreen';

interface ReceiptScreenProps {
  lang: ScLanguage;
  mode: SelfCheckoutMode;
  method: PaymentMethod;
  totalGrosze: number;
  receiptPrinted?: boolean;
  /** Backend is still routing the order-copy or fiscal receipt print job. */
  receiptPrinting?: boolean;
  onComplete: () => void;
  onLangChange: (lang: ScLanguage) => void;
  onCallStaff?: () => void;
}

const AUTO_ADVANCE_MS = 4000;
// When the print FAILED the screen stays up much longer (with a CALL STAFF
// button) so the customer can get help — but it must still self-recover:
// a paid customer who walks away would otherwise leave the kiosk dead-ended
// on this screen forever, blocking the next customer.
const PRINT_FAILED_AUTO_ADVANCE_MS = 120_000;

function formatMessage(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

export default function ReceiptScreen({
  lang,
  mode,
  method,
  totalGrosze,
  receiptPrinted = true,
  receiptPrinting = false,
  onComplete,
  onLangChange,
  onCallStaff,
}: ReceiptScreenProps) {
  const t = getScStrings(lang);
  // Visible countdown so the customer knows the screen will auto-advance.
  const [remainingMs, setRemainingMs] = useState(AUTO_ADVANCE_MS);
  const printFailed = !receiptPrinted && !receiptPrinting;
  // Every method routes through the fiscal printer now (Polish fiscal law
  // requires a paragon for cash/BLIK sales too), so the labels are fiscal
  // for all tenders.
  const printLabel = t.receiptPrintStep;
  const printingLabel = t.receiptFiscalPrinting;

  useEffect(() => {
    if (!receiptPrinted || receiptPrinting) return;
    setRemainingMs(AUTO_ADVANCE_MS);
    const tick = window.setInterval(() => {
      setRemainingMs((ms) => Math.max(0, ms - 250));
    }, 250);
    const done = window.setTimeout(onComplete, AUTO_ADVANCE_MS);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(done);
    };
  }, [onComplete, receiptPrinted, receiptPrinting]);

  // Print-failure recovery: the screen is excluded from the global idle reset,
  // so without this timer a failed print would strand the kiosk on this
  // screen forever once the customer leaves.
  useEffect(() => {
    if (!printFailed) return;
    const recover = window.setTimeout(onComplete, PRINT_FAILED_AUTO_ADVANCE_MS);
    return () => window.clearTimeout(recover);
  }, [onComplete, printFailed]);

  const secondsLeft = Math.ceil(remainingMs / 1000);

  return (
    <div className="sc-shell flex h-screen w-screen flex-col text-[var(--sc-ink)] select-none">
      <header className="flex justify-end gap-3 px-8 py-4">
        {onCallStaff && !printFailed && (
          <button
            type="button"
            onClick={onCallStaff}
            className="sc-help-action sc-focusable flex items-center gap-2 px-5 text-base"
          >
            <Hand size={20} />
            {t.callStaff}
          </button>
        )}
        <LanguageSwitch lang={lang} onLangChange={onLangChange} compact />
      </header>
      <main className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 pb-6 text-center">
        <section className="sc-surface sc-receipt-panel w-full max-w-3xl p-8">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-[24px] bg-emerald-50 text-[var(--sc-success)]">
            <Printer size={52} />
          </div>
          <div className="mt-5 inline-flex items-center gap-3 rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-amber-800">
            {mode === 'demo' ? t.demoMode : t.productionMode}
          </div>
          <h1 className="mt-5 text-5xl font-black">
            {t.receiptTitle}
          </h1>

          {/* Keep the customer here until the backend-routed printer job is done. */}
          {receiptPrinting ? (
            <p className="mx-auto mt-4 flex items-center justify-center gap-3 text-xl font-bold text-[var(--sc-primary-deep)]">
              <span>{printingLabel}</span>
              <span className="sc-dot-loader" aria-hidden="true">
                <span /><span /><span />
              </span>
            </p>
          ) : (
            <p className="mx-auto mt-4 max-w-2xl text-xl leading-8 text-[var(--sc-muted)]">
              {mode === 'demo'
                ? t.receiptDemoBody
                : receiptPrinted
                  ? t.thankYouSub
                  : t.receiptPrintFailed}
            </p>
          )}

          <div className="mt-6 space-y-2 text-left">
            <ReceiptStep icon={<CheckCircle2 size={24} />} label={t.paymentSuccess} done />
            <ReceiptStep
              icon={<FileText size={24} />}
              label={mode === 'demo' ? t.receiptDemoBody : t.receiptOrderSaved}
              done
            />
            <ReceiptStep
              icon={<Printer size={24} />}
              label={receiptPrinting ? printingLabel : printLabel}
              done={mode === 'demo' || receiptPrinted}
            />
            <ReceiptStep
              icon={<CheckCircle2 size={24} />}
              label={receiptPrinted ? t.receiptCollectStep : t.callStaff}
              done={receiptPrinted}
            />
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-[var(--sc-border)] pt-5">
            <div className="text-left">
              <div className="text-sm font-black uppercase tracking-[0.12em] text-[var(--sc-muted)]">
                {method}
              </div>
              <div className="text-lg font-bold text-[var(--sc-muted)]">
                {t.total}
              </div>
            </div>
            <div className="sc-tabular text-4xl font-black">
              {formatPLN(totalGrosze)}
            </div>
          </div>

          {/* Physical arrow pointing toward the printer slot. Research from
              kiosk vendors: a visible "take your receipt" arrow significantly
              improves receipt pickup, esp. for first-time customers. */}
          {receiptPrinted && !receiptPrinting && (
            <div className="mt-6 flex items-center justify-center gap-2 text-sm font-bold text-[var(--sc-muted)]">
              <ArrowDown size={18} className="animate-bounce" />
              <span>{t.receiptCollectArrow}</span>
            </div>
          )}

          {/* Visible countdown so the customer knows the kiosk will reset. */}
          {receiptPrinted && !receiptPrinting && secondsLeft > 0 && (
            <div className="mt-3 text-xs font-bold uppercase tracking-wide text-[var(--sc-muted)]">
              {formatMessage(t.receiptCountdown, { seconds: secondsLeft })}
            </div>
          )}

          {printFailed && onCallStaff && (
            <button
              type="button"
              onClick={onCallStaff}
              className="sc-focusable mt-6 flex w-full items-center justify-center gap-3 rounded-[24px] border-2 border-amber-700 bg-amber-600 px-6 py-5 text-2xl font-black text-white transition-colors hover:bg-amber-700"
            >
              <AlertTriangle size={24} />
              {t.callStaff}
            </button>
          )}
        </section>
      </main>
    </div>
  );
}

function ReceiptStep({
  icon,
  label,
  done,
}: {
  icon: React.ReactNode;
  label: string;
  done: boolean;
}) {
  return (
    <div className={`flex items-center gap-4 rounded-2xl border px-4 py-3 text-base font-black ${
      done
        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
        : 'border-[var(--sc-border)] bg-[var(--sc-surface-muted)] text-[var(--sc-muted)]'
    }`}>
      {icon}
      <span>{label}</span>
    </div>
  );
}
