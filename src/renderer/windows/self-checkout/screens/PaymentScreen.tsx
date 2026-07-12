// Assisted payment overlay. The kiosk has no automated terminal integration
// yet, so after the customer picks CARD, CASH, or BLIK we (1) play a
// pre-rendered Polish announcement over the kiosk speakers so staff knows the
// amount + method, then (2) wait for staff to physically collect/confirm
// payment, tap "Money received", and verify their staff PIN before saving the
// order and printing.
//
// The announcement is assembled from clips in `public/tts-pl/` rendered by
// `scripts/generate-tts-clips.mjs`. See `polish-amount-tts.ts` for the
// sequence-building logic and Web Speech API fallback.
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Banknote, CreditCard, Delete, Loader2, Lock, RotateCcw, ShieldCheck, Smartphone, X } from 'lucide-react';
import LanguageSwitch from '../LanguageSwitch';
import { ScLanguage, getScStrings } from '../i18n';
import type { SelfCheckoutPaymentProfile } from '../self-checkout-model';
import { formatPLN } from '../useScCart';
import { cancelAnnouncement, playAnnouncement, warmUpClipCache } from '../polish-amount-tts';
import {
  canAttempt,
  initialStaffPinGateState,
  recordFailure,
  recordSuccess,
} from '../lib/staff-pin-gate';

export type PaymentMethod = 'CASH' | 'CARD' | 'BLIK';

type Phase = 'idle' | 'awaitStaff' | 'processing';

// Shop's BLIK phone number — customers send manual peer-to-peer BLIK
// transfer (banking app → "Przelew na telefon"). Staff sees the transfer
// land in their phone and taps "Money received".
const BLIK_PHONE_DISPLAY = '729 448 788';
const ASSISTED_PAYMENT_METHODS: PaymentMethod[] = ['BLIK', 'CARD', 'CASH'];
const STAFF_PIN_MAX_LENGTH = 16;
const STAFF_PIN_KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'cancel', '0', 'backspace'] as const;

type SelfCheckoutStaffApi = {
  staffVerify?: (code: string) => Promise<{ valid: boolean }>;
  helpRequest?: (payload: { reason: string; cartTotalGrosze: number }) => Promise<unknown>;
};

function getSelfCheckoutStaffApi(): SelfCheckoutStaffApi | undefined {
  return (window as Window & {
    electronAPI?: { selfCheckout?: SelfCheckoutStaffApi };
  }).electronAPI?.selfCheckout;
}

function formatStaffPinLocked(template: string, seconds: number): string {
  return template.replace('{seconds}', String(seconds));
}

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
  const [pinOpen, setPinOpen] = useState(false);
  const [pinCode, setPinCode] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSubmitting, setPinSubmitting] = useState(false);
  const [pinGate, setPinGate] = useState(initialStaffPinGateState);
  const [pinNow, setPinNow] = useState(() => Date.now());

  useEffect(() => {
    warmUpClipCache();
    return () => {
      cancelAnnouncement();
    };
  }, []);

  useEffect(() => {
    if (!pinGate.lockedUntil || Date.now() >= pinGate.lockedUntil) return;

    setPinNow(Date.now());
    const intervalId = window.setInterval(() => {
      const nextNow = Date.now();
      setPinNow(nextNow);
      if (nextNow >= pinGate.lockedUntil!) {
        window.clearInterval(intervalId);
      }
    }, 500);

    return () => window.clearInterval(intervalId);
  }, [pinGate.lockedUntil]);

  useEffect(() => {
    if (phase === 'awaitStaff') return;
    setPinOpen(false);
    setPinCode('');
    setPinError(null);
    setPinSubmitting(false);
  }, [phase]);

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
  const staffPinLocked = !canAttempt(pinGate, pinNow);
  const staffPinLockSeconds = Math.max(0, Math.ceil(((pinGate.lockedUntil ?? pinNow) - pinNow) / 1000));

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

  const closePinPanel = () => {
    setPinOpen(false);
    setPinCode('');
    setPinError(null);
    setPinSubmitting(false);
  };

  const openStaffPinPanel = () => {
    if (invoiceBlocked) return;
    setPinNow(Date.now());
    setPinOpen(true);
    setPinCode('');
    setPinError(null);
  };

  const handlePinDigit = (digit: string) => {
    if (staffPinLocked || pinSubmitting) return;
    setPinError(null);
    setPinCode((current) => (
      current.length >= STAFF_PIN_MAX_LENGTH ? current : `${current}${digit}`
    ));
  };

  const handlePinBackspace = () => {
    if (staffPinLocked || pinSubmitting) return;
    setPinError(null);
    setPinCode((current) => current.slice(0, -1));
  };

  const handlePinSubmit = async () => {
    const now = Date.now();
    setPinNow(now);
    if (phase !== 'awaitStaff' || !method || invoiceBlocked) return;
    if (!canAttempt(pinGate, now) || pinCode.length < 4 || pinSubmitting) return;

    setPinSubmitting(true);
    try {
      const staffApi = getSelfCheckoutStaffApi();
      const result = await staffApi?.staffVerify?.(pinCode).catch(() => ({ valid: false }));
      if (result?.valid === true) {
        setPinGate(recordSuccess());
        closePinPanel();
        await confirmReceived();
        return;
      }

      // The main-process gate fails closed when no real staff code is set (or it
      // is still the legacy default). That is a configuration problem, not a
      // wrong guess — surface it without spending the lockout budget.
      if ((result as { reason?: string } | undefined)?.reason === 'not_configured') {
        setPinCode('');
        setPinError(t.staffPinNotConfigured);
        return;
      }

      const nextGate = recordFailure(pinGate, now);
      const enteredLock = canAttempt(pinGate, now) && !canAttempt(nextGate, now);
      setPinGate(nextGate);
      setPinCode('');
      setPinError(enteredLock ? null : t.staffPinError);
      if (enteredLock) {
        void staffApi?.helpRequest?.({
          reason: 'STAFF_PIN_FAILED',
          cartTotalGrosze: totalGrosze,
        }).catch(() => undefined);
      }
    } finally {
      setPinSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (phase === 'processing') return;
    cancelAnnouncement();
    closePinPanel();
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
                <div className="mt-6">
                  {pinOpen ? (
                    <StaffPinPanel
                      strings={t}
                      codeLength={pinCode.length}
                      errorText={pinError}
                      locked={staffPinLocked}
                      lockedSeconds={staffPinLockSeconds}
                      submitting={pinSubmitting}
                      submitDisabled={pinCode.length < 4}
                      onDigit={handlePinDigit}
                      onBackspace={handlePinBackspace}
                      onCancel={closePinPanel}
                      onSubmit={handlePinSubmit}
                    />
                  ) : (
                    <div className="flex flex-col gap-3">
                      <button
                        type="button"
                        onClick={openStaffPinPanel}
                        disabled={invoiceBlocked}
                        className="sc-focusable flex items-center justify-center gap-3 rounded-[24px] border-2 border-[var(--sc-border)] bg-white px-6 py-5 text-2xl font-black text-[var(--sc-ink)] transition-colors hover:border-[var(--sc-primary)] hover:bg-[var(--sc-primary-soft)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Lock size={28} />
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

function StaffPinPanel({
  strings,
  codeLength,
  errorText,
  locked,
  lockedSeconds,
  submitting,
  submitDisabled,
  onDigit,
  onBackspace,
  onCancel,
  onSubmit,
}: {
  strings: ReturnType<typeof getScStrings>;
  codeLength: number;
  errorText: string | null;
  locked: boolean;
  lockedSeconds: number;
  submitting: boolean;
  submitDisabled: boolean;
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const inputDisabled = locked || submitting;
  const dotCount = Math.max(4, codeLength);

  return (
    <div className="rounded-[24px] border-2 border-[var(--sc-border)] bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--sc-surface-muted)] text-[var(--sc-ink)]">
          <Lock size={24} />
        </div>
        <div className="min-w-0">
          <h3 className="text-2xl font-black text-[var(--sc-ink)]">
            {strings.staffPinTitle}
          </h3>
          <p className="mt-1 text-base font-semibold leading-6 text-[var(--sc-muted)]">
            {strings.staffPinHint}
          </p>
        </div>
      </div>

      <div
        aria-label={strings.staffPinTitle}
        className="mt-4 flex min-h-[64px] flex-wrap items-center justify-center gap-3 rounded-2xl border-2 border-[var(--sc-border)] bg-[var(--sc-surface-muted)] px-4 py-3"
      >
        {Array.from({ length: dotCount }).map((_, index) => (
          <span
            key={index}
            className={`h-4 w-4 rounded-full ${
              index < codeLength
                ? 'bg-[var(--sc-ink)]'
                : 'border-2 border-[var(--sc-border)] bg-white'
            }`}
          />
        ))}
      </div>

      {errorText && !locked && (
        <div role="alert" className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-center text-base font-black text-red-800">
          {errorText}
        </div>
      )}

      {locked && (
        <div role="alert" className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-center text-base font-black text-amber-900">
          {formatStaffPinLocked(strings.staffPinLocked, lockedSeconds)}
        </div>
      )}

      <div className="mt-4 grid grid-cols-3 gap-2">
        {STAFF_PIN_KEYPAD.map((key) => {
          if (key === 'cancel') {
            return (
              <button
                key={key}
                type="button"
                onClick={onCancel}
                disabled={submitting}
                className="sc-focusable min-h-[64px] rounded-2xl border-2 border-[var(--sc-border)] bg-white px-2 text-lg font-black text-[var(--sc-ink)] transition-colors hover:border-[var(--sc-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {strings.staffPinCancel}
              </button>
            );
          }

          if (key === 'backspace') {
            return (
              <button
                key={key}
                type="button"
                onClick={onBackspace}
                disabled={inputDisabled || codeLength === 0}
                aria-label={strings.staffPinBackspace}
                className="sc-focusable flex min-h-[64px] items-center justify-center rounded-2xl border-2 border-[var(--sc-border)] bg-white text-[var(--sc-ink)] transition-colors hover:border-[var(--sc-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Delete size={28} />
              </button>
            );
          }

          return (
            <button
              key={key}
              type="button"
              onClick={() => onDigit(key)}
              disabled={inputDisabled}
              className="sc-focusable min-h-[64px] rounded-2xl border-2 border-[var(--sc-border)] bg-white text-3xl font-black text-[var(--sc-ink)] transition-colors hover:border-[var(--sc-primary)] hover:bg-[var(--sc-primary-soft)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {key}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onSubmit}
        disabled={inputDisabled || submitDisabled}
        className="sc-focusable mt-3 flex min-h-[64px] w-full items-center justify-center gap-3 rounded-[24px] border-2 border-[var(--sc-primary)] bg-[var(--sc-primary)] px-6 text-xl font-black text-white transition-colors hover:bg-[var(--sc-primary-deep)] disabled:cursor-not-allowed disabled:border-[var(--sc-border)] disabled:bg-[var(--sc-surface-muted)] disabled:text-[var(--sc-muted)]"
      >
        {submitting ? <Loader2 size={24} className="animate-spin" /> : <ShieldCheck size={24} />}
        {strings.staffPinConfirm}
      </button>
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
