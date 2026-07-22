import { useState } from 'react';
import { WifiOff, X } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import { Language } from '../../i18n/translations';
import {
  isBilliardPosCheckoutFrozen,
  resolveBilliardOutstandingBalance,
} from '../../../shared/billiard-contract';
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
 * The unsettled-sessions panel. Every COMPLETED but UNPAID/PARTIAL session
 * lands here instead of flooding the floor. Per-row Settle reuses the
 * PaymentDialog; per-row and multi-select Void write sessions off through the
 * OWNER/MANAGER backend endpoints with a required reason. Settlement and void
 * are online-only (mutation policy), so both disable while offline.
 */
export function UnsettledPanel({
  open,
  onOpenChange,
  sessions,
  online,
  language,
  onSettle,
  onVoid,
  voidPending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sessions: any[];
  online: boolean;
  language: Language;
  onSettle: (session: any) => void;
  /** Write off sessions (single or bulk). Absent → void UI stays hidden. */
  onVoid?: (sessionIds: string[], reason: string) => Promise<void>;
  voidPending?: boolean;
}) {
  const { t } = useTranslation(language);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [voidTarget, setVoidTarget] = useState<string[] | null>(null);
  const [reason, setReason] = useState('');

  if (!open) return null;

  const rows = sortUnsettledNewestFirst(sessions ?? []);
  const summary = summarizeUnsettled(sessions);
  const canVoid = Boolean(onVoid) && online && !voidPending;
  const selectedVoidableIds = [...selected].filter((id) => {
    const session = rows.find((row: any) => row.id === id);
    return session && !isBilliardPosCheckoutFrozen(session);
  });

  const toggleSelected = (id: string) => {
    const session = rows.find((row: any) => row.id === id);
    if (!session || isBilliardPosCheckoutFrozen(session)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirmVoid = async () => {
    if (!onVoid || !voidTarget || !reason.trim()) return;
    const ids = voidTarget.filter((id) => {
      const session = rows.find((row: any) => row.id === id);
      return session && !isBilliardPosCheckoutFrozen(session);
    });
    if (ids.length === 0) {
      setVoidTarget(null);
      setReason('');
      return;
    }
    setVoidTarget(null);
    setReason('');
    await onVoid(ids, reason.trim());
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      style={{ bottom: 'var(--touch-keyboard-inset, 0px)' }}
      onClick={() => onOpenChange(false)}
    >
      <div
        className="m-4 flex max-h-[calc(100%-2rem)] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl"
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
              {rows.map((session: any) => {
                const checkoutFrozen = isBilliardPosCheckoutFrozen(session);
                return (
                <li key={session.id} className="flex items-center gap-3 px-4 py-2.5">
                  {onVoid && (
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-brand-600"
                      checked={selected.has(session.id)}
                      disabled={checkoutFrozen}
                      onChange={() => toggleSelected(session.id)}
                      aria-label={session.resource?.name || session.id}
                    />
                  )}
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
                      {checkoutFrozen && (
                        <span
                          className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-800"
                          title="Frozen POS checkout: settle or use owner correction after payment"
                        >
                          POS
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                    {formatCurrency(resolveBilliardOutstandingBalance(session))}
                  </div>
                  {onVoid && (
                    <button
                      type="button"
                      disabled={!canVoid || checkoutFrozen}
                      title={checkoutFrozen ? 'Frozen POS checkout cannot be voided' : undefined}
                      onClick={() => { setReason(''); setVoidTarget([session.id]); }}
                      className="h-8 shrink-0 rounded-lg border border-slate-300 px-2.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('billiard.void') || 'Void'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!online}
                    onClick={() => onSettle(session)}
                    className="h-8 shrink-0 rounded-lg bg-brand-600 px-3 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {t('billiard.settle') || 'Settle'}
                  </button>
                </li>
                );
              })}
            </ul>
          )}
        </div>

        {onVoid && selectedVoidableIds.length > 0 && (
          <div className="flex items-center justify-end border-t border-slate-200 bg-slate-50 px-4 py-2.5">
            <button
              type="button"
              disabled={!canVoid}
              onClick={() => { setReason(''); setVoidTarget(selectedVoidableIds); }}
              className="h-8 rounded-lg border border-red-300 bg-white px-3 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {(t('billiard.voidSelected') || 'Void selected')} ({selectedVoidableIds.length})
            </button>
          </div>
        )}

        {voidTarget && (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
            style={{ bottom: 'var(--touch-keyboard-inset, 0px)' }}
            onClick={() => setVoidTarget(null)}
          >
            <div
              className="m-4 w-full max-w-sm max-h-[calc(100%-2rem)] overflow-y-auto rounded-xl bg-white p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-sm font-semibold text-slate-900">
                {(t('billiard.void') || 'Void')} ({voidTarget.length})
              </h3>
              <label className="mt-3 block text-xs font-medium text-slate-700">
                {t('billiard.voidReason') || 'Reason (required)'}
              </label>
              <textarea
                className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                rows={2}
                maxLength={500}
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('billiard.voidReasonPlaceholder') || 'Why is this written off?'}
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setVoidTarget(null)}
                  className="h-9 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  {t('common.cancel') || 'Cancel'}
                </button>
                <button
                  type="button"
                  disabled={!reason.trim() || !canVoid}
                  onClick={confirmVoid}
                  className="h-9 rounded-lg bg-red-600 px-3 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {t('billiard.void') || 'Void'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
