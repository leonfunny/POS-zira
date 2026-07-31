/**
 * Business-shift indicator for the billiard floor. Green = a shift is open
 * (shows opening time and float). Red = no shift — tapping it opens a small
 * open-shift dialog. Informational only: starting sessions is never blocked
 * here, the server stamps the shift on end-session regardless. Closing a
 * shift stays on the web dashboard (cash reconciliation lives there).
 */

import { useState } from 'react';
import { CircleDot, Loader2, Lock, X } from 'lucide-react';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import { useToast } from './Toast';
import { useCurrentShift, useOpenShift } from '../../hooks/useBilliardData';

interface ShiftChipProps {
  language: Language;
  online: boolean;
  /** Pause the status poll while the billiard tab is hidden. */
  pollPaused?: boolean;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(value);
}

function formatTime(value: string | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' }).format(date);
}

export function ShiftChip({ language, online, pollPaused }: ShiftChipProps) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const tOr = (key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  };

  const { data, error, refetch } = useCurrentShift({ pollPaused });
  const openShift = useOpenShift(refetch);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [openingCash, setOpeningCash] = useState('');

  // Offline or the poll failed: shift state is unknown — stay out of the way.
  if (!online || (error && !data)) return null;
  if (!data) return null;

  const shift = (data as any)?.shift ?? null;

  const handleOpen = async () => {
    if (openShift.isPending) return;
    const cash = Number.parseFloat(openingCash.replace(',', '.'));
    try {
      await openShift.mutate({
        openingCash: Number.isNaN(cash) ? 0 : cash,
      });
      toast.success(tOr('billiard.shiftOpened', 'Shift opened'));
      setDialogOpen(false);
      setOpeningCash('');
    } catch (err: any) {
      toast.error(err?.message || tOr('billiard.shiftOpenFailed', 'Could not open shift'));
    }
  };

  return (
    <>
      {shift ? (
        <span className="flex w-fit items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
          <CircleDot className="h-4 w-4 text-emerald-600" />
          {tOr('billiard.shiftOpen', 'Shift open')}
          {shift.openedAt && (
            <span className="tabular-nums">· {formatTime(shift.openedAt)}</span>
          )}
          {shift.openingCash != null && (
            <span className="tabular-nums">· {formatCurrency(Number(shift.openingCash))}</span>
          )}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="flex w-fit items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800 transition-colors hover:bg-red-100"
        >
          <Lock className="h-4 w-4" />
          {tOr('billiard.shiftClosed', 'No shift open — tap to open')}
        </button>
      )}

      {dialogOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-xs overflow-hidden rounded-2xl bg-white shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <span className="font-semibold text-slate-800">
                {tOr('billiard.openShift', 'Open shift')}
              </span>
              <button
                type="button"
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
                onClick={() => setDialogOpen(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3 p-4">
              <label className="block text-sm font-medium text-slate-600">
                {tOr('billiard.openingCash', 'Opening cash (float)')}
                <input
                  value={openingCash}
                  onChange={(e) => setOpeningCash(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="mt-1 h-11 w-full rounded-lg border border-slate-300 px-3 text-slate-800 outline-none focus:border-brand-500"
                />
              </label>
              <button
                type="button"
                disabled={openShift.isPending}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 font-semibold text-white hover:bg-brand-500 disabled:opacity-50"
                onClick={() => void handleOpen()}
              >
                {openShift.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tOr('billiard.openShiftConfirm', 'Open shift')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
