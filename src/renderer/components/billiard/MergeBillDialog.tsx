/**
 * Merge other active/paused table sessions into the current one. Server-side
 * operation: source sessions collapse into the target and their items move
 * over. Online-only; sessions already frozen to a POS checkout are refused by
 * the backend.
 */

import { useState } from 'react';
import { Check, Loader2, Merge, Target, X } from 'lucide-react';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useToast } from './Toast';
import { useFloorOverview, useMergeSessions } from '../../hooks/useBilliardData';

interface MergeBillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  language: Language;
  currentSessionId: string;
  /** Called after a successful merge — close the detail modal and refetch. */
  onMerged?: () => void;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(value);
}

export function MergeBillDialog({
  open,
  onOpenChange,
  language,
  currentSessionId,
  onMerged,
}: MergeBillDialogProps) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const tOr = (key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  };

  const { data: overview, refetch } = useFloorOverview({ pollPaused: !open });
  const mergeSessions = useMergeSessions(refetch);
  const [selected, setSelected] = useState<string[]>([]);

  if (!open) return null;

  const rows: any[] = Array.isArray(overview)
    ? overview
    : (overview as any)?.resources || [];
  const candidates = rows
    .map((row: any) => ({ session: row.session, resource: row.resource ?? row }))
    .filter(({ session }) =>
      session
      && session.id !== currentSessionId
      && (session.status === 'ACTIVE' || session.status === 'PAUSED'));

  const toggle = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const handleMerge = async () => {
    if (selected.length === 0 || mergeSessions.isPending) return;
    try {
      await mergeSessions.mutate([currentSessionId, ...selected]);
      toast.success(tOr('billiard.mergeDone', 'Bills merged'));
      setSelected([]);
      onOpenChange(false);
      onMerged?.();
    } catch (err: any) {
      toast.error(err?.message || tOr('billiard.mergeFailed', 'Merge failed'));
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[34rem] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold text-slate-800">
            <Merge className="h-5 w-5 text-sky-600" />
            {tOr('billiard.mergeBills', 'Merge bills')}
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="mb-3 text-sm text-slate-500">
            {tOr('billiard.selectSessionsToMerge', 'Select tables to merge into this bill')}
          </p>
          {candidates.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">
              {tOr('billiard.noOtherSessions', 'No other active tables')}
            </p>
          ) : (
            <div className="space-y-2">
              {candidates.map(({ session, resource }) => {
                const isSelected = selected.includes(session.id);
                return (
                  <button
                    key={session.id}
                    type="button"
                    className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                      isSelected
                        ? 'border-sky-500 bg-sky-50'
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}
                    onClick={() => toggle(session.id)}
                  >
                    <span
                      className={`flex h-5 w-5 items-center justify-center rounded border-2 ${
                        isSelected
                          ? 'border-sky-600 bg-sky-600 text-white'
                          : 'border-slate-300'
                      }`}
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </span>
                    <Target className="h-4 w-4 text-slate-400" />
                    <span className="flex-1">
                      <span className="block text-sm font-medium text-slate-800">
                        {resource?.name || session.customerName || session.id.slice(0, 8)}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {session.totalCharge != null
                          ? formatCurrency(Number(session.totalCharge))
                          : tOr('billiard.running', 'Running…')}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button
            type="button"
            className="min-h-11 rounded-lg border border-slate-300 px-4 font-medium text-slate-600 hover:bg-slate-50"
            onClick={() => onOpenChange(false)}
          >
            {tOr('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            disabled={selected.length === 0 || mergeSessions.isPending}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-sky-600 px-4 font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void handleMerge()}
          >
            {mergeSessions.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {tOr('billiard.mergeConfirm', 'Merge')} ({selected.length + 1})
          </button>
        </div>
      </div>
    </div>
  );
}
