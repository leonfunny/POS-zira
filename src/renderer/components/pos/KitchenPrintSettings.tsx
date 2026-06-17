import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, UtensilsCrossed } from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import { getTranslation, Language } from '../../i18n/translations';

interface KitchenCategoryRow {
  id: string;
  name: string;
  name_translations?: string | null;
  kitchen_print?: number | null;
}

interface KitchenPrintSettingsProps {
  lang?: string;
}

/**
 * Settings → "In đơn bếp": mark which categories are available in the
 * customer kitchen self-order menu. When a customer submits that flow, the
 * kitchen ticket prints on the local KITCHEN printer or the salon printer
 * registered under the KITCHEN role via a backend print job.
 *
 * The flag lives on the BACKEND category (categories.kitchen_print) so one
 * toggle applies to every terminal; the toggle PATCHes through the existing
 * product-admin endpoint and the next product sync mirrors it locally.
 */
export default function KitchenPrintSettings({ lang }: KitchenPrintSettingsProps) {
  const t = getTranslation((lang as Language) || 'pl');
  const tOr = (key: string, fallback: string) => {
    const value = t(key);
    return value === key ? fallback : value;
  };

  const [categories, setCategories] = useState<KitchenCategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = (await window.electronAPI.pos.categories.getAll()) as KitchenCategoryRow[];
      setCategories(rows || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load categories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (category: KitchenCategoryRow) => {
      if (savingId) return;
      const next = (category.kitchen_print ?? 0) !== 1;
      setSavingId(category.id);
      setError(null);
      // Optimistic flip so the switch feels instant; revert on failure.
      setCategories((prev) =>
        prev.map((c) => (c.id === category.id ? { ...c, kitchen_print: next ? 1 : 0 } : c)),
      );
      try {
        const result = await window.electronAPI.pos.productAdmin.updateCategory(category.id, {
          name: category.name,
          kitchenPrint: next,
        } as any);
        if (!result || (result as any).error) {
          throw new Error((result as any)?.error || 'Update failed');
        }
      } catch (e: any) {
        setCategories((prev) =>
          prev.map((c) => (c.id === category.id ? { ...c, kitchen_print: category.kitchen_print ?? 0 } : c)),
        );
        setError(e?.message || tOr('settings.kitchenPrintToggleFailed', 'Could not save — check the connection'));
      } finally {
        setSavingId(null);
      }
    },
    [savingId, tOr],
  );

  const flaggedCount = categories.filter((c) => (c.kitchen_print ?? 0) === 1).length;

  return (
    <div className="panel p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2">
        <UtensilsCrossed size={16} className="text-orange-600" />
        {tOr('settings.kitchenPrint', 'Kitchen ticket printing')}
        {flaggedCount > 0 && (
          <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-bold text-orange-800">
            {flaggedCount}
          </span>
        )}
      </h2>
      <p className="text-xs text-slate-400 mb-4">
        {tOr(
          'settings.kitchenPrintDesc',
          'Marked categories appear in the customer kitchen self-order menu and print a kitchen ticket when the customer submits that order.',
        )}
      </p>

      {loading ? (
        <div className="flex items-center gap-2 p-2 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          {tOr('settings.kitchenPrintLoading', 'Loading categories...')}
        </div>
      ) : categories.length === 0 ? (
        <div className="p-2 text-sm text-slate-400">
          {tOr('settings.kitchenPrintEmpty', 'No categories yet — sync products first.')}
        </div>
      ) : (
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {categories.map((category) => {
            const enabled = (category.kitchen_print ?? 0) === 1;
            const busy = savingId === category.id;
            return (
              <label
                key={category.id}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-lg p-2 hover:bg-slate-50"
              >
                <div className="min-w-0 text-sm text-slate-700">
                  {resolveName(category, lang || 'pl')}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  disabled={busy}
                  onClick={() => void toggle(category)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${enabled ? 'bg-orange-500' : 'bg-slate-200'}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
                  />
                </button>
              </label>
            );
          })}
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-800">
          {error}
        </div>
      )}
    </div>
  );
}
