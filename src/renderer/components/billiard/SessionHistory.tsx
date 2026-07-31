/**
 * SessionHistory — Browse past billiard sessions with filters.
 *
 * Shows completed/cancelled sessions with table name, duration,
 * revenue breakdown, F&B items, and payment splits.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  History, Calendar, X, RefreshCw, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp, Search, Filter, Clock, Users,
  CreditCard, Banknote, Smartphone, Package, Timer, WifiOff,
} from 'lucide-react';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { formatCurrency } from './utils';

/* ─── Types ──────────────────────────────────────────── */

interface SessionItem {
  id: string;
  name: string;
  quantity: number;
  unit_price: number;
}

interface SessionPayment {
  id: string;
  method: string;
  amount: number;
  createdAt: string;
}

interface HistorySession {
  id: string;
  resource_id: string | null;
  status: string;
  billing_mode: string;
  guest_count: number;
  started_at: string | null;
  ended_at: string | null;
  total_minutes: number;
  total_charge: number;
  time_charge: number;
  fnb_charge: number;
  package_mode: number;
  package_price: number | null;
  customer_name: string | null;
  tableName: string;
  items: SessionItem[];
  payments: SessionPayment[];
}

interface HistoryData {
  sessions: HistorySession[];
  total: number;
  /** True when served from the offline cache instead of the server. */
  fromCache?: boolean;
}

type DateRange = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

/* ─── Helpers ──────────────────────────────────────────── */

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getDateRange(range: DateRange, customFrom?: string, customTo?: string): [string, string] {
  const now = new Date();
  const today = toISODate(now);
  switch (range) {
    case 'today': return [today, today];
    case 'yesterday': { const y = new Date(now); y.setDate(y.getDate() - 1); return [toISODate(y), toISODate(y)]; }
    case 'week': { const w = new Date(now); w.setDate(w.getDate() - 6); return [toISODate(w), today]; }
    case 'month': { const m = new Date(now); m.setDate(m.getDate() - 29); return [toISODate(m), today]; }
    case 'custom': return [customFrom || today, customTo || today];
  }
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const LANG_LOCALE: Record<string, string> = {
  en: 'en-GB', pl: 'pl-PL', vi: 'vi-VN', tr: 'tr-TR', zh: 'zh-CN', uk: 'uk-UA', ru: 'ru-RU',
};

function formatDateTime(iso: string | null, lang?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const locale = (lang && LANG_LOCALE[lang]) || 'pl-PL';
  return d.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const METHOD_ICON: Record<string, typeof Banknote> = {
  CASH: Banknote,
  CARD: CreditCard,
  BLIK: Smartphone,
};

const PAGE_SIZE = 20;

/* ─── Component ────────────────────────────────────────── */

interface SessionHistoryProps {
  language: Language;
  onClose?: () => void;
}

export function SessionHistory({ language, onClose }: SessionHistoryProps) {
  const { t } = useTranslation(language);

  // Filters
  const [range, setRange] = useState<DateRange>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [tableFilter, setTableFilter] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);

  // Data
  const [data, setData] = useState<HistoryData | null>(null);
  const [tables, setTables] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [dateFrom, dateTo] = useMemo(
    () => getDateRange(range, customFrom, customTo),
    [range, customFrom, customTo],
  );

  // Debounce search input (300ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Fetch table list on mount
  useEffect(() => {
    window.electronAPI?.sessionHistory?.getTables?.().then((res: any) => {
      if (res?.success && res.data) setTables(res.data);
    }).catch(() => {});
  }, []);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.sessionHistory?.get?.({
        dateFrom,
        dateTo,
        status: statusFilter,
        resourceId: tableFilter || undefined,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      if (result?.success && result.data) {
        setData(result.data);
      } else {
        setError(result?.error || 'Failed to load history');
      }
    } catch (e: any) {
      setError(e.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, statusFilter, tableFilter, debouncedSearch, page]);

  // Refetch when filters change
  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [dateFrom, dateTo, statusFilter, tableFilter, debouncedSearch]);

  const navigateDay = (delta: number) => {
    const current = new Date(dateFrom);
    current.setDate(current.getDate() + delta);
    const iso = toISODate(current);
    setRange('custom');
    setCustomFrom(iso);
    setCustomTo(iso);
  };

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  const rangeLabels: Record<DateRange, string> = {
    today: t('report.today') || 'Today',
    yesterday: t('report.yesterday') || 'Yesterday',
    week: t('report.week') || 'Last 7 days',
    month: t('report.month') || 'Last 30 days',
    custom: t('report.custom') || 'Custom',
  };

  return (
    <div className="h-full flex flex-col bg-slate-50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-slate-200 shadow-sm">
        <div className="flex items-center gap-3">
          <History className="w-5 h-5 text-indigo-600" />
          <h1 className="text-lg font-bold text-slate-900">
            {t('history.title') || 'Session History'}
          </h1>
          {data && (
            <span className="text-xs text-slate-400 tabular-nums">
              ({data.total} {t('history.results') || 'results'})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchHistory}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 text-slate-600 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100 transition-colors">
              <X className="w-5 h-5 text-slate-600" />
            </button>
          )}
        </div>
      </div>

      {/* Filters bar */}
      <div className="px-4 py-2 bg-white border-b border-slate-100 space-y-2">
        {/* Date range row */}
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => navigateDay(-1)} className="p-1.5 rounded-md hover:bg-slate-100">
            <ChevronLeft className="w-4 h-4 text-slate-500" />
          </button>
          {(['today', 'yesterday', 'week', 'month'] as DateRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                range === r ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {rangeLabels[r]}
            </button>
          ))}
          <button onClick={() => navigateDay(1)} className="p-1.5 rounded-md hover:bg-slate-100">
            <ChevronRight className="w-4 h-4 text-slate-500" />
          </button>

          {range === 'custom' && (
            <div className="flex items-center gap-1 ml-2">
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                className="px-2 py-1 text-xs rounded-md border border-slate-300 bg-white text-slate-800" />
              <span className="text-xs text-slate-400">—</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                className="px-2 py-1 text-xs rounded-md border border-slate-300 bg-white text-slate-800" />
            </div>
          )}

          <span className="ml-auto text-xs text-slate-500 font-mono tabular-nums">
            <Calendar className="w-3.5 h-3.5 inline mr-1" />
            {dateFrom === dateTo ? dateFrom : `${dateFrom} → ${dateTo}`}
          </span>
        </div>

        {/* Filter row */}
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-slate-400" />

          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs bg-white border border-slate-300 rounded-md px-2 py-1.5 text-slate-700"
          >
            <option value="all">{t('history.allStatuses') || 'All statuses'}</option>
            <option value="completed">{t('history.completed') || 'Completed'}</option>
            <option value="cancelled">{t('history.cancelled') || 'Cancelled'}</option>
            <option value="ended">{t('history.ended') || 'Ended'}</option>
          </select>

          {/* Table filter */}
          {tables.length > 0 && (
            <select
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              className="text-xs bg-white border border-slate-300 rounded-md px-2 py-1.5 text-slate-700"
            >
              <option value="">{t('history.allTables') || 'All tables'}</option>
              {tables.map((tb) => (
                <option key={tb.id} value={tb.id}>{tb.name}</option>
              ))}
            </select>
          )}

          {/* Search */}
          <div className="relative flex-1 max-w-[200px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('history.searchCustomer') || 'Search customer...'}
              className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md border border-slate-300 bg-white text-slate-800 placeholder:text-slate-400"
            />
          </div>
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {loading && !data && (
          <div className="flex items-center justify-center h-32">
            <RefreshCw className="w-8 h-8 animate-spin text-indigo-500" />
          </div>
        )}

        {error && (
          <div className="mx-4 mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {data?.fromCache && (
          <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
            <WifiOff className="h-4 w-4 shrink-0" />
            {t('history.offlineCache') || 'Offline — showing locally cached history; recent web-side sessions may be missing.'}
          </div>
        )}

        {data && data.sessions.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <History className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t('history.noSessions') || 'No sessions found for this period'}</p>
          </div>
        )}

        {data && data.sessions.length > 0 && (
          <div className="divide-y divide-slate-100">
            {data.sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                expanded={expandedId === session.id}
                onToggle={() => setExpandedId(expandedId === session.id ? null : session.id)}
                t={t}
                lang={language}
              />
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-slate-200 bg-white">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronLeft className="w-3.5 h-3.5 inline mr-1" />
            {t('common.prev') || 'Prev'}
          </button>
          <span className="text-xs text-slate-500 tabular-nums">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 hover:bg-slate-50 disabled:opacity-40"
          >
            {t('common.next') || 'Next'}
            <ChevronRight className="w-3.5 h-3.5 inline ml-1" />
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Session Row (expandable) ─────────────────────────── */

function SessionRow({
  session,
  expanded,
  onToggle,
  t,
  lang,
}: {
  session: HistorySession;
  expanded: boolean;
  onToggle: () => void;
  t: (key: string) => string;
  lang?: string;
}) {
  const isPackage = session.package_mode === 1;
  const statusColor = session.status === 'completed'
    ? 'bg-emerald-100 text-emerald-700'
    : session.status === 'cancelled'
      ? 'bg-red-100 text-red-700'
      : 'bg-slate-100 text-slate-600';

  return (
    <div className="bg-white">
      {/* Summary row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
      >
        {/* Expand arrow */}
        <div className="shrink-0">
          {expanded
            ? <ChevronUp className="w-4 h-4 text-slate-400" />
            : <ChevronDown className="w-4 h-4 text-slate-400" />
          }
        </div>

        {/* Table name */}
        <div className="min-w-[80px]">
          <p className="text-sm font-semibold text-slate-900">{session.tableName}</p>
          {session.customer_name && (
            <p className="text-[10px] text-slate-500 truncate max-w-[100px]">{session.customer_name}</p>
          )}
        </div>

        {/* Time */}
        <div className="min-w-[100px]">
          <p className="text-xs text-slate-700">{formatDateTime(session.started_at, lang)}</p>
          <p className="text-[10px] text-slate-400">
            {formatMinutes(session.total_minutes)}
            {session.guest_count > 1 && (
              <span className="ml-1.5">
                <Users className="w-3 h-3 inline" /> {session.guest_count}
              </span>
            )}
          </p>
        </div>

        {/* Type badge */}
        <span className="shrink-0" title={isPackage ? 'Package' : 'Per-minute'}>
          {isPackage
            ? <Package className="w-4 h-4 text-brand-500" />
            : <Timer className="w-4 h-4 text-blue-500" />
          }
        </span>

        {/* Status */}
        <span className={`shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full capitalize ${statusColor}`}>
          {t(`history.${session.status}`) || session.status}
        </span>

        {/* Revenue */}
        <div className="ml-auto text-right min-w-[80px]">
          <p className="text-sm font-bold text-slate-900 tabular-nums">
            {formatCurrency(session.total_charge)}
          </p>
          {session.fnb_charge > 0 && (
            <p className="text-[10px] text-slate-400 tabular-nums">
              F&B: {formatCurrency(session.fnb_charge)}
            </p>
          )}
        </div>

        {/* Payment method icons */}
        <div className="flex items-center gap-0.5 shrink-0 min-w-[40px]">
          {session.payments.length > 0
            ? session.payments.map((pay) => {
                const Icon = METHOD_ICON[pay.method] || CreditCard;
                return <span key={pay.id} title={`${pay.method}: ${formatCurrency(pay.amount)}`}><Icon className="w-3.5 h-3.5 text-slate-400" /></span>;
              })
            : <span className="text-[10px] text-slate-300">—</span>
          }
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-3 pl-12 space-y-3">
          {/* Payment splits */}
          {session.payments.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                {t('history.payments') || 'Payments'}
              </p>
              <div className="flex flex-wrap gap-2">
                {session.payments.map((pay) => {
                  const Icon = METHOD_ICON[pay.method] || CreditCard;
                  return (
                    <div key={pay.id} className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 rounded-md">
                      <Icon className="w-3.5 h-3.5 text-slate-500" />
                      <span className="text-xs font-medium text-slate-700">{pay.method}</span>
                      <span className="text-xs font-bold text-slate-900 tabular-nums">{formatCurrency(pay.amount)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* F&B Items */}
          {session.items.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                {t('history.items') || 'Items'}
              </p>
              <div className="space-y-0.5">
                {session.items.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 text-xs">
                    <span className="text-slate-700 flex-1 truncate">{item.name}</span>
                    <span className="text-slate-400 tabular-nums">x{item.quantity}</span>
                    <span className="text-slate-600 tabular-nums font-medium min-w-[60px] text-right">
                      {formatCurrency(item.unit_price * item.quantity)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Revenue breakdown */}
          <div className="flex gap-4 text-[10px] text-slate-500">
            <span><Clock className="w-3 h-3 inline mr-0.5" /> {t('report.timeRevenue') || 'Time'}: {formatCurrency(session.time_charge)}</span>
            <span>F&B: {formatCurrency(session.fnb_charge)}</span>
            <span className="font-semibold text-slate-700">
              {t('billiard.total') || 'Total'}: {formatCurrency(session.total_charge)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
