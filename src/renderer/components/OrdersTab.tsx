import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Printer, RefreshCw, Search } from 'lucide-react';
import { Language } from '../i18n/translations';
import { useTranslation } from '../i18n/useTranslation';
import { useConfig } from '../hooks/useConfig';
import { compareOrdersByDisplayTimeDesc, parseOrderTimestampMs } from './pos/order-history-time';
import { getHistoryDisplayNumber, getRealHistoryOrderNumber } from './pos/order-fiscal-visibility';
import rlog from '../utils/logger';

interface OrdersTabProps {
  language: Language;
}

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
  customer_name?: string | null;
  customer_nip?: string | null;
  requires_invoice?: boolean;
  payment_tenders?: string | null;
  refund_amount?: number;
  refunded_at?: string | null;
  created_at: string;
  backend_id?: string | null;
  synced?: number;
  has_fiscal?: number;
  _origin?: 'server';
}

interface OrderItemRow {
  id: string;
  order_id: string;
  name: string;
  sku: string | null;
  price: number;
  quantity: number;
  sale_quantity?: number | null;
  sale_unit?: string | null;
  sell_by?: string | null;
  total: number;
  vat_rate: number;
}

interface OrderDetailResult {
  order: OrderRow;
  items: OrderItemRow[];
}

type PeriodKey = 'today' | 'week' | 'month' | 'custom';
type ReprintFeedback = { orderId: string; ok: boolean; text: string } | null;

const PAGE_SIZE = 25;
const LOCAL_ORDER_FETCH_LIMIT = 1000;
const SERVER_ORDER_FETCH_LIMIT = 200;
const PAYMENT_METHODS = ['', 'CASH', 'CARD', 'BLIK', 'TRANSFER', 'INVOICE', 'SPLIT'];

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rangeForPeriod(period: PeriodKey, customFrom: string, customTo: string): { from: string; to: string } {
  switch (period) {
    case 'today': return { from: todayISO(), to: todayISO() };
    case 'week': return { from: shiftDays(7), to: todayISO() };
    case 'month': return { from: shiftDays(30), to: todayISO() };
    case 'custom': return { from: customFrom || todayISO(), to: customTo || todayISO() };
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(parseOrderTimestampMs(iso));
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(parseOrderTimestampMs(iso));
    const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    return `${date} ${formatTime(iso)}`;
  } catch { return iso; }
}

function formatMoney(amountGrosze: number, currency: string): string {
  return `${(amountGrosze / 100).toFixed(2)} ${currency}`;
}

function paymentLabelText(method: string | null | undefined, t: (k: string) => string): string {
  if (!method) return '-';
  return tOr(t, `pos.payment.${method.toLowerCase()}`, method);
}

function dataSourceLabel(source: 'local+server' | 'local-only' | 'server-unreachable', t: (k: string) => string): string {
  if (source === 'local+server') return tOr(t, 'orders.source.localServer', 'Local + Server');
  if (source === 'server-unreachable') return tOr(t, 'orders.source.serverUnreachable', 'Server unreachable - showing local data');
  return tOr(t, 'orders.source.localOnly', 'Local only');
}

function parseTenders(order: OrderRow): Array<{ method: string; amount: number }> {
  if (!order.payment_tenders) return [];
  try {
    const tenders = JSON.parse(order.payment_tenders);
    if (!Array.isArray(tenders)) return [];
    return tenders.filter((t: any) => typeof t?.method === 'string' && typeof t?.amount === 'number');
  } catch {
    return [];
  }
}

function isSplitOrder(order: OrderRow): boolean {
  return order.payment_method === 'SPLIT' || parseTenders(order).length > 1;
}

function normalizePaymentMethod(method: string | null | undefined): string | null {
  if (!method) return null;
  return method === 'TRANSFER' ? 'BANK_TRANSFER' : method;
}

function paymentSummaryText(order: OrderRow, t: (k: string) => string): string {
  const tenders = parseTenders(order);
  if (tenders.length > 1) {
    return tenders
      .map((tender) => `${paymentLabelText(tender.method, t)} ${(tender.amount / 100).toFixed(2)}`)
      .join(' + ');
  }
  if (order.payment_method === 'SPLIT') return paymentLabelText('SPLIT', t);
  return paymentLabelText(order.payment_method, t);
}

function orderMatchesPayment(order: OrderRow, method: string): boolean {
  if (!method) return true;
  const split = isSplitOrder(order);
  if (method === 'SPLIT') return split;
  if (method === 'INVOICE') return Boolean(order.requires_invoice || order.customer_nip);
  return !split && normalizePaymentMethod(order.payment_method) === normalizePaymentMethod(method);
}

function orderMatchesStaff(order: OrderRow, staffName: string): boolean {
  const needle = staffName.trim().toLowerCase();
  if (!needle) return true;
  return (order.staff_name || '').toLowerCase().includes(needle);
}

function serverPaymentFilter(method: string): { paymentMethod?: string; requiresInvoice?: boolean } {
  if (method === 'TRANSFER') return { paymentMethod: 'BANK_TRANSFER' };
  if (method === 'INVOICE') return { requiresInvoice: true };
  if (method) return { paymentMethod: method };
  return {};
}

function orderWithinRange(order: OrderRow, from: string, to: string): boolean {
  const created = order.created_at?.slice(0, 10);
  return Boolean(created && created >= from && created <= to);
}

function mergeOrders(localOrders: OrderRow[], serverOrders: OrderRow[]): OrderRow[] {
  const byId = new Map<string, OrderRow>();
  for (const order of serverOrders) byId.set(order.id, order);
  for (const order of localOrders) {
    if (order.backend_id) byId.delete(order.backend_id);
    byId.set(order.id, order);
  }
  return Array.from(byId.values()).sort(compareOrdersByDisplayTimeDesc);
}

function statusBadgeClass(status: string, refundedAt?: string | null): string {
  if (refundedAt) return 'bg-rose-100 text-rose-700 border-rose-200';
  switch (status) {
    case 'COMPLETED': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
    case 'REFUNDED': return 'bg-rose-100 text-rose-700 border-rose-200';
    case 'PARTIAL_REFUND': return 'bg-amber-100 text-amber-700 border-amber-200';
    case 'CANCELLED': return 'bg-slate-200 text-slate-700 border-slate-300';
    default: return 'bg-slate-100 text-slate-600 border-slate-200';
  }
}

export default function OrdersTab({ language }: OrdersTabProps) {
  const { t } = useTranslation(language);
  const { config } = useConfig();
  const currency = tOr(t, 'pos.currency', 'zł');

  const [period, setPeriod] = useState<PeriodKey>('today');
  const [customFrom, setCustomFrom] = useState(todayISO());
  const [customTo, setCustomTo] = useState(todayISO());
  const [paymentMethod, setPaymentMethod] = useState('');
  const [staffName, setStaffName] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<'local+server' | 'local-only' | 'server-unreachable'>('local-only');

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetailResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [serverItemsMap, setServerItemsMap] = useState<Record<string, OrderItemRow[]>>({});
  const [reprintBusyId, setReprintBusyId] = useState<string | null>(null);
  const [reprintFeedback, setReprintFeedback] = useState<ReprintFeedback>(null);
  const hideNonFiscalOrders = config?.showNonFiscalOrders === false;

  const searchedOrders = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return orders;
    return orders.filter((order) => (
      (order.order_number || '').toLowerCase().includes(needle)
      || (order.customer_name || '').toLowerCase().includes(needle)
      || (order.staff_name || '').toLowerCase().includes(needle)
      || order.id.toLowerCase().includes(needle)
    ));
  }, [orders, search]);
  const totalPages = Math.max(1, Math.ceil(searchedOrders.length / PAGE_SIZE));
  const displayedOrders = useMemo(() => {
    const offset = (page - 1) * PAGE_SIZE;
    return searchedOrders.slice(offset, offset + PAGE_SIZE);
  }, [page, searchedOrders]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const range = rangeForPeriod(period, customFrom, customTo);
    try {
      const trimmedSearch = search.trim();
      const trimmedStaffName = staffName.trim();
      const serverFilters = {
        from: range.from,
        to: range.to,
        ...serverPaymentFilter(paymentMethod),
        ...(trimmedSearch ? { search: trimmedSearch } : {}),
        ...(trimmedStaffName ? { staffName: trimmedStaffName } : {}),
        page: 1,
        limit: SERVER_ORDER_FETCH_LIMIT,
      };
      const serverListPromise = hideNonFiscalOrders
        ? Promise.resolve({ orders: [], items: {}, total: 0, page: 1, limit: SERVER_ORDER_FETCH_LIMIT, source: 'unconfigured' as const })
        : window.electronAPI.pos.orders.getServerList(serverFilters as any);
      const [localResult, serverResult] = await Promise.allSettled([
        window.electronAPI.pos.orders.getHistory({
          from: range.from,
          to: range.to,
          page: 1,
          limit: LOCAL_ORDER_FETCH_LIMIT,
          fiscalOnly: hideNonFiscalOrders,
          paymentMethod: paymentMethod || undefined,
          staffName: trimmedStaffName || undefined,
        } as any),
        serverListPromise,
      ]);

      const localRows = localResult.status === 'fulfilled'
        ? ((localResult.value?.orders || []) as OrderRow[])
        : [];
      let serverRows: OrderRow[] = [];
      let nextItemsMap: Record<string, OrderItemRow[]> = {};
      let nextSource: 'local+server' | 'local-only' | 'server-unreachable' = 'local-only';

      if (serverResult.status === 'fulfilled') {
        const value = serverResult.value;
        if (value?.source === 'server') {
          serverRows = (value.orders || []) as OrderRow[];
          nextItemsMap = (value.items || {}) as Record<string, OrderItemRow[]>;
          nextSource = 'local+server';
        } else if (value?.source === 'network-error') {
          nextSource = 'server-unreachable';
        }
      } else {
        nextSource = 'server-unreachable';
      }

      const merged = mergeOrders(localRows, serverRows)
        .filter((order) => order.status !== 'DRAFT' && order.status !== 'POS-DRA')
        .filter((order) => orderWithinRange(order, range.from, range.to))
        .filter((order) => orderMatchesPayment(order, paymentMethod))
        .filter((order) => orderMatchesStaff(order, staffName));

      setOrders(merged);
      setServerItemsMap(nextItemsMap);
      setDataSource(nextSource);
    } catch (err: any) {
      rlog.warn('[OrdersTab] getHistory failed:', err);
      setError(err?.message || tOr(t, 'orders.loadFailed', 'Failed to load orders'));
      setOrders([]);
      setServerItemsMap({});
      setDataSource('server-unreachable');
    } finally {
      setLoading(false);
    }
  }, [period, customFrom, customTo, paymentMethod, staffName, search, hideNonFiscalOrders]);

  useEffect(() => { void load(); }, [load]);

  // Reset to page 1 whenever filters change
  useEffect(() => { setPage(1); }, [period, customFrom, customTo, paymentMethod, staffName, search, hideNonFiscalOrders]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageTotalGrosze = useMemo(() => displayedOrders.reduce((sum, o) => sum + (o.total || 0), 0), [displayedOrders]);
  const pageCount = displayedOrders.length;

  const handleExpand = useCallback(async (orderId: string) => {
    if (expandedId === orderId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(orderId);
    setDetail(null);
    setDetailLoading(true);
    const order = orders.find((o) => o.id === orderId);
    const serverItems = serverItemsMap[orderId];
    if (order && serverItems?.length) {
      setDetail({ order, items: serverItems });
      setDetailLoading(false);
      return;
    }

    try {
      const result = await window.electronAPI.pos.orders.getDetail(orderId);
      if (result) setDetail(result as OrderDetailResult);
    } catch (err) {
      rlog.warn('[OrdersTab] getDetail failed:', err);
    } finally {
      setDetailLoading(false);
    }
  }, [expandedId, orders, serverItemsMap]);

  const handleReprint = useCallback(async (order: OrderRow) => {
    const orderId = order.id;
    if (reprintBusyId) return;
    setReprintBusyId(orderId);
    setReprintFeedback(null);
    try {
      let printableOrderId = orderId;
      if (order._origin === 'server') {
        const kind: 'cash' | 'invoiced' = order.customer_nip ? 'invoiced' : 'cash';
        const mirrored = await window.electronAPI.pos.orders.mirrorFromServer(order.id, kind);
        if (!mirrored?.success || !mirrored.localOrderId) {
          throw new Error(mirrored?.error || tOr(t, 'orders.mirrorFailed', 'Could not mirror server order before printing'));
        }
        printableOrderId = mirrored.localOrderId;
      }

      const result = await window.electronAPI.pos.payment.reprintReceipt(printableOrderId);
      const ok = !!result?.receiptPrinted;
      setReprintFeedback({
        orderId,
        ok,
        text: ok
          ? tOr(t, 'orders.reprintSuccess', 'Reprinted')
          : tOr(t, 'orders.reprintFailed', 'Reprint failed — check printer'),
      });
    } catch (err: any) {
      rlog.warn('[OrdersTab] reprintReceipt failed:', err);
      setReprintFeedback({
        orderId,
        ok: false,
        text: err?.message || tOr(t, 'orders.reprintFailed', 'Reprint failed'),
      });
    } finally {
      setReprintBusyId(null);
      setTimeout(() => setReprintFeedback(null), 4000);
    }
  }, [reprintBusyId, t]);

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">{tOr(t, 'orders.title', 'Đơn hàng')}</h1>
          <p className="text-sm text-slate-500">{tOr(t, 'orders.subtitle', 'Danh sách đơn hàng đã bán từ POS')}</p>
          <p className={`mt-1 text-xs font-semibold ${
            dataSource === 'local+server'
              ? 'text-emerald-600'
              : dataSource === 'server-unreachable'
                ? 'text-amber-600'
                : 'text-slate-400'
          }`}>
            {dataSourceLabel(dataSource, t)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          {tOr(t, 'orders.refresh', 'Làm mới')}
        </button>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase text-slate-500">{tOr(t, 'orders.period', 'Thời gian')}</label>
            <div className="inline-flex overflow-hidden rounded-md border border-slate-300">
              {(['today', 'week', 'month', 'custom'] as PeriodKey[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    period === p
                      ? 'bg-brand-600 text-white'
                      : 'bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {tOr(t, `orders.period.${p}`, p === 'today' ? 'Hôm nay' : p === 'week' ? '7 ngày' : p === 'month' ? '30 ngày' : 'Tùy chọn')}
                </button>
              ))}
            </div>
          </div>

          {period === 'custom' && (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium uppercase text-slate-500">{tOr(t, 'orders.from', 'Từ ngày')}</label>
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="h-10 rounded-md border border-slate-300 px-2 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium uppercase text-slate-500">{tOr(t, 'orders.to', 'Đến ngày')}</label>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="h-10 rounded-md border border-slate-300 px-2 text-sm"
                />
              </div>
            </>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase text-slate-500">{tOr(t, 'orders.paymentMethod', 'Phương thức')}</label>
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              className="h-10 rounded-md border border-slate-300 px-2 text-sm"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m || 'all'} value={m}>
                  {m ? paymentLabelText(m, t) : tOr(t, 'orders.allMethods', 'Tất cả')}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase text-slate-500">{tOr(t, 'orders.staff', 'Nhân viên')}</label>
            <input
              type="text"
              value={staffName}
              onChange={(e) => setStaffName(e.target.value)}
              placeholder={tOr(t, 'orders.staffPlaceholder', 'Tên nhân viên...')}
              className="h-10 w-40 rounded-md border border-slate-300 px-2 text-sm"
            />
          </div>

          <div className="flex flex-1 flex-col gap-1">
            <label className="text-xs font-medium uppercase text-slate-500">{tOr(t, 'orders.search', 'Tìm kiếm')}</label>
            <div className="relative">
              <Search size={16} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={tOr(t, 'orders.searchPlaceholder', 'Số đơn / khách / nhân viên...')}
                className="h-10 w-full rounded-md border border-slate-300 pl-8 pr-2 text-sm"
              />
            </div>
          </div>
        </div>
      </section>

      <section className="flex flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="grid shrink-0 grid-cols-[40px_120px_140px_minmax(140px,1fr)_120px_120px_140px_120px_140px] gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <span aria-hidden="true" />
          <span>{tOr(t, 'orders.col.number', 'Số đơn')}</span>
          <span>{tOr(t, 'orders.col.time', 'Thời gian')}</span>
          <span>{tOr(t, 'orders.col.customer', 'Khách hàng')}</span>
          <span>{tOr(t, 'orders.col.method', 'Phương thức')}</span>
          <span>{tOr(t, 'orders.col.staff', 'Nhân viên')}</span>
          <span className="text-right">{tOr(t, 'orders.col.total', 'Tổng tiền')}</span>
          <span>{tOr(t, 'orders.col.status', 'Trạng thái')}</span>
          <span className="text-right">{tOr(t, 'orders.col.actions', 'Thao tác')}</span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && orders.length === 0 ? (
            <div className="flex items-center justify-center p-12 text-sm text-slate-500">
              {tOr(t, 'orders.loading', 'Đang tải...')}
            </div>
          ) : error ? (
            <div className="flex items-center justify-center p-12 text-sm text-rose-600">{error}</div>
          ) : displayedOrders.length === 0 ? (
            <div className="flex items-center justify-center p-12 text-sm text-slate-500">
              {tOr(t, 'orders.empty', 'Không có đơn hàng nào trong khoảng thời gian này')}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {displayedOrders.map((order, index) => {
                const isExpanded = expandedId === order.id;
                const isReprintBusy = reprintBusyId === order.id;
                const feedback = reprintFeedback?.orderId === order.id ? reprintFeedback : null;
                const displayNumber = getHistoryDisplayNumber(order, (page - 1) * PAGE_SIZE + index, hideNonFiscalOrders, searchedOrders.length);
                const realOrderNumber = getRealHistoryOrderNumber(order);
                return (
                  <li key={order.id} className="bg-white">
                    <button
                      type="button"
                      onClick={() => void handleExpand(order.id)}
                      className="grid w-full grid-cols-[40px_120px_140px_minmax(140px,1fr)_120px_120px_140px_120px_140px] items-center gap-2 px-4 py-3 text-left text-sm transition-colors hover:bg-slate-50"
                    >
                      <span className="flex h-6 w-6 items-center justify-center text-slate-400">
                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold tabular-nums text-slate-950" title={hideNonFiscalOrders ? `Real order number: ${realOrderNumber}` : undefined}>
                          {displayNumber}
                        </span>
                        {hideNonFiscalOrders && (
                          <span className="mt-0.5 block truncate text-[11px] font-medium text-slate-500">
                            {realOrderNumber}
                          </span>
                        )}
                      </span>
                      <span className="text-slate-700">{formatDateTime(order.created_at)}</span>
                      <span className="truncate text-slate-700">
                        {order.customer_name || (order.customer_nip ? `NIP: ${order.customer_nip}` : '-')}
                      </span>
                      <span className="truncate text-slate-700">{paymentSummaryText(order, t)}</span>
                      <span className="truncate text-slate-700">{order.staff_name || '-'}</span>
                      <span className="text-right font-semibold tabular-nums text-slate-950">{formatMoney(order.total, currency)}</span>
                      <span>
                        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${statusBadgeClass(order.status, order.refunded_at)}`}>
                          {tOr(t, `orders.status.${order.status.toLowerCase()}`, order.status)}
                        </span>
                      </span>
                      <span
                        className="flex items-center justify-end gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => void handleReprint(order)}
                          disabled={isReprintBusy}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                          title={tOr(t, 'orders.reprint', 'In lại')}
                        >
                          <Printer size={14} />
                          {isReprintBusy ? tOr(t, 'orders.reprinting', 'Đang in...') : tOr(t, 'orders.reprint', 'In lại')}
                        </button>
                      </span>
                    </button>

                    {feedback && (
                      <div
                        className={`mx-4 mb-2 rounded-md px-3 py-2 text-xs font-medium ${feedback.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}
                      >
                        {feedback.text}
                      </div>
                    )}

                    {isExpanded && (
                      <div className="border-t border-slate-100 bg-slate-50 px-6 py-4">
                        {detailLoading ? (
                          <p className="text-sm text-slate-500">{tOr(t, 'orders.loadingDetail', 'Đang tải chi tiết...')}</p>
                        ) : !detail ? (
                          <p className="text-sm text-slate-500">{tOr(t, 'orders.noDetail', 'Không có chi tiết')}</p>
                        ) : (
                          <div className="space-y-3">
                            <table className="w-full table-auto text-sm">
                              <thead>
                                <tr className="text-left text-xs uppercase text-slate-500">
                                  <th className="py-1 pr-2">{tOr(t, 'orders.item.name', 'Tên hàng')}</th>
                                  <th className="py-1 pr-2 text-right">{tOr(t, 'orders.item.qty', 'SL')}</th>
                                  <th className="py-1 pr-2 text-right">{tOr(t, 'orders.item.price', 'Đơn giá')}</th>
                                  <th className="py-1 pr-2 text-right">{tOr(t, 'orders.item.vat', 'VAT')}</th>
                                  <th className="py-1 text-right">{tOr(t, 'orders.item.total', 'Thành tiền')}</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-200">
                                {detail.items.map((item) => (
                                  <tr key={item.id}>
                                    <td className="py-1 pr-2 text-slate-800">{item.name}{item.sku ? <span className="ml-2 text-xs text-slate-400">{item.sku}</span> : null}</td>
                                    <td className="py-1 pr-2 text-right tabular-nums text-slate-700">{item.quantity}</td>
                                    <td className="py-1 pr-2 text-right tabular-nums text-slate-700">{formatMoney(item.price, currency)}</td>
                                    <td className="py-1 pr-2 text-right tabular-nums text-slate-700">{item.vat_rate}%</td>
                                    <td className="py-1 text-right tabular-nums font-semibold text-slate-900">{formatMoney(item.total, currency)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>

                            <div className="grid grid-cols-2 gap-2 rounded-md bg-white p-3 text-sm sm:grid-cols-4">
                              <div>
                                <p className="text-xs text-slate-500">{tOr(t, 'orders.detail.subtotal', 'Tạm tính')}</p>
                                <p className="font-semibold tabular-nums text-slate-900">{formatMoney(detail.order.subtotal, currency)}</p>
                              </div>
                              {detail.order.discount > 0 && (
                                <div>
                                  <p className="text-xs text-slate-500">{tOr(t, 'orders.detail.discount', 'Giảm giá')}</p>
                                  <p className="font-semibold tabular-nums text-rose-700">−{formatMoney(detail.order.discount, currency)}</p>
                                </div>
                              )}
                              <div>
                                <p className="text-xs text-slate-500">{tOr(t, 'orders.detail.paid', 'Đã thu')}</p>
                                <p className="font-semibold tabular-nums text-slate-900">{formatMoney(detail.order.payment_amount, currency)}</p>
                              </div>
                              {detail.order.change_amount > 0 && (
                                <div>
                                  <p className="text-xs text-slate-500">{tOr(t, 'orders.detail.change', 'Tiền thừa')}</p>
                                  <p className="font-semibold tabular-nums text-slate-900">{formatMoney(detail.order.change_amount, currency)}</p>
                                </div>
                              )}
                              <div className="col-span-2 sm:col-span-4">
                                <p className="text-xs text-slate-500">{tOr(t, 'orders.detail.total', 'Tổng tiền')}</p>
                                <p className="text-lg font-bold tabular-nums text-slate-950">{formatMoney(detail.order.total, currency)}</p>
                              </div>
                            </div>

                            {detail.order.refunded_at && (
                              <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                                {tOr(t, 'orders.detail.refunded', 'Đã hoàn tiền')}: {formatMoney(detail.order.refund_amount || 0, currency)}
                                {detail.order.refunded_at ? ` • ${formatDateTime(detail.order.refunded_at)}` : ''}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-2 text-sm">
          <div className="text-slate-600">
            {pageCount} / {searchedOrders.length} {tOr(t, 'orders.summary', 'đơn — tổng trang này')}: <span className="font-semibold text-slate-950">{formatMoney(pageTotalGrosze, currency)}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="min-w-[88px] rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {tOr(t, 'orders.prev', 'Trước')}
            </button>
            <span className="min-w-[80px] text-center tabular-nums text-slate-700">{page} / {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="min-w-[88px] rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {tOr(t, 'orders.next', 'Sau')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
