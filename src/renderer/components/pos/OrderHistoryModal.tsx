import React, { useState, useEffect, useCallback } from 'react';

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
}

interface OrderItemRow {
  id: string;
  order_id: string;
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

const PAYMENT_ICONS: Record<string, string> = {
  CASH: '\u{1F4B5}',
  CARD: '\u{1F4B3}',
  BLIK: '\u{1F4F1}',
  TRANSFER: '\u{1F3E6}',
  INVOICE: '\u{1F4C4}',
};

const PAGE_SIZE = 20;

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
  } catch { return ''; }
}

function formatDate(iso: string): string {
  try {
    const d = parseUtcDate(iso);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  } catch { return ''; }
}

// ─── Refund status helpers ──────────────────────────────────

function getRefundStatus(order: OrderRow): 'none' | 'full' | 'partial' {
  if (order.status === 'REFUNDED') return 'full';
  if (order.status === 'PARTIAL_REFUND') return 'partial';
  return 'none';
}

function RefundBadge({ status, t }: { status: 'full' | 'partial'; t: (k: string) => string }) {
  const isFull = status === 'full';
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
      isFull ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'
    }`}>
      {isFull ? (t('pos.history.refunded') || 'Refunded') : (t('pos.history.partialRefund') || 'Partial')}
    </span>
  );
}

// ─── Refund Panel (inline in detail view) ───────────────────

const REFUND_REASONS = [
  { key: 'customerRequest', fallback: 'Customer request' },
  { key: 'damaged', fallback: 'Damaged item' },
  { key: 'wrongItem', fallback: 'Wrong item' },
  { key: 'other', fallback: 'Other' },
];

function RefundPanel({ order, currency, t, onComplete }: {
  order: OrderRow;
  currency: string;
  t: (k: string) => string;
  onComplete: () => void;
}) {
  const [refundType, setRefundType] = useState<'FULL' | 'PARTIAL'>('FULL');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('customerRequest');
  const [confirmStep, setConfirmStep] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const maxAmount = order.total / 100;
  const parsedAmount = parseFloat(amount || '0');
  const refundAmount = refundType === 'FULL' ? order.total : Math.round(parsedAmount * 100);
  const isValid = refundType === 'FULL' || (parsedAmount > 0 && parsedAmount <= maxAmount);

  const handleConfirm = async () => {
    if (!confirmStep) {
      setConfirmStep(true);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const reasonText = t(`pos.refund.${reason}`) || reason;
      const result = await window.electronAPI.pos.orders.refund(order.id, {
        type: refundType,
        amount: refundType === 'PARTIAL' ? refundAmount : undefined,
        reason: reasonText,
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
      <div className="px-5 py-4 bg-emerald-50 border-t border-emerald-100">
        <p className="text-sm text-emerald-600 font-medium text-center">
          {t('pos.refund.success') || 'Refund processed'}
        </p>
      </div>
    );
  }

  return (
    <div className="px-5 py-4 bg-slate-50 border-t border-gray-200 space-y-3">
      <p className="text-sm font-semibold text-gray-700">{t('pos.refund.title') || 'Refund Order'}</p>

      {/* Refund type toggle */}
      <div className="flex gap-2">
        <button
          onClick={() => { setRefundType('FULL'); setConfirmStep(false); }}
          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
            refundType === 'FULL'
              ? 'bg-red-500 text-white'
              : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
          }`}
        >
          {t('pos.refund.full') || 'Full Refund'}
          <br />
          <span className="text-[10px] opacity-80">{(order.total / 100).toFixed(2)} {currency}</span>
        </button>
        <button
          onClick={() => { setRefundType('PARTIAL'); setConfirmStep(false); }}
          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
            refundType === 'PARTIAL'
              ? 'bg-amber-500 text-white'
              : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
          }`}
        >
          {t('pos.refund.partial') || 'Partial Refund'}
        </button>
      </div>

      {/* Partial amount input */}
      {refundType === 'PARTIAL' && (
        <div>
          <label className="text-xs text-gray-500 mb-1 block">{t('pos.refund.amount') || 'Refund amount'} ({currency})</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max={maxAmount}
            value={amount}
            onChange={e => { setAmount(e.target.value); setConfirmStep(false); }}
            placeholder={`max ${maxAmount.toFixed(2)}`}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-brand-400"
          />
        </div>
      )}

      {/* Reason selector */}
      <div>
        <label className="text-xs text-gray-500 mb-1 block">{t('pos.refund.reason') || 'Reason'}</label>
        <select
          value={reason}
          onChange={e => { setReason(e.target.value); setConfirmStep(false); }}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-brand-400 cursor-pointer"
        >
          {REFUND_REASONS.map(r => (
            <option key={r.key} value={r.key}>{t(`pos.refund.${r.key}`) || r.fallback}</option>
          ))}
        </select>
      </div>

      {/* Error */}
      {error && <p className="text-xs text-red-500">{error}</p>}

      {/* Confirm button (2-step) */}
      <button
        onClick={handleConfirm}
        disabled={!isValid || loading}
        className={`w-full py-3 rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${
          loading ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
          : confirmStep ? 'bg-red-600 hover:bg-red-700 text-white cursor-pointer'
          : 'bg-red-500 hover:bg-red-600 text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'
        }`}
      >
        {loading ? (
          <>
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
            Processing...
          </>
        ) : confirmStep ? (
          t('pos.refund.confirmAsk') || 'Are you sure?'
        ) : (
          <>
            {t('pos.refund.confirm') || 'Confirm Refund'}
            {refundType === 'PARTIAL' && isValid && ` (${parsedAmount.toFixed(2)} ${currency})`}
          </>
        )}
      </button>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

export default function OrderHistoryModal({ onClose, t }: OrderHistoryModalProps) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [totalOrders, setTotalOrders] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(todayISO());
  const [filterMethod, setFilterMethod] = useState('');
  const [filterStaff, setFilterStaff] = useState('');
  const [detail, setDetail] = useState<{ order: OrderRow; items: OrderItemRow[] } | null>(null);
  const [reprintStatus, setReprintStatus] = useState<string | null>(null);
  const [showRefund, setShowRefund] = useState(false);

  const currency = t('pos.currency') || 'zl';
  const totalPages = Math.max(1, Math.ceil(totalOrders / PAGE_SIZE));

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.pos.orders.getHistory({
        from: selectedDate,
        to: selectedDate,
        paymentMethod: filterMethod || undefined,
        staffName: filterStaff || undefined,
        page,
        limit: PAGE_SIZE,
      });
      setOrders(result?.orders || []);
      setTotalOrders(result?.total || 0);
    } catch {
      setOrders([]);
      setTotalOrders(0);
    } finally {
      setLoading(false);
    }
  }, [selectedDate, filterMethod, filterStaff, page]);

  useEffect(() => { loadOrders(); }, [loadOrders]);
  useEffect(() => { setPage(1); }, [selectedDate, filterMethod, filterStaff]);

  const handleSelectOrder = async (orderId: string) => {
    const result = await window.electronAPI.pos.orders.getDetail(orderId);
    if (result) {
      setDetail(result);
      setShowRefund(false);
    }
  };

  const [reprinting, setReprinting] = useState(false);
  const handleReprint = async (orderId: string) => {
    if (reprinting) return;
    setReprinting(true);
    setReprintStatus(null);
    try {
      await window.electronAPI.pos.payment.reprintReceipt(orderId);
      setReprintStatus('ok');
    } catch {
      setReprintStatus('error');
    }
    setReprinting(false);
    setTimeout(() => setReprintStatus(null), 3000);
  };

  const staffNames = [...new Set(orders.map(o => o.staff_name).filter(Boolean))];
  const pageTotal = orders.reduce((sum, o) => sum + o.total, 0);

  // ─── Detail view ──────────────────────────────────────────
  if (detail) {
    const { order, items } = detail;
    const refundStatus = getRefundStatus(order);
    const canRefund = order.backend_id && refundStatus === 'none';
    const notSynced = !order.backend_id && order.synced !== 1;

    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-8 bg-black/50" onClick={onClose}>
        <div className="bg-white rounded-2xl w-full max-w-md mx-4 shadow-2xl border border-gray-200" onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
            <button onClick={() => { setDetail(null); setShowRefund(false); }} className="text-sm text-brand-500 hover:text-brand-600 font-medium cursor-pointer flex items-center gap-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              {t('pos.history.title') || 'History'}
            </button>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-gray-900">{order.order_number || order.id.substring(0, 8)}</span>
              {refundStatus !== 'none' && <RefundBadge status={refundStatus} t={t} />}
            </div>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 cursor-pointer">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          {/* Order meta */}
          <div className="px-5 py-3 text-sm text-gray-500 flex items-center gap-2 flex-wrap">
            <span>{formatDate(order.created_at)} {formatTime(order.created_at)}</span>
            <span>{PAYMENT_ICONS[order.payment_method || ''] || ''} {order.payment_method}</span>
            {order.staff_name && <span>· {order.staff_name}</span>}
          </div>

          {/* Items */}
          <div className="px-5 pb-3 space-y-2">
            {items.map(item => (
              <div key={item.id} className="flex justify-between text-sm">
                <span className="text-gray-700">{item.name} <span className="text-gray-400">x{item.quantity}</span></span>
                <span className="text-gray-900 font-medium">{(item.total / 100).toFixed(2)} {currency}</span>
              </div>
            ))}

            <div className="border-t border-gray-100 pt-2 mt-2 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">{t('pos.cart.subtotal') || 'Subtotal'}</span>
                <span className="text-gray-600">{(order.subtotal / 100).toFixed(2)} {currency}</span>
              </div>
              {order.tax > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">{t('pos.cart.inclVat') || 'Incl. VAT'}</span>
                  <span className="text-gray-400">{(order.tax / 100).toFixed(2)} {currency}</span>
                </div>
              )}
              {order.discount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-emerald-500">{t('pos.cart.discount') || 'Discount'}</span>
                  <span className="text-emerald-500">-{(order.discount / 100).toFixed(2)} {currency}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold pt-1">
                <span className="text-gray-900">{t('pos.cart.total') || 'Total'}</span>
                <span className="text-brand-500">{(order.total / 100).toFixed(2)} {currency}</span>
              </div>
              {order.payment_method === 'CASH' && order.change_amount > 0 && (
                <div className="flex justify-between text-xs text-gray-400">
                  <span>Change</span>
                  <span>{(order.change_amount / 100).toFixed(2)} {currency}</span>
                </div>
              )}
              {/* Refund amount (if refunded) */}
              {(order.refund_amount ?? 0) > 0 && (
                <div className="flex justify-between text-sm text-red-500 pt-1">
                  <span>{t('pos.history.refunded') || 'Refunded'}</span>
                  <span>-{((order.refund_amount ?? 0) / 100).toFixed(2)} {currency}</span>
                </div>
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div className="px-5 pb-3 flex gap-2">
            <button
              onClick={() => handleReprint(order.id)}
              disabled={reprinting}
              className={`flex-1 py-3 rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                reprinting
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-slate-100 hover:bg-slate-200 text-gray-700 cursor-pointer'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
              {t('pos.history.reprint') || 'Reprint'}
            </button>
            {canRefund && (
              <button
                onClick={() => setShowRefund(!showRefund)}
                className={`flex-1 py-3 rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2 cursor-pointer ${
                  showRefund
                    ? 'bg-red-100 text-red-600 hover:bg-red-200'
                    : 'bg-red-50 hover:bg-red-100 text-red-500'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                {t('pos.refund.title') || 'Refund'}
              </button>
            )}
            {notSynced && (
              <span className="flex-1 py-3 rounded-xl text-xs text-gray-400 bg-gray-50 flex items-center justify-center">
                {t('pos.refund.notSynced') || 'Not synced'}
              </span>
            )}
            {refundStatus !== 'none' && (
              <span className="flex-1 py-3 rounded-xl text-xs text-gray-400 bg-gray-50 flex items-center justify-center">
                {t('pos.refund.alreadyRefunded') || 'Refunded'}
              </span>
            )}
          </div>

          {/* Reprint feedback */}
          {reprintStatus === 'ok' && (
            <p className="text-xs text-emerald-500 text-center pb-3">{t('pos.history.reprinted') || 'Receipt sent to printer'}</p>
          )}
          {reprintStatus === 'error' && (
            <p className="text-xs text-red-500 text-center pb-3">{t('pos.history.reprintFailed') || 'Printer not connected'}</p>
          )}

          {/* Refund panel (inline) */}
          {showRefund && canRefund && (
            <RefundPanel
              order={order}
              currency={currency}
              t={t}
              onComplete={() => {
                setShowRefund(false);
                // Reload detail to show updated status
                handleSelectOrder(order.id);
                loadOrders();
              }}
            />
          )}
        </div>
      </div>
    );
  }

  // ─── List view ────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-8 bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg mx-4 shadow-2xl border border-gray-200 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
          <h2 className="text-sm font-bold text-gray-900">{t('pos.history.title') || 'Order History'}</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 cursor-pointer">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-gray-50 shrink-0 flex-wrap">
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-brand-400"
          />
          <select
            value={filterMethod}
            onChange={e => setFilterMethod(e.target.value)}
            className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-brand-400 cursor-pointer"
          >
            <option value="">{t('pos.history.allMethods') || 'All Methods'}</option>
            <option value="CASH">Cash</option>
            <option value="CARD">Card</option>
            <option value="BLIK">Blik</option>
            <option value="TRANSFER">Transfer</option>
          </select>
          {staffNames.length > 0 && (
            <select
              value={filterStaff}
              onChange={e => setFilterStaff(e.target.value)}
              className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-brand-400 cursor-pointer"
            >
              <option value="">{t('pos.history.allStaff') || 'All Staff'}</option>
              {staffNames.map(name => <option key={name} value={name!}>{name}</option>)}
            </select>
          )}
        </div>

        {/* Summary */}
        <div className="px-5 py-2 text-xs text-gray-400 border-b border-gray-50 shrink-0">
          {totalOrders} {t('pos.history.orders') || 'orders'} · {(pageTotal / 100).toFixed(2)} {currency}
          {totalPages > 1 && <span className="ml-2">· Page {page}/{totalPages}</span>}
        </div>

        {/* Orders list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" />
            </div>
          ) : orders.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-sm text-gray-400">{t('pos.history.noOrders') || 'No orders found'}</p>
            </div>
          ) : (
            orders.map(order => {
              const refStatus = getRefundStatus(order);
              return (
                <button
                  key={order.id}
                  onClick={() => handleSelectOrder(order.id)}
                  className="w-full flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors cursor-pointer border-b border-gray-50 last:border-0"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-gray-400 w-24 text-left">{order.order_number || order.id.substring(0, 8)}</span>
                    <span className="text-xs text-gray-400 w-12">{formatTime(order.created_at)}</span>
                    {refStatus !== 'none' && <RefundBadge status={refStatus} t={t} />}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-sm font-bold ${refStatus !== 'none' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                      {(order.total / 100).toFixed(2)} {currency}
                    </span>
                    <span className="text-sm" title={order.payment_method || ''}>{PAYMENT_ICONS[order.payment_method || ''] || '?'}</span>
                    <span className="text-xs text-gray-400 w-16 text-right truncate">{order.staff_name || ''}</span>
                    <svg className="w-3.5 h-3.5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 px-5 py-3 border-t border-gray-100 shrink-0">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
            >
              &larr;
            </button>
            <span className="text-xs text-gray-500">{page} / {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
            >
              &rarr;
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
