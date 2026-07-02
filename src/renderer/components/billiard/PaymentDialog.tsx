/**
 * PaymentDialog — payment processing for billiard sessions.
 * Supports Cash, Card (Elavon terminal), and BLIK.
 * After payment: prints receipt + opens cash drawer (cash only).
 */

import { useState, useEffect } from 'react';
import { CreditCard, Loader2, X, Banknote, Smartphone, AlertTriangle } from 'lucide-react';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useToast } from './Toast';
import { useProcessPayment } from '../../hooks/useBilliardData';

interface PaymentDialogProps {
  session: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  language: Language;
  onRefetch?: () => Promise<void>;
}

type PaymentStep = 'select' | 'elavon_waiting' | 'processing' | 'done';

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(value);
}

export function PaymentDialog({ session, open, onOpenChange, language, onRefetch }: PaymentDialogProps) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const processPayment = useProcessPayment(onRefetch);
  const [method, setMethod] = useState<'CASH' | 'CARD' | 'BLIK'>('CASH');
  const [step, setStep] = useState<PaymentStep>('select');
  const [elavonError, setElavonError] = useState<string | null>(null);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setStep('select');
      setElavonError(null);
      setMethod('CASH');
    }
  }, [open]);

  // Listen for Elavon terminal status updates
  useEffect(() => {
    if (!open || step !== 'elavon_waiting') return;
    const unsub = window.electronAPI?.pos?.payment?.onElavonStatus?.((data: any) => {
      if (data.status === 'approved' || data.approved) {
        // Card approved — proceed with payment processing
        handlePostElavon();
      } else if (data.status === 'declined' || data.status === 'error' || data.error) {
        setElavonError(data.message || data.error || t('billiard.cardDeclined') || 'Card declined');
        setStep('select');
      }
    });
    return () => { unsub?.(); };
  }, [open, step]);

  if (!open || !session) return null;

  const items = session.items || [];
  const timeCharge = session.currentTimeCharge ?? session.timeCharge ?? 0;
  const itemsTotal = items.reduce((sum: number, item: any) => sum + (item.unitPrice || 0) * (item.quantity || 1), 0);
  const isPackage = session.billingMode === 'PACKAGE_COUNTDOWN';
  const total = isPackage ? Number(session.packagePrice ?? 0) + itemsTotal : timeCharge + itemsTotal;

  const handlePostElavon = async () => {
    setStep('processing');
    try {
      await processPayment.mutate({ sessionId: session.id, data: { method: 'CARD', amount: total } });

      // Print receipt (don't block on failure)
      try {
        const result = await window.electronAPI.billiard.printReceipt(session.id, { method: 'CARD', amount: total });
        if (!result.receiptPrinted) {
          toast.error(t('billiard.receiptNotPrinted') || 'Receipt could not be printed');
        }
      } catch { /* printer offline — don't block */ }

      toast.success(t('billiard.paymentSuccess') || 'Payment processed');
      setStep('done');
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message || t('billiard.paymentFailed') || 'Payment failed');
      setStep('select');
    }
  };

  const handlePay = async () => {
    // Card payment via Elavon terminal
    if (method === 'CARD') {
      // Check if online (Elavon requires network)
      try {
        const syncStatus = await window.electronAPI.billiard.getSyncStatus();
        if (!syncStatus.online) {
          setElavonError(t('billiard.cardRequiresNetwork') || 'Card payment requires network connection');
          return;
        }
      } catch { /* proceed anyway */ }

      setElavonError(null);
      setStep('elavon_waiting');

      try {
        await window.electronAPI.pos.payment.cardPayment({ amount: total, orderId: session.id });
        // Elavon response comes asynchronously via onElavonStatus listener
      } catch (err: any) {
        setElavonError(err?.message || t('billiard.cardTerminalError') || 'Card terminal error');
        setStep('select');
      }
      return;
    }

    // Cash / BLIK — process immediately
    setStep('processing');
    try {
      await processPayment.mutate({ sessionId: session.id, data: { method, amount: total } });

      // Print receipt (don't block on failure)
      try {
        const result = await window.electronAPI.billiard.printReceipt(session.id, { method, amount: total });
        if (!result.receiptPrinted) {
          toast.error(t('billiard.receiptNotPrinted') || 'Receipt could not be printed');
        }
      } catch { /* printer offline — don't block */ }

      // Open cash drawer for cash payments
      if (method === 'CASH') {
        try { await window.electronAPI.billiard.openCashDrawer(); } catch { /* ignore */ }
      }

      toast.success(t('billiard.paymentSuccess') || 'Payment processed');
      setStep('done');
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message || t('billiard.paymentFailed') || 'Payment failed');
      setStep('select');
    }
  };

  const handleCancel = () => {
    if (step === 'elavon_waiting') {
      // Can't really cancel Elavon mid-transaction, but reset UI
      setStep('select');
      setElavonError(null);
      return;
    }
    onOpenChange(false);
  };

  const methods = [
    { key: 'CASH' as const, icon: <Banknote className="w-5 h-5" />, label: t('billiard.cash') || 'Cash' },
    { key: 'CARD' as const, icon: <CreditCard className="w-5 h-5" />, label: t('billiard.card') || 'Card' },
    { key: 'BLIK' as const, icon: <Smartphone className="w-5 h-5" />, label: 'BLIK' },
  ];

  const isProcessing = step === 'processing' || step === 'elavon_waiting';

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center" onClick={() => !isProcessing && onOpenChange(false)}>
      <div className="bg-white rounded-xl shadow-xl max-w-sm w-full mx-4 flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            {t('billiard.payment') || 'Payment'}
          </h3>
          <button onClick={handleCancel} className="p-1 rounded hover:bg-slate-100" disabled={step === 'processing'}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-center py-4 bg-slate-50 rounded-lg">
            <p className="text-3xl font-bold tabular-nums">{formatCurrency(total)}</p>
            <p className="text-sm text-slate-500 mt-1">{t('billiard.total') || 'Total'}</p>
          </div>

          {/* Elavon waiting state */}
          {step === 'elavon_waiting' && (
            <div className="flex flex-col items-center gap-3 py-4 bg-blue-50 rounded-lg">
              <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              <p className="text-sm font-medium text-blue-800">
                {t('billiard.waitingForCard') || 'Waiting for card...'}
              </p>
              <p className="text-xs text-blue-600">
                {t('billiard.presentCard') || 'Present card on the terminal'}
              </p>
            </div>
          )}

          {/* Elavon error */}
          {elavonError && (
            <div className="flex items-start gap-2 p-3 bg-red-50 rounded-lg text-sm text-red-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{elavonError}</span>
            </div>
          )}

          {/* Payment method selector */}
          {step === 'select' && (
            <div className="grid grid-cols-3 gap-2">
              {methods.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => { setMethod(m.key); setElavonError(null); }}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border-2 transition-colors ${
                    method === m.key ? 'border-blue-600 bg-blue-50 text-blue-600' : 'border-slate-200 hover:border-blue-300'
                  }`}
                >
                  {m.icon}
                  <span className="text-xs font-medium">{m.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
            onClick={handleCancel}
            disabled={step === 'processing'}
          >
            {step === 'elavon_waiting' ? (t('common.back') || 'Back') : (t('common.cancel') || 'Cancel')}
          </button>
          {step === 'select' && (
            <button
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 flex items-center"
              onClick={handlePay}
              disabled={processPayment.isPending}
            >
              {processPayment.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              {t('billiard.processPayment') || 'Process Payment'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
