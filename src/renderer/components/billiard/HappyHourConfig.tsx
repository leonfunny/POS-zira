/**
 * HappyHourConfig — Manage automatic discount rules.
 *
 * CRUD for time-based discount rules that auto-apply during payment.
 * Each rule: day of week, time range, discount type/value, scope.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Clock, X, RefreshCw, Plus, Trash2, Save, Power, PowerOff,
} from 'lucide-react';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';

/* ─── Types ──────────────────────────────────────────── */

interface HappyHourRule {
  id: string;
  name: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  scope: 'time' | 'fnb' | 'all';
  is_active: number;
}

const DAY_NAMES_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ─── Component ────────────────────────────────────────── */

interface HappyHourConfigProps {
  language: Language;
  onClose?: () => void;
}

export function HappyHourConfig({ language, onClose }: HappyHourConfigProps) {
  const { t } = useTranslation(language);

  const [rules, setRules] = useState<HappyHourRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Add form state
  const [newName, setNewName] = useState('');
  const [newDays, setNewDays] = useState<number[]>([]);
  const [newStartTime, setNewStartTime] = useState('16:00');
  const [newEndTime, setNewEndTime] = useState('19:00');
  const [newDiscountType, setNewDiscountType] = useState<'percent' | 'fixed'>('percent');
  const [newDiscountValue, setNewDiscountValue] = useState('10');
  const [newScope, setNewScope] = useState<'time' | 'fnb' | 'all'>('all');

  const fetchRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.happyHour?.getAll?.();
      if (result?.success && result.data) {
        setRules(result.data);
      } else {
        setError(result?.error || 'Failed to load rules');
      }
    } catch (e: any) {
      setError(e.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  const handleAdd = async () => {
    if (!newName.trim() || newDays.length === 0) return;
    const val = Number(newDiscountValue);
    if (isNaN(val) || val <= 0) return;

    try {
      // Create one rule per selected day
      for (const day of newDays) {
        await window.electronAPI?.happyHour?.upsert?.({
          id: `hh_${Date.now()}_${day}_${Math.random().toString(36).slice(2, 5)}`,
          name: newName.trim(),
          dayOfWeek: day,
          startTime: newStartTime,
          endTime: newEndTime,
          discountType: newDiscountType,
          discountValue: val,
          scope: newScope,
          isActive: true,
        });
      }
      setShowAddForm(false);
      setNewName('');
      setNewDays([]);
      setNewDiscountValue('10');
      fetchRules();
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string) => {
    await window.electronAPI?.happyHour?.delete?.(id).catch(() => {});
  };

  const handleToggleActive = async (rule: HappyHourRule) => {
    await window.electronAPI?.happyHour?.upsert?.({
      id: rule.id,
      name: rule.name,
      dayOfWeek: rule.day_of_week,
      startTime: rule.start_time,
      endTime: rule.end_time,
      discountType: rule.discount_type,
      discountValue: rule.discount_value,
      scope: rule.scope,
      isActive: rule.is_active === 0,
    }).catch(() => {});
  };

  const toggleDay = (day: number) => {
    setNewDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  };

  const dayLabel = (day: number): string => {
    const keys: Record<number, string> = {
      0: 'discount.sun', 1: 'discount.mon', 2: 'discount.tue', 3: 'discount.wed',
      4: 'discount.thu', 5: 'discount.fri', 6: 'discount.sat',
    };
    return t(keys[day]) || DAY_NAMES_EN[day];
  };

  // Group rules by name for display
  const grouped = rules.reduce<Record<string, HappyHourRule[]>>((acc, rule) => {
    const key = `${rule.name}|${rule.start_time}|${rule.end_time}|${rule.discount_type}|${rule.discount_value}|${rule.scope}`;
    (acc[key] ||= []).push(rule);
    return acc;
  }, {});

  return (
    <div className="h-full flex flex-col bg-slate-50 dark:bg-slate-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 shadow-sm">
        <div className="flex items-center gap-3">
          <Clock className="w-5 h-5 text-amber-600 dark:text-amber-400" />
          <h1 className="text-lg font-bold text-slate-900 dark:text-white">
            {t('discount.happyHourConfig') || 'Happy Hour'}
          </h1>
          <span className="text-xs text-slate-400">({rules.length} {t('discount.rules') || 'rules'})</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="p-2 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/20 text-amber-600 dark:text-amber-400 transition-colors"
            title={t('discount.addRule') || 'Add rule'}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={fetchRules}
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

      {/* Add form */}
      {showAddForm && (
        <div className="px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-100 dark:border-amber-800/50 space-y-3">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
            {t('discount.addRule') || 'Add Happy Hour Rule'}
          </p>

          {/* Name */}
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('discount.ruleName') || 'e.g. Weekday Evening Deal'}
            className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 dark:text-slate-100"
          />

          {/* Days */}
          <div>
            <label className="text-[10px] text-slate-500 block mb-1">{t('discount.days') || 'Days'}</label>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleDay(day)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    newDays.includes(day)
                      ? 'bg-amber-600 text-white'
                      : 'bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-600 hover:border-amber-400'
                  }`}
                >
                  {dayLabel(day)}
                </button>
              ))}
            </div>
          </div>

          {/* Time range + discount */}
          <div className="flex items-end gap-2 flex-wrap">
            <div className="w-24">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('discount.startTime') || 'From'}</label>
              <input
                type="time"
                value={newStartTime}
                onChange={(e) => setNewStartTime(e.target.value)}
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 dark:text-slate-100"
              />
            </div>
            <div className="w-24">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('discount.endTime') || 'To'}</label>
              <input
                type="time"
                value={newEndTime}
                onChange={(e) => setNewEndTime(e.target.value)}
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 dark:text-slate-100"
              />
            </div>
            <div className="w-24">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('discount.type') || 'Type'}</label>
              <select
                value={newDiscountType}
                onChange={(e) => setNewDiscountType(e.target.value as 'percent' | 'fixed')}
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 dark:text-slate-100"
              >
                <option value="percent">%</option>
                <option value="fixed">PLN</option>
              </select>
            </div>
            <div className="w-20">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('discount.value') || 'Value'}</label>
              <input
                type="number"
                value={newDiscountValue}
                onChange={(e) => setNewDiscountValue(e.target.value)}
                min="0"
                max={newDiscountType === 'percent' ? '100' : undefined}
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 tabular-nums text-right"
              />
            </div>
            <div className="w-20">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('discount.scope') || 'Scope'}</label>
              <select
                value={newScope}
                onChange={(e) => setNewScope(e.target.value as 'time' | 'fnb' | 'all')}
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 dark:text-slate-100"
              >
                <option value="all">{t('discount.scopeAll') || 'All'}</option>
                <option value="time">{t('discount.scopeTime') || 'Time'}</option>
                <option value="fnb">{t('discount.scopeFnb') || 'F&B'}</option>
              </select>
            </div>
            <button
              onClick={handleAdd}
              disabled={!newName.trim() || newDays.length === 0 || !(Number(newDiscountValue) > 0)}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 flex items-center gap-1"
            >
              <Save className="w-3.5 h-3.5" />
              {t('common.save') || 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* Rules list */}
      <div className="flex-1 overflow-y-auto">
        {loading && rules.length === 0 && (
          <div className="flex items-center justify-center h-32">
            <RefreshCw className="w-8 h-8 animate-spin text-amber-500" />
          </div>
        )}

        {error && (
          <div className="mx-4 mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {!loading && rules.length === 0 && !error && (
          <div className="text-center py-12 text-slate-400 dark:text-slate-500">
            <Clock className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t('discount.noRules') || 'No happy hour rules yet'}</p>
            <p className="text-xs mt-1">{t('discount.noRulesHint') || 'Add rules to auto-apply discounts at specific times'}</p>
          </div>
        )}

        {Object.entries(grouped).length > 0 && (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {Object.entries(grouped).map(([key, group]) => {
              const first = group[0];
              const days = group.map((r) => r.day_of_week).sort();
              const allActive = group.every((r) => r.is_active === 1);

              return (
                <div
                  key={key}
                  className={`px-4 py-3 flex items-center gap-3 ${
                    allActive ? 'bg-white dark:bg-slate-800/50' : 'bg-slate-50 dark:bg-slate-900 opacity-60'
                  }`}
                >
                  {/* Status indicator */}
                  <button
                    onClick={async () => { for (const r of group) await handleToggleActive(r); fetchRules(); }}
                    className={`shrink-0 p-1.5 rounded-md transition-colors ${
                      allActive
                        ? 'text-amber-600 hover:bg-amber-50'
                        : 'text-slate-400 hover:bg-slate-100'
                    }`}
                    title={allActive ? (t('discount.disable') || 'Disable') : (t('discount.enable') || 'Enable')}
                  >
                    {allActive ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                  </button>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">{first.name}</p>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {/* Days */}
                      <span className="text-[10px] text-slate-500 dark:text-slate-400">
                        {days.map((d) => dayLabel(d)).join(', ')}
                      </span>
                      {/* Time */}
                      <span className="text-[10px] text-slate-500 tabular-nums">
                        {first.start_time} – {first.end_time}
                      </span>
                      {/* Scope badge */}
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                        {first.scope === 'all' ? (t('discount.scopeAll') || 'All')
                          : first.scope === 'time' ? (t('discount.scopeTime') || 'Time')
                          : (t('discount.scopeFnb') || 'F&B')}
                      </span>
                    </div>
                  </div>

                  {/* Discount badge */}
                  <span className="shrink-0 text-sm font-bold text-amber-700 dark:text-amber-400 tabular-nums">
                    {first.discount_type === 'percent' ? `−${first.discount_value}%` : `−${first.discount_value} PLN`}
                  </span>

                  {/* Delete */}
                  <button
                    onClick={async () => { for (const r of group) await handleDelete(r.id); fetchRules(); }}
                    className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title={t('common.delete') || 'Delete'}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
