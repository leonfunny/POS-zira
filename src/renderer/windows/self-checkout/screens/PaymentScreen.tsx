// Assisted payment overlay. The kiosk has no automated terminal integration
// yet, so after the customer picks CARD, CASH, or BLIK we (1) play a
// pre-rendered Polish announcement over the kiosk speakers so staff knows the
// amount + method, then (2) wait for staff to physically collect/confirm
// payment and tap "Money received" before saving the order and printing.
//
// The announcement is assembled from clips in `public/tts-pl/` rendered by
// `scripts/generate-tts-clips.mjs`. See `polish-amount-tts.ts` for the
// sequence-building logic and Web Speech API fallback.
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Banknote, CheckCircle2, CreditCard, Loader2, RotateCcw, Smartphone, X } from 'lucide-react';
import LanguageSwitch from '../LanguageSwitch';
import { ScLanguage, getScStrings } from '../i18n';
import type { SelfCheckoutPaymentProfile } from '../self-checkout-model';
import { formatPLN } from '../useScCart';
import { cancelAnnouncement, playAnnouncement, warmUpClipCache } from '../polish-amount-tts';

export type PaymentMethod = 'CASH' | 'CARD' | 'BLIK';

type Phase = 'idle' | 'awaitStaff' | 'processing';

// Shop's BLIK phone number — customers send manual peer-to-peer BLIK
// transfer (banking app → "Przelew na telefon"). Staff sees the transfer
// land in their phone and taps "Money received".
const BLIK_PHONE_DISPLAY = '729 448 788';
const ASSISTED_PAYMENT_METHODS: PaymentMethod[] = ['BLIK', 'CARD', 'CASH'];

interface PaymentScreenProps {
  lang: ScLanguage;
  profile: SelfCheckoutPaymentProfile;
  totalGrosze: number;
  terminalStatus?: string | null;
  errorText?: string | null;
  onSuccess: (method: PaymentMethod, customerNip: string | null) => void | Promise<void>;
  onCancel: () => void;
  onLangChange: (lang: ScLanguage) => void;
}

export default function PaymentScreen({
  lang,
  profile,
  totalGrosze,
  terminalStatus,
  errorText,
  onSuccess,
  onCancel,
  onLangChange,
}: PaymentScreenProps) {
  const t = getScStrings(lang);
  const assisted = profile === 'assistedDemo' || profile === 'assistedProduction';
  const runtimeBadge = profile === 'assistedProduction' ? t.productionMode : t.demoMode;
  const runtimeBadgeClass = profile === 'assistedProduction'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : 'border-amber-200 bg-amber-50 text-amber-800';
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [nipDigits, setNipDigits] = useState('');

  useEffect(() => {
    warmUpClipCache();
    return () => {
      cancelAnnouncement();
    };
  }, []);

  const chooseMethod = (next: PaymentMethod) => {
    if (phase !== 'idle' || !assisted) return;
    setMethod(next);
    setPhase('awaitStaff');
    void playAnnouncement(next, totalGrosze);
  };

  const replayAnnouncement = () => {
    if (!method || phase === 'processing') return;
    void playAnnouncement(method, totalGrosze);
  };

  const nipValid = nipDigits.length === 10;
  const invoiceBlocked = invoiceOpen && !nipValid;

  const confirmReceived = async () => {
    if (phase !== 'awaitStaff' || !method) return;
    if (invoiceBlocked) return;
    setPhase('processing');
    try {
      await onSuccess(method, invoiceOpen ? nipDigits : null);
    } catch {
      setPhase('awaitStaff');
    }
  };

  const handleCancel = () => {
    if (phase === 'processing') return;
    cancelAnnouncement();
    setMethod(null);
    setPhase('idle');
    setInvoiceOpen(false);
    setNipDigits('');
    onCancel();
  };

  const selectedLabel =
    method === 'CASH' ? t.cash : method === 'CARD' ? t.card : method === 'BLIK' ? t.blik : null;
  const sideIcon =
    method === 'CASH' ? <Banknote size={44} />
    : method === 'BLIK' ? <Smartphone size={44} />
    : <CreditCard size={44} />;
  const processing = phase === 'processing';
  const awaitingStaff = phase === 'awaitStaff';
  const sideTitle =
    awaitingStaff || processing
      ? t.staffConfirmTitle
      : selectedLabel || t.terminalReadyTitle;
  const sideBody = processing
    ? terminalStatus || t.waitForTerminal
    : awaitingStaff
      ? t.staffConfirmBody
      : t.terminalReadyBody;

  if (!assisted) {
    return (
      <div className="sc-payment-overlay fixed inset-0 z-30 flex items-center justify-center bg-slate-950/55 select-none">
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="self-checkout-payment-title"
          className="sc-surface sc-payment-dialog flex w-full max-w-3xl flex-col overflow-hidden"
        >
          <header className="sc-payment-header flex items-center justify-between border-b border-[var(--sc-border)]">
            <button
              type="button"
              onClick={handleCancel}
              className="sc-secondary-action sc-focusable flex items-center gap-3 px-5 text-lg"
            >
              <X size={22} />
              {t.cancel}
            </button>
            <LanguageSwitch lang={lang} onLangChange={onLangChange} compact />
          </header>
          <div className="p-8 text-center">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-[24px] bg-red-50 text-[var(--sc-danger)]">
              <AlertTriangle size={42} />
            </div>
            <h1 id="self-checkout-payment-title" className="mt-6 text-4xl font-black text-[var(--sc-ink)]">
              {t.paymentUnavailableTitle}
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-xl font-semibold leading-8 text-[var(--sc-muted)]">
              {t.paymentUnavailableBody}
            </p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="sc-payment-overlay fixed inset-0 z-30 flex items-center justify-center bg-slate-950/55 select-none">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="self-checkout-payment-title"
        className="sc-surface sc-payment-dialog flex w-full max-w-5xl flex-col overflow-hidden"
      >
        <header className="sc-payment-header flex items-center justify-between border-b border-[var(--sc-border)]">
          <button
            type="button"
            onClick={handleCancel}
            disabled={processing}
            className="sc-secondary-action sc-focusable flex items-center gap-3 px-5 text-lg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={22} />
            {t.cancel}
          </button>
          <div className="flex items-center gap-3">
            <div className={`rounded-full border px-4 py-2 text-sm font-black uppercase tracking-[0.14em] ${runtimeBadgeClass}`}>
              {runtimeBadge}
            </div>
            <LanguageSwitch lang={lang} onLangChange={onLangChange} compact />
          </div>
        </header>

        <div className="sc-payment-body">
            <main className="sc-payment-main min-w-0">
              <h1 id="self-checkout-payment-title" className="sc-payment-title font-black text-[var(--sc-ink)]">
                {t.paymentTitle}
              </h1>
              <div className="sc-payment-total sc-tabular font-black text-[var(--sc-ink)]">
                {formatPLN(totalGrosze)}
              </div>
              <p className="sc-payment-hint max-w-2xl font-semibold text-[var(--sc-muted)]">
                {t.paymentTerminalHint}
              </p>

              <div className="sc-payment-method-grid">
                {ASSISTED_PAYMENT_METHODS.map((paymentMethod) => (
                  <PaymentMethodButton
                    key={paymentMethod}
                    active={method === paymentMethod}
                    disabled={phase !== 'idle'}
                    icon={
                      paymentMethod === 'BLIK' ? <Smartphone size={48} />
                      : paymentMethod === 'CARD' ? <CreditCard size={48} />
                      : <Banknote size={48} />
                    }
                    title={
                      paymentMethod === 'BLIK' ? t.payWithBlik
                      : paymentMethod === 'CARD' ? t.payWithCard
                      : t.payWithCash
                    }
                    body={
                      paymentMethod === 'BLIK' ? t.blikHint
                      : paymentMethod === 'CARD' ? t.cardTerminalHint
                      : t.cashHint
                    }
                    onClick={() => chooseMethod(paymentMethod)}
                  />
                ))}
              </div>

              {/* NIP / Faktura toggle. Must be set BEFORE the fiscal print:
                  Polish law forbids retrofitting NIP onto a printed paragon. */}
              <div className="sc-payment-invoice rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-muted)]">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={invoiceOpen}
                    disabled={phase !== 'idle'}
                    onChange={(e) => {
                      setInvoiceOpen(e.target.checked);
                      if (!e.target.checked) setNipDigits('');
                    }}
                    className="mt-1 h-6 w-6 accent-[var(--sc-primary)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-lg font-black text-[var(--sc-ink)]">{t.invoiceToggleLabel}</div>
                    <div className="text-sm font-semibold text-[var(--sc-muted)]">{t.invoiceToggleHint}</div>
                  </div>
                </label>
                {invoiceOpen && (
                  <div className="mt-3">
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={10}
                      value={nipDigits}
                      disabled={phase === 'processing'}
                      onChange={(e) => setNipDigits(e.target.value.replace(/\D/g, '').slice(0, 10))}
                      placeholder={t.invoiceNipPlaceholder}
                      className="sc-tabular w-full rounded-xl border-2 border-[var(--sc-border)] bg-white px-4 py-3 text-2xl font-black tracking-widest focus:border-[var(--sc-primary)] focus:outline-none"
                      aria-invalid={!nipValid}
                    />
                    {!nipValid && nipDigits.length > 0 && (
                      <div className="mt-2 text-sm font-bold text-[var(--sc-danger)]">
                        {t.invoiceNipInvalid}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </main>

            <aside className="sc-payment-aside rounded-3xl border border-[var(--sc-border)] bg-[var(--sc-surface-muted)]">
              <div className="flex h-20 w-20 items-center justify-center rounded-[24px] bg-white text-[var(--sc-info)]">
                {sideIcon}
              </div>
              <h2 className="mt-6 text-3xl font-black text-[var(--sc-ink)]">
                {sideTitle}
              </h2>
              <p className="mt-4 text-xl font-semibold leading-8 text-[var(--sc-muted)]">
                {sideBody}
              </p>

              {awaitingStaff && method === 'BLIK' && (
                <div className="mt-6 rounded-2xl border-2 border-[var(--sc-info)] bg-blue-50 p-5">
                  <div className="text-base font-black uppercase tracking-wide text-[var(--sc-info)]">
                    {t.blikInstructionTitle}
                  </div>
                  <p className="mt-2 text-base font-semibold leading-6 text-[var(--sc-ink)]">
                    {t.blikInstructionBody}
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-white p-3 text-center">
                      <div className="text-xs font-black uppercase tracking-wide text-[var(--sc-muted)]">
                        {t.blikPhoneLabel}
                      </div>
                      <div className="sc-tabular mt-1 text-2xl font-black text-[var(--sc-ink)]">
                        {BLIK_PHONE_DISPLAY}
                      </div>
                    </div>
                    <div className="rounded-xl bg-white p-3 text-center">
                      <div className="text-xs font-black uppercase tracking-wide text-[var(--sc-muted)]">
                        {t.blikAmountLabel}
                      </div>
                      <div className="sc-tabular mt-1 text-2xl font-black text-[var(--sc-ink)]">
                        {formatPLN(totalGrosze)}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {awaitingStaff && (
                <div className="mt-6 flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={confirmReceived}
                    disabled={invoiceBlocked}
                    className="sc-focusable flex items-center justify-center gap-3 rounded-[24px] border-2 border-emerald-600 bg-emerald-600 px-6 py-5 text-2xl font-black text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:border-emerald-300 disabled:bg-emerald-300"
                  >
                    <CheckCircle2 size={28} />
                    {t.staffConfirmButton}
                  </button>
                  {invoiceBlocked && (
                    <div role="alert" className="text-center text-sm font-bold text-[var(--sc-danger)]">
                      {t.invoiceNipInvalid}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={replayAnnouncement}
                    className="sc-focusable flex items-center justify-center gap-3 rounded-[24px] border-2 border-[var(--sc-border)] bg-white px-6 py-4 text-xl font-bold text-[var(--sc-ink)] transition-colors hover:border-[var(--sc-primary)]"
                  >
                    <RotateCcw size={24} />
                    {t.replayVoice}
                  </button>
                </div>
              )}

              {processing && (
                <div
                  role="status"
                  className="mt-8 flex items-center gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4 text-xl font-black text-blue-800"
                >
                  <Loader2 size={28} className="animate-spin" />
                  {t.paymentProcessing}
                </div>
              )}
              {errorText && (
                <div
                  role="alert"
                  className="mt-5 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-left text-lg font-black leading-7 text-red-800"
                >
                  <AlertTriangle size={26} className="mt-0.5 shrink-0" />
                  <span>{errorText}</span>
                </div>
              )}
            </aside>
        </div>
      </section>
    </div>
  );
}

function PaymentMethodButton({
  active,
  disabled,
  icon,
  title,
  body,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`sc-payment-method-button sc-focusable border-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        active
          ? 'border-[var(--sc-success)] bg-emerald-50 text-emerald-800'
          : 'border-[var(--sc-border)] bg-white text-[var(--sc-ink)] hover:border-[var(--sc-primary)] hover:bg-[var(--sc-primary-soft)]'
      }`}
    >
      <div className="text-[var(--sc-primary-deep)]">{icon}</div>
      <div className="sc-payment-method-title font-black">{title}</div>
      <div className="sc-payment-method-body font-bold text-[var(--sc-muted)]">
        {body}
      </div>
    </button>
  );
}
