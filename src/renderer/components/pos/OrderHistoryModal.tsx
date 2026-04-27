import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { translations } from '../../i18n/translations';

interface OrderRow {
  id: string;
  order_number: string | null;
  status: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  payment_method: string | null;
  payment_amount: number;
  change_amount: number;
  staff_name: string | null;
  created_at: string;
  backend_id?: string | null;
  synced?: number;
  refund_amount?: number;
  refund_reason?: string | null;
  refunded_at?: string | null;
  customer_nip?: string | null;
  customer_name?: string | null;
  payment_tenders?: string | null;
  sync_error?: string | null;
  sync_attempts?: number;
  _origin?: 'server';
}

interface OrderItemRow {
  id: string;
  order_id: string;
  variant_id?: string | null;
  name: string;
  sku: string | null;
  price: number;
  quantity: number;
  total: number;
  vat_rate: number;
}

interface OrderHistoryModalProps {
  onClose: () => void;
  t: (key: string) => string;
}

type RefundStatus = 'none' | 'full' | 'partial';
type ReprintStatus = { type: 'ok' | 'error'; message: string } | null;

const PAGE_SIZE = 20;

const PAYMENT_METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card' },
  { value: 'BLIK', label: 'BLIK' },
  { value: 'TRANSFER', label: 'Transfer' },
  { value: 'INVOICE', label: 'Invoice' },
];

const REFUND_REASONS = [
  { key: 'customerRequest', fallback: 'Customer request' },
  { key: 'damaged', fallback: 'Damaged item' },
  { key: 'wrongItem', fallback: 'Wrong item' },
  { key: 'other', fallback: 'Other' },
];

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseUtcDate(iso: string): Date {
  let s = iso.includes('T') ? iso : iso.replace(' ', 'T');
  if (!s.endsWith('Z') && !s.includes('+') && !s.includes('-', 10)) s += 'Z';
  return new Date(s);
}

function formatTime(iso: string): string {
  try {
    const d = parseUtcDate(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

function formatDate(iso: string): string {
  try {
    const d = parseUtcDate(iso);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  } catch {
    return '';
  }
}

function formatDateInput(value: string): string {
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}/${month}/${year}` : value;
}

const PERIOD_LABELS: Record<string, string> = { today: 'Today', week: 'This Week', month: 'This Month', all: 'All Time' };

function periodToDateRange(period: string): { from: string; to: string } {
  const today = todayISO();
  switch (period) {
    case 'week': { const d = new Date(); d.setDate(d.getDate() - 7); return { from: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, to: today }; }
    case 'month': { const d = new Date(); d.setMonth(d.getMonth() - 1); return { from: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, to: today }; }
    case 'all': return { from: '2000-01-01', to: '2099-12-31' };
    default: return { from: today, to: today };
  }
}

function formatMoney(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

function getOrderLabel(order: OrderRow): string {
  return order.order_number || order.id.substring(0, 8);
}

function paymentLabel(method: string | null | undefined): string {
  switch (method) {
    case 'CASH': return 'Cash';
    case 'CARD': return 'Card';
    case 'BLIK': return 'BLIK';
    case 'TRANSFER': return 'Transfer';
    case 'INVOICE': return 'Invoice';
    default: return 'Unknown';
  }
}

function getRefundStatus(order: OrderRow): RefundStatus {
  if (order.status === 'REFUNDED') return 'full';
  if (order.status === 'PARTIAL_REFUND') return 'partial';
  return 'none';
}

function StatusBadge({ order, t }: { order: OrderRow; t: (key: string) => string }) {
  const refundStatus = getRefundStatus(order);

  if (refundStatus === 'full') {
    return (
      <span className="inline-flex h-7 items-center rounded-full border border-red-200 bg-red-50 px-2.5 text-xs font-bold text-red-700">
        {tOr(t, 'pos.history.refunded', 'Refunded')}
      </span>
    );
  }

  if (refundStatus === 'partial') {
    return (
      <span className="inline-flex h-7 items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 text-xs font-bold text-amber-800">
        {tOr(t, 'pos.history.partialRefund', 'Partial refund')}
      </span>
    );
  }

  return (
    <span className="inline-flex h-7 items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-bold text-emerald-700">
      Completed
    </span>
  );
}

function DialogShell({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-3" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="flex h-[calc(100vh-24px)] max-h-[860px] w-[calc(100vw-24px)] max-w-[1180px] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      aria-label="Close"
      className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-200"
    >
      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  );
}

function RefundPanel({
  order,
  items,
  currency,
  t,
  onCancel,
  onComplete,
}: {
  order: OrderRow;
  items: OrderItemRow[];
  currency: string;
  t: (key: string) => string;
  onCancel: () => void;
  onComplete: () => void;
}) {
  const [refundType, setRefundType] = useState<'FULL' | 'PARTIAL'>('FULL');
  const [selectedQtys, setSelectedQtys] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState('customerRequest');
  const [customReason, setCustomReason] = useState('');
  const [confirmStep, setConfirmStep] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const alreadyRefunded = order.refund_amount ?? 0;
  const refundableItems = items.map(item => ({
    ...item,
    maxQty: item.quantity,
  }));

  const selectedRefundLines = refundableItems
    .filter(item => (selectedQtys[item.id] ?? 0) > 0)
    .map(item => ({
      variantId: item.variant_id ?? undefined,
      sku: item.sku ?? undefined,
      name: item.name,
      quantity: selectedQtys[item.id],
      unitPrice: item.price,
      refundAmount: item.price * selectedQtys[item.id],
      restock,
    }));

  const computedRefundTotal = refundType === 'FULL'
    ? order.total - alreadyRefunded
    : selectedRefundLines.reduce((sum, l) => sum + l.refundAmount, 0);

  const isValid = (refundType === 'FULL'
    ? (order.total - alreadyRefunded) > 0
    : selectedRefundLines.length > 0 && computedRefundTotal > 0)
    && (reason !== 'other' || customReason.trim().length > 0);

  const setType = (next: 'FULL' | 'PARTIAL') => {
    setRefundType(next);
    setConfirmStep(false);
    setError(null);
    if (next === 'FULL') {
      const allQtys: Record<string, number> = {};
      refundableItems.forEach(item => { allQtys[item.id] = item.maxQty; });
      setSelectedQtys(allQtys);
    } else {
      setSelectedQtys({});
    }
  };

  const setItemQty = (itemId: string, qty: number, max: number) => {
    setSelectedQtys(prev => ({ ...prev, [itemId]: Math.max(0, Math.min(qty, max)) }));
    setConfirmStep(false);
    setError(null);
  };

  const handleConfirm = async () => {
    if (!isValid || loading) return;
    if (!confirmStep) { setConfirmStep(true); return; }

    setLoading(true);
    setError(null);
    try {
      const reasonText = reason === 'other' && customReason.trim()
        ? customReason.trim()
        : translations.pl[`pos.refund.${reason}`] || tOr(t, `pos.refund.${reason}`, reason);
      let refundItems = selectedRefundLines as any[];
      if (refundType === 'FULL') {
        refundItems = refundableItems.map(item => ({
          variantId: item.variant_id ?? undefined,
          sku: item.sku ?? undefined,
          name: item.name,
          quantity: item.maxQty,
          unitPrice: item.price,
          refundAmount: item.price * item.maxQty,
          restock,
        }));
      }

      const result = await window.electronAPI.pos.orders.refund(order.id, {
        type: refundType,
        reason: reasonText,
        lines: refundItems,
      });
      if (result.success) {
        setSuccess(true);
        setTimeout(onComplete, 1500);
      } else {
        setError(result.error || 'Refund failed');
        setConfirmStep(false);
      }
    } catch (e: any) {
      setError(e.message || 'Refund failed');
      setConfirmStep(false);
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <div className="text-sm font-bold text-emerald-800">{tOr(t, 'pos.refund.success', 'Refund processed')}</div>
        <div className="mt-1 text-xs text-emerald-700">Refreshing order status...</div>
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-red-200 bg-red-50/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-extrabold text-red-900">{tOr(t, 'pos.refund.title', 'Refund Order')}</h3>
          <p className="mt-1 text-xs font-medium text-red-700">Maximum: {formatMoney(order.total - alreadyRefunded, currency)}</p>
        </div>
        <button onClick={onCancel} disabled={loading}
          className="h-10 rounded-lg border border-red-200 bg-white px-3 text-sm font-bold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-red-200">
          Cancel
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button onClick={() => setType('FULL')}
          className={`min-h-12 rounded-lg border px-3 text-left text-sm font-extrabold transition-colors focus:outline-none focus:ring-2 focus:ring-red-200 ${
            refundType === 'FULL' ? 'border-red-600 bg-red-600 text-white' : 'border-slate-300 bg-white text-slate-800 hover:border-red-300 hover:bg-red-50'
          }`}>
          <span className="block">{tOr(t, 'pos.refund.full', 'Full Refund')}</span>
          <span className="mt-0.5 block text-xs opacity-85">{formatMoney(order.total - alreadyRefunded, currency)}</span>
        </button>
        <button onClick={() => setType('PARTIAL')}
          className={`min-h-12 rounded-lg border px-3 text-left text-sm font-extrabold transition-colors focus:outline-none focus:ring-2 focus:ring-amber-200 ${
            refundType === 'PARTIAL' ? 'border-amber-500 bg-amber-500 text-white' : 'border-slate-300 bg-white text-slate-800 hover:border-amber-300 hover:bg-amber-50'
          }`}>
          <span className="block">{tOr(t, 'pos.refund.partial', 'Partial Refund')}</span>
          <span className="mt-0.5 block text-xs opacity-85">Select items</span>
        </button>
      </div>

      {refundType === 'PARTIAL' && (
        <div className="mt-4 space-y-2">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-600">Select items to refund</div>
          {refundableItems.map(item => {
            const qty = selectedQtys[item.id] ?? 0;
            return (
              <div key={item.id} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-slate-900 truncate">{item.name}</div>
                  <div className="text-xs text-slate-500">{formatMoney(item.price, currency)} x {item.maxQty}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => setItemQty(item.id, qty - 1, item.maxQty)}
                    disabled={qty <= 0}
                    className="w-8 h-8 rounded-md border border-slate-300 bg-white text-slate-700 font-bold text-lg disabled:opacity-30 hover:bg-slate-50">
                    -
                  </button>
                  <span className="w-8 text-center text-sm font-extrabold tabular-nums">{qty}</span>
                  <button onClick={() => setItemQty(item.id, qty + 1, item.maxQty)}
                    disabled={qty >= item.maxQty}
                    className="w-8 h-8 rounded-md border border-slate-300 bg-white text-slate-700 font-bold text-lg disabled:opacity-30 hover:bg-slate-50">
                    +
                  </button>
                </div>
                <div className="text-sm font-bold tabular-nums text-slate-900 w-20 text-right">
                  {qty > 0 ? formatMoney(item.price * qty, currency) : '-'}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <label className="flex items-center gap-2 cursor-pointer text-sm font-bold text-slate-700">
          <input type="checkbox" checked={restock} onChange={e => setRestock(e.target.checked)}
            className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-200" />
          Restock items to inventory
        </label>
      </div>

      <div className="mt-4">
        <label htmlFor="refund-reason" className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-600">
          {tOr(t, 'pos.refund.reason', 'Reason')}
        </label>
        <select id="refund-reason" value={reason}
          onChange={(e) => { setReason(e.target.value); setCustomReason(''); setConfirmStep(false); setError(null); }}
          className="h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100">
          {REFUND_REASONS.map((r) => (
            <option key={r.key} value={r.key}>{tOr(t, `pos.refund.${r.key}`, r.fallback)}</option>
          ))}
        </select>
      </div>

      {reason === 'other' && (
        <div className="mt-3">
          <textarea
            value={customReason}
            onChange={(e) => { setCustomReason(e.target.value); setConfirmStep(false); setError(null); }}
            placeholder={tOr(t, 'pos.refund.otherPlaceholder', 'Describe the reason...')}
            maxLength={200}
            className="min-h-[80px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
          <div className="mt-1 text-right text-xs font-medium text-slate-400">
            {customReason.length}/200
          </div>
        </div>
      )}

      {confirmStep && (
        <div className="mt-4 rounded-lg border border-red-300 bg-white px-3 py-3 text-sm font-bold text-red-800">
          {tOr(t, 'pos.refund.confirmAsk', 'Are you sure?')} This will refund {formatMoney(computedRefundTotal, currency)}
          {restock ? ' and restock items.' : ' (no restock).'}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-300 bg-white px-3 py-3 text-sm font-bold text-red-800">{error}</div>
      )}

      <button onClick={handleConfirm} disabled={!isValid || loading}
        className={`mt-4 flex min-h-12 w-full items-center justify-center rounded-lg px-4 text-sm font-extrabold transition-colors focus:outline-none focus:ring-2 focus:ring-red-200 ${
          loading ? 'cursor-not-allowed bg-slate-200 text-slate-500'
            : confirmStep ? 'bg-red-700 text-white hover:bg-red-800'
            : 'bg-red-600 text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500'
        }`}>
        {loading ? 'Processing...'
          : confirmStep ? tOr(t, 'pos.refund.confirmAsk', 'Are you sure?')
          : `${tOr(t, 'pos.refund.confirm', 'Confirm Refund')} (${formatMoney(computedRefundTotal, currency)})`}
      </button>
    </section>
  );
}

function SyncFailurePanel({
  order,
  onRetried,
  t,
}: {
  order: OrderRow;
  onRetried: () => void;
  t: (key: string) => string;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const err = order.sync_error;
  const isShelved = order.synced === -1;
  const isStockError = err ? /insufficient stock/i.test(err) : false;

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryResult(null);
    try {
      const res = await window.electronAPI.pos.orders.retrySync(order.id);
      if (res.success && res.result?.status === 'synced') {
        setRetryResult({ ok: true, msg: 'Order synced successfully' });
        setTimeout(onRetried, 400);
      } else {
        const errMsg = res.result?.error || res.error || 'Retry failed — check backend stock';
        setRetryResult({ ok: false, msg: errMsg });
      }
    } catch (e: any) {
      setRetryResult({ ok: false, msg: e.message || 'Retry failed' });
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 space-y-2">
      <div className="flex items-start gap-2">
        <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <div className="flex-1 text-sm">
          <div className="font-bold text-amber-900">
            {isShelved ? (isStockError ? 'Backend rejected: insufficient stock' : 'Sync failed') : 'Order not synced yet'}
          </div>
          {err && (
            <div className="mt-1 text-amber-800 font-medium break-words">{err}</div>
          )}
          {isStockError && (
            <div className="mt-2 text-xs text-amber-700 font-medium">
              Fix backend stock first, then click Retry. Refund/cancel unavailable until synced.
            </div>
          )}
        </div>
      </div>
      {isShelved && (
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="w-full flex items-center justify-center gap-2 rounded-md border border-amber-400 bg-white px-3 py-2 text-sm font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
        >
          {retrying ? 'Retrying...' : 'Retry sync'}
        </button>
      )}
      {retryResult && (
        <div className={`text-xs font-bold ${retryResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>
          {retryResult.msg}
        </div>
      )}
    </div>
  );
}

function ServerActionsPanel({
  order,
  t,
  onOrderUpdated,
  isServerOnly = false,
}: {
  order: OrderRow & { customer_nip?: string | null };
  t: (key: string) => string;
  onOrderUpdated: () => void;
  isServerOnly?: boolean;
}) {
  const [nip, setNip] = useState((order as any).customer_nip || '');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'ok' | 'error'; message: string } | null>(null);
  const [gusPreview, setGusPreview] = useState<{ name?: string; address?: string } | null>(null);

  const hasInvoice = Boolean((order as any).customer_nip);
  const kind: 'receipt' | 'invoice' = hasInvoice ? 'invoice' : 'receipt';

  const run = async (key: string, fn: () => Promise<{ success: boolean; error?: string; message?: string }>) => {
    if (busy) return;
    setBusy(key);
    setStatus(null);
    try {
      const res = await fn();
      if (res.success) {
        setStatus({ type: 'ok', message: res.message || tOr(t, 'pos.history.server.ok', 'Done') });
      } else {
        setStatus({ type: 'error', message: res.error || 'Failed' });
      }
    } catch (e: any) {
      setStatus({ type: 'error', message: e?.message || 'Failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleDownload = () =>
    run('download', async () => {
      const res = await window.electronAPI.pos.orders.downloadPdf(order.id, kind, 'VAT');
      return res.success
        ? { success: true, message: tOr(t, 'pos.history.server.pdfSaved', 'PDF saved') }
        : { success: false, error: res.error };
    });

  const handleLookupNip = () =>
    run('nip', async () => {
      const res = await window.electronAPI.pos.customers.lookupNip(nip);
      if (!res.success) return { success: false, error: res.error };
      const gus = res.data?.gusData || res.data?.customer || null;
      if (gus) setGusPreview({ name: gus.name, address: gus.address });
      return { success: true, message: tOr(t, 'pos.history.server.nipFound', 'Company found') };
    });

  const handleAddInvoice = () =>
    run('invoice', async () => {
      const res = await window.electronAPI.pos.orders.addInvoice(order.id, { customerNip: nip, invoiceType: 'VAT' });
      if (res.success) onOrderUpdated();
      return res.success
        ? { success: true, message: tOr(t, 'pos.history.server.invoiceAdded', 'Invoice attached') }
        : { success: false, error: res.error };
    });

  const handleProforma = () =>
    run('proforma', async () => {
      const res = await window.electronAPI.pos.orders.generateProforma(order.id);
      if (res.success) onOrderUpdated();
      return res.success
        ? { success: true, message: tOr(t, 'pos.history.server.proformaOk', 'Proforma generated') }
        : { success: false, error: res.error };
    });

  const nipDigits = nip.replace(/\D/g, '');
  const nipValid = nipDigits.length === 10;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-extrabold text-slate-900">{tOr(t, 'pos.history.server.title', 'Server documents')}</h3>
      <p className="mt-1 text-xs font-medium text-slate-500">
        {tOr(t, 'pos.history.server.subtitle', 'Actions performed on the server for this order.')}
      </p>

      {isServerOnly && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-bold text-amber-800">
          {tOr(t, 'pos.history.serverOnlyExplain', 'This order was created on another device. Open the eNail dashboard to refund, cancel, or print.')}
        </div>
      )}

      <button
        onClick={handleDownload}
        disabled={busy !== null || isServerOnly}
        className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-800 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand-200"
      >
        {busy === 'download' ? '...' : tOr(t, hasInvoice ? 'pos.history.server.downloadInvoice' : 'pos.history.server.downloadReceipt', hasInvoice ? 'Download Invoice PDF' : 'Download Receipt PDF')}
      </button>

      {!hasInvoice && (
        <div className="mt-4 border-t border-slate-200 pt-3">
          <label className="block text-xs font-bold uppercase tracking-wide text-slate-500">
            {tOr(t, 'pos.history.server.nipLabel', 'Add VAT invoice (NIP)')}
          </label>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={nip}
              onChange={(e) => { setNip(e.target.value); setGusPreview(null); }}
              placeholder="10 digits"
              className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
            <button
              onClick={handleLookupNip}
              disabled={!nipValid || busy !== null || isServerOnly}
              className="h-11 shrink-0 rounded-lg border border-slate-300 bg-slate-50 px-3 text-xs font-extrabold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'nip' ? '...' : 'GUS'}
            </button>
          </div>

          {gusPreview && (
            <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              <div className="font-bold text-slate-900">{gusPreview.name}</div>
              {gusPreview.address && <div>{gusPreview.address}</div>}
            </div>
          )}

          <button
            onClick={handleAddInvoice}
            disabled={!nipValid || busy !== null || isServerOnly}
            className="mt-3 flex min-h-11 w-full items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-extrabold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
          >
            {busy === 'invoice' ? '...' : tOr(t, 'pos.history.server.attachInvoice', 'Attach invoice')}
          </button>
        </div>
      )}

      <button
        onClick={handleProforma}
        disabled={busy !== null || isServerOnly}
        className="mt-3 flex min-h-11 w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-800 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand-200"
      >
        {busy === 'proforma' ? '...' : tOr(t, 'pos.history.server.proforma', 'Generate Proforma')}
      </button>

      {status && (
        <div
          className={`mt-3 rounded-lg border px-3 py-2 text-xs font-bold ${
            status.type === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {status.message}
        </div>
      )}
    </section>
  );
}

export default function OrderHistoryModal({ onClose, t }: OrderHistoryModalProps) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [totalOrders, setTotalOrders] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<'today' | 'week' | 'month' | 'all'>('today');
  const [filterMethod, setFilterMethod] = useState('');
  const [filterStaff, setFilterStaff] = useState('');
  const [detail, setDetail] = useState<{ order: OrderRow; items: OrderItemRow[] } | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [reprintStatus, setReprintStatus] = useState<ReprintStatus>(null);
  const [reprinting, setReprinting] = useState(false);
  const [showRefund, setShowRefund] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [dataSource, setDataSource] = useState<'local+server' | 'local-only' | 'server-unreachable'>('local-only');
  const [serverItemsMap, setServerItemsMap] = useState<Record<string, OrderItemRow[]>>({});

  const currency = tOr(t, 'pos.currency', 'zl');
  const totalPages = Math.max(1, Math.ceil(totalOrders / PAGE_SIZE));
  const hasActiveFilters = selectedPeriod !== 'today' || filterMethod !== '' || filterStaff !== '';

  const staffNames = useMemo(
    () => Array.from(new Set(orders.map((o) => o.staff_name).filter((name): name is string => Boolean(name)))).sort(),
    [orders],
  );
  const pageTotal = useMemo(() => orders.reduce((sum, o) => sum + o.total, 0), [orders]);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    const { from, to } = periodToDateRange(selectedPeriod);

    const [localResult, serverResult] = await Promise.allSettled([
      window.electronAPI.pos.orders.getHistory({ from, to, page, limit: PAGE_SIZE,
        paymentMethod: filterMethod || undefined, staffName: filterStaff || undefined }),
      window.electronAPI.pos.orders.getServerList({ period: selectedPeriod, page, limit: PAGE_SIZE }),
    ]);

    let merged: OrderRow[] = [];
    let total = 0;
    let source: 'local+server' | 'local-only' | 'server-unreachable' = 'local-only';
    let newItemsMap: Record<string, OrderItemRow[]> = {};

    if (serverResult.status === 'fulfilled') {
      const sr = serverResult.value;
      if (sr.source === 'server') {
        merged = [...sr.orders];
        total = sr.total;
        newItemsMap = sr.items || {};
        source = 'local+server';
      } else if (sr.source === 'network-error') {
        source = 'server-unreachable';
      }
    } else {
      source = 'server-unreachable';
    }

    if (localResult.status === 'fulfilled') {
      const localOrders: OrderRow[] = localResult.value?.orders || [];
      if (source === 'local+server') {
        const localIds = new Set(localOrders.map((lo) => lo.id));
        const localBackendIds = new Set(
          localOrders.map((lo) => lo.backend_id).filter((v): v is string => Boolean(v))
        );
        merged = merged.filter(
          (s) => !localIds.has(s.id) && !localBackendIds.has(s.id)
        );
        for (const lo of localOrders) merged.push(lo);
      } else {
        merged = localOrders;
        total = localResult.value?.total || localOrders.length;
      }
    }

    merged = merged.filter((o) => o.status !== 'DRAFT' && o.status !== 'POS-DRA');
    if (filterMethod) merged = merged.filter((o) => o.payment_method === filterMethod);
    if (filterStaff) merged = merged.filter((o) => o.staff_name === filterStaff);
    merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    setOrders(merged);
    setTotalOrders(total);
    setServerItemsMap(newItemsMap);
    setDataSource(source);
    setLoading(false);
  }, [selectedPeriod, filterMethod, filterStaff, page]);

  useEffect(() => { loadOrders(); }, [loadOrders]);
  useEffect(() => { setPage(1); }, [selectedPeriod, filterMethod, filterStaff]);

  useEffect(() => {
    const unsubSynced = window.electronAPI.pos.sync.onOrderSynced?.((data) => {
      loadOrders();
      if (detail && detail.order.id === data.orderId) {
        window.electronAPI.pos.orders.getDetail(data.orderId).then((result) => {
          if (result) setDetail(result);
        });
      }
    });
    const unsubFailed = window.electronAPI.pos.sync.onOrderSyncFailed?.((data) => {
      loadOrders();
      if (detail && detail.order.id === data.orderId) {
        window.electronAPI.pos.orders.getDetail(data.orderId).then((result) => {
          if (result) setDetail(result);
        });
      }
    });
    return () => { unsubSynced?.(); unsubFailed?.(); };
  }, [detail, loadOrders]);

  const handleSelectOrder = async (orderId: string) => {
    setDetailLoadingId(orderId);
    setReprintStatus(null);
    try {
      if (serverItemsMap[orderId] && serverItemsMap[orderId].length > 0) {
        const order = orders.find((o) => o.id === orderId);
        if (order) {
          setDetail({ order, items: serverItemsMap[orderId] });
          setShowRefund(false);
          return;
        }
      }
      const result = await window.electronAPI.pos.orders.getDetail(orderId);
      if (result) {
        setDetail(result);
        setShowRefund(false);
      }
    } finally {
      setDetailLoadingId(null);
    }
  };

  const handleReprint = async (orderId: string, order: OrderRow) => {
    if (reprinting) return;
    setReprinting(true);
    setReprintStatus(null);
    try {
      const isRefunded = order.status === 'REFUNDED' || order.status === 'PARTIAL_REFUND';
      const result = isRefunded
        ? await window.electronAPI.pos.payment.printRefundReceipt(orderId)
        : await window.electronAPI.pos.payment.reprintReceipt(orderId);
      if (result?.success && result.receiptPrinted !== false) {
        setReprintStatus({ type: 'ok', message: tOr(t, 'pos.history.reprinted', 'Receipt sent to printer') });
      } else {
        setReprintStatus({
          type: 'error',
          message: result?.error || tOr(t, 'pos.history.reprintFailed', 'Printer not connected'),
        });
      }
    } catch (e: any) {
      setReprintStatus({
        type: 'error',
        message: e?.message || tOr(t, 'pos.history.reprintFailed', 'Printer not connected'),
      });
    } finally {
      setReprinting(false);
    }
  };

  const resetFilters = () => {
    setSelectedPeriod('today');
    setFilterMethod('');
    setFilterStaff('');
    setPage(1);
  };

  if (detail) {
    const { order, items } = detail;
    const refundStatus = getRefundStatus(order);
    const isServerOnly = order._origin === 'server';
    const canRefund = Boolean(order.backend_id) && refundStatus === 'none' && !isServerOnly;
    const notSynced = !order.backend_id && order.synced !== 1;

    return (
      <DialogShell onClose={onClose}>
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => { setDetail(null); setShowRefund(false); setReprintStatus(null); }}
              className="flex h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-extrabold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-200"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M15 19l-7-7 7-7" />
              </svg>
              {tOr(t, 'pos.history.title', 'History')}
            </button>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-xl font-extrabold text-slate-950">{getOrderLabel(order)}</h2>
                <StatusBadge order={order} t={t} />
              </div>
              <p className="mt-1 text-sm font-medium text-slate-500">
                {formatDate(order.created_at)} {formatTime(order.created_at)} - {(() => {
                  try { const t2 = order.payment_tenders ? JSON.parse(order.payment_tenders) : null; if (Array.isArray(t2) && t2.length > 1) return 'Split'; } catch {}
                  return paymentLabel(order.payment_method);
                })()}
                {order.staff_name ? ` - ${order.staff_name}` : ''}
              </p>
            </div>
          </div>
          <CloseButton onClose={onClose} />
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] overflow-hidden bg-slate-50">
          <main className="min-h-0 overflow-y-auto p-5">
            <div className="grid grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Total</div>
                <div className={`mt-2 text-2xl font-extrabold tabular-nums ${(order.refund_amount ?? 0) > 0 ? 'text-amber-700' : 'text-slate-950'}`}>{formatMoney(order.total - (order.refund_amount ?? 0), currency)}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Paid</div>
                <div className="mt-2 text-xl font-extrabold tabular-nums text-slate-950">{formatMoney(order.payment_amount, currency)}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Tax</div>
                <div className="mt-2 text-xl font-extrabold tabular-nums text-slate-950">{formatMoney(order.tax, currency)}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Staff</div>
                <div className="mt-2 truncate text-xl font-extrabold text-slate-950">{order.staff_name || '-'}</div>
              </div>
            </div>

            <section className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
                <h3 className="text-sm font-extrabold text-slate-900">Items</h3>
                <span className="text-xs font-bold text-slate-500">{items.length} rows</span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_76px_108px_112px] gap-3 border-b border-slate-200 bg-white px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <span>Product</span>
                <span className="text-right">Qty</span>
                <span className="text-right">VAT</span>
                <span className="text-right">Total</span>
              </div>
              <div className="divide-y divide-slate-100">
                {items.map((item) => (
                  <div key={item.id} className="grid min-h-14 grid-cols-[minmax(0,1fr)_76px_108px_112px] items-center gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold text-slate-950">{item.name}</div>
                      <div className="mt-0.5 truncate text-xs font-medium text-slate-500">{item.sku || 'No SKU'} - {formatMoney(item.price, currency)}</div>
                    </div>
                    <div className="text-right text-sm font-bold tabular-nums text-slate-700">{item.quantity}</div>
                    <div className="text-right text-sm font-bold tabular-nums text-slate-700">{item.vat_rate}%</div>
                    <div className="text-right text-sm font-extrabold tabular-nums text-slate-950">{formatMoney(item.total, currency)}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-extrabold text-slate-900">Payment and totals</h3>
              <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="font-medium text-slate-500">{tOr(t, 'pos.cart.subtotal', 'Subtotal')}</span>
                  <span className="font-bold tabular-nums text-slate-900">{formatMoney(order.subtotal, currency)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="font-medium text-slate-500">{tOr(t, 'pos.cart.inclVat', 'Incl. VAT')}</span>
                  <span className="font-bold tabular-nums text-slate-900">{formatMoney(order.tax, currency)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="font-medium text-slate-500">{tOr(t, 'pos.cart.discount', 'Discount')}</span>
                  <span className="font-bold tabular-nums text-emerald-700">
                    {order.discount > 0 ? `-${formatMoney(order.discount, currency)}` : formatMoney(0, currency)}
                  </span>
                </div>
                {(() => {
                  let tenders: Array<{ method: string; amount: number }> | null = null;
                  try { if (order.payment_tenders) tenders = JSON.parse(order.payment_tenders); } catch {}
                  if (tenders && tenders.length > 1) {
                    return (
                      <div className="space-y-1">
                        <span className="font-medium text-slate-500">Payment split</span>
                        {tenders.map((t, i) => (
                          <div key={i} className="flex justify-between gap-4 pl-2">
                            <span className="text-slate-600">{paymentLabel(t.method)}</span>
                            <span className="font-bold tabular-nums text-slate-900">{formatMoney(t.amount, currency)}</span>
                          </div>
                        ))}
                      </div>
                    );
                  }
                  return (
                    <div className="flex justify-between gap-4">
                      <span className="font-medium text-slate-500">Method</span>
                      <span className="font-bold text-slate-900">{paymentLabel(order.payment_method)}</span>
                    </div>
                  );
                })()}
                <div className="flex justify-between gap-4">
                  <span className="font-medium text-slate-500">Paid amount</span>
                  <span className="font-bold tabular-nums text-slate-900">{formatMoney(order.payment_amount, currency)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="font-medium text-slate-500">Change</span>
                  <span className="font-bold tabular-nums text-slate-900">{formatMoney(order.change_amount, currency)}</span>
                </div>
                {(order.refund_amount ?? 0) > 0 && (
                  <>
                    <div className="flex justify-between gap-4">
                      <span className="font-medium text-red-700">{tOr(t, 'pos.history.refunded', 'Refunded')}</span>
                      <span className="font-bold tabular-nums text-red-700">-{formatMoney(order.refund_amount ?? 0, currency)}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="font-medium text-slate-500">{tOr(t, 'pos.refund.reason', 'Reason')}</span>
                      <span className="truncate font-bold text-slate-900">{order.refund_reason || '-'}</span>
                    </div>
                  </>
                )}
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-3">
                <span className="text-base font-extrabold text-slate-950">{tOr(t, 'pos.cart.total', 'Total')}</span>
                <span className={`text-2xl font-extrabold tabular-nums ${(order.refund_amount ?? 0) > 0 ? 'text-amber-700' : 'text-brand-700'}`}>{formatMoney(order.total - (order.refund_amount ?? 0), currency)}</span>
              </div>
            </section>
          </main>

          <aside className="flex min-h-0 flex-col border-l border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Operations</div>
              <div className="mt-1 text-lg font-extrabold text-slate-950">Receipt and refund</div>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              {showRefund && canRefund && (
                <RefundPanel
                  order={order}
                  items={items}
                  currency={currency}
                  t={t}
                  onCancel={() => setShowRefund(false)}
                  onComplete={() => {
                    setShowRefund(false);
                    handleSelectOrder(order.id);
                    loadOrders();
                  }}
                />
              )}

              <section className="rounded-lg border border-slate-200 bg-white p-4">
                <h3 className="text-sm font-extrabold text-slate-900">Receipt</h3>
                <p className="mt-1 text-xs font-medium text-slate-500">Send this order receipt to the configured printer.</p>
                <button
                  onClick={() => handleReprint(order.id, order)}
                  disabled={reprinting || isServerOnly}
                  title={isServerOnly ? tOr(t, 'pos.history.serverOnlyTooltip', 'Created on another device — open dashboard') : undefined}
                  className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-slate-900 px-4 text-sm font-extrabold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-200 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
                >
                  {reprinting && (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
                  )}
                  {reprinting ? 'Sending...' : tOr(t, 'pos.history.reprint', 'Reprint Receipt')}
                </button>

                {reprintStatus && (
                  <div
                    className={`mt-3 rounded-lg border px-3 py-3 text-sm font-bold ${
                      reprintStatus.type === 'ok'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-red-200 bg-red-50 text-red-800'
                    }`}
                  >
                    {reprintStatus.message}
                  </div>
                )}
              </section>

              <section className="rounded-lg border border-slate-200 bg-white p-4">
                <h3 className="text-sm font-extrabold text-slate-900">Refund availability</h3>
                <div className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="font-medium text-slate-500">Backend sync</span>
                    <span className={`font-bold ${order.backend_id ? 'text-emerald-700' : 'text-amber-800'}`}>
                      {order.backend_id ? 'Ready' : 'Not ready'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="font-medium text-slate-500">Refund status</span>
                    <span className="font-bold text-slate-900">
                      {refundStatus === 'none'
                        ? canRefund ? 'Available' : 'Blocked'
                        : refundStatus === 'full'
                          ? tOr(t, 'pos.history.refunded', 'Refunded')
                          : tOr(t, 'pos.history.partialRefund', 'Partial refund')}
                    </span>
                  </div>
                </div>
              </section>

              {canRefund && !showRefund && (
                <button
                  onClick={() => setShowRefund(true)}
                  className="flex min-h-12 w-full items-center justify-center rounded-lg border border-red-300 bg-red-50 px-4 text-sm font-extrabold text-red-700 transition-colors hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-200"
                >
                  {tOr(t, 'pos.refund.title', 'Refund Order')}
                </button>
              )}

              {order.backend_id && order.status !== 'CANCELLED' && refundStatus === 'none' && !showRefund && !isServerOnly && (
                <button
                  disabled={cancelling}
                  onClick={async () => {
                    if (!confirm(tOr(t, 'pos.history.cancelConfirm', 'Cancel this order? This cannot be undone.'))) return;
                    setCancelling(true);
                    try {
                      const res = await window.electronAPI.pos.orders.cancel(order.id);
                      if (res.success) { handleSelectOrder(order.id); loadOrders(); }
                      else { alert(res.error || 'Cancel failed'); }
                    } catch (err: any) { alert(err.message); }
                    finally { setCancelling(false); }
                  }}
                  className="flex min-h-10 w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-4 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-200 disabled:opacity-50"
                >
                  {cancelling ? 'Cancelling...' : tOr(t, 'pos.history.cancelOrder', 'Cancel Order')}
                </button>
              )}

              {notSynced && (
                <SyncFailurePanel
                  order={order}
                  onRetried={() => { handleSelectOrder(order.id); loadOrders(); }}
                  t={t}
                />
              )}

              {refundStatus !== 'none' && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700">
                  {tOr(t, 'pos.refund.alreadyRefunded', 'Already refunded')}
                </div>
              )}

              {order.backend_id && (
                <ServerActionsPanel
                  order={order as any}
                  t={t}
                  onOrderUpdated={() => { handleSelectOrder(order.id); loadOrders(); }}
                  isServerOnly={isServerOnly}
                />
              )}

            </div>
          </aside>
        </div>
      </DialogShell>
    );
  }

  return (
    <DialogShell onClose={onClose}>
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-extrabold text-slate-950">{tOr(t, 'pos.history.title', 'Order History')}</h2>
          <p className="mt-1 text-sm font-medium text-slate-500">
            {PERIOD_LABELS[selectedPeriod] || 'Today'} — {totalOrders} {tOr(t, 'pos.history.orders', 'orders')} — page total {formatMoney(pageTotal, currency)}
            <span className={`ml-2 inline-flex items-center gap-1 text-xs font-bold ${dataSource === 'local+server' ? 'text-emerald-600' : dataSource === 'server-unreachable' ? 'text-amber-600' : 'text-slate-400'}`}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
              {dataSource === 'local+server' ? 'Local + Server' : dataSource === 'server-unreachable' ? 'Server unreachable — showing local data' : 'Local only (offline)'}
            </span>
          </p>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      <div className="shrink-0 border-b border-slate-200 bg-slate-50 px-5 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[168px] flex-1 text-xs font-bold uppercase tracking-wide text-slate-600">
            Period
            <select
              value={selectedPeriod}
              onChange={(e) => setSelectedPeriod(e.target.value as 'today' | 'week' | 'month' | 'all')}
              className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="today">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="all">All Time</option>
            </select>
          </label>

          <label className="min-w-[184px] flex-1 text-xs font-bold uppercase tracking-wide text-slate-600">
            Payment
            <select
              value={filterMethod}
              onChange={(e) => setFilterMethod(e.target.value)}
              className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="">{tOr(t, 'pos.history.allMethods', 'All Methods')}</option>
              {PAYMENT_METHODS.map((method) => (
                <option key={method.value} value={method.value}>{method.label}</option>
              ))}
            </select>
          </label>

          <label className="min-w-[184px] flex-1 text-xs font-bold uppercase tracking-wide text-slate-600">
            Staff
            <select
              value={filterStaff}
              onChange={(e) => setFilterStaff(e.target.value)}
              disabled={staffNames.length === 0}
              className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-900 shadow-sm disabled:bg-slate-100 disabled:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="">{tOr(t, 'pos.history.allStaff', 'All Staff')}</option>
              {staffNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>

          <button
            onClick={resetFilters}
            disabled={!hasActiveFilters}
            className="h-11 min-w-[112px] rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col bg-white">
        <div className="grid h-11 shrink-0 grid-cols-[minmax(150px,1.15fr)_90px_120px_130px_minmax(120px,1fr)_120px_44px] items-center gap-3 border-b border-slate-200 bg-slate-100 px-5 text-xs font-extrabold uppercase tracking-wide text-slate-600">
          <span>Order</span>
          <span>Time</span>
          <span className="text-right">Total</span>
          <span>Payment</span>
          <span>Staff</span>
          <span>Status</span>
          <span />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full min-h-[260px] items-center justify-center">
              <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-600 shadow-sm">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" aria-hidden="true" />
                Loading orders...
              </div>
            </div>
          ) : loadError ? (
            <div className="flex h-full min-h-[260px] items-center justify-center px-6 text-center">
              <div className="rounded-lg border border-red-200 bg-red-50 px-5 py-4 text-sm font-bold text-red-800">
                {loadError}
              </div>
            </div>
          ) : orders.length === 0 ? (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center px-6 text-center">
              <div className="text-base font-extrabold text-slate-900">{tOr(t, 'pos.history.noOrders', 'No orders found')}</div>
              <div className="mt-1 text-sm font-medium text-slate-500">Adjust the date, payment method, or staff filter.</div>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {orders.map((order) => {
                const refundStatus = getRefundStatus(order);
                return (
                  <button
                    key={order.id}
                    onClick={() => handleSelectOrder(order.id)}
                    className="grid min-h-[64px] w-full grid-cols-[minmax(150px,1.15fr)_90px_120px_130px_minmax(120px,1fr)_120px_44px] items-center gap-3 px-5 text-left transition-colors hover:bg-brand-50 focus:bg-brand-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-300"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-extrabold text-slate-950">{getOrderLabel(order)}</span>
                      <span className="mt-0.5 block truncate text-xs font-medium text-slate-500">{formatDate(order.created_at)}</span>
                    </span>
                    <span className="text-sm font-bold tabular-nums text-slate-700">{formatTime(order.created_at)}</span>
                    <span className={`text-right text-base font-extrabold tabular-nums ${refundStatus === 'none' ? 'text-slate-950' : 'text-slate-500 line-through'}`}>
                      {formatMoney(order.total, currency)}
                    </span>
                    <span className="inline-flex h-8 max-w-full items-center justify-center truncate rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-extrabold text-slate-700">
                      {(() => {
                        try {
                          const t2 = order.payment_tenders ? JSON.parse(order.payment_tenders) : null;
                          if (Array.isArray(t2) && t2.length > 1) return 'Split';
                        } catch {}
                        return paymentLabel(order.payment_method);
                      })()}
                    </span>
                    <span className="truncate text-sm font-bold text-slate-700">{order.staff_name || '-'}</span>
                    <StatusBadge order={order} t={t} />
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400">
                      {detailLoadingId === order.id ? (
                        <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" aria-hidden="true" />
                      ) : (
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 5l7 7-7 7" />
                        </svg>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <div className="text-sm font-bold text-slate-600">
            {totalOrders} {tOr(t, 'pos.history.orders', 'orders')} - {formatMoney(pageTotal, currency)} on this page
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="h-11 min-w-[84px] rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
            >
              Prev
            </button>
            <span className="min-w-[88px] text-center text-sm font-extrabold tabular-nums text-slate-700">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="h-11 min-w-[84px] rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </DialogShell>
  );
}
