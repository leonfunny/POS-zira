/**
 * StockManager — F&B inventory tracking for billiard venue.
 *
 * View all stock levels, edit quantities inline, set low-stock
 * thresholds, and see alerts for items running low.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Package, X, RefreshCw, AlertTriangle, Save, Plus,
  ChevronDown, ChevronUp, Search,
} from 'lucide-react';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';

/* ─── Types ──────────────────────────────────────────── */

interface StockRow {
  variant_id: string;
  variant_name: string;
  quantity: number;
  low_threshold: number;
  unit: string;
  updated_at: string;
}

type SortField = 'name' | 'quantity' | 'threshold';
type SortDir = 'asc' | 'desc';

/* ─── Component ────────────────────────────────────────── */

interface StockManagerProps {
  language: Language;
  onClose?: () => void;
}

export function StockManager({ language, onClose }: StockManagerProps) {
  const { t } = useTranslation(language);

  const [items, setItems] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQty, setEditQty] = useState('');
  const [editThreshold, setEditThreshold] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newQty, setNewQty] = useState('0');
  const [newThreshold, setNewThreshold] = useState('5');
  const [newUnit, setNewUnit] = useState('szt');

  const fetchStock = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.stock?.getAll?.();
      if (result?.success && result.data) {
        setItems(result.data);
      } else {
        setError(result?.error || 'Failed to load stock');
      }
    } catch (e: any) {
      setError(e.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStock();
  }, [fetchStock]);

  const handleSave = async (row: StockRow) => {
    const qty = Number(editQty);
    const threshold = Number(editThreshold);
    if (isNaN(qty) || isNaN(threshold) || qty < 0 || threshold < 0) return;

    try {
      await window.electronAPI?.stock?.update?.({
        variantId: row.variant_id,
        variantName: row.variant_name,
        quantity: qty,
        lowThreshold: threshold,
        unit: row.unit,
      });
      setEditingId(null);
      fetchStock();
    } catch { /* ignore */ }
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    try {
      await window.electronAPI?.stock?.update?.({
        variantId: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        variantName: newName.trim(),
        quantity: Math.max(0, Number(newQty) || 0),
        lowThreshold: Math.max(0, Number(newThreshold) || 5),
        unit: newUnit || 'szt',
      });
      setShowAddForm(false);
      setNewName('');
      setNewQty('0');
      setNewThreshold('5');
      setNewUnit('szt');
      fetchStock();
    } catch { /* ignore */ }
  };

  const startEdit = (row: StockRow) => {
    setEditingId(row.variant_id);
    setEditQty(String(row.quantity));
    setEditThreshold(String(row.low_threshold));
  };

  const cancelEdit = () => setEditingId(null);

  // Escape key cancels edit mode
  useEffect(() => {
    if (!editingId) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelEdit(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [editingId]);

  // Sorting
  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === 'asc'
      ? <ChevronUp className="w-3 h-3 inline ml-0.5" />
      : <ChevronDown className="w-3 h-3 inline ml-0.5" />;
  };

  // Filter + sort
  const filtered = items
    .filter((i) => !search || i.variant_name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      switch (sortField) {
        case 'name': return a.variant_name.localeCompare(b.variant_name) * dir;
        case 'quantity': return (a.quantity - b.quantity) * dir;
        case 'threshold': return (a.low_threshold - b.low_threshold) * dir;
        default: return 0;
      }
    });

  const lowCount = items.filter((i) => i.quantity <= i.low_threshold).length;

  return (
    <div className="h-full flex flex-col bg-slate-50 dark:bg-slate-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 shadow-sm">
        <div className="flex items-center gap-3">
          <Package className="w-5 h-5 text-teal-600 dark:text-teal-400" />
          <h1 className="text-lg font-bold text-slate-900 dark:text-white">
            {t('stock.title') || 'Stock Management'}
          </h1>
          {lowCount > 0 && (
            <span className="flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-400 px-2 py-0.5 rounded-full">
              <AlertTriangle className="w-3 h-3" />
              {lowCount} {t('stock.lowItems') || 'low'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="p-2 rounded-lg hover:bg-teal-50 dark:hover:bg-teal-900/20 text-teal-600 dark:text-teal-400 transition-colors"
            title={t('stock.addItem') || 'Add item'}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={fetchStock}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 text-slate-600 dark:text-slate-300 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5 text-slate-600 dark:text-slate-300" />
            </button>
          )}
        </div>
      </div>

      {/* Search bar */}
      <div className="px-4 py-2 bg-white dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-700/50">
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('stock.searchItem') || 'Search items...'}
            className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 placeholder:text-slate-400"
          />
        </div>
      </div>

      {/* Add form */}
      {showAddForm && (
        <div className="px-4 py-3 bg-teal-50 dark:bg-teal-900/20 border-b border-teal-100 dark:border-teal-800/50">
          <p className="text-xs font-semibold text-teal-700 dark:text-teal-400 mb-2">
            {t('stock.addItem') || 'Add new stock item'}
          </p>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[150px]">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('stock.itemName') || 'Name'}</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Cola 0.5L"
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 dark:text-slate-100"
              />
            </div>
            <div className="w-20">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('stock.qty') || 'Qty'}</label>
              <input
                type="number"
                value={newQty}
                onChange={(e) => setNewQty(e.target.value)}
                min="0"
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 tabular-nums text-right"
              />
            </div>
            <div className="w-20">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('stock.threshold') || 'Alert at'}</label>
              <input
                type="number"
                value={newThreshold}
                onChange={(e) => setNewThreshold(e.target.value)}
                min="0"
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 tabular-nums text-right"
              />
            </div>
            <div className="w-16">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('stock.unit') || 'Unit'}</label>
              <input
                type="text"
                value={newUnit}
                onChange={(e) => setNewUnit(e.target.value)}
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 dark:text-slate-100"
              />
            </div>
            <button
              onClick={handleAdd}
              disabled={!newName.trim()}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40 flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('common.add') || 'Add'}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {loading && items.length === 0 && (
          <div className="flex items-center justify-center h-32">
            <RefreshCw className="w-8 h-8 animate-spin text-teal-500" />
          </div>
        )}

        {error && (
          <div className="mx-4 mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {!loading && items.length === 0 && !error && (
          <div className="text-center py-12 text-slate-400 dark:text-slate-500">
            <Package className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t('stock.noItems') || 'No stock items yet'}</p>
            <p className="text-xs mt-1">{t('stock.noItemsHint') || 'Items appear automatically when sold, or add manually above'}</p>
          </div>
        )}

        {filtered.length > 0 && (
          <table className="w-full">
            <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
              <tr className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                <th className="text-left px-4 py-2 cursor-pointer select-none" onClick={() => toggleSort('name')}>
                  {t('stock.itemName') || 'Item'} <SortIcon field="name" />
                </th>
                <th className="text-right px-4 py-2 cursor-pointer select-none" onClick={() => toggleSort('quantity')}>
                  {t('stock.qty') || 'Qty'} <SortIcon field="quantity" />
                </th>
                <th className="text-center px-4 py-2">{t('stock.unit') || 'Unit'}</th>
                <th className="text-right px-4 py-2 cursor-pointer select-none" onClick={() => toggleSort('threshold')}>
                  {t('stock.threshold') || 'Alert at'} <SortIcon field="threshold" />
                </th>
                <th className="text-center px-4 py-2">{t('stock.status') || 'Status'}</th>
                <th className="text-right px-4 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((row) => {
                const isLow = row.quantity <= row.low_threshold;
                const isEditing = editingId === row.variant_id;

                return (
                  <tr
                    key={row.variant_id}
                    className={`transition-colors ${isLow ? 'bg-amber-50/50 dark:bg-amber-900/10' : 'bg-white dark:bg-slate-800/50'} hover:bg-slate-50 dark:hover:bg-slate-800`}
                  >
                    {/* Name */}
                    <td className="px-4 py-2.5">
                      <span className="text-sm font-medium text-slate-900 dark:text-white">{row.variant_name}</span>
                    </td>

                    {/* Quantity */}
                    <td className="px-4 py-2.5 text-right">
                      {isEditing ? (
                        <input
                          type="number"
                          value={editQty}
                          onChange={(e) => setEditQty(e.target.value)}
                          min="0"
                          step="1"
                          className="w-20 px-2 py-1 text-sm text-right rounded-md border border-teal-400 bg-white dark:bg-slate-700 tabular-nums focus:outline-none focus:ring-1 focus:ring-teal-500"
                          autoFocus
                        />
                      ) : (
                        <span className={`text-sm font-bold tabular-nums ${isLow ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-white'}`}>
                          {row.quantity}
                        </span>
                      )}
                    </td>

                    {/* Unit */}
                    <td className="px-4 py-2.5 text-center">
                      <span className="text-xs text-slate-500">{row.unit}</span>
                    </td>

                    {/* Threshold */}
                    <td className="px-4 py-2.5 text-right">
                      {isEditing ? (
                        <input
                          type="number"
                          value={editThreshold}
                          onChange={(e) => setEditThreshold(e.target.value)}
                          min="0"
                          step="1"
                          className="w-20 px-2 py-1 text-sm text-right rounded-md border border-slate-300 bg-white dark:bg-slate-700 tabular-nums"
                        />
                      ) : (
                        <span className="text-xs text-slate-500 tabular-nums">{row.low_threshold}</span>
                      )}
                    </td>

                    {/* Status */}
                    <td className="px-4 py-2.5 text-center">
                      {isLow ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                          <AlertTriangle className="w-3 h-3" />
                          {t('stock.low') || 'Low'}
                        </span>
                      ) : (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                          {t('stock.ok') || 'OK'}
                        </span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-2.5 text-right">
                      {isEditing ? (
                        <div className="flex items-center gap-1 justify-end">
                          <button
                            onClick={cancelEdit}
                            className="p-1.5 rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                            title={t('common.cancel') || 'Cancel'}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleSave(row)}
                            className="p-1.5 rounded-md bg-teal-600 text-white hover:bg-teal-700 transition-colors"
                          >
                            <Save className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startEdit(row)}
                          className="text-xs text-teal-600 dark:text-teal-400 hover:underline"
                        >
                          {t('common.edit') || 'Edit'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
