import React, { useState, useEffect, useRef } from 'react';
import type { CartState, PosAction } from '../../hooks/usePosStore';
import rlog from '../../utils/logger';

interface PaymentModalProps {
  cart: CartState;
  dispatch: (action: PosAction) => void;
  onClose: () => void;
  onComplete?: () => void;
  t: (key: string) => string;
  shiftId: string | null;
  staffId: string | null;
  staffName: string | null;
  extraOrderFields?: Record<string, any>;
}

type PaymentMethod = 'CASH' | 'CARD' | 'BLIK' | 'TRANSFER' | 'INVOICE';

const QUICK_AMOUNTS = [1000, 2000, 5000, 10000, 20000]; // grosze

export default function PaymentModal({ cart, dispatch, onClose, onComplete, t, shiftId, staffId, staffName, extraOrderFields }: PaymentModalProps) {
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [cashAmount, setCashAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardStatus, setCardStatus] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const tip = extraOrderFields?.tip ?? 0;
  const grandTotal = cart.total + tip;
  const totalZl = grandTotal / 100;
  const parsedCash = parseFloat(cashAmount || '0');
  const cashAmountGrosze = Number.isFinite(parsedCash) ? Math.round(parsedCash * 100) : 0;
  const changeGrosze = method === 'CASH' ? Math.max(0, cashAmountGrosze - grandTotal) : 0;

  const isB2B = extraOrderFields?.mode === 'b2b';
  const canPayInvoice = extraOrderFields?.canPayInvoice ?? false;
  const hasCustomer = !!extraOrderFields?.customer_id;

  const paymentMethods: { id: PaymentMethod; labelKey: string; icon: React.ReactNode; disabled?: boolean }[] = [
    {
      id: 'CASH',
      labelKey: 'pos.payment.cash',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      id: 'CARD',
      labelKey: 'pos.payment.card',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
        </svg>
      ),
    },
    {
      id: 'BLIK',
      labelKey: 'pos.payment.blik',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      id: 'TRANSFER',
      labelKey: 'pos.payment.transfer',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
      ),
    },
    ...(isB2B && hasCustomer
      ? [{
          id: 'INVOICE' as PaymentMethod,
          labelKey: 'pos.payment.invoice',
          icon: (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          ),
          disabled: !canPayInvoice,
        }]
      : []),
  ];

  // Auto-switch away from disabled INVOICE
  useEffect(() => {
    if (method === 'INVOICE' && !canPayInvoice) {
      setMethod('CASH');
    }
  }, [canPayInvoice, method]);

  useEffect(() => {
    if (method === 'CASH') {
      inputRef.current?.focus();
    }
  }, [method]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, saving]);

  // Listen for Elavon status updates
  useEffect(() => {
    if (method !== 'CARD') return;
    const unsub = window.electronAPI.pos.payment.onElavonStatus((data: any) => {
      setCardStatus(data.status);
    });
    return unsub;
  }, [method]);

  const saveOrderAndFinish = async (orderId: string, paymentAmount: number) => {
    const order = {
      id: orderId,
      order_number: null as string | null,
      status: 'COMPLETED',
      subtotal: cart.subtotal,
      discount: cart.discount,
      tax: cart.tax,
      total: cart.total,
      payment_method: method,
      payment_amount: paymentAmount,
      change_amount: method === 'CASH' ? changeGrosze : 0,
      staff_id: staffId,
      staff_name: staffName,
      customer_id: extraOrderFields?.customer_id ?? null,
      customer_name: extraOrderFields?.customer_name ?? null,
      customer_nip: extraOrderFields?.customer_nip ?? null,
      shift_id: shiftId,
      source: 'POS',
      table_id: extraOrderFields?.table_id ?? null,
      covers: extraOrderFields?.covers ?? null,
      order_type: extraOrderFields?.order_type ?? 'standard',
      tip: extraOrderFields?.tip ?? 0,
      mode: extraOrderFields?.mode ?? 'retail',
      synced: 0,
      backend_id: null,
      created_at: new Date().toISOString(),
      synced_at: null,
    };

    const items = cart.items.map((item) => ({
      id: crypto.randomUUID(),
      order_id: orderId,
      variant_id: item.variantId,
      name: item.name,
      sku: item.sku,
      price: item.price,
      quantity: item.quantity,
      total: item.total,
      vat_rate: item.vatRate ?? 23,
      staff_id: item.staffId ?? null,
      staff_name: item.staffName ?? null,
      notes: item.notes ?? null,
      course: item.course ?? null,
    }));

    const result = await window.electronAPI.pos.orders.create(order, items);
    if (result && !result.success) {
      throw new Error(result.error || 'Failed to save order');
    }

    // Order saved successfully — now print receipt + open drawer
    // These are best-effort: if printing fails, order is still saved
    try {
      await window.electronAPI.pos.payment.printReceipt(orderId);
    } catch (err) {
      rlog.warn('[PaymentModal] Receipt print failed:', err);
    }
    if (method === 'CASH') {
      try {
        await window.electronAPI.pos.payment.openCashDrawer();
      } catch (err) {
        rlog.warn('[PaymentModal] Cash drawer failed:', err);
      }
    }

    // B2B: increase customer debt when paying by invoice
    if (method === 'INVOICE' && extraOrderFields?.customer_id) {
      try {
        await window.electronAPI.pos.customers.increaseDebt(extraOrderFields.customer_id, cart.total);
      } catch (err) {
        rlog.warn('[PaymentModal] Failed to increase customer debt:', err);
      }
    }

    // Only clear cart AFTER order is saved successfully
    dispatch({
      type: 'display/setMode',
      payload: { mode: 'thankyou', lastOrderTotal: cart.total },
    });
    dispatch({ type: 'cart/clear' });
    if (onComplete) {
      onComplete();
    } else {
      onClose();
    }
  };

  const handleComplete = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);

    try {
      const orderId = crypto.randomUUID();

      if (method === 'CARD') {
        setCardStatus(t('pos.payment.cardWaiting'));
        const result = await window.electronAPI.pos.payment.cardPayment({
          amount: grandTotal,
          orderId,
        });

        if (!result.success) {
          setError(result.error || t('pos.payment.cardFailed'));
          setSaving(false);
          setCardStatus(null);
          return;
        }

        setCardStatus(t('pos.payment.cardSuccess'));
        await saveOrderAndFinish(orderId, grandTotal);
      } else {
        const paymentAmount = method === 'CASH' ? cashAmountGrosze : grandTotal;
        await saveOrderAndFinish(orderId, paymentAmount);
      }
    } catch (err) {
      rlog.error('[PaymentModal] Failed to complete payment:', err);
      setError(t('pos.payment.error'));
    } finally {
      setSaving(false);
      setCardStatus(null);
    }
  };

  const canComplete =
    !saving && (method !== 'CASH' || cashAmountGrosze >= grandTotal);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-8 bg-black/50" onClick={saving ? undefined : onClose}>
      <div
        className="bg-white rounded-2xl w-full max-w-md mx-4 mb-[320px] shadow-2xl border border-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold text-gray-900">{t('pos.payment')}</h2>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Total */}
          <div className="bg-brand-50 border border-brand-100 rounded-xl py-4 text-center">
            <p className="text-xs text-brand-400 font-medium mb-0.5">{t('pos.cart.total')}</p>
            <p className="text-3xl font-bold text-brand-600 leading-none">{totalZl.toFixed(2)}&nbsp;{t('pos.currency')}</p>
          </div>

          {/* Payment method */}
          <div className="grid grid-cols-3 gap-2.5">
            {paymentMethods.map((pm) => (
              <button
                key={pm.id}
                onClick={() => !pm.disabled && setMethod(pm.id)}
                disabled={saving || pm.disabled}
                className={`py-3.5 px-3 rounded-xl text-center transition-all flex flex-col items-center gap-1.5 border cursor-pointer touch-manipulation ${
                  method === pm.id
                    ? 'bg-brand-500 text-white border-brand-500 shadow-sm'
                    : pm.disabled
                      ? 'bg-slate-50 text-gray-300 border-gray-100 cursor-not-allowed'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-brand-300 hover:text-brand-500 hover:bg-brand-50'
                } disabled:opacity-50`}
              >
                <span className={method === pm.id ? 'text-white' : ''}>{pm.icon}</span>
                <p className="text-[11px] font-medium leading-none">{t(pm.labelKey)}</p>
              </button>
            ))}
          </div>

          {/* Cash input */}
          {method === 'CASH' && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 font-medium block mb-1.5">{t('pos.payment.received')}</label>
                <input
                  ref={inputRef}
                  type="text"
                  inputMode="decimal"
                  value={cashAmount}
                  onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setCashAmount(e.target.value); }}
                  placeholder={totalZl.toFixed(2)}
                  className="w-full px-4 py-3 bg-slate-50 border border-gray-200 rounded-xl text-xl text-gray-900 text-right font-bold focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                />
              </div>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => setCashAmount(totalZl.toFixed(2))}
                  className="px-3 py-2 text-xs bg-brand-50 text-brand-500 border border-brand-200 rounded-lg hover:bg-brand-100 transition-colors font-medium cursor-pointer"
                >
                  {t('pos.payment.exact')}
                </button>
                {QUICK_AMOUNTS.filter((a) => a >= grandTotal).slice(0, 3).map((amount) => (
                  <button
                    key={amount}
                    onClick={() => setCashAmount((amount / 100).toFixed(2))}
                    className="px-3 py-2 text-xs bg-slate-50 text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors font-medium cursor-pointer"
                  >
                    {(amount / 100).toFixed(0)}&nbsp;{t('pos.currency')}
                  </button>
                ))}
              </div>
              {cashAmountGrosze > 0 && cashAmountGrosze >= grandTotal && (
                <div className="flex justify-between items-center px-4 py-3 bg-emerald-50 border border-emerald-100 rounded-xl">
                  <span className="text-sm font-medium text-emerald-700">{t('pos.payment.change')}</span>
                  <span className="text-xl font-bold text-emerald-600">{(changeGrosze / 100).toFixed(2)}&nbsp;{t('pos.currency')}</span>
                </div>
              )}
            </div>
          )}

          {/* Card status */}
          {method === 'CARD' && cardStatus && (
            <div className="flex items-center justify-center gap-2 py-3 px-4 bg-blue-50 border border-blue-100 rounded-xl">
              <svg className="w-4 h-4 text-blue-500 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="text-sm font-medium text-blue-600">{cardStatus}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 pb-5 pt-1 space-y-2">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-100 rounded-lg">
              <svg className="w-4 h-4 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-xs text-red-600">{error}</p>
            </div>
          )}
          <button
            onClick={handleComplete}
            disabled={!canComplete}
            className="w-full py-4 rounded-xl font-bold text-base text-white bg-brand-500 hover:bg-brand-600 active:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm active:scale-[0.99] cursor-pointer"
          >
            {saving ? t('pos.payment.saving') : t('pos.payment.complete')}
          </button>
        </div>
      </div>
    </div>
  );
}
