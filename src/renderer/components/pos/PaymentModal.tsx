import React, { useState, useEffect, useRef } from 'react';
import type { CartState, PosAction } from '../../hooks/usePosStore';
import rlog from '../../utils/logger';
import {
  deriveReceiptOutcome,
  type PrintReceiptResponse,
} from './receipt-outcome';
import { formatInitialCashAmount } from './format-cash-amount';

interface PaymentModalProps {
  cart: CartState;
  dispatch: (action: PosAction) => void;
  onClose: () => void;
  onComplete?: () => void;
  t: (key: string) => string;
  shiftId: string | null;
  staffId: string | null;
  staffName: string | null;
  initialCashAmountGrosze?: number;
  extraOrderFields?: Record<string, any>;
}

type PaymentMethod = 'CASH' | 'CARD' | 'BLIK' | 'TRANSFER' | 'INVOICE';

interface Tender {
  method: PaymentMethod;
  amount: number; // grosze
}

type ReceiptRecovery = {
  orderId: string;
  nextAction: 'close' | 'fiscalPrompt';
};

// Polish cash denominations (grosze) — surface every one so the cashier can
// compose received cash by tapping each bill they were handed, including
// denominations smaller than the order total (e.g. customer pays 200 zł
// for a 350 zł order with 2× 200 zł notes).
const DENOMINATIONS = [1000, 2000, 5000, 10000, 20000];

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

export default function PaymentModal({
  cart,
  dispatch,
  onClose,
  onComplete,
  t,
  shiftId,
  staffId,
  staffName,
  initialCashAmountGrosze,
  extraOrderFields,
}: PaymentModalProps) {
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [cashAmount, setCashAmount] = useState(() => formatInitialCashAmount(initialCashAmountGrosze));
  // Per-denomination bill counts (grosze → count). The cashier taps a
  // denomination to record one bill received; the total auto-syncs to
  // cashAmount. Any manual edit (numpad / input field) clears these so
  // they don't drift out of sync with the canonical cashAmount string.
  const [denomCounts, setDenomCounts] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);
  const [savingLabel, setSavingLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [printWarning, setPrintWarning] = useState<string | null>(null);
  const [splitMode, setSplitMode] = useState(false);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [splitAmount, setSplitAmount] = useState('');
  const [splitMethod, setSplitMethod] = useState<PaymentMethod>('CASH');
  const [hasFiscalPrinter, setHasFiscalPrinter] = useState(false);
  const [fiscalPrompt, setFiscalPrompt] = useState<{ orderId: string } | null>(null);
  const [fiscalBusy, setFiscalBusy] = useState(false);
  const [receiptRecovery, setReceiptRecovery] = useState<ReceiptRecovery | null>(null);
  const [receiptRetrying, setReceiptRetrying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tOr = (key: string, fallback: string) => {
    const value = t(key);
    return value !== key ? value : fallback;
  };

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.pos.payment.hasFiscalPrinter()
      .then((result: { configured?: boolean }) => {
        if (!cancelled) setHasFiscalPrinter(!!result?.configured);
      })
      .catch((err: unknown) => {
        rlog.warn('[PaymentModal] hasFiscalPrinter probe failed:', err);
        if (!cancelled) setHasFiscalPrinter(false);
      });
    return () => { cancelled = true; };
  }, []);

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

  // Temporarily keep BLIK out of new POS sales until the shop has a signed
  // BLIK contract. Leave the wider payment model intact so historical BLIK
  // orders/reports still render correctly if they exist.
  const availableMethods: PaymentMethod[] = ['CASH', 'CARD', 'TRANSFER',
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

  // ─── Denomination counters ────────────────────────────────

  const totalFromDenoms = Object.entries(denomCounts).reduce(
    (sum, [denom, count]) => sum + Number(denom) * count,
    0,
  );

  const updateDenom = (denom: number, delta: number) => {
    setDenomCounts((prev) => {
      const next = { ...prev };
      const nextCount = Math.max(0, (next[denom] ?? 0) + delta);
      if (nextCount === 0) delete next[denom];
      else next[denom] = nextCount;
      const sum = Object.entries(next).reduce(
        (s, [d, c]) => s + Number(d) * c,
        0,
      );
      setCashAmount(sum > 0 ? (sum / 100).toFixed(2) : '');
      return next;
    });
  };

  const resetDenoms = () => {
    setDenomCounts({});
    setCashAmount('');
  };

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
    // Any cash-side keypad press is a "manual override" — drop the
    // denomination counters so the displayed cash and the counter row
    // can't disagree.
    if (!splitMode) setDenomCounts({});

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

    // ─── Payment-method-aware print routing ──────────────────────────
    // CASH (or split with any cash tender): print the order copy on the
    //   thermal RECEIPT printer + open drawer, then ASK the cashier
    //   whether to also print the fiscal receipt.
    // CARD/BLIK/TRANSFER: skip the order copy, fire the fiscal receipt
    //   directly. No drawer.
    // INVOICE: skip both prints (debt already increased above).
    const printOrderCopy = hasCash;
    const autoPrintFiscal = !hasCash && method !== 'INVOICE';
    const offerFiscalPrompt = hasCash && hasFiscalPrinter;

    setSavingLabel(t('test.printing') || 'Printing...');
    let printResult: PrintReceiptResponse | undefined;
    try {
      if (printOrderCopy) {
        printResult = await window.electronAPI.pos.payment.printReceiptAndOpenDrawer(orderId).catch(
          (err: unknown) => {
            rlog.warn('[PaymentModal] Receipt print/drawer failed:', err);
            return { success: false, receiptPrinted: false } as PrintReceiptResponse;
          },
        );
      } else {
        // Synthesize a "skipped" outcome so deriveReceiptOutcome does not
        // emit a "receipt not printed" warning for non-cash flows.
        printResult = { success: true, receiptPrinted: true };
      }
    } catch { /* errors already logged inside each call */ }

    let fiscalWarning: string | null = null;
    if (autoPrintFiscal) {
      if (!hasFiscalPrinter) {
        rlog.warn('[PaymentModal] No fiscal printer configured; skipping fiscal receipt for non-cash payment');
      } else {
        setSavingLabel(t('pos.payment.fiscalPrinting') || 'Printing fiscal receipt...');
        try {
          const fiscalResult = await window.electronAPI.pos.payment.printFiscalReceipt(orderId);
          if (!fiscalResult?.fiscalPrinted) {
            fiscalWarning = fiscalResult?.error || t('pos.payment.fiscalFailed') || 'Fiscal receipt not printed - reprint from Order History';
          }
        } catch (err) {
          rlog.warn('[PaymentModal] Fiscal receipt print failed:', err);
          fiscalWarning = (err as Error)?.message || t('pos.payment.fiscalFailed') || 'Fiscal receipt not printed - reprint from Order History';
        }
      }
    }

    const outcome = deriveReceiptOutcome(printResult, t);
    dispatch({ type: 'display/setMode', payload: { mode: 'thankyou', lastOrderTotal: cart.total } });
    dispatch({ type: 'cart/clear' });

    if (printOrderCopy && !outcome.receiptPrinted) {
      setSavingLabel('');
      setPrintWarning(outcome.warning);
      setReceiptRecovery({
        orderId,
        nextAction: offerFiscalPrompt ? 'fiscalPrompt' : 'close',
      });
      return;
    }

    if (offerFiscalPrompt) {
      // Pause here — order is saved + thermal copy printed. The fiscal
      // prompt overlay will close the modal when the cashier picks an
      // option (print fiscal or skip).
      setSavingLabel('');
      setFiscalPrompt({ orderId });
      return;
    }

    if (fiscalWarning) {
      setPrintWarning(fiscalWarning);
      setSavingLabel('');
      setTimeout(() => {
        if (onComplete) { onComplete(); } else { onClose(); }
      }, 4000);
      return;
    }

    if (onComplete) { onComplete(); } else { onClose(); }
  };

  const handleFiscalPromptChoice = async (printFiscal: boolean) => {
    if (fiscalBusy) return;
    const orderId = fiscalPrompt?.orderId;
    if (!orderId) return;

    if (!printFiscal) {
      setFiscalPrompt(null);
      if (onComplete) { onComplete(); } else { onClose(); }
      return;
    }

    setFiscalBusy(true);
    setSavingLabel(t('pos.payment.fiscalPrinting') || 'Printing fiscal receipt...');
    let warning: string | null = null;
    try {
      const result = await window.electronAPI.pos.payment.printFiscalReceipt(orderId);
      if (!result?.fiscalPrinted) {
        warning = result?.error || t('pos.payment.fiscalFailed') || 'Fiscal receipt not printed - reprint from Order History';
      }
    } catch (err) {
      rlog.warn('[PaymentModal] Fiscal receipt print failed:', err);
      warning = (err as Error)?.message || t('pos.payment.fiscalFailed') || 'Fiscal receipt not printed - reprint from Order History';
    }
    setFiscalBusy(false);
    setSavingLabel('');
    setFiscalPrompt(null);

    if (warning) {
      setPrintWarning(warning);
      setTimeout(() => {
        if (onComplete) { onComplete(); } else { onClose(); }
      }, 4000);
      return;
    }

    if (onComplete) { onComplete(); } else { onClose(); }
  };

  const finishReceiptRecovery = (recovery: ReceiptRecovery) => {
    setReceiptRecovery(null);
    setPrintWarning(null);
    if (recovery.nextAction === 'fiscalPrompt') {
      setFiscalPrompt({ orderId: recovery.orderId });
      return;
    }
    if (onComplete) { onComplete(); } else { onClose(); }
  };

  const handleRetryReceipt = async () => {
    const recovery = receiptRecovery;
    if (!recovery || receiptRetrying) return;

    setReceiptRetrying(true);
    setSavingLabel(t('test.printing') || 'Printing...');
    setPrintWarning(null);

    try {
      const result = await window.electronAPI.pos.payment.printReceipt(recovery.orderId);
      const outcome = deriveReceiptOutcome(result, t);
      if (outcome.receiptPrinted) {
        setSavingLabel('');
        finishReceiptRecovery(recovery);
        return;
      }
      setPrintWarning(outcome.warning);
    } catch (err) {
      rlog.warn('[PaymentModal] Receipt retry failed:', err);
      const outcome = deriveReceiptOutcome({ success: false, receiptPrinted: false }, t);
      setPrintWarning(outcome.warning);
    } finally {
      setReceiptRetrying(false);
      setSavingLabel('');
    }
  };

  const handleContinueWithoutReceipt = () => {
    if (!receiptRecovery || receiptRetrying) return;
    finishReceiptRecovery(receiptRecovery);
  };

  const handleComplete = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setPrintWarning(null);
    setReceiptRecovery(null);

    try {
      if (!shiftId || !staffName?.trim()) {
        setError(tOr('pos.shift.staffMissing', 'Shift is open but missing staff. Close and reopen the shift before payment.'));
        setSaving(false);
        return;
      }

      const orderId = crypto.randomUUID();

      if (splitMode) {
        if (!splitComplete) { setError(t('pos.split.incomplete') || 'Split payment incomplete'); setSaving(false); return; }
        await saveOrderAndFinish(orderId, tendersTotal);
      } else {
        const paymentAmount = method === 'CASH' ? cashAmountGrosze : grandTotal;
        await saveOrderAndFinish(orderId, paymentAmount);
      }
    } catch (err) {
      rlog.error('[PaymentModal] Failed to complete payment:', err);
      setError(t('pos.payment.error'));
    } finally {
      setSaving(false);
    }
  };

  const canComplete = !receiptRecovery && !saving && !!shiftId && !!staffName?.trim() && (
    splitMode ? splitComplete
    : method !== 'CASH' || cashAmountGrosze >= grandTotal
  );

  const currency = t('pos.currency') || 'zl';
  const money = (amount: number) => `${(amount / 100).toFixed(2)} ${currency}`;
  const methodLabel = (pm: PaymentMethod) => t(`pos.payment.${pm.toLowerCase()}`) || pm;
  const activeMethodLabel = splitMode ? tOr('pos.split.toggle', 'Split') : methodLabel(method);
  const completeButtonLabel = method === 'CARD' && !splitMode
    ? tOr('pos.payment.cardReceived', 'Card payment received')
    : t('pos.payment.complete');
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

  const fiscalPromptOverlay = fiscalPrompt && (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fiscal-prompt-title"
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="border-b border-slate-200 px-6 py-4">
          <h3 id="fiscal-prompt-title" className="text-lg font-semibold text-slate-950">
            {tOr('pos.payment.fiscalPromptTitle', 'In hóa đơn tài chính?')}
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            {tOr('pos.payment.fiscalPromptHint', 'Order đã in xong. Bạn có muốn in tiếp hóa đơn tài chính cho khách không?')}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 bg-slate-50 px-6 py-4">
          <button
            type="button"
            onClick={() => handleFiscalPromptChoice(false)}
            disabled={fiscalBusy}
            className="min-h-[52px] rounded-md border border-slate-300 bg-white px-4 text-base font-semibold text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {tOr('pos.payment.fiscalSkip', 'Bỏ qua')}
          </button>
          <button
            type="button"
            onClick={() => handleFiscalPromptChoice(true)}
            disabled={fiscalBusy}
            className="min-h-[52px] rounded-md border border-emerald-600 bg-emerald-600 px-4 text-base font-semibold text-white transition-colors hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {fiscalBusy
              ? tOr('pos.payment.fiscalPrinting', 'Đang in...')
              : tOr('pos.payment.fiscalConfirm', 'In hóa đơn tài chính')}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/55 p-4"
      onClick={(saving || fiscalPrompt || receiptRecovery) ? undefined : onClose}
    >
      {fiscalPromptOverlay}
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
              disabled={saving || !!receiptRecovery}
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
              disabled={saving || !!receiptRecovery}
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
                  onChange={(e) => {
                    if (!/^\d*\.?\d*$/.test(e.target.value)) return;
                    setCashAmount(e.target.value);
                    setDenomCounts({});
                  }}
                  placeholder={totalZl.toFixed(2)}
                  className="h-16 w-full rounded-md border border-slate-300 bg-white px-4 text-right text-3xl font-semibold text-slate-950 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </label>

              {renderNumericKeypad('exact')}

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-bold text-slate-600">
                    {tOr('pos.payment.bills', 'Bills received')}
                  </p>
                  {totalFromDenoms > 0 && (
                    <button
                      type="button"
                      onClick={resetDenoms}
                      className="text-[11px] font-bold text-slate-500 hover:text-red-700 transition-colors cursor-pointer touch-manipulation"
                    >
                      {tOr('pos.payment.resetBills', 'Reset')}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {DENOMINATIONS.map((denom) => {
                    const count = denomCounts[denom] ?? 0;
                    const active = count > 0;
                    return (
                      <div key={denom} className="relative">
                        <button
                          type="button"
                          onClick={() => updateDenom(denom, +1)}
                          aria-label={`Add ${denom / 100} ${currency} bill`}
                          className={`w-full min-h-[64px] rounded-lg border-2 px-2 py-2 flex flex-col items-center justify-center transition-colors cursor-pointer touch-manipulation focus:outline-none focus:ring-2 focus:ring-brand-300 ${
                            active
                              ? 'border-brand-500 bg-brand-50 text-brand-900'
                              : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300 hover:bg-brand-50'
                          }`}
                        >
                          <span className="text-sm font-extrabold leading-none tabular-nums">
                            {denom / 100} {currency}
                          </span>
                          {active && (
                            <span className="mt-1 text-[11px] font-bold leading-none tabular-nums">
                              × {count} = {((denom * count) / 100).toFixed(2)}
                            </span>
                          )}
                        </button>
                        {active && (
                          <button
                            type="button"
                            onClick={() => updateDenom(denom, -1)}
                            aria-label={`Remove one ${denom / 100} ${currency} bill`}
                            className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-slate-800 text-white text-sm font-bold leading-none flex items-center justify-center shadow-md hover:bg-slate-950 cursor-pointer touch-manipulation focus:outline-none focus:ring-2 focus:ring-slate-300"
                          >
                            −
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

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
              {method === 'CARD' && (
                <>
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-5 text-white shadow-sm">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold uppercase text-slate-300">{t('pos.payment.card')}</p>
                        <p className="mt-2 text-5xl font-semibold leading-none">{money(grandTotal)}</p>
                      </div>
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-slate-100">
                        {PM_ICONS.CARD}
                      </span>
                    </div>
                  </div>

                  <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                    <p className="text-sm font-semibold text-blue-900">
                      {tOr(
                        'pos.payment.cardManualHint',
                        'Enter this amount on the card terminal. After approval, press the button below.',
                      )}
                    </p>
                  </div>
                </>
              )}

              {method !== 'CARD' && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-5">
                  <div className="flex items-start gap-4">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700">{PM_ICONS[method]}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-lg font-semibold text-slate-950">{methodLabel(method)}</p>
                      <p className="mt-1 text-sm text-slate-600">{t('pos.cart.total')}: {money(grandTotal)}</p>
                    </div>
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
                {receiptRecovery
                  ? tOr('pos.payment.orderSavedPrintPending', 'Order saved - receipt still needs printing')
                  : splitMode
                  ? `${tOr('pos.split.remaining', 'Remaining')}: ${money(Math.max(remaining, 0))}`
                  : method === 'CASH'
                    ? `${t('pos.payment.change')}: ${money(changeGrosze)}`
                    : `${t('pos.cart.total')}: ${money(grandTotal)}`}
              </p>
            </div>
            {receiptRecovery ? (
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[360px] sm:flex-row">
                <button
                  type="button"
                  onClick={handleRetryReceipt}
                  disabled={receiptRetrying}
                  className="min-h-[56px] flex-1 rounded-md bg-brand-600 px-5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600"
                >
                  {receiptRetrying ? (savingLabel || tOr('test.printing', 'Printing...')) : tOr('pos.payment.retryReceipt', 'Retry order print')}
                </button>
                <button
                  type="button"
                  onClick={handleContinueWithoutReceipt}
                  disabled={receiptRetrying}
                  className="min-h-[56px] flex-1 rounded-md border border-amber-300 bg-amber-50 px-5 text-base font-semibold text-amber-900 transition-colors hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {tOr('pos.payment.continueWithoutReceipt', 'Continue without print')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleComplete}
                disabled={!canComplete}
                className="min-h-[56px] w-full rounded-md bg-brand-600 px-6 text-base font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600 sm:w-auto sm:min-w-[240px]"
              >
                {saving ? (savingLabel || t('pos.payment.saving')) : `${completeButtonLabel} ${money(grandTotal)}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
