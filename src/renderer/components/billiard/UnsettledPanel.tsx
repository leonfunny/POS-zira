import { WifiOff, X } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import { Language } from '../../i18n/translations';
import { resolveBilliardOutstandingBalance } from '../../../shared/billiard-contract';
import { formatCurrency, sortUnsettledNewestFirst, summarizeUnsettled } from './utils';

/** "21.07 · 3d" — when the session ended and how long it has been waiting. */
function endedLabel(session: any): string {
  const raw = session?.endedAt || session?.startedAt;
  if (!raw) return '—';
  const ended = new Date(raw);
  const days = Math.max(0, Math.floor((Date.now() - ended.getTime()) / 86_400_000));
  const date = ended.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' });
  return days > 0 ? `${date} · ${days}d` : date;
}

/**
 * The unsettled-sessions panel (Phase 1, settle-only). Every COMPLETED but
 * UNPAID/PARTIAL session lands here instead of flooding the floor. Settlement
 * is online-only (mutation policy), so rows disable while offline. Void joins
 * this panel once the backend VOID endpoints are deployed.
 */
export function UnsettledPanel({
  open,
  onOpenChange,
  sessions,
  online,
  language,
  onSettle,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sessions: any[];
  online: boolean;
  language: Language;
  onSettle: (session: any) => void;
}) {
  const { t } = useTranslation(language);
  if (!open) return null;

  const rows = sortUnsettledNewestFirst(sessions ?? []);
  const summary = summarizeUnsettled(sessions);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="m-4 flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              {t('billiard.unsettled') || 'Unsettled'}
              {summary.count > 0 && (
                <span className="ml-2 tabular-nums text-slate-500">
                  {summary.count} · {formatCurrency(summary.totalOutstanding)}
                </span>
              )}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100"
            aria-label={t('common.close') || 'Close'}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!online && (
          <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800">
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            {t('billiard.offlineSettleNotice') || 'Connection required to settle'}
          </div>
        )}

        <div className="overflow-y-auto">
          {rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">
              {t('billiard.unsettledEmpty') || 'No unsettled sessions'}
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {rows.map((session: any) => (
                <li key={session.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-900">
                      {session.resource?.name || session.id.slice(0, 8)}
                    </div>
                    <div className="text-xs tabular-nums text-slate-500">
                      {endedLabel(session)}
                      {session.paymentStatus === 'PARTIAL' && (
                        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
                          {t('billiard.partiallyPaid') || 'PARTIAL'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                    {formatCurrency(resolveBilliardOutstandingBalance(session))}
                  </div>
                  <button
                    type="button"
                    disabled={!online}
                    onClick={() => onSettle(session)}
                    className="h-8 shrink-0 rounded-lg bg-brand-600 px-3 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {t('billiard.settle') || 'Settle'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
