/**
 * PaymentDialog — payment processing for billiard sessions.
 * Supports cash settlement. Card and BLIK stay hidden until the terminal
 * transport can provide an idempotent, reconcilable authorization result.
 * Payment first freezes the session total on the server, then settles it.
 * The backend owns receipt dispatch; the client only opens the cash drawer.
 */

import { useState, useEffect } from 'react';
import { CreditCard, Loader2, X, Banknote, AlertTriangle } from 'lucide-react';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useToast } from './Toast';
import { useEndSession, useProcessPayment } from '../../hooks/useBilliardData';
import {
  resolveBilliardOutstandingBalance,
  resolveBilliardSessionTotal,
} from '../../../shared/billiard-contract';

interface PaymentDialogProps {
  session: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  language: Language;
  onRefetch?: () => Promise<void>;
}

type PaymentStep = 'select' | 'review' | 'processing' | 'done';

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(value);
}

export function PaymentDialog({ session, open, onOpenChange, language, onRefetch }: PaymentDialogProps) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const endSession = useEndSession(onRefetch);
  const processPayment = useProcessPayment(onRefetch);
  const [step, setStep] = useState<PaymentStep>('select');
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [endedSnapshot, setEndedSnapshot] = useState<any | null>(null);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      const status = String(session?.status || '').toUpperCase();
      const alreadyEnded = status !== 'ACTIVE' && status !== 'PAUSED';
      setStep(alreadyEnded ? 'review' : 'select');
      setPaymentError(null);
      setEndedSnapshot(alreadyEnded ? session : null);
    }
  }, [open, session?.id]);

  if (!open || !session) return null;

  const displayedSession = endedSnapshot ?? session;
  const grandTotal = resolveBilliardSessionTotal(displayedSession);
  const paidAmount = Math.max(0, Number(displayedSession?.paidAmount ?? 0));
  const outstanding = resolveBilliardOutstandingBalance(displayedSession);

  const ensureEnded = async () => {
    if (endedSnapshot) return endedSnapshot;
    const status = String(session.status || '').toUpperCase();
    if (status !== 'ACTIVE' && status !== 'PAUSED') {
      setEndedSnapshot(session);
      return session;
    }

    const result = await endSession.mutate(session.id);
    if (!result || result.queued) {
      throw new Error('Could not freeze the final billiard total on the server.');
    }
    setEndedSnapshot(result);
    return result;
  };

  const settleCashPayment = async (snapshot: any) => {
    const amountDue = resolveBilliardOutstandingBalance(snapshot);
    const alreadySettledZero = amountDue <= 0
      && String(snapshot.paymentStatus || '').toUpperCase() === 'PAID';
    const result = alreadySettledZero
      ? snapshot
      : await processPayment.mutate({
          sessionId: session.id,
          data: {
            paymentMethod: 'CASH',
            ...(amountDue > 0 ? { amount: amountDue } : {}),
          },
        });
    if (!result || String(result.paymentStatus || '').toUpperCase() !== 'PAID') {
      throw new Error(t('billiard.paymentFailed') || 'The server did not confirm this payment.');
    }

    if (amountDue > 0) {
      try { await window.electronAPI.billiard.openCashDrawer(); } catch { /* best effort */ }
    }

    // BilliardPaymentService dispatches the canonical receipt print job.
    // Do not print a second local copy here.
    toast.success(t('billiard.paymentSuccess') || 'Payment processed');
    setStep('done');
    onOpenChange(false);
  };

  const recoverSessionState = async (): Promise<'paid' | 'pending' | null> => {
    try {
      const latest = await window.electronAPI.billiard.mutate(
        'online_api',
        'GET',
        `/billiard/sessions/${session.id}`,
      );
      if (!latest?.id) return null;
      if (String(latest.paymentStatus || '').toUpperCase() === 'PAID') {
        toast.success(t('billiard.paymentSuccess') || 'Payment processed');
        setStep('done');
        onOpenChange(false);
        return 'paid';
      }
      const status = String(latest.status || '').toUpperCase();
      if (status === 'COMPLETED') {
        setEndedSnapshot(latest);
        setStep('review');
        setPaymentError(
          t('billiard.paymentFailed') || 'Session ended. Review the final total and complete payment.',
        );
        return 'pending';
      }
    } catch {
      // The original error is more useful when reconciliation is unavailable.
    }
    return null;
  };

  const handlePrimaryAction = async () => {
    setPaymentError(null);
    try {
      if (step === 'select') {
        await ensureEnded();
        setStep('review');
        return;
      }

      const snapshot = endedSnapshot ?? await ensureEnded();
      setStep('processing');
      await settleCashPayment(snapshot);
    } catch (err: any) {
      const message = err?.message || t('billiard.paymentFailed') || 'Payment failed';
      const recovery = await recoverSessionState();
      if (recovery === 'paid') return;
      if (recovery === 'pending') {
        toast.error(message);
        return;
      }
      setPaymentError(message);
      toast.error(message);
      setStep(endedSnapshot ? 'review' : 'select');
    }
  };

  const handleCancel = () => {
    if (step === 'processing') return;
    if (endedSnapshot && step !== 'done') {
      toast.error(
        t('billiard.paymentFailed') || 'Payment is still pending and remains visible on the billiard screen.',
      );
    }
    onOpenChange(false);
  };

  const isProcessing = step === 'processing';

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center" onClick={handleCancel}>
      <div className="bg-white rounded-xl shadow-xl max-w-sm w-full mx-4 flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            {t('billiard.payment') || 'Payment'}
          </h3>
          <button onClick={handleCancel} className="p-1 rounded hover:bg-slate-100" disabled={isProcessing}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-center py-4 bg-slate-50 rounded-lg">
            <p className="text-3xl font-bold tabular-nums">{formatCurrency(outstanding)}</p>
            <p className="text-sm text-slate-500 mt-1">
              {step === 'select'
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

          {(step === 'select' || step === 'review') && (
            <div className="flex items-center justify-center gap-2 p-3 rounded-lg border-2 border-blue-600 bg-blue-50 text-blue-700">
              <Banknote className="w-5 h-5" />
              <span className="text-sm font-medium">{t('billiard.cash') || 'Cash'}</span>
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
            onClick={handleCancel}
            disabled={isProcessing}
          >
            {t('common.cancel') || 'Cancel'}
          </button>
          {(step === 'select' || step === 'review') && (
            <button
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 flex items-center"
              onClick={handlePrimaryAction}
              disabled={processPayment.isPending || endSession.isPending}
            >
              {processPayment.isPending || endSession.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              {step === 'select'
                ? `${t('billiard.endSession') || 'End session'} · ${t('billiard.total') || 'Total'}`
                : (t('billiard.processPayment') || 'Process Payment')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
