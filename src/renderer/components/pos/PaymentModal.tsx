import React, { useCallback, useState, useEffect, useRef } from 'react';
import type { CartState, CheckoutDraftState, PosAction } from '../../hooks/usePosStore';
import type { PosLoyaltyLookupResponse } from '../../../shared/types';
import rlog from '../../utils/logger';
import {
  deriveReceiptOutcome,
  type PrintReceiptResponse,
} from './receipt-outcome';
import { formatInitialCashAmount } from './format-cash-amount';
import { useConfig } from '../../hooks/useConfig';
import {
  resolveFiscalAction,
  shouldPrintNonFiscalOrderCopy,
  type FiscalAction,
} from './payment-fiscal-prompt-mode';
import type { RestoredCartReconciliation } from '../../../shared/billiard-pos-handoff';
import { buildImmediateRestoredCartReconciliation } from './restored-cart-reconciliation';
import {
  resolvePaymentSubmission,
  type PaymentMethod,
  type PaymentSubmissionOverrides,
  type ResolvedPaymentSubmission,
  type Tender,
} from './payment-submission';

interface PaymentModalProps {
  cart: CartState;
  dispatch: (action: PosAction) => void;
  onClose: () => void;
  onComplete?: (result: { orderId: string }) => void;
  onTenderOutcomeUncertain?: (
    message: string,
    restoredCartReconciliation?: RestoredCartReconciliation,
  ) => void;
  t: (key: string) => string;
  shiftId: string | null;
  staffId: string | null;
  staffName: string | null;
  initialCashAmountGrosze?: number;
  initialMethod?: PaymentMethod;
  checkoutDraft?: CheckoutDraftState;
  scanCommands?: {
    card?: string;
    cash?: string;
  };
  extraOrderFields?: Record<string, any>;
}

type PaymentSnapshot = {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  tip: number;
  grandTotal: number;
  cashAmountGrosze: number;
  changeGrosze: number;
};

type ReceiptRecovery = {
  orderId: string;
  nextAction: 'close' | 'fiscalPrompt';
};

type LoyaltyLookupState = 'idle' | 'loading' | 'found' | 'not_found' | 'error';

function normalizeNipInput(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 10);
}

function getInitialCustomerNip(
  checkoutDraft: CheckoutDraftState | undefined,
  extraOrderFields: Record<string, any> | undefined,
): string {
  const hasDraftNip = !!checkoutDraft && Object.prototype.hasOwnProperty.call(checkoutDraft, 'customerNip');
  return normalizeNipInput(hasDraftNip ? checkoutDraft?.customerNip : extraOrderFields?.customer_nip);
}

// Polish cash denominations (grosze) — surface every one so the cashier can
// compose received cash by tapping each bill they were handed, including
// denominations smaller than the order total (e.g. customer pays 200 zł
// for a 350 zł order with 2× 200 zł notes).
const DENOMINATIONS = [1000, 2000, 5000, 10000, 20000];
const BLIK_RECEIPT_PHONE = '729448788';

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
  onTenderOutcomeUncertain,
  t,
  shiftId,
  staffId,
  staffName,
  initialCashAmountGrosze,
  initialMethod,
  checkoutDraft,
  scanCommands,
  extraOrderFields,
}: PaymentModalProps) {
  const { config } = useConfig();
  const protectedTender = Boolean(checkoutDraft?.billiard || checkoutDraft?.restoredInterruption);
  const [method, setMethod] = useState<PaymentMethod>(initialMethod ?? 'CASH');
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
  const [paymentPreflightStatus, setPaymentPreflightStatus] = useState<'checking' | 'ready' | 'blocked'>(
    protectedTender ? 'ready' : 'checking',
  );
  const [paymentPreflightToken, setPaymentPreflightToken] = useState<string | null>(null);
  const [fiscalPrompt, setFiscalPrompt] = useState<{ orderId: string } | null>(null);
  const [fiscalBusy, setFiscalBusy] = useState(false);
  const [receiptRecovery, setReceiptRecovery] = useState<ReceiptRecovery | null>(null);
  const [receiptRetrying, setReceiptRetrying] = useState(false);
  const [paymentSnapshot, setPaymentSnapshot] = useState<PaymentSnapshot | null>(null);
  const initialCustomerNip = getInitialCustomerNip(checkoutDraft, extraOrderFields);
  const [customerNip, setCustomerNip] = useState(initialCustomerNip);
  const [nipOpen, setNipOpen] = useState(initialCustomerNip.length > 0 || initialMethod === 'INVOICE');
  const [loyaltyOpen, setLoyaltyOpen] = useState(false);
  const [loyaltyPhone, setLoyaltyPhone] = useState(() =>
    String(extraOrderFields?.customer_phone ?? '').trim(),
  );
  const [loyaltyStatus, setLoyaltyStatus] = useState<LoyaltyLookupState>('idle');
  const [loyaltyResult, setLoyaltyResult] = useState<PosLoyaltyLookupResponse | null>(null);
  const [loyaltyError, setLoyaltyError] = useState<string | null>(null);
  const [nipPadOpen, setNipPadOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nipInputRef = useRef<HTMLInputElement>(null);
  const scannerBufferRef = useRef('');
  const scannerLastKeyRef = useRef(0);
  const paymentCompleteInFlightRef = useRef(false);
  const orderAttemptIdRef = useRef(
    checkoutDraft?.billiard?.orderId
      || checkoutDraft?.restoredInterruption?.orderId
      || crypto.randomUUID(),
  );
  const completedOrderIdRef = useRef<string | null>(null);
  const tenderBoundaryCrossedRef = useRef(false);
  const [tenderPrepared, setTenderPrepared] = useState(false);
  const tOr = (key: string, fallback: string) => {
    const value = t(key);
    return value !== key ? value : fallback;
  };
  const fiscalOnCashSale = config?.fiscalOnCashSale;

  const handleLoyaltyLookup = async () => {
    const phone = loyaltyPhone.trim();
    if (!phone) {
      setLoyaltyStatus('error');
      setLoyaltyResult(null);
      setLoyaltyError(tOr('pos.loyalty.phoneRequired', 'Enter customer phone.'));
      return;
    }

    const lookupCustomer = (window as any).electronAPI?.pos?.loyalty?.lookupCustomer as
      | ((phone: string) => Promise<{ success: boolean; result?: PosLoyaltyLookupResponse; error?: string; unavailable?: boolean }>)
      | undefined;

    if (!lookupCustomer) {
      setLoyaltyStatus('error');
      setLoyaltyResult(null);
      setLoyaltyError(tOr('pos.loyalty.unavailable', 'Loyalty bridge is not available.'));
      return;
    }

    setLoyaltyStatus('loading');
    setLoyaltyResult(null);
    setLoyaltyError(null);

    try {
      const result = await lookupCustomer(phone);
      if (!result?.success || !result.result) {
        throw new Error(result?.error || (result?.unavailable ? 'loyalty_unavailable' : 'loyalty_lookup_failed'));
      }
      setLoyaltyResult(result.result);
      setLoyaltyStatus(result.result.found ? 'found' : 'not_found');
    } catch (err) {
      rlog.warn('[PaymentModal] Loyalty lookup failed:', err);
      setLoyaltyStatus('error');
      setLoyaltyError(tOr('pos.loyalty.lookupFailed', 'Could not load loyalty data.'));
    }
  };

  // Polish NIP shown grouped (XXX-XXX-XX-XX) so the cashier can read the 10
  // digits back at a glance.
  const formatNip = (value: string) => {
    const d = value.replace(/\D/g, '').slice(0, 10);
    return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)]
      .filter(Boolean)
      .join('-');
  };
  const updateCustomerNip = (value: unknown) => {
    if (tenderPrepared) return;
    const next = normalizeNipInput(value);
    setCustomerNip(next);
    dispatch({ type: 'checkoutDraft/update', payload: { customerNip: next } });
  };
  const appendNipDigit = (digit: string) => updateCustomerNip(customerNip + digit);
  const backspaceNip = () => updateCustomerNip(customerNip.slice(0, -1));

  useEffect(() => {
    setCustomerNip(getInitialCustomerNip(checkoutDraft, extraOrderFields));
  }, [checkoutDraft?.customerNip, extraOrderFields?.customer_nip]);

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

  useEffect(() => {
    if (protectedTender) {
      setPaymentPreflightStatus('ready');
      return;
    }
    let cancelled = false;
    setPaymentPreflightStatus('checking');
    window.electronAPI.pos.payment.preflight(orderAttemptIdRef.current)
      .then((result: { success?: boolean; token?: string; error?: string }) => {
        if (cancelled) return;
        if (result?.success) {
          setPaymentPreflightToken(result.token || null);
          setPaymentPreflightStatus('ready');
          return;
        }
        setPaymentPreflightStatus('blocked');
        setError(result?.error || 'POS payment preflight failed.');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err || 'POS payment preflight failed.');
        setPaymentPreflightStatus('blocked');
        setError(message);
      });
    return () => { cancelled = true; };
  }, [protectedTender]);

  const tip = extraOrderFields?.tip ?? 0;
  const liveGrandTotal = cart.total + tip;
  const parsedCash = parseFloat(cashAmount || '0');
  const cashAmountGrosze = Number.isFinite(parsedCash) ? Math.round(parsedCash * 100) : 0;
  const liveChangeGrosze = method === 'CASH' && !splitMode ? Math.max(0, cashAmountGrosze - liveGrandTotal) : 0;
  const displaySubtotal = paymentSnapshot?.subtotal ?? cart.subtotal;
  const displayDiscount = paymentSnapshot?.discount ?? cart.discount;
  const displayTax = paymentSnapshot?.tax ?? cart.tax;
  const displayTip = paymentSnapshot?.tip ?? tip;
  const displayGrandTotal = paymentSnapshot?.grandTotal ?? liveGrandTotal;
  const displayCashAmountGrosze = paymentSnapshot?.cashAmountGrosze ?? cashAmountGrosze;
  const displayChangeGrosze = paymentSnapshot?.changeGrosze ?? liveChangeGrosze;
  const grandTotal = displayGrandTotal;
  const totalZl = grandTotal / 100;
  const changeGrosze = displayChangeGrosze;
  const cashShortfall = method === 'CASH' && !splitMode && displayCashAmountGrosze > 0 && displayCashAmountGrosze < grandTotal
    ? grandTotal - displayCashAmountGrosze
    : 0;
  const customerNipValid = customerNip.length === 0 || customerNip.length === 10;
  const customerNipForOrder = customerNip.length === 10 ? customerNip : null;
  const nipForcedOpen = customerNip.length > 0 || method === 'INVOICE';

  const isB2B = extraOrderFields?.mode === 'b2b';
  const canPayInvoice = extraOrderFields?.canPayInvoice ?? false;
  const hasCustomer = !!extraOrderFields?.customer_id;

  // Split payment calculations
  const tendersTotal = tenders.reduce((s, t) => s + t.amount, 0);
  const remaining = grandTotal - tendersTotal;
  const splitComplete = tendersTotal === grandTotal;
  const splitOverpaid = tendersTotal > grandTotal;

  // Temporarily keep BLIK out of new POS sales until the shop has a signed
  // BLIK contract. Leave the wider payment model intact so historical BLIK
  // orders/reports still render correctly if they exist.
  const availableMethods: PaymentMethod[] = ['CASH', 'CARD', 'TRANSFER',
    ...(isB2B && hasCustomer ? ['INVOICE' as PaymentMethod] : [])];

  const handleNipToggle = () => {
    if (tenderPrepared) return;
    if (nipOpen && !nipForcedOpen) {
      setNipOpen(false);
      setNipPadOpen(false);
      return;
    }

    setNipOpen(true);
    setNipPadOpen(true);
  };

  useEffect(() => {
    if (method === 'INVOICE' && !canPayInvoice) setMethod('CASH');
  }, [canPayInvoice, method]);

  useEffect(() => {
    if (nipForcedOpen) setNipOpen(true);
  }, [nipForcedOpen]);

  useEffect(() => {
    if (method === 'CASH' && !splitMode) inputRef.current?.focus();
  }, [method, splitMode]);

  useEffect(() => {
    if (nipOpen && nipPadOpen) nipInputRef.current?.focus();
  }, [nipOpen, nipPadOpen]);

  useEffect(() => {
    document.body.dataset.posPaymentOpen = 'true';
    return () => {
      delete document.body.dataset.posPaymentOpen;
    };
  }, []);

  useEffect(() => {
    if (initialMethod) setMethod(initialMethod);
  }, [initialMethod]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape'
        && !saving
        && (!protectedTender || !tenderPrepared || !!completedOrderIdRef.current)
      ) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, protectedTender, saving, tenderPrepared]);

  // ─── Denomination counters ────────────────────────────────

  const totalFromDenoms = Object.entries(denomCounts).reduce(
    (sum, [denom, count]) => sum + Number(denom) * count,
    0,
  );

  const updateDenom = (denom: number, delta: number) => {
    if (tenderPrepared) return;
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
    if (tenderPrepared) return;
    setDenomCounts({});
    setCashAmount('');
  };

  const selectBlikPayment = () => {
    if (tenderPrepared) return;
    setSplitMode(false);
    setMethod('BLIK');
    setDenomCounts({});
    setCashAmount('');
    setError(null);
    setPrintWarning(null);
  };

  const finishCompletedPayment = () => {
    const orderId = completedOrderIdRef.current;
    if (onComplete && orderId) { onComplete({ orderId }); } else { onClose(); }
  };

  const showFiscalWarningThenClose = (warning: string) => {
    setPrintWarning(warning);
    setSavingLabel('');
    setTimeout(() => {
      finishCompletedPayment();
    }, 4000);
  };

  const printFiscalReceiptForOrder = async (orderId: string): Promise<string | null> => {
    try {
      const result = await window.electronAPI.pos.payment.printFiscalReceipt(orderId);
      if (!result?.fiscalPrinted) {
        return result?.error || tOr('pos.payment.fiscalFailed', 'Fiscal receipt not printed - reprint from Order History');
      }
    } catch (err) {
      rlog.warn('[PaymentModal] Fiscal receipt print failed:', err);
      return (err as Error)?.message || tOr('pos.payment.fiscalFailed', 'Fiscal receipt not printed - reprint from Order History');
    }
    return null;
  };

  const printFiscalFromRecovery = async (orderId: string) => {
    setReceiptRetrying(true);
    setSavingLabel(tOr('pos.payment.fiscalPrinting', 'Printing fiscal receipt...'));
    const warning = await printFiscalReceiptForOrder(orderId);
    setReceiptRetrying(false);
    setSavingLabel('');
    setReceiptRecovery(null);
    setPrintWarning(null);

    if (warning) {
      showFiscalWarningThenClose(warning);
      return;
    }

    finishCompletedPayment();
  };

  // ─── Add split tender ─────────────────────────────────────

  const addTender = () => {
    if (tenderPrepared) return;
    const parsed = parseFloat(splitAmount || '0');
    const amountGrosze = Math.round(parsed * 100);
    if (amountGrosze <= 0) return;
    if (remaining <= 0 || amountGrosze > remaining) {
      setError('Split tender cannot exceed the exact remaining amount.');
      return;
    }
    setTenders(prev => [...prev, { method: splitMethod, amount: amountGrosze }]);
    setSplitAmount('');
    setError(null);
  };

  const removeTender = (idx: number) => {
    if (tenderPrepared) return;
    setTenders(prev => prev.filter((_, i) => i !== idx));
  };

  const addRemaining = () => {
    if (tenderPrepared) return;
    if (remaining <= 0) return;
    setTenders(prev => [...prev, { method: splitMethod, amount: remaining }]);
    setSplitAmount('');
  };

  // ─── Numeric keypad ──────────────────────────────────────

  const handleKeypadPress = (key: string) => {
    if (tenderPrepared) return;
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

  const saveOrderAndFinish = async (
    orderId: string,
    submission: ResolvedPaymentSubmission,
  ) => {
    const {
      method: paymentMethod,
      splitMode: paymentSplitMode,
      tenders: paymentTenders,
      paymentAmount,
      cashAmountGrosze: submittedCashAmountGrosze,
      changeGrosze: paymentChangeGrosze,
    } = submission;
    // Determine primary method (largest tender or single method)
    let primaryMethod = paymentMethod;
    let tendersJson: string | null = null;

    if (paymentSplitMode && paymentTenders.length > 0) {
      const sorted = [...paymentTenders].sort((a, b) => b.amount - a.amount);
      primaryMethod = sorted[0].method;
      tendersJson = JSON.stringify(paymentTenders);
    }

    // Numbering series: CARD/TRANSFER auto-print the fiscal paragon -> the
    // fiscal POS- series. CASH/BLIK print the order copy (fiscal only on
    // explicit prompt) and INVOICE prints neither -> the separate ZAM-
    // order-copy series, so non-fiscal slips never interleave with the
    // fiscal numbering.
    const seriesHasCash = paymentSplitMode
      ? paymentTenders.some(t => t.method === 'CASH')
      : paymentMethod === 'CASH';
    const seriesHasBlik = paymentSplitMode
      ? paymentTenders.some(t => t.method === 'BLIK')
      : paymentMethod === 'BLIK';
    const numberSeries: 'FISCAL' | 'ORDER' =
      seriesHasCash || seriesHasBlik || paymentMethod === 'INVOICE' ? 'ORDER' : 'FISCAL';

    const kitchenSelfOrderCheckout = checkoutDraft?.kitchenSelfOrder?.kitchenAlreadyReleased === true;
    const order = {
      id: orderId,
      order_number: null as string | null,
      number_series: numberSeries,
      status: 'COMPLETED',
      subtotal: cart.subtotal,
      discount: cart.discount,
      tax: cart.tax,
      total: cart.total,
      payment_method: primaryMethod,
      payment_amount: paymentAmount,
      change_amount: paymentChangeGrosze,
      staff_id: staffId,
      staff_name: staffName,
      customer_id: extraOrderFields?.customer_id ?? null,
      customer_name: extraOrderFields?.customer_name ?? null,
      customer_nip: customerNipForOrder,
      shift_id: shiftId,
      source: kitchenSelfOrderCheckout ? 'KITCHEN_SELF_ORDER' : 'POS',
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
      kitchen_number: kitchenSelfOrderCheckout ? checkoutDraft?.kitchenSelfOrder?.orderNumber ?? null : null,
      client_attempt_id: checkoutDraft?.billiard?.clientAttemptId
        ?? checkoutDraft?.restoredInterruption?.clientAttemptId
        ?? null,
      billiard_origin_json: checkoutDraft?.billiard
        ? JSON.stringify(checkoutDraft.billiard.origin)
        : null,
      ...(paymentPreflightToken ? { payment_preflight_token: paymentPreflightToken } : {}),
    };

    const items = cart.items.map((item) => ({
      id: item.billiard
        ? `${orderId}:${item.billiard.lineKey}`
        : crypto.randomUUID(),
      order_id: orderId,
      variant_id: item.variantId ?? null,
      name: item.name,
      sku: item.sku ?? null,
      price: item.price,
      quantity: item.quantity,
      sale_quantity: item.quantity,
      sale_unit: item.saleUnit ?? (item.sellBy === 'WEIGHT' ? 'kg' : 'szt'),
      sell_by: item.sellBy ?? 'PIECE',
      total: item.total,
      vat_rate: item.vatRate ?? 23,
      staff_id: item.staffId ?? null,
      staff_name: item.staffName ?? null,
      notes: item.notes ?? null,
      course: item.course ?? null,
      billiard_json: item.billiard ? JSON.stringify(item.billiard) : null,
      inventory_policy: item.billiard?.inventoryPolicy ?? null,
      refund_policy: item.billiard?.refundPolicy ?? null,
      allocated_discount: item.billiard?.allocatedDiscountGrosze ?? 0,
      payable_total: item.billiard?.payableGrosze ?? item.total,
    }));

    const result = await window.electronAPI.pos.orders.create(order, items);
    if (result && !result.success) {
      if (result.paymentCommitted) {
        // Main crossed the local money boundary. Lock this modal permanently
        // against a second tender even when the disk verification response is
        // uncertain; recovery/sync will continue from the journal.
        completedOrderIdRef.current = result.id || orderId;
        setError(
          result.durabilityError
            ? `Payment was recorded, but local disk verification failed. Do not charge again. ${result.durabilityError}`
            : 'Payment was recorded. Do not charge again; reopen POS to recover its sync status.',
        );
        return;
      }
      if (protectedTender && tenderBoundaryCrossedRef.current) {
        const message =
          'Payment outcome is uncertain. Do not charge again. Reconcile the cash/card terminal and POS Order History with the owner.';
        completedOrderIdRef.current = orderId;
        setError(message);
        onTenderOutcomeUncertain?.(
          message,
          buildImmediateRestoredCartReconciliation(checkoutDraft?.restoredInterruption, message),
        );
        return;
      }
      throw new Error(result.error || 'Failed to save order');
    }
    completedOrderIdRef.current = orderId;

    // Trigger immediate backend sync — don't wait 30s. Runs in parallel with print.
    // Result surfaces via pos:order-synced / pos:order-sync-failed events → Order History banner.
    window.electronAPI.pos.sync.orders().catch((err: unknown) => {
      rlog.warn('[PaymentModal] Immediate order sync failed:', err);
    });

    const hasCash = paymentSplitMode
      ? paymentTenders.some(t => t.method === 'CASH')
      : paymentMethod === 'CASH';
    const hasBlik = paymentSplitMode
      ? paymentTenders.some(t => t.method === 'BLIK')
      : paymentMethod === 'BLIK';

    if (paymentMethod === 'INVOICE' && extraOrderFields?.customer_id) {
      try { await window.electronAPI.pos.customers.increaseDebt(extraOrderFields.customer_id, cart.total); }
      catch (err) { rlog.warn('[PaymentModal] Failed to increase customer debt:', err); }
    }

    // ─── Payment-method-aware print routing ──────────────────────────
    // CASH (or split with any cash tender): print the order copy on the
    //   thermal RECEIPT printer + open drawer, then follow the terminal's
    //   CASH/BLIK fiscal mode. In `always` mode the fiscal paragon replaces
    //   the non-fiscal copy and the drawer opens only after fiscal success.
    // BLIK: print the order copy with the BLIK phone instruction, no drawer,
    //   then follow the terminal's CASH/BLIK fiscal mode.
    // CARD/TRANSFER: skip the order copy, fire the fiscal receipt directly.
    // INVOICE: skip both prints (debt already increased above).
    const printOrderCopy = shouldPrintNonFiscalOrderCopy({
      hasCash,
      hasBlik,
      hasFiscalPrinter,
      mode: fiscalOnCashSale,
    });
    const printOrderCopyWithDrawer = hasCash;
    const openDrawerAfterFiscal = hasCash && !printOrderCopy;
    const autoPrintFiscal = !printOrderCopy && paymentMethod !== 'INVOICE';
    const fiscalAction = resolveFiscalAction({
      printOrderCopy,
      hasFiscalPrinter,
      method: paymentMethod,
      mode: fiscalOnCashSale,
    });

    setSavingLabel(t('test.printing') || 'Printing...');
    let printResult: PrintReceiptResponse | undefined;
    try {
      if (printOrderCopy) {
        const printOrderCopyAction = printOrderCopyWithDrawer
          ? window.electronAPI.pos.payment.printReceiptAndOpenDrawer(orderId)
          : window.electronAPI.pos.payment.printReceipt(orderId);
        printResult = await printOrderCopyAction.catch(
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
        setSavingLabel(tOr('pos.payment.fiscalPrinting', 'Printing fiscal receipt...'));
        fiscalWarning = await printFiscalReceiptForOrder(orderId);
      }
    }
    if (!fiscalWarning && openDrawerAfterFiscal) {
      await window.electronAPI.pos.payment.openCashDrawer().catch((err: unknown) => {
        rlog.warn('[PaymentModal] Fiscal sale completed but cash drawer did not open:', err);
        return { success: false, drawerOpened: false };
      });
    }
    setSavingLabel('');

    const outcome = deriveReceiptOutcome(printResult, t);
    setPaymentSnapshot({
      subtotal: cart.subtotal,
      discount: cart.discount,
      tax: cart.tax,
      total: cart.total,
      tip,
      grandTotal: cart.total + tip,
      cashAmountGrosze: paymentMethod === 'CASH' && !paymentSplitMode
        ? paymentAmount
        : submittedCashAmountGrosze,
      changeGrosze: paymentChangeGrosze,
    });
    if (!checkoutDraft?.billiard) {
      dispatch({ type: 'display/setMode', payload: { mode: 'thankyou', lastOrderTotal: cart.total } });
      dispatch({ type: 'cart/completeCheckout' });
    }

    if (printOrderCopy && !outcome.receiptPrinted) {
      setSavingLabel('');
      setPrintWarning(outcome.warning);
      setReceiptRecovery({
        orderId,
        nextAction: fiscalAction === 'skip' ? 'close' : 'fiscalPrompt',
      });
      return;
    }

    if (fiscalAction === 'prompt') {
      // Pause here — order is saved + thermal copy printed. The fiscal
      // prompt overlay will close the modal when the cashier picks an
      // option (print fiscal or skip).
      setSavingLabel('');
      setFiscalPrompt({ orderId });
      return;
    }

    if (printOrderCopy && fiscalAction === 'autoPrint') {
      setSavingLabel(tOr('pos.payment.fiscalPrinting', 'Printing fiscal receipt...'));
      fiscalWarning = await printFiscalReceiptForOrder(orderId);
      setSavingLabel('');
    }

    if (fiscalWarning) {
      showFiscalWarningThenClose(fiscalWarning);
      return;
    }

    finishCompletedPayment();
  };

  const handleFiscalPromptChoice = async (printFiscal: boolean) => {
    if (fiscalBusy) return;
    const orderId = fiscalPrompt?.orderId;
    if (!orderId) return;

    if (!printFiscal) {
      setFiscalPrompt(null);
      finishCompletedPayment();
      return;
    }

    setFiscalBusy(true);
    setSavingLabel(tOr('pos.payment.fiscalPrinting', 'Printing fiscal receipt...'));
    const warning = await printFiscalReceiptForOrder(orderId);
    setFiscalBusy(false);
    setSavingLabel('');
    setFiscalPrompt(null);

    if (warning) {
      showFiscalWarningThenClose(warning);
      return;
    }

    finishCompletedPayment();
  };

  const finishReceiptRecovery = async (recovery: ReceiptRecovery) => {
    if (recovery.nextAction === 'fiscalPrompt') {
      const action: FiscalAction = resolveFiscalAction({
        printOrderCopy: true,
        hasFiscalPrinter,
        method,
        mode: fiscalOnCashSale,
      });
      if (action === 'prompt') {
        setReceiptRecovery(null);
        setPrintWarning(null);
        setFiscalPrompt({ orderId: recovery.orderId });
        return;
      }
      if (action === 'autoPrint') {
        await printFiscalFromRecovery(recovery.orderId);
        return;
      }
    }
    setReceiptRecovery(null);
    setPrintWarning(null);
    finishCompletedPayment();
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
        await finishReceiptRecovery(recovery);
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
    void finishReceiptRecovery(receiptRecovery);
  };

  const completePayment = useCallback(async (overrides: PaymentSubmissionOverrides = {}) => {
    if (
      saving ||
      paymentCompleteInFlightRef.current ||
      completedOrderIdRef.current ||
      receiptRecovery ||
      fiscalPrompt ||
      receiptRetrying ||
      (!protectedTender && paymentPreflightStatus !== 'ready')
    ) return;
    paymentCompleteInFlightRef.current = true;
    setSaving(true);
    setError(null);
    setPrintWarning(null);
    setReceiptRecovery(null);

    try {
      if (!customerNipValid) {
        setError(tOr('pos.payment.customerNipInvalid', 'NIP must have exactly 10 digits.'));
        setSaving(false);
        return;
      }

      const submission = resolvePaymentSubmission({
        method,
        splitMode,
        tenders,
        cashAmountGrosze,
        grandTotal,
      }, overrides);
      if (!submission.complete) {
        setError(submission.splitMode
          ? tOr('pos.split.incomplete', 'Split payment incomplete')
          : tOr('pos.payment.insufficient', 'Insufficient cash'));
        setSaving(false);
        return;
      }

      if (protectedTender && !tenderBoundaryCrossedRef.current) {
        const boundary = checkoutDraft?.billiard
          ? await window.electronAPI.pos.billiardCheckout.beginTender(checkoutDraft.billiard.handoffId)
          : await window.electronAPI.pos.billiardCheckout.beginRestoredTender(
              checkoutDraft!.restoredInterruption!.holdId,
            );
        if (!boundary?.success) {
          if (boundary?.paymentCommitted) {
            completedOrderIdRef.current = boundary.orderId || orderAttemptIdRef.current;
            setError(boundary.error || 'Payment is already recorded locally. Do not charge again.');
            return;
          }
          if (boundary?.outcomeUncertain) {
            const message = boundary.error
              || 'Payment outcome is uncertain. Do not charge again. Reconcile cash/card and POS Order History with the owner.';
            completedOrderIdRef.current = orderAttemptIdRef.current;
            setError(message);
            onTenderOutcomeUncertain?.(
              message,
              buildImmediateRestoredCartReconciliation(checkoutDraft?.restoredInterruption, message),
            );
            return;
          }
          throw new Error(boundary?.error || 'Could not persist the tender safety boundary.');
        }
        // Main has fsynced the anti-duplicate boundary. Keep this renderer
        // locked and continue to the existing POS order commit in the same
        // cashier action; any post-boundary failure remains fail-closed below.
        tenderBoundaryCrossedRef.current = true;
        setTenderPrepared(true);
        setNipPadOpen(false);
      }

      const orderId = orderAttemptIdRef.current;
      await saveOrderAndFinish(orderId, submission);
    } catch (err) {
      rlog.error('[PaymentModal] Failed to complete payment:', err);
      if (
        protectedTender
        && tenderBoundaryCrossedRef.current
        && !completedOrderIdRef.current
      ) {
        const message =
          'Payment outcome is uncertain. Do not charge again. Reconcile the cash/card terminal and POS Order History with the owner.';
        completedOrderIdRef.current = orderAttemptIdRef.current;
        setError(message);
        onTenderOutcomeUncertain?.(
          message,
          buildImmediateRestoredCartReconciliation(checkoutDraft?.restoredInterruption, message),
        );
        return;
      }
      const rawMessage = err instanceof Error
        ? err.message
        : (typeof err === 'string' ? err : '');
      const message = rawMessage.trim();
      if (/active shift staff|local active shift/i.test(message)) {
        setError(tOr('pos.shift.staffMissing', 'Shift is open but missing staff. Close and reopen the shift before payment.'));
      } else {
        setError(message || t('pos.payment.error'));
      }
    } finally {
      setSaving(false);
      paymentCompleteInFlightRef.current = false;
    }
  }, [cashAmountGrosze, checkoutDraft, customerNipForOrder, customerNipValid, fiscalPrompt, grandTotal, method, onTenderOutcomeUncertain, paymentPreflightStatus, paymentPreflightToken, protectedTender, receiptRecovery, receiptRetrying, saving, shiftId, splitMode, staffId, staffName, t, tOr, tenders]);

  const handleComplete = useCallback(() => {
    void completePayment();
  }, [completePayment]);

  const selectedTenderIsComplete = splitMode
    ? splitComplete
    : method !== 'CASH' || cashAmountGrosze >= grandTotal;
  const canComplete = !receiptRecovery
    && !fiscalPrompt
    && !completedOrderIdRef.current
    && !saving
    && customerNipValid
    && (protectedTender || paymentPreflightStatus === 'ready')
    && selectedTenderIsComplete;

  const currency = t('pos.currency') || 'zl';
  const money = (amount: number) => `${(amount / 100).toFixed(2)} ${currency}`;
  const methodLabel = (pm: PaymentMethod) => t(`pos.payment.${pm.toLowerCase()}`) || pm;
  const loyaltyOwner = loyaltyResult?.owner;
  const loyalty = loyaltyResult?.loyalty;
  const loyaltyTierName = loyalty?.tier?.name || tOr('pos.loyalty.noTier', 'No tier');
  const loyaltyPackageCount = Number(
    (loyalty as any)?.activePackages
      ?? (loyalty as any)?.activePackagesCount
      ?? (loyalty as any)?.activeServicePackages
      ?? 0,
  ) || 0;
  const loyaltyNoShowCount = loyaltyOwner?.noShowCount ?? 0;
  const loyaltyLateCount = loyaltyOwner?.lateCount ?? 0;
  const loyaltyCancelCount = loyaltyOwner?.cancelCount ?? 0;
  const loyaltyRiskTotal = loyaltyNoShowCount + loyaltyLateCount + loyaltyCancelCount;
  const activeMethodLabel = splitMode ? tOr('pos.split.toggle', 'Split') : methodLabel(method);
  const completeButtonLabel = method === 'CARD' && !splitMode
    ? tOr('pos.payment.cardReceived', 'Card payment received')
    : t('pos.payment.complete');
  const completeButtonShortLabel = tOr('pos.payment.completeShort', completeButtonLabel);
  const cashHasChange = method === 'CASH' && !splitMode && changeGrosze > 0;
  const cashHasShortfall = method === 'CASH' && !splitMode && cashShortfall > 0;
  const cashStatusLabel = cashHasShortfall
    ? tOr('pos.payment.shortfall', 'Shortfall')
    : t('pos.payment.change');
  const cashStatusAmount = cashHasShortfall ? cashShortfall : changeGrosze;
  const cashStatusTone = cashHasShortfall
    ? 'shortfall'
    : cashHasChange
      ? 'change'
      : displayCashAmountGrosze > 0
        ? 'covered'
        : 'idle';
  const completeButtonText = saving
    ? (savingLabel || t('pos.payment.saving'))
    : cashHasChange
      ? `${completeButtonShortLabel} · ${tOr('pos.payment.returnChange', 'return')} ${money(changeGrosze)}`
      : `${completeButtonLabel} ${money(grandTotal)}`;
  const splitProgress = grandTotal > 0
    ? Math.min(100, Math.max(0, (tendersTotal / grandTotal) * 100))
    : 0;
  const closeBlocked = saving
    || !!fiscalPrompt
    || !!receiptRecovery
    || (protectedTender && tenderPrepared && !completedOrderIdRef.current);

  const removeScannedCommandFromActiveInput = useCallback((code: string) => {
    window.setTimeout(() => {
      const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (!active || (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA')) return;
      const fullMatch = active.value.endsWith(code);
      const partialCode = code.slice(0, -1);
      const partialMatch = partialCode.length > 0 && active.value.endsWith(partialCode);
      if (!fullMatch && !partialMatch) return;
      active.value = active.value.slice(0, fullMatch ? -code.length : -partialCode.length);
      active.dispatchEvent(new Event('input', { bubbles: true }));
    }, 0);
  }, []);

  const runPaymentScanCommand = useCallback((rawCode: string): boolean => {
    const code = rawCode.trim();
    const cardCommand = scanCommands?.card?.trim();
    const cashCommand = scanCommands?.cash?.trim();
    const submitBlocked =
      saving ||
      paymentCompleteInFlightRef.current ||
      !!completedOrderIdRef.current ||
      !!receiptRecovery ||
      receiptRetrying ||
      !!fiscalPrompt ||
      tenderPrepared;

    if (cardCommand && code === cardCommand) {
      if (submitBlocked) return true;
      setSplitMode(false);
      setTenders([]);
      setSplitAmount('');
      setDenomCounts({});
      setCashAmount('');
      setError(null);
      setPrintWarning(null);

      if (method === 'CARD') {
        void completePayment({
          method: 'CARD',
          splitMode: false,
          tenders: [],
          cashAmountGrosze: 0,
        });
      } else {
        setMethod('CARD');
      }
      return true;
    }

    if (cashCommand && code === cashCommand) {
      if (submitBlocked) return true;
      const shouldCompleteCash = method === 'CASH';
      setSplitMode(false);
      setTenders([]);
      setSplitAmount('');
      setMethod('CASH');
      setDenomCounts({});
      setCashAmount(totalZl.toFixed(2));
      setError(null);
      setPrintWarning(null);
      if (shouldCompleteCash) {
        void completePayment({
          method: 'CASH',
          splitMode: false,
          tenders: [],
          cashAmountGrosze: grandTotal,
        });
      }
      return true;
    }

    return false;
  }, [completePayment, fiscalPrompt, grandTotal, method, receiptRecovery, receiptRetrying, saving, scanCommands?.card, scanCommands?.cash, tenderPrepared, totalZl]);

  useEffect(() => {
    const commandCodes = [scanCommands?.card, scanCommands?.cash]
      .map((code) => code?.trim())
      .filter((code): code is string => !!code);
    if (commandCodes.length === 0) return;
    const maxCommandLength = Math.max(...commandCodes.map((code) => code.length));

    const handleCommand = (code: string, event?: KeyboardEvent): boolean => {
      if (!runPaymentScanCommand(code)) return false;
      event?.preventDefault();
      event?.stopPropagation();
      removeScannedCommandFromActiveInput(code);
      scannerBufferRef.current = '';
      return true;
    };

    const unsubscribe = window.electronAPI?.onBarcodeScanned?.((barcode: string) => {
      handleCommand(barcode);
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const now = Date.now();
      if (now - scannerLastKeyRef.current > 150) scannerBufferRef.current = '';
      scannerLastKeyRef.current = now;

      if (event.key === 'Enter' || event.key === 'Tab') {
        handleCommand(scannerBufferRef.current, event);
        scannerBufferRef.current = '';
        return;
      }

      if (event.key.length !== 1) return;
      const commandCandidate = (scannerBufferRef.current + event.key).slice(-maxCommandLength);
      const matchingCommand = commandCodes.find((candidate) => candidate.startsWith(commandCandidate));
      scannerBufferRef.current = commandCandidate;

      if (!matchingCommand) return;

      // Keyboard-wedge scanners type into the focused cash input before React
      // can recognize the full 8-digit command. Let a single manual "1"/"2"
      // through, but once the sequence is clearly a fast command prefix, stop
      // it from becoming a cash amount suffix.
      if (commandCandidate.length > 1) {
        event.preventDefault();
        event.stopPropagation();
        removeScannedCommandFromActiveInput(commandCandidate.slice(0, -1));
      }

      if (commandCandidate === matchingCommand) handleCommand(matchingCommand, event);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      unsubscribe?.();
    };
  }, [removeScannedCommandFromActiveInput, runPaymentScanCommand, scanCommands?.card, scanCommands?.cash]);

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
          disabled={tenderPrepared}
            className={`flex min-h-[44px] items-center justify-center rounded-md border text-lg font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
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
          disabled={tenderPrepared}
          className="flex min-h-[44px] items-center justify-center rounded-md border border-slate-200 bg-white text-lg font-semibold text-slate-800 transition-colors hover:bg-slate-50 active:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >0</button>
        <button
          type="button"
          onClick={() => handleKeypadPress('00')}
          disabled={tenderPrepared}
          className="flex min-h-[44px] items-center justify-center rounded-md border border-slate-200 bg-white text-lg font-semibold text-slate-800 transition-colors hover:bg-slate-50 active:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >00</button>
        <button
          type="button"
          onClick={() => handleKeypadPress(quickAction)}
          disabled={tenderPrepared || quickDisabled}
          className="col-span-2 flex min-h-[44px] items-center justify-center rounded-md border border-brand-200 bg-brand-50 text-sm font-semibold text-brand-800 transition-colors hover:bg-brand-100 active:bg-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
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
            className="min-h-[52px] rounded-md border border-slate-300 bg-white px-4 text-base font-semibold text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {tOr('pos.payment.fiscalSkip', 'Bỏ qua')}
          </button>
          <button
            type="button"
            onClick={() => handleFiscalPromptChoice(true)}
            disabled={fiscalBusy}
            className="min-h-[52px] rounded-md border border-emerald-600 bg-emerald-600 px-4 text-base font-semibold text-white transition-colors hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
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
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/55 p-2 sm:p-3"
      onClick={closeBlocked ? undefined : onClose}
    >
      {fiscalPromptOverlay}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-modal-title"
        className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-slate-500">{activeMethodLabel}</p>
            <h2 id="payment-modal-title" className="truncate text-xl font-semibold text-slate-950">{t('pos.payment')}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setSplitMode(!splitMode); setTenders([]); setSplitAmount(''); }}
              disabled={saving || !!receiptRecovery || tenderPrepared}
              aria-pressed={splitMode}
              className={`min-h-[44px] rounded-md border px-4 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
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
              disabled={closeBlocked}
              aria-label="Close"
              className="flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-100 p-3">
          <div className="grid min-h-0 gap-3 lg:grid-cols-[0.8fr_1.4fr]">
            <aside className="space-y-3">
              <div className="rounded-lg border border-slate-800 bg-slate-950 p-4 text-white shadow-sm">
                <p className="text-xs font-semibold uppercase text-slate-300">{t('pos.cart.total')}</p>
                <p className="mt-1 text-4xl font-semibold leading-none">{money(grandTotal)}</p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-200">
                  <div>
                    <p className="text-xs text-slate-400">{t('pos.cart.subtotal')}</p>
                    <p className="font-semibold">{money(displaySubtotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">{t('pos.cart.inclVat')}</p>
                    <p className="font-semibold">{money(displayTax)}</p>
                  </div>
                  {(displayDiscount > 0 || displayTip > 0) && (
                    <>
                      {displayDiscount > 0 && (
                        <div>
                          <p className="text-xs text-slate-400">{t('pos.cart.discount')}</p>
                          <p className="font-semibold text-amber-200">-{money(displayDiscount)}</p>
                        </div>
                      )}
                      {displayTip > 0 && (
                        <div>
                          <p className="text-xs text-slate-400">{tOr('pos.tip', 'Tip')}</p>
                          <p className="font-semibold">{money(displayTip)}</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleNipToggle}
                  aria-expanded={nipOpen}
                  className={`flex h-11 min-w-0 items-center justify-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${
                    nipOpen
                      ? 'border-brand-700 bg-brand-50 text-brand-800 shadow-sm'
                      : 'border-slate-300 bg-white text-slate-700 hover:border-brand-500 hover:text-brand-700'
                  }`}
                >
                  <span className="shrink-0 text-base leading-none">+</span>
                  <span className="truncate">{tOr('pos.payment.addNip', 'Add NIP')}</span>
                  {nipOpen && (
                    <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setLoyaltyOpen(open => !open)}
                  aria-expanded={loyaltyOpen}
                  className={`flex h-11 min-w-0 items-center justify-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${
                    loyaltyOpen
                      ? 'border-brand-700 bg-brand-50 text-brand-800 shadow-sm'
                      : 'border-slate-300 bg-white text-slate-700 hover:border-brand-500 hover:text-brand-700'
                  }`}
                >
                  <span className="shrink-0 text-base leading-none">♥</span>
                  <span className="truncate">{tOr('pos.payment.loyaltyChip', 'Loyalty')}</span>
                  {loyaltyOpen && (
                    <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                </button>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                <p className="text-xs font-semibold uppercase text-slate-500">{t('pos.payment')}</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {availableMethods.map(pm => {
                    const disabled = (pm === 'INVOICE' && !canPayInvoice) || tenderPrepared;
                    const selected = !splitMode && method === pm;
                    return (
                      <button
                        key={pm}
                        type="button"
                        onClick={() => !disabled && setMethod(pm)}
                        disabled={saving || disabled}
                        className={`flex min-h-[60px] min-w-0 items-center gap-2 rounded-md border p-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed ${
                          selected
                            ? 'border-brand-700 bg-brand-50 text-brand-900 shadow-sm'
                            : disabled
                              ? 'border-slate-200 bg-slate-50 text-slate-300'
                              : 'border-slate-300 bg-white text-slate-700 hover:border-brand-500 hover:bg-brand-50'
                        }`}
                      >
                        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md border ${
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

              {loyaltyOpen && (
              <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold uppercase text-slate-500">
                      {tOr('pos.loyalty.title', 'Customer loyalty')}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {tOr('pos.loyalty.noAutoDiscount', 'Info only. Discount is not applied automatically.')}
                    </p>
                  </div>
                  {loyaltyStatus === 'found' && loyaltyResult?.found && (
                    <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-700">
                      {tOr('pos.loyalty.found', 'Found')}
                    </span>
                  )}
                </div>

                <div className="mt-3 flex gap-2">
                  <input
                    type="tel"
                    inputMode="tel"
                    data-keyboard="false"
                    value={loyaltyPhone}
                    onChange={(e) => {
                      setLoyaltyPhone(e.target.value);
                      if (loyaltyStatus !== 'idle') {
                        setLoyaltyStatus('idle');
                        setLoyaltyResult(null);
                        setLoyaltyError(null);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleLoyaltyLookup();
                    }}
                    placeholder={tOr('pos.loyalty.phonePlaceholder', 'Customer phone')}
                    className="h-11 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 text-base font-semibold text-slate-950 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <button
                    type="button"
                    onClick={() => void handleLoyaltyLookup()}
                    disabled={saving || loyaltyStatus === 'loading'}
                    className="h-11 rounded-md border border-brand-700 bg-brand-700 px-3 text-sm font-semibold text-white transition-colors hover:bg-brand-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loyaltyStatus === 'loading'
                      ? tOr('pos.loyalty.loadingShort', '...')
                      : tOr('pos.loyalty.lookup', 'Lookup')}
                  </button>
                </div>

                {loyaltyStatus === 'loading' && (
                  <p className="mt-2 text-sm font-semibold text-slate-600">
                    {tOr('pos.loyalty.loading', 'Looking up customer...')}
                  </p>
                )}

                {loyaltyStatus === 'not_found' && (
                  <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
                    {tOr('pos.loyalty.notFound', 'No customer found for this phone.')}
                  </p>
                )}

                {loyaltyStatus === 'error' && loyaltyError && (
                  <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
                    {loyaltyError}
                  </p>
                )}

                {loyaltyStatus === 'found' && loyaltyResult?.found && (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-slate-950">
                            {loyaltyOwner?.fullName || tOr('pos.loyalty.customer', 'Customer')}
                          </p>
                          <p className="truncate text-xs font-semibold text-slate-500">
                            {loyaltyOwner?.phone || loyaltyResult.phone}
                          </p>
                        </div>
                        {loyaltyOwner?.isBlocked && (
                          <span className="shrink-0 rounded-full bg-red-100 px-2 py-1 text-xs font-bold text-red-700">
                            {tOr('pos.loyalty.blocked', 'Blocked')}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="rounded-md border border-slate-200 bg-white p-2">
                        <p className="text-xs font-semibold text-slate-500">{tOr('pos.loyalty.points', 'Points')}</p>
                        <p className="mt-0.5 text-lg font-bold tabular-nums text-slate-950">
                          {loyalty?.currentPoints ?? 0}
                        </p>
                      </div>
                      <div className="rounded-md border border-slate-200 bg-white p-2">
                        <p className="text-xs font-semibold text-slate-500">{tOr('pos.loyalty.tier', 'Tier')}</p>
                        <p className="mt-0.5 truncate text-lg font-bold text-slate-950">{loyaltyTierName}</p>
                      </div>
                      <div className="rounded-md border border-slate-200 bg-white p-2">
                        <p className="text-xs font-semibold text-slate-500">{tOr('pos.loyalty.stamps', 'Stamps')}</p>
                        <p className="mt-0.5 text-lg font-bold tabular-nums text-slate-950">
                          {loyalty?.activeStampCards ?? 0}
                        </p>
                      </div>
                      <div className="rounded-md border border-slate-200 bg-white p-2">
                        <p className="text-xs font-semibold text-slate-500">{tOr('pos.loyalty.packages', 'Packages')}</p>
                        <p className="mt-0.5 text-lg font-bold tabular-nums text-slate-950">
                          {loyaltyPackageCount}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                      <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                        <p className="font-semibold text-slate-500">{tOr('pos.loyalty.noShow', 'No-show')}</p>
                        <p className={`mt-1 text-base font-bold tabular-nums ${loyaltyNoShowCount > 0 ? 'text-red-700' : 'text-slate-800'}`}>
                          {loyaltyNoShowCount}
                        </p>
                      </div>
                      <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                        <p className="font-semibold text-slate-500">{tOr('pos.loyalty.late', 'Late')}</p>
                        <p className={`mt-1 text-base font-bold tabular-nums ${loyaltyLateCount > 0 ? 'text-amber-700' : 'text-slate-800'}`}>
                          {loyaltyLateCount}
                        </p>
                      </div>
                      <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                        <p className="font-semibold text-slate-500">{tOr('pos.loyalty.cancel', 'Cancel')}</p>
                        <p className={`mt-1 text-base font-bold tabular-nums ${loyaltyCancelCount > 0 ? 'text-amber-700' : 'text-slate-800'}`}>
                          {loyaltyCancelCount}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 text-xs font-semibold">
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                        {tOr('pos.loyalty.lifetime', 'Lifetime')}: {loyalty?.lifetimePoints ?? 0}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                        {tOr('pos.loyalty.pending', 'Pending')}: {loyalty?.pendingRedemptions ?? 0}
                      </span>
                      {loyaltyRiskTotal > 0 && (
                        <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-800">
                          {tOr('pos.loyalty.risk', 'Risk')}: {loyaltyRiskTotal}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
              )}

              {nipOpen && (
              <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span id="payment-customer-nip-label" className="text-sm font-semibold text-slate-900">
                    {tOr('pos.payment.customerNipLabel', 'Buyer NIP (optional)')}
                  </span>
                  <span className={`text-xs font-bold tabular-nums ${customerNipValid ? 'text-slate-400' : 'text-red-600'}`}>
                    {customerNip.length}/10
                  </span>
                </div>

                {/* Opt out of the shared on-screen keyboard (data-keyboard="false");
                    it otherwise pops up at the bottom over the modal and hides this
                    field. Touch entry is driven by the inline numpad below, so the
                    digits stay visible the whole time. */}
                <input
                  id="payment-customer-nip"
                  ref={nipInputRef}
                  type="text"
                  inputMode="numeric"
                  data-keyboard="false"
                  maxLength={10}
                  value={customerNip}
                  disabled={tenderPrepared}
                  onChange={(e) => updateCustomerNip(e.target.value)}
                  onFocus={() => { if (!tenderPrepared) setNipPadOpen(true); }}
                  onClick={() => { if (!tenderPrepared) setNipPadOpen(true); }}
                  placeholder={tOr('pos.payment.customerNipPlaceholder', 'Tap to enter 10 digits')}
                  aria-invalid={!customerNipValid}
                  aria-labelledby="payment-customer-nip-label"
                  className={`mt-2 h-12 w-full rounded-md border bg-white px-3 text-xl font-semibold tracking-[0.2em] text-slate-950 focus:outline-none focus:ring-2 ${
                    customerNipValid
                      ? 'border-slate-300 focus:ring-brand-500'
                      : 'border-red-300 focus:ring-red-500'
                  }`}
                />

                {customerNip.length > 0 && (
                  <p className="mt-1 text-sm font-semibold tabular-nums tracking-wider text-slate-500">
                    {formatNip(customerNip)}
                  </p>
                )}

                {nipPadOpen && (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2">
                    <div className="grid grid-cols-3 gap-1.5">
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => appendNipDigit(k)}
                          disabled={tenderPrepared}
                          className="flex min-h-[48px] items-center justify-center rounded-md border border-slate-200 bg-white text-xl font-semibold text-slate-800 transition-colors hover:bg-slate-100 active:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                        >
                          {k}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={backspaceNip}
                        disabled={tenderPrepared}
                        aria-label={tOr('pos.payment.nipBackspace', 'Delete')}
                        className="flex min-h-[48px] items-center justify-center rounded-md border border-slate-200 bg-slate-100 text-slate-600 transition-colors hover:bg-slate-200 active:bg-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9.75L14.25 12m0 0l2.25 2.25M14.25 12l2.25-2.25M14.25 12L12 14.25m-2.58 4.92l-6.374-6.375a1.125 1.125 0 010-1.59L9.42 4.83c.21-.211.497-.33.795-.33H19.5a2.25 2.25 0 012.25 2.25v10.5a2.25 2.25 0 01-2.25 2.25h-9.284c-.298 0-.585-.119-.795-.33z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => appendNipDigit('0')}
                        disabled={tenderPrepared}
                        className="flex min-h-[48px] items-center justify-center rounded-md border border-slate-200 bg-white text-xl font-semibold text-slate-800 transition-colors hover:bg-slate-100 active:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        0
                      </button>
                      <button
                        type="button"
                        onClick={() => setNipPadOpen(false)}
                        className="flex min-h-[48px] items-center justify-center rounded-md border border-brand-200 bg-brand-50 text-sm font-semibold text-brand-800 transition-colors hover:bg-brand-100 active:bg-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        {tOr('pos.payment.nipDone', 'Done')}
                      </button>
                    </div>
                    {customerNip.length > 0 && (
                      <button
                        type="button"
                        onClick={() => updateCustomerNip('')}
                        disabled={tenderPrepared}
                        className="mt-1.5 w-full rounded-md py-1 text-xs font-semibold text-slate-500 transition-colors hover:text-red-700"
                      >
                        {tOr('pos.payment.nipClear', 'Clear')}
                      </button>
                    )}
                  </div>
                )}

                <p className={`mt-2 text-xs font-semibold ${customerNipValid ? 'text-slate-500' : 'text-red-700'}`}>
                  {customerNipValid
                    ? tOr('pos.payment.customerNipHint', 'Add before payment if the customer needs NIP on the receipt or invoice.')
                    : tOr('pos.payment.customerNipInvalid', 'NIP must have exactly 10 digits.')}
                </p>
              </div>
              )}
            </aside>

            <section className="flex min-w-0 flex-col rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-4 py-3">
                <p className="text-xs font-semibold uppercase text-slate-500">{activeMethodLabel}</p>
                <p className="mt-1 text-sm text-slate-600">
                  {splitMode
                    ? `${tOr('pos.split.remaining', 'Remaining')}: ${money(Math.max(remaining, 0))}`
                    : method === 'CASH'
                      ? `${t('pos.payment.received')}: ${displayCashAmountGrosze > 0 ? money(displayCashAmountGrosze) : money(0)}`
                      : `${t('pos.cart.total')}: ${money(grandTotal)}`}
                </p>
              </div>
              <div className="flex-1 space-y-3 p-4">

          {/* ─── SPLIT MODE ─────────────────────────────────── */}
          {splitMode ? (
            <div className="space-y-3">
              <div className={`rounded-lg border p-4 ${
                splitOverpaid
                  ? 'border-red-300 bg-red-50'
                  : splitComplete ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'
              }`}>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className={`text-sm font-semibold ${splitOverpaid ? 'text-red-800' : splitComplete ? 'text-emerald-800' : 'text-amber-800'}`}>
                      {splitOverpaid
                        ? 'Tender exceeds total'
                        : splitComplete ? tOr('pos.split.complete', 'Fully covered') : tOr('pos.split.remaining', 'Remaining')}
                    </p>
                    <p className={`mt-1 text-3xl font-semibold leading-none ${splitOverpaid ? 'text-red-900' : splitComplete ? 'text-emerald-900' : 'text-amber-900'}`}>
                      {money(splitOverpaid ? -remaining : splitComplete ? 0 : Math.max(remaining, 0))}
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
                        disabled={tenderPrepared}
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
                        disabled={tenderPrepared}
                        placeholder={(Math.max(remaining, 0) / 100).toFixed(2)}
                        className="h-12 w-full rounded-md border border-slate-300 bg-white px-3 text-right text-lg font-semibold text-slate-950 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        onKeyDown={e => { if (e.key === 'Enter') addTender(); }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={addTender}
                      disabled={
                        tenderPrepared
                        || !splitAmount
                        || parseFloat(splitAmount) <= 0
                        || Math.round(parseFloat(splitAmount) * 100) > Math.max(remaining, 0)
                      }
                      aria-label="Add tender"
                      className="mt-0 flex min-h-[48px] min-w-[56px] items-center justify-center rounded-md bg-brand-600 px-5 text-xl font-semibold text-white transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 md:mt-6"
                    >
                      +
                    </button>
                  </div>
                  {remaining > 0 && (
                    <button
                      type="button"
                      onClick={addRemaining}
                      disabled={tenderPrepared}
                      className="mt-3 min-h-[44px] w-full rounded-md border border-brand-300 bg-white px-4 text-sm font-semibold text-brand-800 transition-colors hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
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
                            disabled={tenderPrepared}
                            aria-label="Remove tender"
                            className="flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-500 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
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
            <div className="space-y-3">
              {/* ─── SINGLE MODE ──────────────────────────────── */}
              <label className="block" htmlFor="payment-cash-received">
                <span className="mb-1 block text-sm font-semibold text-slate-700">{t('pos.payment.received')}</span>
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
                   disabled={tenderPrepared}
                  className="h-14 w-full rounded-md border border-slate-300 bg-white px-4 text-right text-3xl font-semibold text-slate-950 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </label>

              <div aria-live="polite" className={`rounded-lg border p-3 ${
                cashStatusTone === 'shortfall'
                  ? 'border-red-300 bg-red-50'
                  : cashStatusTone === 'change'
                    ? 'border-emerald-300 bg-emerald-50'
                    : cashStatusTone === 'covered'
                      ? 'border-emerald-200 bg-emerald-50'
                      : 'border-slate-200 bg-slate-50'
              }`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className={`text-sm font-semibold ${
                      cashStatusTone === 'shortfall'
                        ? 'text-red-800'
                        : cashStatusTone === 'idle'
                          ? 'text-slate-600'
                          : 'text-emerald-800'
                    }`}>
                      {cashStatusLabel}
                    </p>
                    <p className={`mt-1 text-3xl font-semibold leading-none ${
                      cashStatusTone === 'shortfall'
                        ? 'text-red-800'
                        : cashStatusTone === 'idle'
                          ? 'text-slate-500'
                          : 'text-emerald-800'
                    }`}>
                      {money(cashStatusAmount)}
                    </p>
                  </div>
                  <div className="text-right text-sm text-slate-600">
                    <p>{t('pos.cart.total')}: {money(grandTotal)}</p>
                    <p>{t('pos.payment.received')}: {money(displayCashAmountGrosze)}</p>
                  </div>
                </div>
              </div>

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
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  <button
                     type="button"
                     onClick={selectBlikPayment}
                     disabled={tenderPrepared}
                    aria-label="Pay by BLIK"
                    className="min-h-[52px] rounded-lg border-2 border-slate-900 bg-slate-950 px-2 py-2 text-white transition-colors hover:bg-slate-800 active:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
                  >
                    <span className="block text-sm font-extrabold leading-none">BLIK</span>
                    <span className="mt-1 block text-[11px] font-bold leading-none tabular-nums text-slate-200">
                      {BLIK_RECEIPT_PHONE}
                    </span>
                  </button>
                  {DENOMINATIONS.map((denom) => {
                    const count = denomCounts[denom] ?? 0;
                    const active = count > 0;
                    return (
                      <div key={denom} className="relative">
                        <button
                           type="button"
                           onClick={() => updateDenom(denom, +1)}
                           disabled={tenderPrepared}
                          aria-label={`Add ${denom / 100} ${currency} bill`}
                          className={`w-full min-h-[52px] rounded-lg border-2 px-2 py-2 flex flex-col items-center justify-center transition-colors cursor-pointer touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 ${
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
                             disabled={tenderPrepared}
                            aria-label={`Remove one ${denom / 100} ${currency} bill`}
                            className="absolute -top-2.5 -right-2.5 w-10 h-10 rounded-full bg-slate-800 text-white text-xl font-bold leading-none flex items-center justify-center shadow-md hover:bg-slate-950 cursor-pointer touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                          >
                            −
                          </button>
                        )}
                      </div>
                    );
                  })}
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
                      {paymentPreflightStatus === 'ready'
                        ? tOr(
                            'pos.payment.cardManualHint',
                            'Enter this amount on the card terminal. After approval, press the button below.',
                          )
                        : paymentPreflightStatus === 'checking'
                          ? tOr(
                              'pos.payment.preflightChecking',
                              'Checking the POS register and shift. Do not use the card terminal yet.',
                            )
                          : tOr(
                              'pos.payment.preflightBlocked',
                              'Payment is unavailable. Do not use the card terminal.',
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

              {method === 'BLIK' && (
                <div className="rounded-lg border border-slate-900 bg-slate-950 p-5 text-white">
                  <p className="text-xs font-semibold uppercase text-slate-300">BLIK</p>
                  <p className="mt-2 text-4xl font-semibold leading-none tracking-normal">{BLIK_RECEIPT_PHONE}</p>
                  <p className="mt-2 text-sm font-semibold text-slate-200">
                    {tOr('pos.payment.blikReceiptHint', 'Receipt will print this phone number with BLIK below it.')}
                  </p>
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

        <div className="shrink-0 space-y-2 border-t border-slate-200 bg-white px-4 py-3">
          {!protectedTender && paymentPreflightStatus === 'checking' && (
            <div aria-live="polite" className="rounded-md border border-blue-200 bg-blue-50 px-3 py-3 text-sm font-semibold text-blue-900">
              {tOr(
                'pos.payment.preflightChecking',
                'Checking the POS register and shift. Do not collect payment yet.',
              )}
            </div>
          )}
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
            {method === 'CASH' && !splitMode && !receiptRecovery ? (
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
                  <p className="whitespace-nowrap">
                    <span className="font-semibold text-slate-500">{t('pos.cart.total')}:</span>{' '}
                    <span className="font-bold tabular-nums text-slate-950">{money(grandTotal)}</span>
                  </p>
                  <p className="whitespace-nowrap">
                    <span className="font-semibold text-slate-500">{t('pos.payment.received')}:</span>{' '}
                    <span className="font-bold tabular-nums text-slate-950">{money(displayCashAmountGrosze)}</span>
                  </p>
                  <p className={`min-w-0 max-w-full break-words text-lg font-bold tabular-nums ${
                    cashStatusTone === 'shortfall'
                      ? 'text-red-700'
                      : cashStatusTone === 'change'
                        ? 'text-emerald-700'
                        : 'text-slate-700'
                  }`}>
                    {cashStatusLabel}: {money(cashStatusAmount)}
                  </p>
                </div>
              </div>
            ) : (
              <div className="min-w-0 text-sm text-slate-600">
                <p className="font-semibold text-slate-950">{activeMethodLabel}</p>
                <p className="truncate">
                  {receiptRecovery
                    ? tOr('pos.payment.orderSavedPrintPending', 'Order saved - receipt still needs printing')
                    : splitMode
                    ? `${tOr('pos.split.remaining', 'Remaining')}: ${money(Math.max(remaining, 0))}`
                    : `${t('pos.cart.total')}: ${money(grandTotal)}`}
                </p>
              </div>
            )}
            {receiptRecovery ? (
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[360px] sm:flex-row">
                <button
                  type="button"
                  onClick={handleRetryReceipt}
                  disabled={receiptRetrying}
                  className="min-h-[56px] flex-1 rounded-md bg-brand-600 px-5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600"
                >
                  {receiptRetrying ? (savingLabel || tOr('test.printing', 'Printing...')) : tOr('pos.payment.retryReceipt', 'Retry order print')}
                </button>
                <button
                  type="button"
                  onClick={handleContinueWithoutReceipt}
                  disabled={receiptRetrying}
                  className="min-h-[56px] flex-1 rounded-md border border-amber-300 bg-amber-50 px-5 text-base font-semibold text-amber-900 transition-colors hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {tOr('pos.payment.continueWithoutReceipt', 'Continue without print')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleComplete}
                disabled={!canComplete}
                className="min-h-[56px] w-full max-w-full rounded-md bg-brand-600 px-4 text-center text-base font-semibold leading-tight text-white shadow-sm transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600 sm:w-auto sm:min-w-[220px] sm:max-w-[320px] whitespace-normal break-words"
              >
                {completeButtonText}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
