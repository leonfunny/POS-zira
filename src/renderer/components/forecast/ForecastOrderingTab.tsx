import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Download,
  PackagePlus,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  TrendingUp,
} from 'lucide-react';
import type {
  ForecastOrderDraftDTO,
  ForecastOrderDraftLineInput,
  ForecastRecommendationDTO,
  ForecastRiskLevel,
  TodaySalesReportDTO,
  WarehouseDocument,
  WarehouseDocumentCreateInput,
  WarehouseInfo,
} from '../../../shared/types';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useForecastOrdering } from '../../hooks/useForecastOrdering';

interface ForecastOrderingTabProps {
  language: Language;
}

const FORECAST_ROW_RENDER_LIMIT = 300;
const FORECAST_DRAFT_LINE_RENDER_LIMIT = 200;

interface PolicyDraft {
  leadTimeDays: number;
  safetyStockDays: number;
  minDisplayQty: number;
  packSize: number;
  maxStock: string;
  supplierName: string;
}

interface DraftLineState extends ForecastOrderDraftLineInput {
  selected: boolean;
}

type RiskFilter = ForecastRiskLevel | 'all';

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatQty(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function formatMoney(amountGrosze: number, currency: string): string {
  return `${((Number(amountGrosze) || 0) / 100).toFixed(2)} ${currency}`;
}

function riskClass(risk: ForecastRiskLevel): string {
  switch (risk) {
    case 'stockout': return 'border-rose-200 bg-rose-50 text-rose-700';
    case 'reorder': return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'watch': return 'border-sky-200 bg-sky-50 text-sky-700';
    default: return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  }
}

function createDraft(rec: ForecastRecommendationDTO | null): PolicyDraft {
  return {
    leadTimeDays: rec?.leadTimeDays ?? 1,
    safetyStockDays: rec?.safetyStockDays ?? 1,
    minDisplayQty: rec?.minDisplayQty ?? 0,
    packSize: rec?.packSize ?? 1,
    maxStock: rec?.maxStock == null ? '' : String(rec.maxStock),
    supplierName: rec?.supplierName ?? '',
  };
}

function downloadCsv(csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `forecast-order-${todayISO()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function draftLineFromRecommendation(rec: ForecastRecommendationDTO): DraftLineState {
  const unitValue = rec.suggestedOrderQty > 0
    ? Math.round(rec.estimatedRetailValue / rec.suggestedOrderQty)
    : 0;
  return {
    selected: true,
    variantId: rec.variantId,
    name: rec.name,
    sku: rec.sku,
    barcode: rec.barcode,
    supplierName: rec.supplierName,
    stockOnHand: rec.stockOnHand,
    velocity7d: rec.velocity7d,
    velocity30d: rec.velocity30d,
    suggestedOrderQty: rec.suggestedOrderQty,
    orderQty: rec.suggestedOrderQty,
    unitValue,
    reason: rec.reason,
  };
}

export default function ForecastOrderingTab({ language }: ForecastOrderingTabProps) {
  const { t } = useTranslation(language);
  const currency = tOr(t, 'pos.currency', 'zl');
  const [asOfDate, setAsOfDate] = useState(todayISO());
  const [horizonDays, setHorizonDays] = useState(3);
  const [historyDays, setHistoryDays] = useState(90);
  const [query, setQuery] = useState('');
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const [onlySuggested, setOnlySuggested] = useState(true);
  const [selected, setSelected] = useState<ForecastRecommendationDTO | null>(null);
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft>(createDraft(null));
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [todaySales, setTodaySales] = useState<TodaySalesReportDTO | null>(null);
  const [todaySalesLoading, setTodaySalesLoading] = useState(false);
  const [todaySalesError, setTodaySalesError] = useState<string | null>(null);
  const [draftLines, setDraftLines] = useState<DraftLineState[]>([]);
  const [draftNotes, setDraftNotes] = useState('');
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [savedDraft, setSavedDraft] = useState<ForecastOrderDraftDTO | null>(null);
  const [recentDrafts, setRecentDrafts] = useState<ForecastOrderDraftDTO[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseInfo[]>([]);
  const [warehouseValue, setWarehouseValue] = useState('MAIN');
  const [warehouseError, setWarehouseError] = useState<string | null>(null);
  const [creatingPz, setCreatingPz] = useState(false);
  const [createdPz, setCreatedPz] = useState<WarehouseDocument | null>(null);
  const [pzError, setPzError] = useState<string | null>(null);

  const { data, loading, refreshing, error, recompute, savePolicy } = useForecastOrdering({
    asOfDate,
    horizonDays,
    historyDays,
  });

  const recommendations = data?.recommendations ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return recommendations.filter((rec) => {
      if (onlySuggested && rec.suggestedOrderQty <= 0) return false;
      if (riskFilter !== 'all' && rec.riskLevel !== riskFilter) return false;
      if (!needle) return true;
      return (
        rec.name.toLowerCase().includes(needle)
        || (rec.sku || '').toLowerCase().includes(needle)
        || (rec.barcode || '').toLowerCase().includes(needle)
        || (rec.categoryName || '').toLowerCase().includes(needle)
      );
    });
  }, [onlySuggested, query, recommendations, riskFilter]);
  const displayedRecommendations = useMemo(
    () => filtered.slice(0, FORECAST_ROW_RENDER_LIMIT),
    [filtered],
  );
  const displayedDraftLines = useMemo(
    () => draftLines.slice(0, FORECAST_DRAFT_LINE_RENDER_LIMIT),
    [draftLines],
  );

  const summary = useMemo(() => {
    const reorderCount = recommendations.filter((rec) => rec.suggestedOrderQty > 0).length;
    const stockoutCount = recommendations.filter((rec) => rec.riskLevel === 'stockout').length;
    const confidence = recommendations.length
      ? recommendations.reduce((sum, rec) => sum + rec.confidence, 0) / recommendations.length
      : 0;
    return { reorderCount, stockoutCount, confidence };
  }, [recommendations]);

  const topTodaySales = useMemo(() => (todaySales?.items ?? []).slice(0, 8), [todaySales]);
  const activeDraftLines = useMemo(
    () => draftLines.filter((line) => line.selected && line.orderQty > 0),
    [draftLines],
  );
  const draftTotals = useMemo(() => ({
    itemCount: activeDraftLines.length,
    totalQty: activeDraftLines.reduce((sum, line) => sum + line.orderQty, 0),
    totalValue: activeDraftLines.reduce((sum, line) => sum + line.orderQty * line.unitValue, 0),
  }), [activeDraftLines]);

  useEffect(() => {
    if (!selected) return;
    const fresh = recommendations.find((rec) => rec.variantId === selected.variantId) ?? null;
    setSelected(fresh);
  }, [recommendations, selected?.variantId]);

  useEffect(() => {
    setPolicyDraft(createDraft(selected));
    setPolicyError(null);
  }, [selected?.variantId, selected?.runId]);

  useEffect(() => {
    const nextLines = recommendations
      .filter((rec) => rec.suggestedOrderQty > 0)
      .map(draftLineFromRecommendation);
    setDraftLines(nextLines);
    setDraftError(null);
  }, [data?.run.id]);

  const loadRecentDrafts = async () => {
    const result = await window.electronAPI.forecast.listOrderDrafts(5);
    if (result.success && result.data) setRecentDrafts(result.data);
  };

  useEffect(() => {
    void loadRecentDrafts();
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.warehouse.warehouses.list()
      .then((result: { success: boolean; data?: { warehouses: WarehouseInfo[] }; error?: string }) => {
        if (cancelled) return;
        if (!result.success || !result.data?.warehouses?.length) {
          setWarehouseError(result.error || 'Warehouse backend is not available yet.');
          return;
        }
        const activeWarehouses = result.data.warehouses.filter((warehouse: WarehouseInfo) => warehouse.isActive !== false);
        setWarehouses(activeWarehouses);
        const preferred = activeWarehouses.find((warehouse: WarehouseInfo) => warehouse.isDefault) || activeWarehouses[0];
        if (preferred) setWarehouseValue(preferred.id || preferred.code);
        setWarehouseError(null);
      })
      .catch((err: any) => setWarehouseError(err?.message || 'Warehouse backend is not available yet.'));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setTodaySalesLoading(true);
    setTodaySalesError(null);
    window.electronAPI.forecast.getTodaySales(asOfDate)
      .then((result: { success: boolean; data?: TodaySalesReportDTO; error?: string }) => {
        if (cancelled) return;
        if (!result.success || !result.data) {
          throw new Error(result.error || 'Could not load today sales');
        }
        setTodaySales(result.data);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setTodaySales(null);
        setTodaySalesError(err?.message || 'Could not load today sales');
      })
      .finally(() => {
        if (!cancelled) setTodaySalesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [asOfDate]);

  const handleExport = async () => {
    const result = await window.electronAPI.forecast.exportCsv(filtered);
    if (result.success && result.data) downloadCsv(result.data);
  };

  const handleSavePolicy = async () => {
    if (!selected) return;
    setSavingPolicy(true);
    setPolicyError(null);
    try {
      await savePolicy({
        variantId: selected.variantId,
        leadTimeDays: policyDraft.leadTimeDays,
        safetyStockDays: policyDraft.safetyStockDays,
        minDisplayQty: policyDraft.minDisplayQty,
        packSize: policyDraft.packSize,
        maxStock: policyDraft.maxStock.trim() ? Number(policyDraft.maxStock) : null,
        supplierName: policyDraft.supplierName.trim() || null,
      });
    } catch (err: any) {
      setPolicyError(err?.message || 'Could not save policy');
    } finally {
      setSavingPolicy(false);
    }
  };

  const updateDraftLine = (variantId: string, patch: Partial<DraftLineState>) => {
    setDraftLines((lines) => lines.map((line) => (
      line.variantId === variantId ? { ...line, ...patch } : line
    )));
  };

  const handleSaveDraft = async () => {
    if (!data?.run) return;
    setDraftSaving(true);
    setDraftError(null);
    try {
      const lines = activeDraftLines.map(({ selected: _selected, ...line }) => line);
      const result = await window.electronAPI.forecast.createOrderDraft({
        sourceRunId: data.run.id,
        asOfDate,
        notes: draftNotes.trim() || null,
        lines,
      });
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Could not save draft');
      }
      setSavedDraft(result.data);
      setCreatedPz(null);
      setPzError(null);
      setDraftNotes('');
      await loadRecentDrafts();
    } catch (err: any) {
      setDraftError(err?.message || 'Could not save draft');
    } finally {
      setDraftSaving(false);
    }
  };

  const selectedWarehouse = warehouses.find((warehouse) => (
    warehouse.id === warehouseValue || warehouse.code === warehouseValue
  ));

  const handleCreatePzDraft = async () => {
    if (!savedDraft) return;
    setCreatingPz(true);
    setPzError(null);
    setCreatedPz(null);
    try {
      const supplierNames = Array.from(new Set(savedDraft.lines.map((line) => line.supplierName).filter(Boolean)));
      const payload: WarehouseDocumentCreateInput = {
        type: 'PZ',
        warehouseId: selectedWarehouse?.id,
        warehouseCode: selectedWarehouse?.code || warehouseValue || undefined,
        contractorName: supplierNames.length === 1 ? supplierNames[0] || undefined : undefined,
        sourceDocumentNo: `Forecast ${savedDraft.asOfDate}`,
        issueDate: new Date().toISOString(),
        operationDate: new Date().toISOString(),
        notes: [
          `Forecast order draft ${savedDraft.id}`,
          savedDraft.notes || '',
        ].filter(Boolean).join('\n'),
        lines: savedDraft.lines.map((line) => ({
          productVariantId: line.variantId,
          sku: line.sku,
          barcode: line.barcode,
          name: line.name,
          unit: 'szt',
          quantity: Math.max(0, line.orderQty),
          unitCostGrosze: Math.max(0, Math.round(line.unitValue || 0)),
          bookStock: Math.max(0, Math.round(line.stockOnHand || 0)),
        })),
        idempotencyKey: `forecast-pz-${savedDraft.id}`,
      };
      const result = await window.electronAPI.warehouse.documents.create(payload);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Could not create PZ draft');
      }
      setCreatedPz(result.data);
    } catch (err: any) {
      setPzError(err?.message || 'Could not create PZ draft');
    } finally {
      setCreatingPz(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">
            {tOr(t, 'forecast.title', 'Forecast ordering')}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {tOr(t, 'forecast.subtitle', 'Sales forecast and suggested daily replenishment.')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-slate-600">
          <span className="rounded-md border border-slate-200 bg-white px-3 py-2">
            {data?.run.itemCount ?? 0} {tOr(t, 'forecast.items', 'items')}
          </span>
          <span className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-700">
            {data?.run.totalSuggestedQty ?? 0} {tOr(t, 'forecast.units', 'units')}
          </span>
          <span className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sky-700">
            {formatMoney(data?.run.totalEstimatedRetailValue ?? 0, currency)}
          </span>
        </div>
      </header>

      <section className="rounded-md border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-950">
              {tOr(t, 'forecast.todaySales', 'Sold today')}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {asOfDate} · {todaySales?.totalOrders ?? 0} {tOr(t, 'forecast.orders', 'orders')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
              {todaySales?.itemCount ?? 0} {tOr(t, 'forecast.items', 'items')}
            </span>
            <span className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-700">
              {formatQty(todaySales?.totalUnits ?? 0)} {tOr(t, 'forecast.units', 'units')}
            </span>
            <span className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sky-700">
              {formatMoney(todaySales?.totalRevenue ?? 0, currency)}
            </span>
          </div>
        </div>

        {todaySalesError ? (
          <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {todaySalesError}
          </div>
        ) : todaySalesLoading ? (
          <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
            {tOr(t, 'forecast.loadingTodaySales', 'Loading today sales...')}
          </div>
        ) : topTodaySales.length === 0 ? (
          <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
            {tOr(t, 'forecast.noSalesToday', 'No item sales for this date')}
          </div>
        ) : (
          <div className="mt-3 overflow-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-normal text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">{tOr(t, 'forecast.product', 'Product')}</th>
                  <th className="px-3 py-2 text-right">{tOr(t, 'forecast.sold', 'Sold')}</th>
                  <th className="px-3 py-2 text-right">{tOr(t, 'forecast.revenue', 'Revenue')}</th>
                  <th className="px-3 py-2 text-right">{tOr(t, 'forecast.velocity7d', 'Velocity 7d')}</th>
                  <th className="px-3 py-2 text-right">{tOr(t, 'forecast.velocity30d', 'Velocity 30d')}</th>
                  <th className="px-3 py-2 text-right">{tOr(t, 'forecast.stock', 'Stock')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {topTodaySales.map((item) => (
                  <tr key={item.variantId}>
                    <td className="px-3 py-2">
                      <div className="max-w-[360px] truncate font-medium text-slate-900">{item.name}</div>
                      <div className="mt-0.5 truncate text-xs text-slate-500">
                        {[item.sku, item.barcode, item.categoryName].filter(Boolean).join(' / ') || '-'}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-950">{formatQty(item.quantity)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatMoney(item.revenue, currency)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatQty(item.velocity7d)}/d</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatQty(item.velocity30d)}/d</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatQty(item.stockOnHand)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <div className="rounded-md border border-slate-200 bg-white p-3">
          <div className="text-xs uppercase tracking-normal text-slate-500">{tOr(t, 'forecast.reorder', 'Reorder')}</div>
          <div className="mt-1 text-2xl font-semibold text-slate-950">{summary.reorderCount}</div>
        </div>
        <div className="rounded-md border border-slate-200 bg-white p-3">
          <div className="text-xs uppercase tracking-normal text-slate-500">{tOr(t, 'forecast.stockouts', 'Stockouts')}</div>
          <div className="mt-1 text-2xl font-semibold text-rose-700">{summary.stockoutCount}</div>
        </div>
        <div className="rounded-md border border-slate-200 bg-white p-3">
          <div className="text-xs uppercase tracking-normal text-slate-500">{tOr(t, 'forecast.confidence', 'Confidence')}</div>
          <div className="mt-1 text-2xl font-semibold text-slate-950">{Math.round(summary.confidence * 100)}%</div>
        </div>
        <div className="rounded-md border border-slate-200 bg-white p-3">
          <div className="text-xs uppercase tracking-normal text-slate-500">{tOr(t, 'forecast.generated', 'Generated')}</div>
          <div className="mt-1 truncate text-sm font-medium text-slate-700">
            {data?.run.generatedAt ? new Date(data.run.generatedAt).toLocaleString() : '-'}
          </div>
        </div>
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[140px] text-xs font-medium text-slate-600">
            {tOr(t, 'forecast.asOf', 'As of')}
            <input
              type="date"
              value={asOfDate}
              onChange={(event) => setAsOfDate(event.target.value)}
              className="mt-1 w-full rounded-md border border-slate-200 px-2 py-2 text-sm text-slate-900"
            />
          </label>
          <label className="w-28 text-xs font-medium text-slate-600">
            {tOr(t, 'forecast.horizon', 'Days')}
            <input
              type="number"
              min={1}
              max={14}
              value={horizonDays}
              onChange={(event) => setHorizonDays(Number(event.target.value))}
              className="mt-1 w-full rounded-md border border-slate-200 px-2 py-2 text-sm text-slate-900"
            />
          </label>
          <label className="w-32 text-xs font-medium text-slate-600">
            {tOr(t, 'forecast.history', 'History')}
            <select
              value={historyDays}
              onChange={(event) => setHistoryDays(Number(event.target.value))}
              className="mt-1 w-full rounded-md border border-slate-200 px-2 py-2 text-sm text-slate-900"
            >
              <option value={30}>30</option>
              <option value={60}>60</option>
              <option value={90}>90</option>
              <option value={180}>180</option>
            </select>
          </label>
          <div className="relative min-w-[220px] flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-9 text-slate-400" />
            <label className="text-xs font-medium text-slate-600">
              {tOr(t, 'forecast.search', 'Search')}
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tOr(t, 'forecast.searchPlaceholder', 'Name, SKU, barcode...')}
                className="mt-1 w-full rounded-md border border-slate-200 py-2 pl-9 pr-3 text-sm text-slate-900"
              />
            </label>
          </div>
          <label className="w-36 text-xs font-medium text-slate-600">
            {tOr(t, 'forecast.risk', 'Risk')}
            <select
              value={riskFilter}
              onChange={(event) => setRiskFilter(event.target.value as RiskFilter)}
              className="mt-1 w-full rounded-md border border-slate-200 px-2 py-2 text-sm text-slate-900"
            >
              <option value="all">{tOr(t, 'forecast.all', 'All')}</option>
              <option value="stockout">Stockout</option>
              <option value="reorder">Reorder</option>
              <option value="watch">Watch</option>
              <option value="ok">OK</option>
            </select>
          </label>
          <label className="flex h-10 items-center gap-2 rounded-md border border-slate-200 px-3 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={onlySuggested}
              onChange={(event) => setOnlySuggested(event.target.checked)}
            />
            {tOr(t, 'forecast.onlySuggested', 'Suggested')}
          </label>
          <button
            type="button"
            onClick={() => void recompute()}
            disabled={refreshing}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            {tOr(t, 'forecast.refresh', 'Refresh')}
          </button>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={filtered.length === 0}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-slate-950 px-3 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            <Download size={16} />
            CSV
          </button>
        </div>
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
              <PackagePlus size={16} />
              {tOr(t, 'forecast.orderDraft', 'Order draft')}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {draftTotals.itemCount} {tOr(t, 'forecast.items', 'items')} · {draftTotals.totalQty} {tOr(t, 'forecast.units', 'units')} · {formatMoney(draftTotals.totalValue, currency)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              value={draftNotes}
              onChange={(event) => setDraftNotes(event.target.value)}
              placeholder={tOr(t, 'forecast.draftNotes', 'Notes for supplier/order...')}
              className="h-10 min-w-[240px] rounded-md border border-slate-200 px-3 text-sm text-slate-900"
            />
            <button
              type="button"
              onClick={() => void handleSaveDraft()}
              disabled={draftSaving || activeDraftLines.length === 0}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-slate-950 px-3 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              <Save size={16} />
              {draftSaving ? tOr(t, 'forecast.saving', 'Saving...') : tOr(t, 'forecast.saveDraft', 'Save draft')}
            </button>
          </div>
        </div>

        {draftError ? (
          <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {draftError}
          </div>
        ) : null}
        {savedDraft ? (
          <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {tOr(t, 'forecast.draftSaved', 'Draft saved')} · {savedDraft.itemCount} {tOr(t, 'forecast.items', 'items')} · {formatMoney(savedDraft.totalEstimatedRetailValue, currency)}
          </div>
        ) : null}

        {savedDraft ? (
          <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-[220px] text-xs font-medium text-slate-600">
                {tOr(t, 'forecast.targetWarehouse', 'Target warehouse')}
                <select
                  value={warehouseValue}
                  onChange={(event) => setWarehouseValue(event.target.value)}
                  className="mt-1 h-10 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900"
                >
                  {warehouses.length === 0 ? (
                    <option value={warehouseValue}>{warehouseValue}</option>
                  ) : warehouses.map((warehouse) => (
                    <option key={warehouse.id || warehouse.code} value={warehouse.id || warehouse.code}>
                      {warehouse.code} · {warehouse.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void handleCreatePzDraft()}
                disabled={creatingPz || savedDraft.lines.length === 0}
                className="inline-flex h-10 items-center gap-2 rounded-md border border-emerald-200 bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <PackagePlus size={16} />
                {creatingPz ? tOr(t, 'forecast.creatingPz', 'Creating PZ...') : tOr(t, 'forecast.createPz', 'Create PZ draft')}
              </button>
            </div>
            {warehouseError ? (
              <div className="mt-2 text-xs text-amber-700">{warehouseError}</div>
            ) : null}
            {pzError ? (
              <div className="mt-2 text-xs text-rose-700">{pzError}</div>
            ) : null}
            {createdPz ? (
              <div className="mt-2 text-xs text-emerald-700">
                {tOr(t, 'forecast.pzCreated', 'PZ draft created')} · {createdPz.number || createdPz.id}
              </div>
            ) : null}
          </div>
        ) : null}

        {draftLines.length === 0 ? (
          <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
            {tOr(t, 'forecast.noDraftItems', 'No reorder items to draft.')}
          </div>
        ) : (
          <div className="mt-3 max-h-64 overflow-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-normal text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">{tOr(t, 'forecast.product', 'Product')}</th>
                  <th className="px-3 py-2 text-right">{tOr(t, 'forecast.suggested', 'Suggested')}</th>
                  <th className="px-3 py-2 text-right">{tOr(t, 'forecast.orderQty', 'Order')}</th>
                  <th className="px-3 py-2 text-right">{tOr(t, 'forecast.velocity7d', 'Velocity 7d')}</th>
                  <th className="px-3 py-2 text-left">{tOr(t, 'forecast.supplier', 'Supplier')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {displayedDraftLines.map((line) => (
                  <tr key={line.variantId} className={!line.selected ? 'opacity-50' : ''}>
                    <td className="px-3 py-2">
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={line.selected}
                          onChange={(event) => updateDraftLine(line.variantId, { selected: event.target.checked })}
                          className="mt-1"
                        />
                        <span>
                          <span className="block max-w-[360px] truncate font-medium text-slate-900">{line.name}</span>
                          <span className="mt-0.5 block truncate text-xs text-slate-500">
                            {[line.sku, line.barcode].filter(Boolean).join(' / ') || '-'}
                          </span>
                        </span>
                      </label>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{line.suggestedOrderQty}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        value={line.orderQty}
                        onChange={(event) => updateDraftLine(line.variantId, { orderQty: Math.max(0, Math.round(Number(event.target.value) || 0)) })}
                        className="h-8 w-20 rounded-md border border-slate-200 px-2 text-right text-sm"
                      />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatQty(line.velocity7d)}/d</td>
                    <td className="px-3 py-2 text-slate-700">{line.supplierName || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {displayedDraftLines.length < draftLines.length ? (
              <div className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
                {tOr(t, 'forecast.renderLimit', 'Showing first')} {displayedDraftLines.length} / {draftLines.length}.
              </div>
            ) : null}
          </div>
        )}

        {recentDrafts.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
            {recentDrafts.map((draft) => (
              <span key={draft.id} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1">
                {new Date(draft.createdAt).toLocaleString()} · {draft.totalQty} {tOr(t, 'forecast.units', 'units')} · {formatMoney(draft.totalEstimatedRetailValue, currency)}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      {data?.run.warnings.length ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <div className="flex gap-2">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span>{data.run.warnings.slice(0, 2).join(' ')}</span>
          </div>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-h-0 overflow-hidden rounded-md border border-slate-200 bg-white">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              {tOr(t, 'forecast.loading', 'Loading forecast...')}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center">
              <div className="px-6">
                <TrendingUp size={42} className="mx-auto mb-3 text-slate-300" />
                <div className="text-sm font-medium text-slate-600">
                  {tOr(t, 'forecast.empty', 'No recommendations found')}
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full overflow-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50 text-xs uppercase tracking-normal text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">{tOr(t, 'forecast.product', 'Product')}</th>
                    <th className="px-3 py-2 text-right">{tOr(t, 'forecast.stock', 'Stock')}</th>
                    <th className="px-3 py-2 text-right">{tOr(t, 'forecast.velocity7d', 'Velocity 7d')}</th>
                    <th className="px-3 py-2 text-right">{tOr(t, 'forecast.forecast', 'Forecast')}</th>
                    <th className="px-3 py-2 text-right">{tOr(t, 'forecast.target', 'Target')}</th>
                    <th className="px-3 py-2 text-right">{tOr(t, 'forecast.orderQty', 'Order')}</th>
                    <th className="px-3 py-2 text-left">{tOr(t, 'forecast.risk', 'Risk')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {displayedRecommendations.map((rec) => (
                    <tr
                      key={rec.id}
                      onClick={() => setSelected(rec)}
                      className={`cursor-pointer hover:bg-slate-50 ${selected?.id === rec.id ? 'bg-sky-50' : ''}`}
                    >
                      <td className="px-3 py-2">
                        <div className="max-w-[360px] truncate font-medium text-slate-900">{rec.name}</div>
                        <div className="mt-0.5 truncate text-xs text-slate-500">
                          {[rec.sku, rec.barcode, rec.categoryName].filter(Boolean).join(' / ') || '-'}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatQty(rec.stockOnHand)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatQty(rec.velocity7d)}/d</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatQty(rec.forecastUnits)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatQty(rec.targetStock)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-950">{rec.suggestedOrderQty}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-medium ${riskClass(rec.riskLevel)}`}>
                          {rec.riskLevel}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {displayedRecommendations.length < filtered.length ? (
                <div className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
                  {tOr(t, 'forecast.renderLimit', 'Showing first')} {displayedRecommendations.length} / {filtered.length}.{' '}
                  {tOr(t, 'forecast.renderLimitHint', 'Use search or filters to narrow the list.')}
                </div>
              ) : null}
            </div>
          )}
        </section>

        <aside className="min-h-0 overflow-auto rounded-md border border-slate-200 bg-white p-4">
          {selected ? (
            <div className="flex flex-col gap-4">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-slate-950">{selected.name}</h2>
                    <p className="mt-1 text-xs text-slate-500">{selected.sku || selected.barcode || '-'}</p>
                  </div>
                  <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-medium ${riskClass(selected.riskLevel)}`}>
                    {selected.riskLevel}
                  </span>
                </div>
                <p className="mt-3 text-sm text-slate-600">{selected.reason}</p>
              </div>

              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-md border border-slate-200 p-2">
                  <div className="text-xs text-slate-500">{tOr(t, 'forecast.avgDaily', 'Daily avg')}</div>
                  <div className="font-semibold text-slate-900">{formatQty(selected.avgDailyDemand)}</div>
                </div>
                <div className="rounded-md border border-slate-200 p-2">
                  <div className="text-xs text-slate-500">{tOr(t, 'forecast.velocity7d', 'Velocity 7d')}</div>
                  <div className="font-semibold text-slate-900">{formatQty(selected.velocity7d)}/d</div>
                </div>
                <div className="rounded-md border border-slate-200 p-2">
                  <div className="text-xs text-slate-500">{tOr(t, 'forecast.velocity30d', 'Velocity 30d')}</div>
                  <div className="font-semibold text-slate-900">{formatQty(selected.velocity30d)}/d</div>
                </div>
                <div className="rounded-md border border-slate-200 p-2">
                  <div className="text-xs text-slate-500">{tOr(t, 'forecast.value', 'Value')}</div>
                  <div className="font-semibold text-slate-900">{formatMoney(selected.estimatedRetailValue, currency)}</div>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <SlidersHorizontal size={16} />
                  {tOr(t, 'forecast.policy', 'Policy')}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs font-medium text-slate-600">
                    {tOr(t, 'forecast.leadTime', 'Lead time')}
                    <input
                      type="number"
                      min={0}
                      value={policyDraft.leadTimeDays}
                      onChange={(event) => setPolicyDraft((draft) => ({ ...draft, leadTimeDays: Number(event.target.value) }))}
                      className="mt-1 w-full rounded-md border border-slate-200 px-2 py-2 text-sm"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-600">
                    {tOr(t, 'forecast.safety', 'Safety')}
                    <input
                      type="number"
                      min={0}
                      value={policyDraft.safetyStockDays}
                      onChange={(event) => setPolicyDraft((draft) => ({ ...draft, safetyStockDays: Number(event.target.value) }))}
                      className="mt-1 w-full rounded-md border border-slate-200 px-2 py-2 text-sm"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-600">
                    {tOr(t, 'forecast.minDisplay', 'Min display')}
                    <input
                      type="number"
                      min={0}
                      value={policyDraft.minDisplayQty}
                      onChange={(event) => setPolicyDraft((draft) => ({ ...draft, minDisplayQty: Number(event.target.value) }))}
                      className="mt-1 w-full rounded-md border border-slate-200 px-2 py-2 text-sm"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-600">
                    {tOr(t, 'forecast.packSize', 'Pack')}
                    <input
                      type="number"
                      min={1}
                      value={policyDraft.packSize}
                      onChange={(event) => setPolicyDraft((draft) => ({ ...draft, packSize: Number(event.target.value) }))}
                      className="mt-1 w-full rounded-md border border-slate-200 px-2 py-2 text-sm"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-600">
                    {tOr(t, 'forecast.maxStock', 'Max stock')}
                    <input
                      value={policyDraft.maxStock}
                      onChange={(event) => setPolicyDraft((draft) => ({ ...draft, maxStock: event.target.value }))}
                      className="mt-1 w-full rounded-md border border-slate-200 px-2 py-2 text-sm"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-600">
                    {tOr(t, 'forecast.supplier', 'Supplier')}
                    <input
                      value={policyDraft.supplierName}
                      onChange={(event) => setPolicyDraft((draft) => ({ ...draft, supplierName: event.target.value }))}
                      className="mt-1 w-full rounded-md border border-slate-200 px-2 py-2 text-sm"
                    />
                  </label>
                </div>
                {policyError ? <div className="mt-2 text-xs text-rose-700">{policyError}</div> : null}
                <button
                  type="button"
                  onClick={() => void handleSavePolicy()}
                  disabled={savingPolicy}
                  className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-slate-950 px-3 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  <Save size={16} />
                  {savingPolicy ? tOr(t, 'forecast.saving', 'Saving...') : tOr(t, 'forecast.savePolicy', 'Save policy')}
                </button>
              </div>

              {selected.warnings.length ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  {selected.warnings.join(' ')}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-sm text-slate-500">
              {tOr(t, 'forecast.selectItem', 'Select an item')}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
