import React, { useState, useEffect, useRef } from 'react';
import type { CartState, PosAction } from '../../hooks/usePosStore';
import rlog from '../../utils/logger';
import {
  deriveReceiptOutcome,
  decideCloseAction,
  type PrintReceiptResponse,
} from './receipt-outcome';

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

const KEYPAD_KEYS = [
  ['7', '8', '9', 'backspace'],
  ['4', '5', '6', 'clear'],
  ['1', '2', '3', '.'],
];

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
  const [savingLabel, setSavingLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [printWarning, setPrintWarning] = useState<string | null>(null);
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
  const cashShortfall = method === 'CASH' && !splitMode && cashAmountGrosze > 0 && cashAmountGrosze < grandTotal
    ? grandTotal - cashAmountGrosze
    : 0;

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

  // ─── Numeric keypad ──────────────────────────────────────

  const handleKeypadPress = (key: string) => {
    const setter = splitMode ? setSplitAmount : setCashAmount;

    if (key === 'backspace') {
      setter(prev => prev.slice(0, -1));
    } else if (key === 'clear') {
      setter('');
    } else if (key === '.') {
      setter(prev => prev.includes('.') ? prev : prev + '.');
    } else if (key === 'exact') {
      setCashAmount(totalZl.toFixed(2));
    } else if (key === 'remaining') {
      if (remaining > 0) setSplitAmount((remaining / 100).toFixed(2));
    } else {
      setter(prev => {
        const next = prev + key;
        return /^\d*\.?\d*$/.test(next) ? next : prev;
      });
    }
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
      variant_id: item.variantId ?? null,
      name: item.name,
      sku: item.sku ?? null,
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

    // Trigger immediate backend sync — don't wait 30s. Runs in parallel with print.
    // Result surfaces via pos:order-synced / pos:order-sync-failed events → Order History banner.
    window.electronAPI.pos.sync.orders().catch((err: unknown) => {
      rlog.warn('[PaymentModal] Immediate order sync failed:', err);
    });

    const hasCash = splitMode
      ? tenders.some(t => t.method === 'CASH')
      : method === 'CASH';

    if (method === 'INVOICE' && extraOrderFields?.customer_id) {
      try { await window.electronAPI.pos.customers.increaseDebt(extraOrderFields.customer_id, cart.total); }
      catch (err) { rlog.warn('[PaymentModal] Failed to increase customer debt:', err); }
    }

    // Print receipt + open drawer (parallel, awaited — optimized to ~3-5s).
    // The IPC layer returns { success, receiptPrinted, drawerOpened } —
    // we surface a non-blocking inline warning so the cashier sees the
    // failure before the modal closes (sale itself already completed
    // on the IPC above; reprint lives in Order History).
    setSavingLabel(t('test.printing') || 'Printing...');
    let printResult: PrintReceiptResponse | undefined;
    try {
      const [pr] = await Promise.all([
        window.electronAPI.pos.payment.printReceipt(orderId).catch(
          (err: unknown) => {
            rlog.warn('[PaymentModal] Receipt print failed:', err);
            return { success: false, receiptPrinted: false } as PrintReceiptResponse;
          },
        ),
        hasCash
          ? window.electronAPI.pos.payment.openCashDrawer().catch(
              (err: unknown) => rlog.warn('[PaymentModal] Cash drawer failed:', err),
            )
          : Promise.resolve(),
      ]);
      printResult = pr as PrintReceiptResponse;
    } catch { /* errors already logged inside each call */ }

    const outcome = deriveReceiptOutcome(printResult, t);
    const closeAction = decideCloseAction(outcome);

    dispatch({ type: 'display/setMode', payload: { mode: 'thankyou', lastOrderTotal: cart.total } });
    dispatch({ type: 'cart/clear' });

    if (closeAction.type === 'show-warning-then-close') {
      setPrintWarning(closeAction.warning);
      setSavingLabel('');
      setTimeout(() => {
        if (onComplete) { onComplete(); } else { onClose(); }
      }, closeAction.delayMs);
      return;
    }

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
  const tOr = (key: string, fallback: string) => {
    const value = t(key);
    return value !== key ? value : fallback;
  };
  const money = (amount: number) => `${(amount / 100).toFixed(2)} ${currency}`;
  const methodLabel = (pm: PaymentMethod) => t(`pos.payment.${pm.toLowerCase()}`) || pm;
  const activeMethodLabel = splitMode ? tOr('pos.split.toggle', 'Split') : methodLabel(method);
  const splitProgress = grandTotal > 0
    ? Math.min(100, Math.max(0, (tendersTotal / grandTotal) * 100))
    : 0;

  const renderNumericKeypad = (quickAction: 'exact' | 'remaining') => {
    const quickLabel = quickAction === 'exact'
      ? t('pos.payment.exact')
      : tOr('pos.split.remaining', 'Remaining');
    const quickDisabled = quickAction === 'remaining' && remaining <= 0;

    return (
      <div
        className={`grid grid-cols-4 gap-1.5 ${saving ? 'pointer-events-none opacity-50' : ''}`}
        role="group"
        aria-label="Numeric keypad"
      >
        {KEYPAD_KEYS.flat().map(key => (
          <button
            key={key}
            type="button"
            onClick={() => handleKeypadPress(key)}
            className={`flex min-h-[44px] items-center justify-center rounded-md border text-lg font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 ${
              key === 'backspace' || key === 'clear'
                ? 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100 active:bg-slate-200'
                : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50 active:bg-slate-100'
            }`}
          >
            {key === 'backspace' ? (
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9.75L14.25 12m0 0l2.25 2.25M14.25 12l2.25-2.25M14.25 12L12 14.25m-2.58 4.92l-6.374-6.375a1.125 1.125 0 010-1.59L9.42 4.83c.21-.211.497-.33.795-.33H19.5a2.25 2.25 0 012.25 2.25v10.5a2.25 2.25 0 01-2.25 2.25h-9.284c-.298 0-.585-.119-.795-.33z" />
              </svg>
            ) : key === 'clear' ? 'C' : key}
          </button>
        ))}
        <button
          type="button"
          onClick={() => handleKeypadPress('0')}
          className="flex min-h-[44px] items-center justify-center rounded-md border border-slate-200 bg-white text-lg font-semibold text-slate-800 transition-colors hover:bg-slate-50 active:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >0</button>
        <button
          type="button"
          onClick={() => handleKeypadPress('00')}
          className="flex min-h-[44px] items-center justify-center rounded-md border border-slate-200 bg-white text-lg font-semibold text-slate-800 transition-colors hover:bg-slate-50 active:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >00</button>
        <button
          type="button"
          onClick={() => handleKeypadPress(quickAction)}
          disabled={quickDisabled}
          className="col-span-2 flex min-h-[44px] items-center justify-center rounded-md border border-brand-200 bg-brand-50 text-sm font-semibold text-brand-800 transition-colors hover:bg-brand-100 active:bg-brand-200 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {quickLabel}
        </button>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/55 p-4"
      onClick={saving ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-modal-title"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-slate-500">{activeMethodLabel}</p>
            <h2 id="payment-modal-title" className="truncate text-xl font-semibold text-slate-950">{t('pos.payment')}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setSplitMode(!splitMode); setTenders([]); setSplitAmount(''); }}
              disabled={saving}
              aria-pressed={splitMode}
              className={`min-h-[44px] rounded-md border px-4 text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
                splitMode
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-slate-300 bg-white text-slate-700 hover:border-brand-500 hover:text-brand-700'
              }`}
            >
              {tOr('pos.split.toggle', 'Split')}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              aria-label="Close"
              className="flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto bg-slate-100 p-4">
          <div className="grid min-h-[520px] gap-4 lg:grid-cols-[0.9fr_1.35fr]">
            <aside className="space-y-4">
              <div className="rounded-lg border border-slate-800 bg-slate-950 p-5 text-white shadow-sm">
                <p className="text-xs font-semibold uppercase text-slate-300">{t('pos.cart.total')}</p>
                <p className="mt-2 text-5xl font-semibold leading-none">{money(grandTotal)}</p>
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm text-slate-200">
                  <div>
                    <p className="text-xs text-slate-400">{t('pos.cart.subtotal')}</p>
                    <p className="font-semibold">{money(cart.subtotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">{t('pos.cart.inclVat')}</p>
                    <p className="font-semibold">{money(cart.tax)}</p>
                  </div>
                  {(cart.discount > 0 || tip > 0) && (
                    <>
                      {cart.discount > 0 && (
                        <div>
                          <p className="text-xs text-slate-400">{t('pos.cart.discount')}</p>
                          <p className="font-semibold text-amber-200">-{money(cart.discount)}</p>
                        </div>
                      )}
                      {tip > 0 && (
                        <div>
                          <p className="text-xs text-slate-400">{tOr('pos.tip', 'Tip')}</p>
                          <p className="font-semibold">{money(tip)}</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase text-slate-500">{t('pos.payment')}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {availableMethods.map(pm => {
                    const disabled = pm === 'INVOICE' && !canPayInvoice;
                    const selected = !splitMode && method === pm;
                    return (
                      <button
                        key={pm}
                        type="button"
                        onClick={() => !disabled && setMethod(pm)}
                        disabled={saving || disabled}
                        className={`flex min-h-[72px] min-w-0 items-center gap-3 rounded-md border p-3 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed ${
                          selected
                            ? 'border-brand-700 bg-brand-50 text-brand-900 shadow-sm'
                            : disabled
                              ? 'border-slate-200 bg-slate-50 text-slate-300'
                              : 'border-slate-300 bg-white text-slate-700 hover:border-brand-500 hover:bg-brand-50'
                        }`}
                      >
                        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md border ${
                          selected ? 'border-brand-300 bg-white text-brand-700' : 'border-slate-200 bg-slate-50 text-slate-500'
                        }`}>
                          {PM_ICONS[pm]}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold">{methodLabel(pm)}</span>
                          {pm === 'INVOICE' && disabled && (
                            <span className="block truncate text-xs text-slate-400">B2B</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </aside>

            <section className="flex min-w-0 flex-col rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-5 py-4">
                <p className="text-xs font-semibold uppercase text-slate-500">{activeMethodLabel}</p>
                <p className="mt-1 text-sm text-slate-600">
                  {splitMode
                    ? `${tOr('pos.split.remaining', 'Remaining')}: ${money(Math.max(remaining, 0))}`
                    : method === 'CASH'
                      ? `${t('pos.payment.received')}: ${cashAmount ? money(cashAmountGrosze) : money(0)}`
                      : `${t('pos.cart.total')}: ${money(grandTotal)}`}
                </p>
              </div>
              <div className="flex-1 space-y-4 p-5">

          {/* ─── SPLIT MODE ─────────────────────────────────── */}
          {splitMode ? (
            <div className="space-y-4">
              <div className={`rounded-lg border p-4 ${
                splitComplete ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'
              }`}>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className={`text-sm font-semibold ${splitComplete ? 'text-emerald-800' : 'text-amber-800'}`}>
                      {splitComplete ? tOr('pos.split.complete', 'Fully covered') : tOr('pos.split.remaining', 'Remaining')}
                    </p>
                    <p className={`mt-1 text-3xl font-semibold leading-none ${splitComplete ? 'text-emerald-900' : 'text-amber-900'}`}>
                      {money(splitComplete ? 0 : Math.max(remaining, 0))}
                    </p>
                  </div>
                  <div className="text-right text-sm text-slate-700">
                    <p className="font-semibold">{money(tendersTotal)}</p>
                    <p>{t('pos.cart.total')}: {money(grandTotal)}</p>
                  </div>
                </div>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/80">
                  <div className="h-full rounded-full bg-brand-600" style={{ width: `${splitProgress}%` }} />
                </div>
              </div>

              {!splitComplete && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="grid gap-3 md:grid-cols-[1fr_1.15fr_auto]">
                    <label className="block min-w-0">
                      <span className="mb-1 block text-sm font-semibold text-slate-700">{t('pos.payment')}</span>
                      <select
                        value={splitMethod}
                        onChange={e => setSplitMethod(e.target.value as PaymentMethod)}
                        className="h-12 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
                      >
                        {availableMethods.map(m => (
                          <option key={m} value={m} disabled={m === 'INVOICE' && !canPayInvoice}>{methodLabel(m)}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block min-w-0" htmlFor="payment-split-amount">
                      <span className="mb-1 block text-sm font-semibold text-slate-700">{tOr('pos.split.remaining', 'Amount')}</span>
                      <input
                        id="payment-split-amount"
                        type="text"
                        inputMode="decimal"
                        data-keyboard="false"
                        value={splitAmount}
                        onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setSplitAmount(e.target.value); }}
                        placeholder={(Math.max(remaining, 0) / 100).toFixed(2)}
                        className="h-12 w-full rounded-md border border-slate-300 bg-white px-3 text-right text-lg font-semibold text-slate-950 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        onKeyDown={e => { if (e.key === 'Enter') addTender(); }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={addTender}
                      disabled={!splitAmount || parseFloat(splitAmount) <= 0}
                      aria-label="Add tender"
                      className="mt-0 flex min-h-[48px] min-w-[56px] items-center justify-center rounded-md bg-brand-600 px-5 text-xl font-semibold text-white transition-colors hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 md:mt-6"
                    >
                      +
                    </button>
                  </div>
                  {remaining > 0 && (
                    <button
                      type="button"
                      onClick={addRemaining}
                      className="mt-3 min-h-[44px] w-full rounded-md border border-brand-300 bg-white px-4 text-sm font-semibold text-brand-800 transition-colors hover:bg-brand-50 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
                    >
                      {tOr('pos.split.addRemaining', 'Add remaining')} ({money(remaining)})
                    </button>
                  )}
                </div>
              )}

              {!splitComplete && renderNumericKeypad('remaining')}

              <div className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                  <p className="text-sm font-semibold text-slate-900">{tOr('pos.split.toggle', 'Split')}</p>
                  <p className="text-sm font-semibold text-slate-700">{money(tendersTotal)}</p>
                </div>
                {tenders.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-slate-500">
                    No tenders added. {tOr('pos.split.remaining', 'Remaining')}: {money(grandTotal)}
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200">
                    {tenders.map((tender, idx) => (
                      <div key={`${tender.method}-${idx}`} className="flex items-center justify-between gap-3 px-4 py-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-slate-600">{PM_ICONS[tender.method]}</span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-950">{methodLabel(tender.method)}</p>
                            <p className="text-xs text-slate-500">{idx + 1}</p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <p className="text-lg font-semibold text-slate-950">{money(tender.amount)}</p>
                          <button
                            type="button"
                            onClick={() => removeTender(idx)}
                            aria-label="Remove tender"
                            className="flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-500 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                          >
                            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : method === 'CASH' ? (
            <div className="space-y-4">
              {/* ─── SINGLE MODE ──────────────────────────────── */}
              <label className="block" htmlFor="payment-cash-received">
                <span className="mb-2 block text-sm font-semibold text-slate-700">{t('pos.payment.received')}</span>
                <input
                  id="payment-cash-received"
                  ref={inputRef}
                  type="text"
                  inputMode="decimal"
                  data-keyboard="false"
                  value={cashAmount}
                  onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setCashAmount(e.target.value); }}
                  placeholder={totalZl.toFixed(2)}
                  className="h-16 w-full rounded-md border border-slate-300 bg-white px-4 text-right text-3xl font-semibold text-slate-950 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </label>

              {renderNumericKeypad('exact')}

              {QUICK_AMOUNTS.filter(a => a >= grandTotal).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {QUICK_AMOUNTS.filter(a => a >= grandTotal).slice(0, 4).map(amount => (
                    <button
                      key={amount}
                      type="button"
                      onClick={() => setCashAmount((amount / 100).toFixed(2))}
                      className="min-h-[44px] flex-1 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition-colors hover:border-brand-400 hover:bg-brand-50 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
                    >
                      {money(amount)}
                    </button>
                  ))}
                </div>
              )}

              <div aria-live="polite" className={`rounded-lg border p-4 ${
                cashShortfall > 0
                  ? 'border-red-300 bg-red-50'
                  : cashAmountGrosze >= grandTotal && cashAmountGrosze > 0
                    ? 'border-emerald-300 bg-emerald-50'
                    : 'border-slate-200 bg-slate-50'
              }`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-700">
                      {cashShortfall > 0
                        ? tOr('pos.payment.insufficient', 'Insufficient cash')
                        : t('pos.payment.change')}
                    </p>
                    <p className={`mt-1 text-3xl font-semibold leading-none ${
                      cashShortfall > 0
                        ? 'text-red-800'
                        : cashAmountGrosze >= grandTotal && cashAmountGrosze > 0
                          ? 'text-emerald-800'
                          : 'text-slate-500'
                    }`}>
                      {cashShortfall > 0 ? money(cashShortfall) : money(changeGrosze)}
                    </p>
                  </div>
                  <div className="text-right text-sm text-slate-600">
                    <p>{t('pos.cart.total')}: {money(grandTotal)}</p>
                    <p>{t('pos.payment.received')}: {money(cashAmountGrosze)}</p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-5">
                <div className="flex items-start gap-4">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700">{PM_ICONS[method]}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-lg font-semibold text-slate-950">{methodLabel(method)}</p>
                    <p className="mt-1 text-sm text-slate-600">{t('pos.cart.total')}: {money(grandTotal)}</p>
                  </div>
                </div>
              </div>

              {method === 'CARD' && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                  <div className="flex items-center gap-3">
                    <svg className={`h-5 w-5 text-blue-700 ${cardStatus ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <p className="text-sm font-semibold text-blue-900">{cardStatus || tOr('pos.payment.cardWaiting', 'Ready for terminal')}</p>
                  </div>
                </div>
              )}

              {method === 'INVOICE' && (
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <p className="text-sm font-semibold text-slate-900">{methodLabel('INVOICE')}</p>
                  <p className="mt-1 text-sm text-slate-600">{extraOrderFields?.customer_name ?? extraOrderFields?.customer_nip ?? ''}</p>
                </div>
              )}
            </div>
          )}
              </div>
            </section>
          </div>
        </div>

        <div className="space-y-3 border-t border-slate-200 bg-white px-5 py-4">
          {error && (
            <div aria-live="assertive" className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-3">
              <svg className="h-5 w-5 shrink-0 text-red-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm font-semibold text-red-800">{error}</p>
            </div>
          )}
          {printWarning && (
            <div aria-live="polite" className="flex items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3">
              <svg className="h-5 w-5 shrink-0 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3m0 4h.01M10.29 3.86l-8.53 14.78A2 2 0 003.5 21.5h17a2 2 0 001.74-2.86L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <p className="text-sm font-semibold text-amber-900">{printWarning}</p>
            </div>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm text-slate-600">
              <p className="font-semibold text-slate-950">{activeMethodLabel}</p>
              <p className="truncate">
                {splitMode
                  ? `${tOr('pos.split.remaining', 'Remaining')}: ${money(Math.max(remaining, 0))}`
                  : method === 'CASH'
                    ? `${t('pos.payment.change')}: ${money(changeGrosze)}`
                    : `${t('pos.cart.total')}: ${money(grandTotal)}`}
              </p>
            </div>
            <button
              type="button"
              onClick={handleComplete}
              disabled={!canComplete}
              className="min-h-[56px] w-full rounded-md bg-brand-600 px-6 text-base font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600 sm:w-auto sm:min-w-[240px]"
            >
              {saving ? (savingLabel || t('pos.payment.saving')) : `${t('pos.payment.complete')} ${money(grandTotal)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
