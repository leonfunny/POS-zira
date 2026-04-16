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

function formatTime(iso: string): string {
  try {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'));
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'));
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  } catch { return ''; }
}

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

  // Reset to page 1 when filters change
  useEffect(() => { setPage(1); }, [selectedDate, filterMethod, filterStaff]);

  const handleSelectOrder = async (orderId: string) => {
    const result = await window.electronAPI.pos.orders.getDetail(orderId);
    if (result) setDetail(result);
  };

  const handleReprint = async (orderId: string) => {
    setReprintStatus(null);
    try {
      await window.electronAPI.pos.payment.reprintReceipt(orderId);
      setReprintStatus('ok');
    } catch {
      setReprintStatus('error');
    }
    setTimeout(() => setReprintStatus(null), 3000);
  };

  // Unique staff names for filter dropdown
  const staffNames = [...new Set(orders.map(o => o.staff_name).filter(Boolean))];
  const pageTotal = orders.reduce((sum, o) => sum + o.total, 0);

  // Detail view
  if (detail) {
    const { order, items } = detail;
    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-8 bg-black/50" onClick={onClose}>
        <div className="bg-white rounded-2xl w-full max-w-md mx-4 shadow-2xl border border-gray-200" onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
            <button onClick={() => setDetail(null)} className="text-sm text-brand-500 hover:text-brand-600 font-medium cursor-pointer flex items-center gap-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              {t('pos.history.title') || 'History'}
            </button>
            <span className="text-sm font-bold text-gray-900">{order.order_number || order.id.substring(0, 8)}</span>
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
            </div>
          </div>

          {/* Reprint button */}
          <div className="px-5 pb-5">
            <button
              onClick={() => handleReprint(order.id)}
              className="w-full py-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm font-medium text-gray-700 transition-colors cursor-pointer flex items-center justify-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
              {t('pos.history.reprint') || 'Reprint Receipt'}
            </button>
            {reprintStatus === 'ok' && (
              <p className="text-xs text-emerald-500 text-center mt-2">{t('pos.history.reprinted') || 'Receipt sent to printer'}</p>
            )}
            {reprintStatus === 'error' && (
              <p className="text-xs text-red-500 text-center mt-2">{t('pos.history.reprintFailed') || 'Printer not connected'}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // List view
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
            orders.map(order => (
              <button
                key={order.id}
                onClick={() => handleSelectOrder(order.id)}
                className="w-full flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors cursor-pointer border-b border-gray-50 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-gray-400 w-24 text-left">{order.order_number || order.id.substring(0, 8)}</span>
                  <span className="text-xs text-gray-400 w-12">{formatTime(order.created_at)}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-bold text-gray-900">{(order.total / 100).toFixed(2)} {currency}</span>
                  <span className="text-sm" title={order.payment_method || ''}>{PAYMENT_ICONS[order.payment_method || ''] || '?'}</span>
                  <span className="text-xs text-gray-400 w-16 text-right truncate">{order.staff_name || ''}</span>
                  <svg className="w-3.5 h-3.5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </div>
              </button>
            ))
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
