import { useState, useEffect, useCallback } from 'react';
import {
  Pause,
  Play,
  Square,
  Plus,
  CreditCard,
  ArrowRightLeft,
  Trash2,
  Clock,
  Timer,
  Loader2,
  X,
} from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import { Language } from '../../i18n/translations';
import { useToast } from './Toast';
import {
  usePauseSession,
  useResumeSession,
  useEndSession,
  useRemoveItem,
} from '../../hooks/useBilliardData';
import { AddItemToTabModal } from './AddItemToTabModal';
import { PaymentDialog } from './PaymentDialog';
import { TransferTableDialog } from './TransferTableDialog';

interface SessionDetailModalProps {
  session: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  language: Language;
  onRefetch?: () => Promise<void>;
}

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return hrs > 0
    ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}`
    : `${pad(mins)}:${pad(secs)}`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency: 'PLN',
  }).format(value);
}

function formatRemainingSeconds(autoEndAt: string): { text: string; totalSeconds: number } {
  const remaining = Math.max(0, new Date(autoEndAt).getTime() - Date.now());
  const totalSeconds = Math.ceil(remaining / 1000);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  const text = hrs > 0 ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
  return { text, totalSeconds };
}

export function SessionDetailModal({
  session,
  open,
  onOpenChange,
  language,
  onRefetch,
}: SessionDetailModalProps) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const pauseSession = usePauseSession(onRefetch);
  const resumeSession = useResumeSession(onRefetch);
  const endSession = useEndSession(onRefetch);
  const removeItem = useRemoveItem(onRefetch);

  const [elapsed, setElapsed] = useState(0);
  const [remainingText, setRemainingText] = useState('');
  const [remainingLow, setRemainingLow] = useState(false);
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const isPackage = session?.billingMode === 'PACKAGE_COUNTDOWN' && session?.autoEndAt;

  // Running timer
  const calculateElapsed = useCallback(() => {
    if (!session?.startedAt) return 0;
    const start = new Date(session.startedAt).getTime();
    const pausedDuration = (session.totalPausedSeconds || 0) * 1000;
    const now = Date.now();
    return Math.max(0, Math.floor((now - start - pausedDuration) / 1000));
  }, [session?.startedAt, session?.totalPausedSeconds]);

  useEffect(() => {
    if (!open || !session) return;

    const isPaused = session.status === 'PAUSED';

    const tick = () => {
      if (isPackage) {
        const r = formatRemainingSeconds(session.autoEndAt);
        setRemainingText(r.text);
        setRemainingLow(r.totalSeconds < 900); // < 15 min
      } else {
        setElapsed(calculateElapsed());
      }
    };

    tick();
    if (isPaused) return;

    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [open, session, calculateElapsed, isPackage]);

  if (!session) return null;

  const isPaused = session.status === 'PAUSED';
  const isActive = session.status === 'ACTIVE' || session.status === 'PAUSED';
  const items = session.items || [];
  const timeCharge = session.currentTimeCharge ?? session.timeCharge ?? 0;
  const itemsTotal = items.reduce(
    (sum: number, item: any) => sum + (item.unitPrice || 0) * (item.quantity || 1),
    0
  );
  const runningTotal = isPackage
    ? Number(session.packagePrice ?? 0) + itemsTotal
    : timeCharge + itemsTotal;

  const billingModeLabel = session.billingMode === 'PER_MINUTE'
    ? (t('billiard.perMinute') || 'Per Minute')
    : session.billingMode === 'PER_HOUR_ROUNDED'
      ? (t('billiard.perHourRounded') || 'Per Hour')
      : session.billingMode === 'PACKAGE_COUNTDOWN'
        ? (t('billiard.packageCountdown') || 'Package')
        : '';

  const tableName = session.resource?.name || t('billiard.session') || 'Session';

  const handlePauseResume = async () => {
    try {
      if (isPaused) {
        await resumeSession.mutate(session.id);
      } else {
        await pauseSession.mutate(session.id);
      }
    } catch (err: any) {
      toast.error(err.message || t('billiard.actionFailed') || 'Action failed');
    }
  };

  const handleEnd = async () => {
    try {
      await endSession.mutate(session.id);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || t('billiard.endFailed') || 'Failed to end session');
    }
  };

  const handleRemoveItem = async (itemId: string) => {
    try {
      await removeItem.mutate({ sessionId: session.id, itemId });
    } catch (err: any) {
      toast.error(err.message || t('billiard.removeItemFailed') || 'Failed to remove item');
    }
  };

  return (
    <>
      {/* Main modal */}
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
          onClick={() => onOpenChange(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                {isPackage ? <Timer className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
                {tableName}
                {session.customerName && (
                  <span className="text-gray-500 font-normal">
                    &mdash; {session.customerName}
                  </span>
                )}
              </h3>
              <button
                onClick={() => onOpenChange(false)}
                className="p-1 rounded hover:bg-gray-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="p-4 overflow-y-auto flex-1 space-y-6">
              {/* Combo badge */}
              {session.combo?.name && (
                <div className="flex justify-center">
                  <span className="text-xs bg-purple-100 text-purple-700 px-2.5 py-1 rounded-full font-medium">
                    {session.combo.name}
                  </span>
                </div>
              )}

              {/* Timer Display */}
              <div className="text-center py-6 bg-gray-50 rounded-lg">
                {isPackage ? (
                  <>
                    <p className={`text-5xl font-mono font-bold tabular-nums tracking-wider ${remainingLow ? 'text-orange-600' : ''}`}>
                      {remainingText}
                    </p>
                    <p className="text-sm text-gray-500 mt-2">
                      {isPaused
                        ? (t('billiard.paused') || 'Paused')
                        : (t('billiard.remaining') || 'Remaining')}
                      {remainingLow && (
                        <span className="ml-2 text-orange-600 font-medium">
                          {t('billiard.lowTimeWarning') || '< 15 min left'}
                        </span>
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-5xl font-mono font-bold tabular-nums tracking-wider">
                      {formatDuration(elapsed)}
                    </p>
                    <p className="text-sm text-gray-500 mt-2">
                      {isPaused
                        ? (t('billiard.paused') || 'Paused')
                        : (t('billiard.running') || 'Running')}
                    </p>
                  </>
                )}
                {billingModeLabel && (
                  <span className="inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">
                    {billingModeLabel}
                  </span>
                )}
              </div>

              {/* Price Breakdown */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold uppercase text-gray-500 tracking-wide">
                  {t('billiard.priceBreakdown') || 'Price Breakdown'}
                </h3>
                <div className="border rounded-lg divide-y">
                  <div className="flex items-center justify-between px-4 py-3">
                    <span className="text-sm">
                      {isPackage
                        ? (t('billiard.packagePrice') || 'Package Price')
                        : (t('billiard.timeCharge') || 'Time Charge')}
                    </span>
                    <span className="font-medium tabular-nums">
                      {isPackage
                        ? formatCurrency(Number(session.packagePrice ?? 0))
                        : formatCurrency(timeCharge)}
                    </span>
                  </div>
                  {items.length > 0 && (
                    <div className="flex items-center justify-between px-4 py-3">
                      <span className="text-sm">
                        {t('billiard.foodAndBeverage') || 'Food & Beverage'}
                      </span>
                      <span className="font-medium tabular-nums">
                        {formatCurrency(itemsTotal)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between px-4 py-3 bg-gray-50">
                    <span className="font-semibold">
                      {t('billiard.total') || 'Total'}
                    </span>
                    <span className="text-lg font-bold tabular-nums">
                      {formatCurrency(runningTotal)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Running Tab - Items List */}
              {items.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold uppercase text-gray-500 tracking-wide">
                    {t('billiard.runningTab') || 'Running Tab'}
                  </h3>
                  <div className="border rounded-lg divide-y">
                    {items.map((item: any) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between px-4 py-3"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{item.name}</p>
                          <p className="text-xs text-gray-500">
                            {item.quantity} x {formatCurrency(item.unitPrice || 0)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 ml-4">
                          <span className="text-sm font-medium tabular-nums">
                            {formatCurrency((item.unitPrice || 0) * (item.quantity || 1))}
                          </span>
                          {isActive && (
                            <button
                              className="p-1.5 rounded hover:bg-gray-100 text-red-600 hover:text-red-700"
                              onClick={() => handleRemoveItem(item.id)}
                              disabled={removeItem.isPending}
                              aria-label={t('common.remove') || 'Remove'}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              {isActive && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <button
                    className="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center justify-center disabled:opacity-50"
                    onClick={handlePauseResume}
                    disabled={pauseSession.isPending || resumeSession.isPending}
                  >
                    {pauseSession.isPending || resumeSession.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : isPaused ? (
                      <Play className="w-4 h-4 mr-2" />
                    ) : (
                      <Pause className="w-4 h-4 mr-2" />
                    )}
                    {isPaused
                      ? (t('billiard.resume') || 'Resume')
                      : (t('billiard.pause') || 'Pause')}
                  </button>

                  <button
                    className="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center justify-center"
                    onClick={() => setAddItemOpen(true)}
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    {t('billiard.addItem') || 'Add Item'}
                  </button>

                  <button
                    className="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center justify-center"
                    onClick={() => setTransferOpen(true)}
                  >
                    <ArrowRightLeft className="w-4 h-4 mr-2" />
                    {t('billiard.transfer') || 'Transfer'}
                  </button>

                  <button
                    className="px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center sm:col-span-2"
                    onClick={() => setPaymentOpen(true)}
                  >
                    <CreditCard className="w-4 h-4 mr-2" />
                    {t('billiard.payment') || 'Payment'}
                  </button>

                  <button
                    className="px-3 py-1.5 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 flex items-center justify-center"
                    onClick={handleEnd}
                    disabled={endSession.isPending}
                  >
                    {endSession.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Square className="w-4 h-4 mr-2" />
                    )}
                    {t('billiard.endSession') || 'End'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sub-dialogs */}
      <AddItemToTabModal
        sessionId={session.id}
        open={addItemOpen}
        onOpenChange={setAddItemOpen}
        language={language}
        onRefetch={onRefetch}
      />
      <PaymentDialog
        session={session}
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        language={language}
        onRefetch={onRefetch}
      />
      <TransferTableDialog
        sessionId={session.id}
        open={transferOpen}
        onOpenChange={setTransferOpen}
        language={language}
      />
    </>
  );
}
