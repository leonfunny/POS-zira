/**
 * KitchenDisplay — Kitchen Display System (KDS) for billiard F&B orders.
 *
 * Shows all active kitchen orders in a card-based grid layout.
 * Kitchen staff can advance order status: New → In Progress → Ready → Delivered.
 * Auto-refreshes every 3 seconds via IPC event listener.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ChefHat, Clock, CheckCircle2, Truck, X, AlertCircle,
  Flame, Volume2, VolumeX, ArrowRight,
} from 'lucide-react';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';

type KdsStatus = 'new' | 'in_progress' | 'ready' | 'delivered' | 'cancelled';

interface KitchenOrder {
  id: string;
  session_id: string;
  resource_id: string | null;
  table_name: string | null;
  floor_name: string | null;
  status: KdsStatus;
  priority: number;
  notes: string | null;
  created_at: string;
  accepted_at: string | null;
  ready_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  items: {
    id: string;
    name: string;
    quantity: number;
    unit_price: number;
    notes: string | null;
  }[];
}

type FilterTab = 'all' | 'new' | 'in_progress' | 'ready';

const STATUS_STYLE: Record<KdsStatus, { bg: string; border: string; text: string; icon: any }> = {
  new:         { bg: 'bg-red-50',    border: 'border-red-200',    text: 'text-red-700',    icon: AlertCircle },
  in_progress: { bg: 'bg-amber-50',  border: 'border-amber-200',  text: 'text-amber-700',  icon: Flame },
  ready:       { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', icon: CheckCircle2 },
  delivered:   { bg: 'bg-gray-50',   border: 'border-gray-200',   text: 'text-gray-500',   icon: Truck },
  cancelled:   { bg: 'bg-gray-50',   border: 'border-gray-200',   text: 'text-gray-400',   icon: X },
};

function formatElapsedMinutes(createdAt: string): string {
  const diff = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

interface KitchenDisplayProps {
  language: Language;
  onClose?: () => void;
}

export function KitchenDisplay({ language, onClose }: KitchenDisplayProps) {
  const { t } = useTranslation(language);
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Translated status labels
  const statusLabels: Record<KdsStatus, string> = useMemo(() => ({
    new: t('kds.statusNew') || 'New',
    in_progress: t('kds.statusCooking') || 'Cooking',
    ready: t('kds.statusReady') || 'Ready',
    delivered: t('kds.delivered') || 'Delivered',
    cancelled: t('kds.cancel') || 'Cancelled',
  }), [t]);

  const fetchOrders = useCallback(async () => {
    try {
      const data = await window.electronAPI?.kds?.getActive?.();
      if (Array.isArray(data)) setOrders(data);
    } catch { /* ignore */ }
  }, []);

  // Initial fetch + periodic refresh
  useEffect(() => {
    fetchOrders();
    const timer = setInterval(fetchOrders, 3000);
    return () => clearInterval(timer);
  }, [fetchOrders]);

  // Listen for KDS data updates (real-time from IPC)
  useEffect(() => {
    const unsub = window.electronAPI?.kds?.onDataUpdated?.((data: any) => {
      fetchOrders();
      // Play notification sound for new orders (reuse single AudioContext)
      if (data.type === 'order-created' && soundEnabled) {
        try {
          if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
          const ctx = audioCtxRef.current;
          if (ctx.state === 'suspended') ctx.resume();
          const osc1 = ctx.createOscillator();
          const gain1 = ctx.createGain();
          osc1.connect(gain1);
          gain1.connect(ctx.destination);
          osc1.frequency.value = 880;
          gain1.gain.value = 0.3;
          osc1.start(ctx.currentTime);
          osc1.stop(ctx.currentTime + 0.15);
          const osc2 = ctx.createOscillator();
          const gain2 = ctx.createGain();
          osc2.connect(gain2);
          gain2.connect(ctx.destination);
          osc2.frequency.value = 1100;
          gain2.gain.value = 0.3;
          osc2.start(ctx.currentTime + 0.2);
          osc2.stop(ctx.currentTime + 0.35);
        } catch { /* no audio support */ }
      }
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [fetchOrders, soundEnabled]);

  const updateStatus = async (orderId: string, newStatus: KdsStatus) => {
    try {
      await window.electronAPI?.kds?.updateStatus?.(orderId, newStatus);
      // Optimistic update
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? { ...o, status: newStatus } : o))
          .filter((o) => newStatus !== 'delivered' && newStatus !== 'cancelled' ? true : o.id !== orderId),
      );
    } catch { /* ignore */ }
  };

  const filtered = filter === 'all'
    ? orders
    : orders.filter((o) => o.status === filter);

  const counts = {
    all: orders.length,
    new: orders.filter((o) => o.status === 'new').length,
    in_progress: orders.filter((o) => o.status === 'in_progress').length,
    ready: orders.filter((o) => o.status === 'ready').length,
  };

  const getNextAction = (status: KdsStatus): { label: string; next: KdsStatus; color: string } | null => {
    switch (status) {
      case 'new': return { label: t('kds.accept') || 'Accept', next: 'in_progress', color: 'bg-amber-500 hover:bg-amber-600' };
      case 'in_progress': return { label: t('kds.markReady') || 'Ready', next: 'ready', color: 'bg-emerald-500 hover:bg-emerald-600' };
      case 'ready': return { label: t('kds.delivered') || 'Delivered', next: 'delivered', color: 'bg-brand-500 hover:bg-brand-600' };
      default: return null;
    }
  };

  return (
    <div className="h-full flex flex-col bg-gray-900 text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <ChefHat className="w-6 h-6 text-orange-400" />
          <h1 className="text-lg font-bold">{t('kds.title') || 'Kitchen Display'}</h1>
          {counts.new > 0 && (
            <span className="bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded-full animate-pulse">
              {counts.new} {t('kds.newOrders') || 'new'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className="p-2 rounded-lg hover:bg-gray-700 transition-colors"
            title={soundEnabled ? 'Mute' : 'Unmute'}
          >
            {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5 text-gray-500" />}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-gray-700 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 px-4 py-2 bg-gray-800/50">
        {(['all', 'new', 'in_progress', 'ready'] as FilterTab[]).map((tab) => {
          const isActive = filter === tab;
          const count = counts[tab];
          const labels: Record<FilterTab, string> = {
            all: t('kds.all') || 'All',
            new: t('kds.statusNew') || 'New',
            in_progress: t('kds.statusCooking') || 'Cooking',
            ready: t('kds.statusReady') || 'Ready',
          };
          return (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-white text-gray-900'
                  : 'text-gray-400 hover:text-white hover:bg-gray-700'
              }`}
            >
              {labels[tab]}
              {count > 0 && (
                <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                  isActive ? 'bg-gray-200 text-gray-700' : 'bg-gray-700 text-gray-300'
                }`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Order grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <ChefHat className="w-16 h-16 mb-4 opacity-30" />
            <p className="text-lg font-medium">{t('kds.noOrders') || 'No active orders'}</p>
            <p className="text-sm mt-1">{t('kds.noOrdersHint') || 'Orders will appear here when items are added to tables'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {filtered.map((order) => {
              const config = STATUS_STYLE[order.status] || STATUS_STYLE.new;
              const StatusIcon = config.icon;
              const nextAction = getNextAction(order.status);
              const elapsed = formatElapsedMinutes(order.created_at);
              const isUrgent = order.status === 'new' && (Date.now() - new Date(order.created_at).getTime()) > 600000; // >10min

              return (
                <div
                  key={order.id}
                  className={`rounded-xl border-2 overflow-hidden transition-all ${config.border} ${config.bg} ${
                    isUrgent ? 'ring-2 ring-red-400 animate-pulse' : ''
                  }`}
                >
                  {/* Card header */}
                  <div className={`px-3 py-2 flex items-center justify-between ${
                    order.status === 'new' ? 'bg-red-100' : order.status === 'in_progress' ? 'bg-amber-100' : 'bg-emerald-100'
                  }`}>
                    <div className="flex items-center gap-2">
                      <span className="text-base font-bold text-gray-900">
                        {order.table_name || 'Table'}
                      </span>
                      {order.floor_name && (
                        <span className="text-[10px] text-gray-500 bg-white/60 px-1.5 py-0.5 rounded">
                          {order.floor_name}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-gray-500" />
                      <span className={`text-xs font-mono tabular-nums ${isUrgent ? 'text-red-600 font-bold' : 'text-gray-600'}`}>
                        {elapsed}
                      </span>
                    </div>
                  </div>

                  {/* Items */}
                  <div className="px-3 py-2 space-y-1">
                    {order.items.map((item) => (
                      <div key={item.id} className="flex items-start gap-2">
                        <span className="text-base font-bold text-gray-900 min-w-[24px]">
                          {item.quantity}x
                        </span>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-gray-800 block truncate">
                            {item.name}
                          </span>
                          {item.notes && (
                            <span className="text-xs text-gray-500 italic">{item.notes}</span>
                          )}
                        </div>
                      </div>
                    ))}
                    {order.notes && (
                      <div className="text-xs text-gray-600 bg-white/50 rounded px-2 py-1 mt-1 italic">
                        {order.notes}
                      </div>
                    )}
                  </div>

                  {/* Status + Action */}
                  <div className="px-3 py-2 border-t border-gray-200/50 flex items-center justify-between gap-2">
                    <div className={`flex items-center gap-1 text-xs font-medium ${config.text}`}>
                      <StatusIcon className="w-3.5 h-3.5" />
                      {statusLabels[order.status]}
                    </div>
                    <div className="flex gap-1.5">
                      {order.status !== 'delivered' && order.status !== 'cancelled' && (
                        <button
                          onClick={() => updateStatus(order.id, 'cancelled')}
                          className="px-2 py-1 text-xs rounded-md bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors"
                        >
                          {t('kds.cancel') || 'Cancel'}
                        </button>
                      )}
                      {nextAction && (
                        <button
                          onClick={() => updateStatus(order.id, nextAction.next)}
                          className={`px-3 py-1 text-xs font-medium rounded-md text-white transition-colors flex items-center gap-1 ${nextAction.color}`}
                        >
                          {nextAction.label}
                          <ArrowRight className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
