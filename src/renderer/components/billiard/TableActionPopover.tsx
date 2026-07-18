import { useEffect, useRef, useState } from 'react';
import {
  Play, Pause, Users, Clock, Timer, Minus, Plus,
  CreditCard, ArrowRightLeft, ShoppingBag, UtensilsCrossed, X, Trash2,
} from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import { Language } from '../../i18n/translations';
import type { TableOverview } from './types';
import { estimateCharge, formatCurrency, calculateItemsTotal } from './utils';

function formatClock(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function formatElapsedClock(session: any, isPaused: boolean): string {
  const startedAt = new Date(session.startedAt).getTime();
  let pausedMs = Number(session.totalPausedSeconds || 0) * 1000;
  if (isPaused && session.pausedAt) {
    pausedMs += Math.max(0, Date.now() - new Date(session.pausedAt).getTime());
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt - pausedMs) / 1000));
  return formatClock(elapsedSeconds);
}

function formatRemainingClock(autoEndAt: string): { text: string; totalSeconds: number } {
  const totalSeconds = Math.max(0, Math.ceil((new Date(autoEndAt).getTime() - Date.now()) / 1000));
  return { text: formatClock(totalSeconds), totalSeconds };
}

export function TableActionPopover({
  table,
  open,
  suspended = false,
  onOpenChange,
  onStartSession,
  onPause,
  onResume,
  onAddItem,
  onPayment,
  onTransfer,
  onUpdateGuestCount,
  onRemoveItem,
  isPending,
  language,
}: {
  table: TableOverview;
  open: boolean;
  suspended?: boolean;
  onOpenChange: (v: boolean) => void;
  onStartSession: (guestCount: number) => void;
  onPause: () => void;
  onResume: () => void;
  onAddItem: () => void;
  onPayment: () => void;
  onTransfer: () => void;
  onUpdateGuestCount?: (count: number) => void;
  onRemoveItem?: (itemId: string) => void;
  isPending: boolean;
  language: Language;
}) {
  const { t } = useTranslation(language);
  const drawerRef = useRef<HTMLElement>(null);
  const [startGuests, setStartGuests] = useState(1);
  const [, setClockTick] = useState(0);
  const session = table.session;

  useEffect(() => {
    if (!open || !session || table.status === 'paused') return;
    const interval = window.setInterval(() => setClockTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(interval);
  }, [open, session?.id, table.status]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;

    return () => {
      window.requestAnimationFrame(() => {
        if (previousFocus?.isConnected) previousFocus.focus();
      });
    };
  }, [open]);

  useEffect(() => {
    if (!open || suspended) return;
    const frame = window.requestAnimationFrame(() => drawerRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, suspended, onOpenChange]);

  if (!open) return null;

  const isPackage = session?.billingMode === 'PACKAGE_COUNTDOWN' && session?.autoEndAt;
  const remaining = isPackage ? formatRemainingClock(session.autoEndAt) : null;
  const lowTime = Boolean(remaining && remaining.totalSeconds < 15 * 60);
  const items = session?.items || [];
  const fnbTotal = session ? calculateItemsTotal(items) : 0;
  const authoritativeTimeCharge = Number(session?.currentTimeCharge ?? session?.timeCharge);
  const timeCharge = session
    ? isPackage
      ? Number(session.packagePrice ?? estimateCharge(session))
      : Number.isFinite(authoritativeTimeCharge)
        ? authoritativeTimeCharge
        : estimateCharge(session)
    : 0;
  const runningTotal = timeCharge + fnbTotal;
  const hourlyRate = Number(
    session?.pricingSnapshot?.basePrice
      ?? session?.hourlyRate
      ?? table.resource.pricingRules?.basePrice,
  );
  const isActive = table.status === 'occupied' || table.status === 'paused';

  const billingModeLabel = session?.billingMode === 'PER_MINUTE'
    ? (t('billiard.perMinuteShort') || '/min')
    : session?.billingMode === 'PER_HOUR_ROUNDED'
      ? (t('billiard.perHourShort') || '/hr')
      : session?.billingMode === 'PACKAGE_COUNTDOWN'
        ? (t('billiard.packageCountdown') || 'Package')
        : '';

  const statusLabel = table.status === 'free'
    ? (t('billiard.free') || 'Free')
    : table.status === 'paused'
      ? (t('billiard.paused') || 'Paused')
      : (t('billiard.active') || 'Active');
  const statusClass = table.status === 'free'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : table.status === 'paused'
      ? 'border-amber-200 bg-amber-50 text-amber-700'
      : 'border-red-200 bg-red-50 text-red-700';
  const inertProps = suspended ? { inert: '' } : {};

  return (
    <div
      {...inertProps}
      aria-hidden={suspended || undefined}
      className={`fixed inset-0 z-40 flex items-end justify-end bg-slate-900/30 sm:items-stretch ${
        suspended ? 'pointer-events-none' : ''
      }`}
      onMouseDown={(event) => {
        if (!suspended && event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal={suspended ? undefined : true}
        aria-label={table.resource.name}
        tabIndex={-1}
        className="flex max-h-[88vh] w-full flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl outline-none sm:h-full sm:max-h-none sm:w-[400px] sm:rounded-none sm:border-y-0 sm:border-r-0"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-slate-900">{table.resource.name}</h2>
              <span className={'rounded-full border px-2 py-0.5 text-xs font-medium ' + statusClass}>
                {statusLabel}
              </span>
            </div>
            {session?.customerName && (
              <p className="mt-1 truncate text-sm text-slate-500">{session.customerName}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="ml-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
            aria-label={t('common.close') || 'Close'}
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {table.status === 'free' && (
            <>
              <section className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-center">
                <p className="text-sm text-slate-500">{t('billiard.hourlyRate') || 'Hourly rate'}</p>
                <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">
                  {table.resource.pricingRules?.basePrice != null
                    ? table.resource.pricingRules.basePrice + ' PLN/h'
                    : '—'}
                </p>
              </section>
              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    <Users className="h-4 w-4" />
                    {t('billiard.guests') || 'Guests'}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-50"
                      onClick={() => setStartGuests((count) => Math.max(1, count - 1))}
                      disabled={startGuests <= 1}
                      aria-label={t('billiard.decreaseGuests') || 'Decrease guests'}
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <span className="w-8 text-center text-lg font-semibold tabular-nums">{startGuests}</span>
                    <button
                      type="button"
                      className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white hover:bg-slate-100"
                      onClick={() => setStartGuests((count) => count + 1)}
                      aria-label={t('billiard.increaseGuests') || 'Increase guests'}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}

          {isActive && session && (
            <>
              <section className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-center">
                <div className="flex items-center justify-center gap-2 text-sm text-slate-500">
                  {isPackage ? <Timer className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                  <span>{isPackage ? (t('billiard.remaining') || 'Remaining') : (t('billiard.running') || 'Running')}</span>
                  {billingModeLabel && <span>· {billingModeLabel}</span>}
                </div>
                <p
                  className={lowTime
                    ? 'mt-2 font-mono text-4xl font-semibold tabular-nums text-orange-600'
                    : 'mt-2 font-mono text-4xl font-semibold tabular-nums text-slate-900'}
                >
                  {isPackage
                    ? remaining?.text
                    : formatElapsedClock(session, table.status === 'paused')}
                </p>
                <div className="mt-4 border-t border-slate-200 pt-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{t('billiard.total') || 'Total'}</p>
                  <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">{formatCurrency(runningTotal)}</p>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 text-left">
                  <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <p className="text-xs text-slate-500">{t('billiard.timeCharge') || 'Time charge'}</p>
                    <p className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">{formatCurrency(timeCharge)}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <p className="text-xs text-slate-500">{t('billiard.foodAndBeverage') || 'Food & Beverage'}</p>
                    <p className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">{formatCurrency(fnbTotal)}</p>
                  </div>
                </div>
                {Number.isFinite(hourlyRate) && hourlyRate > 0 && (
                  <p className="mt-3 text-xs text-slate-500">
                    {t('billiard.hourlyRate') || 'Hourly rate'}: {formatCurrency(hourlyRate)}/h
                  </p>
                )}
                {lowTime && (
                  <p className="mt-2 text-sm font-medium text-orange-600">
                    {t('billiard.lowTimeWarning') || '< 15 min left'}
                  </p>
                )}
              </section>

              {(session.combo?.name || session.customerName) && (
                <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
                  {session.customerName && <p className="font-medium text-slate-900">{session.customerName}</p>}
                  {session.combo?.name && <p className="mt-1 text-slate-500">{session.combo.name}</p>}
                </section>
              )}

              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    <Users className="h-4 w-4" />
                    {t('billiard.guests') || 'Guests'}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-50"
                      onClick={() => onUpdateGuestCount?.(Math.max(1, (session.guestCount || 1) - 1))}
                      disabled={!onUpdateGuestCount || isPending || (session.guestCount || 1) <= 1}
                      aria-label={t('billiard.decreaseGuests') || 'Decrease guests'}
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <span className="w-8 text-center text-lg font-semibold tabular-nums">{session.guestCount || 1}</span>
                    <button
                      type="button"
                      className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-50"
                      onClick={() => onUpdateGuestCount?.((session.guestCount || 1) + 1)}
                      disabled={!onUpdateGuestCount || isPending}
                      aria-label={t('billiard.increaseGuests') || 'Increase guests'}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </section>

              {items.length > 0 && (
                <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                    <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <UtensilsCrossed className="h-4 w-4" />
                      {t('billiard.runningTab') || 'Running tab'}
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-slate-700">{formatCurrency(fnbTotal)}</span>
                  </div>
                  <div className="divide-y divide-slate-200">
                    {items.map((item: any) => (
                      <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-900">{item.name}</p>
                          <p className="text-xs text-slate-500">
                            {item.quantity || 1} × {formatCurrency(item.unitPrice || 0)}
                          </p>
                        </div>
                        <span className="text-sm font-medium tabular-nums text-slate-700">
                          {formatCurrency((item.unitPrice || 0) * (item.quantity || 1))}
                        </span>
                        {onRemoveItem && (
                          <button
                            type="button"
                            onClick={() => onRemoveItem(item.id)}
                            disabled={isPending}
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-50"
                            aria-label={t('common.remove') || 'Remove'}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        <footer className="shrink-0 border-t border-slate-200 bg-white p-4">
          {table.status === 'free' ? (
            <button
              type="button"
              className="flex h-12 w-full items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              onClick={() => onStartSession(startGuests)}
              disabled={isPending}
            >
              <Play className="mr-2 h-4 w-4" />
              {t('billiard.startSession') || 'Start Session'}
            </button>
          ) : isActive && session ? (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  className="flex h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                  onClick={table.status === 'paused' ? onResume : onPause}
                  disabled={isPending}
                >
                  {table.status === 'paused' ? <Play className="mr-1.5 h-4 w-4" /> : <Pause className="mr-1.5 h-4 w-4" />}
                  {table.status === 'paused'
                    ? (t('billiard.resume') || 'Resume')
                    : (t('billiard.pause') || 'Pause')}
                </button>
                <button
                  type="button"
                  className="flex h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                  onClick={onAddItem}
                >
                  <ShoppingBag className="mr-1.5 h-4 w-4" />
                  {t('billiard.addItem') || 'Add Item'}
                </button>
                <button
                  type="button"
                  className="flex h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                  onClick={onTransfer}
                >
                  <ArrowRightLeft className="mr-1.5 h-4 w-4" />
                  {t('billiard.transfer') || 'Transfer'}
                </button>
              </div>
              <button
                type="button"
                className="flex h-12 w-full items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                onClick={onPayment}
                disabled={isPending}
              >
                <CreditCard className="mr-2 h-4 w-4" />
                {t('billiard.payment') || 'Payment'} · {formatCurrency(runningTotal)}
              </button>
            </div>
          ) : null}
        </footer>
      </aside>
    </div>
  );
}
