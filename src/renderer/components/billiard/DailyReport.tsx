/**
 * DailyReport — Revenue & analytics dashboard for billiard venue.
 *
 * Shows daily/weekly/custom summary stats: total revenue, sessions,
 * table utilization, top F&B items, and hourly breakdown.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BarChart3, Calendar, TrendingUp, Clock, Users, UtensilsCrossed,
  Package, Timer, X, RefreshCw, ChevronLeft, ChevronRight,
} from 'lucide-react';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { formatCurrency } from './utils';

interface DailyReportSummary {
  totalRevenue: number;
  timeRevenue: number;
  fnbRevenue: number;
  sessionCount: number;
  avgDurationMinutes: number;
  totalGuests: number;
  packageSessionCount: number;
  perMinuteSessionCount: number;
}

interface TableUtilization {
  resourceId: string;
  tableName: string;
  sessionCount: number;
  totalMinutes: number;
  totalRevenue: number;
}

interface TopFnbItem {
  name: string;
  totalQuantity: number;
  totalRevenue: number;
}

interface HourlyBreakdown {
  hour: number;
  sessionCount: number;
  revenue: number;
}

interface ReportData {
  summary: DailyReportSummary;
  tableUtilization: TableUtilization[];
  topFnbItems: TopFnbItem[];
  hourlyBreakdown: HourlyBreakdown[];
}

type DateRange = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getDateRange(range: DateRange, customFrom?: string, customTo?: string): [string, string] {
  const now = new Date();
  const today = toISODate(now);

  switch (range) {
    case 'today':
      return [today, today];
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return [toISODate(y), toISODate(y)];
    }
    case 'week': {
      const w = new Date(now);
      w.setDate(w.getDate() - 6);
      return [toISODate(w), today];
    }
    case 'month': {
      const m = new Date(now);
      m.setDate(m.getDate() - 29);
      return [toISODate(m), today];
    }
    case 'custom':
      return [customFrom || today, customTo || today];
  }
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

interface DailyReportProps {
  language: Language;
  onClose?: () => void;
}

export function DailyReport({ language, onClose }: DailyReportProps) {
  const { t } = useTranslation(language);
  const [range, setRange] = useState<DateRange>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dateFrom, dateTo] = useMemo(
    () => getDateRange(range, customFrom, customTo),
    [range, customFrom, customTo],
  );

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.dailyReport?.get?.(dateFrom, dateTo);
      if (result?.success && result.data) {
        setData(result.data);
      } else {
        setError(result?.error || 'Failed to load report');
      }
    } catch (e: any) {
      setError(e.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  // Navigate day-by-day for today/yesterday
  const navigateDay = (delta: number) => {
    const current = new Date(dateFrom);
    current.setDate(current.getDate() + delta);
    const iso = toISODate(current);
    setRange('custom');
    setCustomFrom(iso);
    setCustomTo(iso);
  };

  const rangeLabels: Record<DateRange, string> = {
    today: t('report.today') || 'Today',
    yesterday: t('report.yesterday') || 'Yesterday',
    week: t('report.week') || 'Last 7 days',
    month: t('report.month') || 'Last 30 days',
    custom: t('report.custom') || 'Custom',
  };

  const summary = data?.summary;
  const maxHourlyRevenue = data?.hourlyBreakdown
    ? Math.max(...data.hourlyBreakdown.map((h) => h.revenue), 1)
    : 1;

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="flex items-center gap-3">
          <BarChart3 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <h1 className="text-lg font-bold text-gray-900 dark:text-white">
            {t('report.title') || 'Daily Report'}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchReport}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
            title={t('report.refresh') || 'Refresh'}
          >
            <RefreshCw className={`w-4 h-4 text-gray-600 dark:text-gray-300 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
              <X className="w-5 h-5 text-gray-600 dark:text-gray-300" />
            </button>
          )}
        </div>
      </div>

      {/* Date range selector */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-gray-800/50 border-b border-gray-100 dark:border-gray-700/50">
        <button
          onClick={() => navigateDay(-1)}
          className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <ChevronLeft className="w-4 h-4 text-gray-500" />
        </button>
        {(['today', 'yesterday', 'week', 'month'] as DateRange[]).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              range === r
                ? 'bg-brand-600 text-white'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            {rangeLabels[r]}
          </button>
        ))}
        <button
          onClick={() => navigateDay(1)}
          className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <ChevronRight className="w-4 h-4 text-gray-500" />
        </button>

        {/* Custom date pickers */}
        {range === 'custom' && (
          <div className="flex items-center gap-1 ml-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="px-2 py-1 text-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
            />
            <span className="text-xs text-gray-400">—</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="px-2 py-1 text-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
            />
          </div>
        )}

        {/* Display active date range */}
        <span className="ml-auto text-xs text-gray-500 dark:text-gray-400 font-mono tabular-nums">
          <Calendar className="w-3.5 h-3.5 inline mr-1" />
          {dateFrom === dateTo ? dateFrom : `${dateFrom} → ${dateTo}`}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && !data && (
          <div className="flex items-center justify-center h-32">
            <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
          </div>
        )}

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {summary && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryCard
                icon={<TrendingUp className="w-5 h-5" />}
                label={t('report.totalRevenue') || 'Total Revenue'}
                value={formatCurrency(summary.totalRevenue)}
                color="text-emerald-600 dark:text-emerald-400"
                bg="bg-emerald-50 dark:bg-emerald-900/20"
              />
              <SummaryCard
                icon={<Clock className="w-5 h-5" />}
                label={t('report.sessions') || 'Sessions'}
                value={String(summary.sessionCount)}
                sub={`${t('report.avgDuration') || 'Avg'}: ${formatMinutes(summary.avgDurationMinutes)}`}
                color="text-blue-600 dark:text-blue-400"
                bg="bg-blue-50 dark:bg-blue-900/20"
              />
              <SummaryCard
                icon={<Users className="w-5 h-5" />}
                label={t('report.totalGuests') || 'Total Guests'}
                value={String(summary.totalGuests)}
                color="text-brand-600 dark:text-brand-400"
                bg="bg-brand-50 dark:bg-brand-900/20"
              />
              <SummaryCard
                icon={<UtensilsCrossed className="w-5 h-5" />}
                label={t('report.fnbRevenue') || 'F&B Revenue'}
                value={formatCurrency(summary.fnbRevenue)}
                sub={`${t('report.timeRevenue') || 'Time'}: ${formatCurrency(summary.timeRevenue)}`}
                color="text-orange-600 dark:text-orange-400"
                bg="bg-orange-50 dark:bg-orange-900/20"
              />
            </div>

            {/* Session type breakdown */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Timer className="w-4 h-4 text-blue-500" />
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                    {t('report.perMinute') || 'Per-minute'}
                  </span>
                </div>
                <p className="text-2xl font-bold text-gray-900 dark:text-white tabular-nums">
                  {summary.perMinuteSessionCount}
                </p>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Package className="w-4 h-4 text-brand-500" />
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                    {t('report.package') || 'Package/Combo'}
                  </span>
                </div>
                <p className="text-2xl font-bold text-gray-900 dark:text-white tabular-nums">
                  {summary.packageSessionCount}
                </p>
              </div>
            </div>

            {/* Table Utilization */}
            {data.tableUtilization.length > 0 && (
              <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                    {t('report.tableUtilization') || 'Table Utilization'}
                  </h3>
                </div>
                <div className="divide-y divide-gray-100 dark:divide-gray-700">
                  {data.tableUtilization.map((table) => (
                    <div key={table.resourceId} className="px-3 py-2 flex items-center gap-3">
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200 min-w-[80px]">
                        {table.tableName}
                      </span>
                      <div className="flex-1 h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, (table.totalRevenue / Math.max(...data.tableUtilization.map((tu) => tu.totalRevenue), 1)) * 100)}%`,
                          }}
                        />
                      </div>
                      <span className="text-xs font-mono tabular-nums text-gray-600 dark:text-gray-400 min-w-[50px] text-right">
                        {table.sessionCount} {t('report.sessionsShort') || 'ses'}
                      </span>
                      <span className="text-xs font-mono tabular-nums text-gray-500 dark:text-gray-500 min-w-[50px] text-right">
                        {formatMinutes(table.totalMinutes)}
                      </span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-white tabular-nums min-w-[80px] text-right">
                        {formatCurrency(table.totalRevenue)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Top F&B Items */}
            {data.topFnbItems.length > 0 && (
              <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                    {t('report.topFnb') || 'Top F&B Items'}
                  </h3>
                </div>
                <div className="divide-y divide-gray-100 dark:divide-gray-700">
                  {data.topFnbItems.map((item, i) => (
                    <div key={item.name} className="px-3 py-2 flex items-center gap-3">
                      <span className="text-xs font-bold text-gray-400 dark:text-gray-500 w-5 text-center">
                        {i + 1}
                      </span>
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200 flex-1 truncate">
                        {item.name}
                      </span>
                      <span className="text-xs font-mono tabular-nums text-gray-500 dark:text-gray-400">
                        x{item.totalQuantity}
                      </span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-white tabular-nums min-w-[80px] text-right">
                        {formatCurrency(item.totalRevenue)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Hourly Breakdown — CSS bar chart */}
            {data.hourlyBreakdown.length > 0 && (
              <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                    {t('report.hourlyBreakdown') || 'Hourly Breakdown'}
                  </h3>
                </div>
                <div className="px-3 py-3">
                  <div className="flex items-end gap-1 h-28">
                    {Array.from({ length: 24 }, (_, h) => {
                      const entry = data.hourlyBreakdown.find((e) => e.hour === h);
                      const revenue = entry?.revenue || 0;
                      const count = entry?.sessionCount || 0;
                      const pct = (revenue / maxHourlyRevenue) * 100;
                      return (
                        <div
                          key={h}
                          className="flex-1 flex flex-col items-center gap-0.5 group relative"
                        >
                          <div
                            className={`w-full rounded-t transition-all ${
                              revenue > 0
                                ? 'bg-blue-500 dark:bg-blue-400 group-hover:bg-blue-600 dark:group-hover:bg-blue-300'
                                : 'bg-gray-100 dark:bg-gray-700'
                            }`}
                            style={{ height: `${Math.max(revenue > 0 ? 4 : 2, pct)}%` }}
                            title={`${h}:00 — ${formatCurrency(revenue)} (${count} ses)`}
                          />
                          {h % 3 === 0 && (
                            <span className="text-[9px] text-gray-400 dark:text-gray-500 tabular-nums">
                              {h}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Empty state */}
            {summary.sessionCount === 0 && (
              <div className="text-center py-8 text-gray-400 dark:text-gray-500">
                <BarChart3 className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">{t('report.noData') || 'No sessions found for this period'}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Reusable stat card */
function SummaryCard({
  icon, label, value, sub, color, bg,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  color: string;
  bg: string;
}) {
  return (
    <div className={`${bg} rounded-lg border border-gray-200 dark:border-gray-700 p-3`}>
      <div className={`flex items-center gap-2 mb-1 ${color}`}>
        {icon}
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{label}</span>
      </div>
      <p className="text-xl font-bold text-gray-900 dark:text-white tabular-nums">{value}</p>
      {sub && <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}
