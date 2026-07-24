/**
 * Ends/freezes a Billiard session, then hands the authoritative checkout
 * bundle to the normal POS payment flow. Billiard never captures money or
 * prints a second receipt on this path.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { CreditCard, Loader2, X, ShoppingCart, AlertTriangle } from 'lucide-react';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useToast } from './Toast';
import { useEndSession } from '../../hooks/useBilliardData';
import {
  resolveBilliardOutstandingBalance,
  resolveBilliardSessionTotal,
  shouldSkipBilliardPosPayment,
} from '../../../shared/billiard-contract';

interface PaymentDialogProps {
  session: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  language: Language;
  onRefetch?: () => Promise<void>;
  onPayInPos?: (input: { posCheckout: any; tableName?: string | null }) => Promise<void>;
}

type PaymentStep = 'ready' | 'processing' | 'done';

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(value);
}

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (event.key !== 'Tab' || !dialog) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!dialog.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function PaymentDialog({ session, open, onOpenChange, language, onRefetch, onPayInPos }: PaymentDialogProps) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const endSession = useEndSession(onRefetch);
  const [step, setStep] = useState<PaymentStep>('ready');
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [endedSnapshot, setEndedSnapshot] = useState<any | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const handoffInFlightRef = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      handoffInFlightRef.current = false;
      return;
    }
    // A successful end mutation can refresh the parent session while the POS
    // handoff is still running. Do not re-enable the action in that window.
    if (handoffInFlightRef.current) return;

    const status = String(session?.status || '').toUpperCase();
    const alreadyEnded = status !== 'ACTIVE' && status !== 'PAUSED';
    if (shouldSkipBilliardPosPayment(session)) {
      setStep('done');
      setPaymentError(null);
      setEndedSnapshot(session);
      onOpenChangeRef.current(false);
      return;
    }
    setStep('ready');
    setPaymentError(null);
    setEndedSnapshot(alreadyEnded ? session : null);
  }, [
    open,
    session?.id,
    session?.status,
    session?.paymentStatus,
    session?.paidAmount,
    session?.outstandingAmount,
    session?.total,
    session?.totalCharge,
    session?.posCheckout,
    session?.posCheckoutId,
  ]);

  const isProcessing = step === 'processing';
  const handleCancel = useCallback(() => {
    if (isProcessing) return;
    if (endedSnapshot && step !== 'done') {
      toast.error(
        t('billiard.paymentFailed') || 'Payment is still pending and remains visible on the billiard screen.',
      );
    }
    onOpenChange(false);
  }, [endedSnapshot, isProcessing, onOpenChange, step, t, toast]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isProcessing) {
        event.preventDefault();
        event.stopPropagation();
        handleCancel();
        return;
      }
      trapDialogFocus(event, dialogRef.current);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleCancel, isProcessing, open]);

  if (!open || !session) return null;

  const displayedSession = endedSnapshot ?? session;
  const grandTotal = resolveBilliardSessionTotal(displayedSession);
  const paidAmount = Math.max(0, Number(displayedSession?.paidAmount ?? 0));
  const outstanding = resolveBilliardOutstandingBalance(displayedSession);

  const reconcileSession = async () => {
    const reconciled = await window.electronAPI.billiard.mutate(
      'online_api',
      'GET',
      `/billiard/sessions/${session.id}`,
    );
    const reconciledStatus = String(reconciled?.status || '').toUpperCase();
    if (
      reconciled?.id
      && reconciledStatus !== 'ACTIVE'
      && reconciledStatus !== 'PAUSED'
    ) {
      setEndedSnapshot(reconciled);
    }
    return reconciled;
  };

  const ensureEnded = async () => {
    if (endedSnapshot) return endedSnapshot;
    const status = String(session.status || '').toUpperCase();
    if (status !== 'ACTIVE' && status !== 'PAUSED') {
      setEndedSnapshot(session);
      return session;
    }

    let result: any;
    try {
      result = await endSession.mutate(session.id);
    } catch (endError) {
      // The server may have committed the end while the response was lost.
      // Reconcile before allowing a second PATCH /end on retry.
      try {
        const reconciled = await reconcileSession();
        const reconciledStatus = String(reconciled?.status || '').toUpperCase();
        if (
          reconciled?.id
          && reconciledStatus !== 'ACTIVE'
          && reconciledStatus !== 'PAUSED'
        ) {
          return reconciled;
        }
      } catch {
        // Preserve the original end failure when reconciliation also fails.
      }
      throw endError;
    }
    if (!result || result.queued) {
      throw new Error('Could not freeze the final billiard total on the server.');
    }
    setEndedSnapshot(result);
    return result;
  };

  const assertPosCheckoutReady = async () => {
    const [config, posState] = await Promise.all([
      window.electronAPI.getConfig(),
      window.electronAPI.pos.getState(),
    ]);
    const salonId = String(config?.salonId || config?.authUser?.salonId || '').trim();
    const userId = String(config?.authUser?.id || '').trim();
    const registerId = String(config?.registerCode || config?.machineId || config?.agentId || '').trim();
    if (!salonId || !userId || !registerId) {
      throw new Error('POS register is not ready. Sign in and pair this register before ending the Billiard session.');
    }

    const posSession = posState?.session;
    if (!posSession?.isOpen || !posSession?.shiftId || !posSession?.staffId) {
      throw new Error('Open a POS shift before ending this Billiard session. The table is still running.');
    }

    if (config?.allowRealFiscalPrint === true) {
      const fiscal = await window.electronAPI.pos.payment.hasFiscalPrinter();
      if (!fiscal?.success || !fiscal.configured || !fiscal.connected) {
        throw new Error('The fiscal printer is not ready. Connect it before ending this Billiard session.');
      }
    }
  };

  const handlePrimaryAction = async () => {
    if (handoffInFlightRef.current) return;
    handoffInFlightRef.current = true;
    setPaymentError(null);
    setStep('processing');
    try {
      if (!onPayInPos) {
        throw new Error('Pay in POS is available in the Windows counter app. This session remains unpaid.');
      }

      await assertPosCheckoutReady();
      let snapshot = endedSnapshot ?? await ensureEnded();
      if (shouldSkipBilliardPosPayment(snapshot)) {
        setStep('done');
        toast.success(t('billiard.paid') || 'Session completed with no balance due.');
        onOpenChange(false);
        return;
      }

      // A successful end response should already contain the frozen checkout,
      // but recover from a delayed/older response by reconciling the completed
      // session before asking the cashier to retry.
      if (!snapshot?.posCheckout) {
        const reconciled = await reconcileSession();
        if (reconciled?.id) {
          snapshot = reconciled;
        }
      }
      if (shouldSkipBilliardPosPayment(snapshot)) {
        setStep('done');
        toast.success(t('billiard.paid') || 'Session completed with no balance due.');
        onOpenChange(false);
        return;
      }
      if (!snapshot?.posCheckout) {
        throw new Error('The final POS checkout is not ready yet. Try again.');
      }
      await onPayInPos({
        posCheckout: snapshot.posCheckout,
        tableName: snapshot?.resource?.name ?? snapshot?.tableName ?? session?.resource?.name ?? null,
      });
      onOpenChange(false);
    } catch (err: any) {
      const message = err?.message || t('billiard.paymentFailed') || 'Payment failed';
      setPaymentError(message);
      toast.error(message);
      setStep('ready');
    } finally {
      handoffInFlightRef.current = false;
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center"
      style={{ bottom: 'var(--touch-keyboard-inset, 0px)' }}
      onClick={handleCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('billiard.payment') || 'Payment'}
        tabIndex={-1}
        className="bg-white rounded-xl shadow-xl max-w-sm w-full mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            {t('billiard.payment') || 'Payment'}
          </h3>
          <button
            autoFocus
            onClick={handleCancel}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
            disabled={isProcessing}
            aria-label={t('common.close') || 'Close'}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-center py-4 bg-slate-50 rounded-lg">
            <p className="text-3xl font-bold tabular-nums">{formatCurrency(outstanding)}</p>
            <p className="text-sm text-slate-500 mt-1">
              {!endedSnapshot
                ? `${t('billiard.remaining') || 'Remaining'} · ${t('billiard.running') || 'Running'}`
                : (t('billiard.remaining') || 'Remaining')}
            </p>
            {paidAmount > 0 && (
              <div className="mt-3 flex items-center justify-center gap-4 text-xs text-slate-600">
                <span>{t('billiard.total') || 'Total'}: {formatCurrency(grandTotal)}</span>
                <span>{t('pos.history.paidAmount') || 'Paid'}: {formatCurrency(paidAmount)}</span>
              </div>
            )}
          </div>

          {paymentError && (
            <div className="flex items-start gap-2 p-3 bg-red-50 rounded-lg text-sm text-red-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{paymentError}</span>
            </div>
          )}

          {step === 'ready' && (
            <div className="flex items-center justify-center gap-2 p-3 rounded-lg border-2 border-blue-600 bg-blue-50 text-blue-700">
              <ShoppingCart className="w-5 h-5" />
              <span className="text-sm font-medium">
                {t('billiard.payment') || 'Payment'} → POS
              </span>
            </div>
          )}
          {step === 'processing' && (
            <div
              className="flex items-center justify-center gap-2 p-3 rounded-lg border border-blue-200 bg-blue-50 text-blue-700"
              role="status"
            >
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm font-medium">
                {t('billiard.payment') || 'Payment'} → POS
              </span>
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            className="flex h-11 items-center rounded-lg border border-slate-300 px-4 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
            onClick={handleCancel}
            disabled={isProcessing}
          >
            {t('common.cancel') || 'Cancel'}
          </button>
          {step === 'ready' && (
            <button
              data-testid="billiard-pos-handoff"
              className="flex h-11 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              onClick={handlePrimaryAction}
              disabled={endSession.isPending || !onPayInPos}
            >
              {endSession.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              {!endedSnapshot
                ? `${t('billiard.endSession') || 'End session'} → POS`
                : `${t('billiard.payment') || 'Payment'} → POS`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
