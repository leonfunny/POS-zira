/**
 * Split-bill calculator. The backend validates that the parts sum exactly to
 * the session's current total and echoes the split back — nothing is written,
 * the cashier just collects each share. Amounts are computed in integer
 * cents (largest-remainder) so the sum always matches to the grosz; the
 * running total of an ACTIVE session is re-read right before submitting.
 */

import { useMemo, useState } from 'react';
import { Loader2, Minus, Plus, Split, Users, X } from 'lucide-react';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useToast } from './Toast';
import { useSession, useSplitBill } from '../../hooks/useBilliardData';

interface SplitBillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  language: Language;
  sessionId: string;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(value);
}

/** Exact even split in cents: first `remainder` shares get one extra grosz. */
export function evenSplitCents(totalCents: number, parts: number): number[] {
  const base = Math.floor(totalCents / parts);
  const remainder = totalCents - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

export function SplitBillDialog({
  open,
  onOpenChange,
  language,
  sessionId,
}: SplitBillDialogProps) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const tOr = (key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  };

  const { data: session, refetch } = useSession(open ? sessionId : null);
  const splitBill = useSplitBill();
  const [parts, setParts] = useState(2);
  const [result, setResult] = useState<number[] | null>(null);

  const total = Number((session as any)?.totalCharge ?? 0);
  const preview = useMemo(
    () => evenSplitCents(Math.round(total * 100), parts).map((c) => c / 100),
    [total, parts],
  );

  if (!open) return null;

  const bumpParts = (delta: number) => {
    setParts((prev) => Math.max(2, Math.min(10, prev + delta)));
    setResult(null);
  };

  const handleSplit = async () => {
    if (splitBill.isPending) return;
    try {
      // Re-read the running total right before validating — an ACTIVE session
      // keeps earning by the minute and the server checks to 1 grosz.
      await refetch();
      const fresh = Number((session as any)?.totalCharge ?? total);
      const amounts = evenSplitCents(Math.round(fresh * 100), parts).map((c) => c / 100);
      const res = await splitBill.mutate({ sessionId, amounts });
      const splits: number[] = (res?.splits ?? amounts.map((a: number) => ({ amount: a })))
        .map((s: any) => Number(s.amount));
      setResult(splits);
    } catch (err: any) {
      toast.error(err?.message || tOr('billiard.splitFailed', 'Split failed'));
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold text-slate-800">
            <Split className="h-5 w-5 text-emerald-600" />
            {tOr('billiard.splitBill', 'Split bill')}
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
            <span className="text-sm text-slate-500">{tOr('billiard.total', 'Total')}</span>
            <span className="text-lg font-bold tabular-nums text-slate-800">
              {formatCurrency(total)}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-medium text-slate-600">
              <Users className="h-4 w-4" />
              {tOr('billiard.numberOfPeople', 'People')}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-200 p-2 hover:bg-slate-50"
                onClick={() => bumpParts(-1)}
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="w-8 text-center text-lg font-semibold tabular-nums">{parts}</span>
              <button
                type="button"
                className="rounded-lg border border-slate-200 p-2 hover:bg-slate-50"
                onClick={() => bumpParts(1)}
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            {(result ?? preview).map((amount, index) => (
              <div
                key={index}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
                  result ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200'
                }`}
              >
                <span className="text-sm text-slate-600">
                  {tOr('billiard.person', 'Person')} {index + 1}
                </span>
                <span className="text-sm font-semibold tabular-nums text-slate-800">
                  {formatCurrency(amount)}
                </span>
              </div>
            ))}
          </div>

          <button
            type="button"
            disabled={splitBill.isPending || total <= 0}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void handleSplit()}
          >
            {splitBill.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {result
              ? tOr('billiard.splitAgain', 'Recalculate')
              : tOr('billiard.splitConfirm', 'Split')}
          </button>
        </div>
      </div>
    </div>
  );
}
