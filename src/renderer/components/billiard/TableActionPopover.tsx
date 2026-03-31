import { useRef, useEffect } from 'react';
import {
  Play, Pause, Square, Users, Clock, Timer, Minus, Plus,
  CreditCard, ArrowRightLeft, ShoppingBag, Eye, UtensilsCrossed,
} from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import { Language } from '../../i18n/translations';
import type { TableOverview } from './types';
import { formatElapsed, estimateCharge, formatCurrency, formatRemaining, calculateItemsTotal } from './utils';

// Labels resolved inside component via t()

export function TableActionPopover({
  table,
  open,
  onOpenChange,
  onStartSession,
  onOpenDetail,
  onPause,
  onResume,
  onEnd,
  onAddItem,
  onPayment,
  onTransfer,
  onUpdateGuestCount,
  isPending,
  clickPosition,
  language,
}: {
  table: TableOverview;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onStartSession: () => void;
  onOpenDetail: () => void;
  onPause: () => void;
  onResume: () => void;
  onEnd: () => void;
  onAddItem: () => void;
  onPayment: () => void;
  onTransfer: () => void;
  onUpdateGuestCount?: (count: number) => void;
  isPending: boolean;
  clickPosition?: { x: number; y: number } | null;
  language: Language;
}) {
  const { t } = useTranslation(language);
  const session = table.session;

  const isPackage = session?.billingMode === 'PACKAGE_COUNTDOWN' && session?.autoEndAt;
  const remaining = isPackage ? formatRemaining(session.autoEndAt) : null;
  const lowTime = remaining && remaining.totalMinutes < 15;
  const fnbTotal = session ? calculateItemsTotal(session.items) : 0;

  const billingModeLabel = session?.billingMode === 'PER_MINUTE'
    ? (t('billiard.perMinuteShort') || '/min')
    : session?.billingMode === 'PER_HOUR_ROUNDED'
      ? (t('billiard.perHourShort') || '/hr')
      : session?.billingMode === 'PACKAGE_COUNTDOWN'
        ? (t('billiard.packageCountdown') || 'Package')
        : '';

  // Clamp popover to viewport
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = popoverRef.current;
    if (!el || !clickPosition) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = clickPosition.x - 120; // center the 240px popover on click
    let y = clickPosition.y + 12;  // offset below click point
    if (x + rect.width > vw - 8) x = vw - rect.width - 8;
    if (y + rect.height > vh - 8) y = clickPosition.y - rect.height - 12; // flip above
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  });

  const fallbackCenter = !clickPosition;

  return (
    <div
      className="fixed inset-0 z-40"
      onClick={() => onOpenChange(false)}
    >
      <div
        ref={popoverRef}
        className="absolute z-50 w-60 bg-popover border rounded-xl shadow-xl p-3 space-y-2"
        style={fallbackCenter
          ? { left: 'calc(50% - 120px)', top: '50%', transform: 'translateY(-50%)' }
          : { left: clickPosition.x - 120, top: clickPosition.y + 12 }
        }
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: table name + billing mode badge */}
        <div className="flex items-center justify-center gap-2 pb-1 border-b">
          <span className="text-sm font-semibold">{table.resource.name}</span>
          {session && billingModeLabel && (
            <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              {billingModeLabel}
            </span>
          )}
        </div>

        {table.status === 'free' && (
          <>
            {table.resource.pricingRules?.basePrice != null && (
              <p className="text-xs text-center text-muted-foreground py-0.5">
                {table.resource.pricingRules.basePrice} PLN/h
              </p>
            )}
            <button className="w-full px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center" onClick={onStartSession} disabled={isPending}>
              <Play className="w-3.5 h-3.5 mr-2" /> {t('billiard.startSession') || 'Start Session'}
            </button>
          </>
        )}

        {(table.status === 'occupied' || table.status === 'paused') && session && (
          <>
            <div className="py-1.5 space-y-1.5 bg-muted/50 rounded-lg px-2">
              {/* Customer name + combo */}
              {(session.customerName || session.combo?.name) && (
                <div className="text-center space-y-0.5">
                  {session.customerName && (
                    <p className="text-xs font-medium truncate">{session.customerName}</p>
                  )}
                  {session.combo?.name && (
                    <span className="inline-block text-[9px] bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 px-1.5 py-0.5 rounded-full">
                      {session.combo.name}
                    </span>
                  )}
                </div>
              )}

              {/* Time + charge row */}
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                {isPackage ? (
                  <span className={`flex items-center gap-0.5 tabular-nums ${lowTime ? 'text-orange-600 font-semibold' : ''}`}>
                    <Timer className="w-3 h-3" />
                    {remaining!.text}
                  </span>
                ) : (
                  <span className="flex items-center gap-0.5 tabular-nums">
                    <Clock className="w-3 h-3" />
                    {formatElapsed(session.startedAt, session.totalPausedSeconds || 0, table.status === 'paused', session.pausedAt)}
                  </span>
                )}
                <span className="font-semibold text-foreground tabular-nums">
                  {formatCurrency(estimateCharge(session))}
                </span>
              </div>

              {/* Low time warning */}
              {lowTime && (
                <p className="text-[10px] text-center text-orange-600 font-medium">
                  {t('billiard.lowTimeWarning') || '< 15 min left'}
                </p>
              )}

              {/* Guest count (inline +/-) + F&B total + paused */}
              <div className="flex items-center justify-center gap-3 text-[10px] text-muted-foreground">
                {/* Inline guest count with +/- */}
                <span className="flex items-center gap-0.5">
                  <Users className="w-2.5 h-2.5" />
                  {onUpdateGuestCount ? (
                    <>
                      <button
                        type="button"
                        className="w-4 h-4 rounded-sm bg-muted hover:bg-accent flex items-center justify-center"
                        onClick={() => onUpdateGuestCount(Math.max(1, (session.guestCount || 1) - 1))}
                        aria-label={t('billiard.decreaseGuests') || 'Decrease guests'}
                      >
                        <Minus className="w-2.5 h-2.5" />
                      </button>
                      <span className="w-4 text-center tabular-nums font-medium">{session.guestCount || 1}</span>
                      <button
                        type="button"
                        className="w-4 h-4 rounded-sm bg-muted hover:bg-accent flex items-center justify-center"
                        onClick={() => onUpdateGuestCount((session.guestCount || 1) + 1)}
                        aria-label={t('billiard.increaseGuests') || 'Increase guests'}
                      >
                        <Plus className="w-2.5 h-2.5" />
                      </button>
                    </>
                  ) : (
                    <span>{session.guestCount || 1}</span>
                  )}
                </span>

                {/* F&B total */}
                {fnbTotal > 0 && (
                  <span className="flex items-center gap-0.5">
                    <UtensilsCrossed className="w-2.5 h-2.5" />
                    {formatCurrency(fnbTotal)}
                  </span>
                )}

                {table.status === 'paused' && (
                  <span className="text-amber-600 font-medium">{t('billiard.paused') || 'Paused'}</span>
                )}
              </div>
            </div>

            <button className="w-full px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center justify-center" onClick={onOpenDetail}>
              <Eye className="w-3.5 h-3.5 mr-2" /> {t('billiard.sessionDetail') || 'Details'}
            </button>
            {table.status === 'occupied' ? (
              <button className="w-full px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center justify-center" onClick={onPause} disabled={isPending}>
                <Pause className="w-3.5 h-3.5 mr-2" /> {t('billiard.pauseSession') || 'Pause'}
              </button>
            ) : (
              <button className="w-full px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center" onClick={onResume} disabled={isPending}>
                <Play className="w-3.5 h-3.5 mr-2" /> {t('billiard.resumeSession') || 'Resume'}
              </button>
            )}
            <button className="w-full px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center justify-center" onClick={onAddItem}>
              <ShoppingBag className="w-3.5 h-3.5 mr-2" /> {t('billiard.addItem') || 'Add Item'}
            </button>
            <button className="w-full px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center justify-center" onClick={onTransfer}>
              <ArrowRightLeft className="w-3.5 h-3.5 mr-2" /> {t('billiard.transferTable') || 'Transfer'}
            </button>
            <button className="w-full px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center" onClick={onPayment}>
              <CreditCard className="w-3.5 h-3.5 mr-2" /> {t('billiard.payment') || 'Payment'}
            </button>
            <button className="w-full px-3 py-1.5 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 flex items-center justify-center" onClick={onEnd} disabled={isPending}>
              <Square className="w-3.5 h-3.5 mr-2" /> {t('billiard.endSession') || 'End'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
