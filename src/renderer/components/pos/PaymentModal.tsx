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

interface Tender {
  method: PaymentMethod;
  amount: number; // grosze
}

const QUICK_AMOUNTS = [1000, 2000, 5000, 10000, 20000]; // grosze

const PM_ICONS: Record<string, React.ReactNode> = {
  CASH: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg>,
  CARD: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>,
  BLIK: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>,
  TRANSFER: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>,
  INVOICE: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
};

export default function PaymentModal({ cart, dispatch, onClose, onComplete, t, shiftId, staffId, staffName, extraOrderFields }: PaymentModalProps) {
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [cashAmount, setCashAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardStatus, setCardStatus] = useState<string | null>(null);
  const [splitMode, setSplitMode] = useState(false);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [splitAmount, setSplitAmount] = useState('');
  const [splitMethod, setSplitMethod] = useState<PaymentMethod>('CASH');
  const inputRef = useRef<HTMLInputElement>(null);

  const tip = extraOrderFields?.tip ?? 0;
  const grandTotal = cart.total + tip;
  const totalZl = grandTotal / 100;
  const parsedCash = parseFloat(cashAmount || '0');
  const cashAmountGrosze = Number.isFinite(parsedCash) ? Math.round(parsedCash * 100) : 0;
  const changeGrosze = method === 'CASH' && !splitMode ? Math.max(0, cashAmountGrosze - grandTotal) : 0;

  const isB2B = extraOrderFields?.mode === 'b2b';
  const canPayInvoice = extraOrderFields?.canPayInvoice ?? false;
  const hasCustomer = !!extraOrderFields?.customer_id;

  // Split payment calculations
  const tendersTotal = tenders.reduce((s, t) => s + t.amount, 0);
  const remaining = grandTotal - tendersTotal;
  const splitComplete = tendersTotal >= grandTotal;

  const availableMethods: PaymentMethod[] = ['CASH', 'CARD', 'BLIK', 'TRANSFER',
    ...(isB2B && hasCustomer ? ['INVOICE' as PaymentMethod] : [])];

  useEffect(() => {
    if (method === 'INVOICE' && !canPayInvoice) setMethod('CASH');
  }, [canPayInvoice, method]);

  useEffect(() => {
    if (method === 'CASH' && !splitMode) inputRef.current?.focus();
  }, [method, splitMode]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, saving]);

  useEffect(() => {
    if (method !== 'CARD') return;
    const unsub = window.electronAPI.pos.payment.onElavonStatus((data: any) => setCardStatus(data.status));
    return unsub;
  }, [method]);

  // ─── Add split tender ─────────────────────────────────────

  const addTender = () => {
    const parsed = parseFloat(splitAmount || '0');
    const amountGrosze = Math.round(parsed * 100);
    if (amountGrosze <= 0) return;
    setTenders(prev => [...prev, { method: splitMethod, amount: amountGrosze }]);
    setSplitAmount('');
  };

  const removeTender = (idx: number) => {
    setTenders(prev => prev.filter((_, i) => i !== idx));
  };

  const addRemaining = () => {
    if (remaining <= 0) return;
    setTenders(prev => [...prev, { method: splitMethod, amount: remaining }]);
    setSplitAmount('');
  };

  // ─── Save order ───────────────────────────────────────────

  const saveOrderAndFinish = async (orderId: string, paymentAmount: number) => {
    // Determine primary method (largest tender or single method)
    let primaryMethod = method;
    let tendersJson: string | null = null;

    if (splitMode && tenders.length > 0) {
      const sorted = [...tenders].sort((a, b) => b.amount - a.amount);
      primaryMethod = sorted[0].method;
      tendersJson = JSON.stringify(tenders);
    }

    const order = {
      id: orderId,
      order_number: null as string | null,
      status: 'COMPLETED',
      subtotal: cart.subtotal,
      discount: cart.discount,
      tax: cart.tax,
      total: cart.total,
      payment_method: primaryMethod,
      payment_amount: paymentAmount,
      change_amount: splitMode ? 0 : (method === 'CASH' ? changeGrosze : 0),
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
      payment_tenders: tendersJson,
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
    if (result && !result.success) throw new Error(result.error || 'Failed to save order');

    try { await window.electronAPI.pos.payment.printReceipt(orderId); }
    catch (err) { rlog.warn('[PaymentModal] Receipt print failed:', err); }

    // Open drawer if any tender is cash
    const hasCash = splitMode
      ? tenders.some(t => t.method === 'CASH')
      : method === 'CASH';
    if (hasCash) {
      try { await window.electronAPI.pos.payment.openCashDrawer(); }
      catch (err) { rlog.warn('[PaymentModal] Cash drawer failed:', err); }
    }

    if (method === 'INVOICE' && extraOrderFields?.customer_id) {
      try { await window.electronAPI.pos.customers.increaseDebt(extraOrderFields.customer_id, cart.total); }
      catch (err) { rlog.warn('[PaymentModal] Failed to increase customer debt:', err); }
    }

    dispatch({ type: 'display/setMode', payload: { mode: 'thankyou', lastOrderTotal: cart.total } });
    dispatch({ type: 'cart/clear' });
    if (onComplete) { onComplete(); } else { onClose(); }
  };

  const handleComplete = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);

    try {
      const orderId = crypto.randomUUID();

      if (splitMode) {
        if (!splitComplete) { setError(t('pos.split.incomplete') || 'Split payment incomplete'); setSaving(false); return; }
        await saveOrderAndFinish(orderId, tendersTotal);
      } else if (method === 'CARD') {
        setCardStatus(t('pos.payment.cardWaiting'));
        const result = await window.electronAPI.pos.payment.cardPayment({ amount: grandTotal, orderId });
        if (!result.success) { setError(result.error || t('pos.payment.cardFailed')); setSaving(false); setCardStatus(null); return; }
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

  const canComplete = !saving && (
    splitMode ? splitComplete
    : method !== 'CASH' || cashAmountGrosze >= grandTotal
  );

  const currency = t('pos.currency') || 'zl';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-8 bg-black/50" onClick={saving ? undefined : onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md mx-4 mb-[320px] shadow-2xl border border-gray-200" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold text-gray-900">{t('pos.payment')}</h2>
          <div className="flex items-center gap-2">
            {/* Split toggle */}
            <button
              onClick={() => { setSplitMode(!splitMode); setTenders([]); setSplitAmount(''); }}
              disabled={saving}
              className={`px-3 py-1.5 text-xs rounded-lg border font-medium transition-colors cursor-pointer ${
                splitMode
                  ? 'bg-purple-500 text-white border-purple-500'
                  : 'bg-white text-gray-500 border-gray-200 hover:border-purple-300 hover:text-purple-500'
              }`}
            >
              {t('pos.split.toggle') || 'Split'}
            </button>
            <button
              onClick={onClose}
              disabled={saving}
              aria-label="Close"
              className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Total */}
          <div className="bg-brand-50 border border-brand-100 rounded-xl py-4 text-center">
            <p className="text-xs text-brand-400 font-medium mb-0.5">{t('pos.cart.total')}</p>
            <p className="text-3xl font-bold text-brand-600 leading-none">{totalZl.toFixed(2)}&nbsp;{currency}</p>
          </div>

          {/* ─── SPLIT MODE ─────────────────────────────────── */}
          {splitMode ? (
            <div className="space-y-3">
              {/* Remaining indicator */}
              <div className={`flex justify-between items-center px-4 py-2.5 rounded-xl border ${
                splitComplete ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'
              }`}>
                <span className="text-xs font-medium text-gray-600">
                  {splitComplete ? (t('pos.split.complete') || 'Fully covered') : (t('pos.split.remaining') || 'Remaining')}
                </span>
                <span className={`text-sm font-bold ${splitComplete ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {splitComplete ? '0.00' : (remaining / 100).toFixed(2)} {currency}
                </span>
              </div>

              {/* Tenders list */}
              {tenders.length > 0 && (
                <div className="space-y-1.5">
                  {tenders.map((tender, idx) => (
                    <div key={idx} className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 text-gray-400">{PM_ICONS[tender.method]}</span>
                        <span className="text-sm text-gray-700">{t(`pos.payment.${tender.method.toLowerCase()}`) || tender.method}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-gray-900">{(tender.amount / 100).toFixed(2)} {currency}</span>
                        <button
                          onClick={() => removeTender(idx)}
                          className="w-6 h-6 flex items-center justify-center rounded-full text-gray-300 hover:text-red-500 hover:bg-red-50 cursor-pointer"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Add tender form */}
              {!splitComplete && (
                <div className="flex gap-2">
                  <select
                    value={splitMethod}
                    onChange={e => setSplitMethod(e.target.value as PaymentMethod)}
                    className="px-2.5 py-2.5 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-brand-400 cursor-pointer"
                  >
                    {availableMethods.map(m => (
                      <option key={m} value={m}>{t(`pos.payment.${m.toLowerCase()}`) || m}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={splitAmount}
                    onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setSplitAmount(e.target.value); }}
                    placeholder={(remaining / 100).toFixed(2)}
                    className="flex-1 px-3 py-2.5 text-sm border border-gray-200 rounded-lg text-right font-medium focus:outline-none focus:border-brand-400"
                    onKeyDown={e => { if (e.key === 'Enter') addTender(); }}
                  />
                  <button
                    onClick={addTender}
                    disabled={!splitAmount || parseFloat(splitAmount) <= 0}
                    className="px-3 py-2.5 bg-brand-500 text-white rounded-lg text-xs font-medium hover:bg-brand-600 disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                  >
                    +
                  </button>
                </div>
              )}

              {/* Quick: add remaining */}
              {!splitComplete && remaining > 0 && (
                <button
                  onClick={addRemaining}
                  className="w-full py-2 text-xs text-brand-500 bg-brand-50 border border-brand-100 rounded-lg hover:bg-brand-100 cursor-pointer font-medium"
                >
                  {t('pos.split.addRemaining') || 'Add remaining'} ({(remaining / 100).toFixed(2)} {currency})
                </button>
              )}
            </div>
          ) : (
            <>
              {/* ─── SINGLE MODE ──────────────────────────────── */}
              <div className="grid grid-cols-3 gap-2.5">
                {availableMethods.map(pm => {
                  const disabled = pm === 'INVOICE' && !canPayInvoice;
                  return (
                    <button
                      key={pm}
                      onClick={() => !disabled && setMethod(pm)}
                      disabled={saving || disabled}
                      className={`py-3.5 px-3 rounded-xl text-center transition-all flex flex-col items-center gap-1.5 border cursor-pointer touch-manipulation ${
                        method === pm
                          ? 'bg-brand-500 text-white border-brand-500 shadow-sm'
                          : disabled
                            ? 'bg-slate-50 text-gray-300 border-gray-100 cursor-not-allowed'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-brand-300 hover:text-brand-500 hover:bg-brand-50'
                      } disabled:opacity-50`}
                    >
                      <span className={method === pm ? 'text-white' : ''}>{PM_ICONS[pm]}</span>
                      <p className="text-[11px] font-medium leading-none">{t(`pos.payment.${pm.toLowerCase()}`)}</p>
                    </button>
                  );
                })}
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
                    <button onClick={() => setCashAmount(totalZl.toFixed(2))} className="px-3 py-2 text-xs bg-brand-50 text-brand-500 border border-brand-200 rounded-lg hover:bg-brand-100 transition-colors font-medium cursor-pointer">
                      {t('pos.payment.exact')}
                    </button>
                    {QUICK_AMOUNTS.filter(a => a >= grandTotal).slice(0, 3).map(amount => (
                      <button key={amount} onClick={() => setCashAmount((amount / 100).toFixed(2))} className="px-3 py-2 text-xs bg-slate-50 text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors font-medium cursor-pointer">
                        {(amount / 100).toFixed(0)}&nbsp;{currency}
                      </button>
                    ))}
                  </div>
                  {cashAmountGrosze > 0 && cashAmountGrosze >= grandTotal && (
                    <div className="flex justify-between items-center px-4 py-3 bg-emerald-50 border border-emerald-100 rounded-xl">
                      <span className="text-sm font-medium text-emerald-700">{t('pos.payment.change')}</span>
                      <span className="text-xl font-bold text-emerald-600">{(changeGrosze / 100).toFixed(2)}&nbsp;{currency}</span>
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
            </>
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
