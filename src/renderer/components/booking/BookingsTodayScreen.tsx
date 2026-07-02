/**
 * BookingsTodayScreen — lists dashboard-synced appointments for today
 * and exposes status-change / cancel actions. Distinct from
 * BookingListScreen (Booksy scraper data) — this reads from the local
 * `bookings` table populated by the sync_log applicator.
 *
 * Status transitions go through window.electronAPI.bookings.* which
 * apply locally + enqueue a sync_log entry. The renderer never talks to
 * the backend directly.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Clock,
  Edit2,
  LogIn,
  Phone as PhoneIcon,
  Plus,
  RefreshCw,
  Sparkles,
  User as UserIcon,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import BookingCreateForm from './BookingCreateForm';
import BookingEditForm, { type EditableBooking } from './BookingEditForm';

export interface BookingRowVM {
  id: string;
  owner_full_name: string | null;
  owner_phone: string | null;
  staff_user_id: string | null;
  staff_full_name: string | null;
  service_name: string | null;
  resource_name: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
  duration_minutes: number | null;
  total_price_pln: number; // grosze
  customer_notes: string | null;
  internal_notes: string | null;
}

const ACTIVE_STATUSES = new Set([
  'PENDING',
  'BOOKED',
  'CHECKED_IN',
  'IN_SERVICE',
]);
const TERMINAL_STATUSES = new Set([
  'COMPLETED',
  'PAID',
  'CANCELLED',
  'NO_SHOW',
]);

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTodayDate(): string {
  return new Date().toLocaleDateString([], {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
  });
}

function formatPriceGrosze(grosze: number): string {
  return (grosze / 100).toFixed(2);
}

interface StatusMeta {
  label: string;
  className: string;
  Icon: LucideIcon;
}

function statusMeta(status: string, label: (k: string, fb: string) => string): StatusMeta {
  switch (status) {
    case 'PENDING':
      return {
        label: label('bookings.status.pending', 'Pending'),
        className: 'bg-amber-50 text-amber-800 border-amber-200',
        Icon: Clock,
      };
    case 'BOOKED':
      return {
        label: label('bookings.status.booked', 'Booked'),
        className: 'bg-blue-50 text-blue-800 border-blue-200',
        Icon: CalendarDays,
      };
    case 'CHECKED_IN':
      return {
        label: label('bookings.status.checked_in', 'Checked in'),
        className: 'bg-indigo-50 text-indigo-800 border-indigo-200',
        Icon: LogIn,
      };
    case 'IN_SERVICE':
      return {
        label: label('bookings.status.in_service', 'In service'),
        className: 'bg-violet-50 text-violet-800 border-violet-200',
        Icon: Sparkles,
      };
    case 'COMPLETED':
      return {
        label: label('bookings.status.completed', 'Completed'),
        className: 'bg-emerald-50 text-emerald-800 border-emerald-200',
        Icon: CheckCircle2,
      };
    case 'PAID':
      return {
        label: label('bookings.status.paid', 'Paid'),
        className: 'bg-emerald-50 text-emerald-800 border-emerald-200',
        Icon: CheckCircle2,
      };
    case 'CANCELLED':
      return {
        label: label('bookings.status.cancelled', 'Cancelled'),
        className: 'bg-rose-50 text-rose-800 border-rose-200',
        Icon: XCircle,
      };
    case 'NO_SHOW':
      return {
        label: label('bookings.status.no_show', 'No show'),
        className: 'bg-slate-100 text-slate-700 border-slate-300',
        Icon: XCircle,
      };
    default:
      return {
        label: status,
        className: 'bg-slate-100 text-slate-700 border-slate-300',
        Icon: Clock,
      };
  }
}

interface SummaryCounts {
  total: number;
  pending: number;
  inService: number;
  completed: number;
  cancelled: number;
}

function deriveCounts(rows: BookingRowVM[]): SummaryCounts {
  let pending = 0;
  let inService = 0;
  let completed = 0;
  let cancelled = 0;
  for (const r of rows) {
    switch (r.status) {
      case 'PENDING':
      case 'BOOKED':
        pending++;
        break;
      case 'CHECKED_IN':
      case 'IN_SERVICE':
        inService++;
        break;
      case 'COMPLETED':
      case 'PAID':
        completed++;
        break;
      case 'CANCELLED':
      case 'NO_SHOW':
        cancelled++;
        break;
    }
  }
  return { total: rows.length, pending, inService, completed, cancelled };
}

interface Props {
  t?: (key: string) => string;
  onBack?: () => void;
}

export default function BookingsTodayScreen({ t, onBack }: Props) {
  const label = useCallback(
    (key: string, fallback: string) => (t ? t(key) : fallback),
    [t],
  );

  const [rows, setRows] = useState<BookingRowVM[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<EditableBooking | null>(null);
  // Cancel confirmation modal state. window.prompt is unsupported in
  // this Electron renderer (throws "prompt() is not supported" and
  // never reaches api.cancel), so cancel runs through a small in-app
  // dialog instead.
  const [cancelTarget, setCancelTarget] = useState<{
    id: string;
    name: string;
    serviceName: string | null;
    startsAt: string;
  } | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const api = (window as any).electronAPI?.bookings;

  const refresh = useCallback(async () => {
    if (!api) {
      setError('bookings API not available');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data: BookingRowVM[] = await api.getToday();
      setRows(data || []);
      setError(null);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();

    // Realtime: subscribe to the socket-bridged booking event. When
    // another agent (or the dashboard) pushes a booking mutation, the
    // main process applies it locally and fires `pos:bookings-updated`;
    // we refresh the list immediately so cashiers see the change
    // without waiting for the next poll tick.
    const off = api?.onUpdated?.(() => refresh());

    // Fallback poll — catches anything the socket missed (offline
    // reconnect, pull window, etc.). Slower now that socket handles
    // the common path.
    const h = setInterval(refresh, 30_000);
    return () => {
      clearInterval(h);
      if (typeof off === 'function') off();
    };
  }, [refresh, api]);

  const runAction = useCallback(
    async (id: string, fn: () => Promise<any>) => {
      setActionId(id);
      try {
        const result = await fn();
        if (result && result.success === false) {
          setError(result.error || 'action failed');
        } else {
          setError(null);
          await refresh();
        }
      } catch (err: any) {
        setError(err.message || String(err));
      } finally {
        setActionId(null);
      }
    },
    [refresh],
  );

  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    [rows],
  );
  const counts = useMemo(() => deriveCounts(sorted), [sorted]);

  return (
    <div className="h-full flex flex-col bg-slate-50">
      <header className="flex flex-col gap-3 px-4 py-3 bg-white border-b border-slate-200 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            {label('bookings.today.title', 'Bookings')}
          </h1>
          <span className="hidden sm:inline-flex items-center gap-1.5 text-sm text-slate-500">
            <CalendarDays className="h-4 w-4" aria-hidden />
            {label('bookings.today.context', 'Today')}
            <span className="text-slate-400">·</span>
            <span className="font-medium text-slate-600">{formatTodayDate()}</span>
          </span>
          <span className="text-sm text-slate-500 tabular-nums">
            {counts.total} {label('bookings.today.count', 'appointments')}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            disabled={!api}
            className="inline-flex items-center gap-2 h-11 px-4 text-sm font-medium bg-indigo-600 text-white rounded-md shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden />
            {label('bookings.action.new_walkin', 'New walk-in')}
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            aria-label={label('common.refresh', 'Refresh')}
            className="inline-flex items-center justify-center h-11 w-11 bg-white text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
              aria-hidden
            />
          </button>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-2 h-11 px-4 text-sm font-medium bg-white text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              {label('common.back', 'Back')}
            </button>
          )}
        </div>
      </header>

      <SummaryStrip counts={counts} label={label} />

      {showCreate && (
        <BookingCreateForm
          t={t}
          onClose={() => setShowCreate(false)}
          onCreated={() => refresh()}
        />
      )}

      {editing && (
        <BookingEditForm
          // Keyed by booking id so switching to a different row —
          // possible if keyboard focus escapes the modal and the user
          // triggers Edit on another row — forces a fresh mount with
          // the new booking's seed values instead of leaking the
          // previous form state.
          key={editing.id}
          t={t}
          booking={editing}
          onClose={() => setEditing(null)}
          onSaved={() => refresh()}
        />
      )}

      {error && (
        <div
          role="alert"
          className="mx-6 mt-4 p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-md text-sm"
        >
          {error}
        </div>
      )}

      <main className="flex-1 overflow-auto px-4 py-4 sm:px-6">
        {loading && !rows.length ? (
          <ListSkeleton />
        ) : sorted.length === 0 ? (
          <EmptyState
            label={label}
            disabled={!api}
            onCreate={() => setShowCreate(true)}
          />
        ) : (
          <ul className="space-y-2">
            {sorted.map((b) => (
              <BookingRow
                key={b.id}
                row={b}
                busy={actionId === b.id}
                api={api}
                label={label}
                onEdit={() =>
                  setEditing({
                    id: b.id,
                    starts_at: b.starts_at,
                    staff_user_id: b.staff_user_id,
                    staff_full_name: b.staff_full_name,
                    service_name: b.service_name,
                    owner_full_name: b.owner_full_name,
                    owner_phone: b.owner_phone,
                    customer_notes: b.customer_notes,
                    internal_notes: b.internal_notes,
                    status: b.status,
                  })
                }
                onCheckIn={() =>
                  runAction(b.id, () => api.changeStatus(b.id, 'CHECKED_IN'))
                }
                onComplete={() =>
                  runAction(b.id, () => api.changeStatus(b.id, 'COMPLETED'))
                }
                onCancel={() => {
                  setCancelReason('');
                  setCancelTarget({
                    id: b.id,
                    name: b.owner_full_name ?? b.id,
                    serviceName: b.service_name,
                    startsAt: b.starts_at,
                  });
                }}
              />
            ))}
          </ul>
        )}
      </main>

      {cancelTarget ? (
        <CancelDialog
          target={cancelTarget}
          reason={cancelReason}
          setReason={setCancelReason}
          onClose={() => {
            setCancelTarget(null);
            setCancelReason('');
          }}
          onConfirm={() => {
            const target = cancelTarget;
            const reason = cancelReason.trim() || 'Cancelled at POS';
            setCancelTarget(null);
            setCancelReason('');
            if (target) {
              runAction(target.id, () => api.cancel(target.id, reason));
            }
          }}
          label={label}
          busy={!!actionId}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Local helper components — kept in this file per spec; small enough
// that splitting into separate modules would just add noise.
// ─────────────────────────────────────────────────────────────────────

function SummaryStrip({
  counts,
  label,
}: {
  counts: SummaryCounts;
  label: (k: string, fb: string) => string;
}) {
  const items: Array<{
    key: string;
    value: number;
    tone: string;
    Icon: LucideIcon;
  }> = [
    {
      key: label('bookings.summary.total', 'Total'),
      value: counts.total,
      tone: 'text-slate-700 bg-slate-50 border-slate-200',
      Icon: CalendarDays,
    },
    {
      key: label('bookings.summary.pending', 'Booked / pending'),
      value: counts.pending,
      tone: 'text-blue-700 bg-blue-50 border-blue-100',
      Icon: Clock,
    },
    {
      key: label('bookings.summary.in_service', 'In service'),
      value: counts.inService,
      tone: 'text-violet-700 bg-violet-50 border-violet-100',
      Icon: Sparkles,
    },
    {
      key: label('bookings.summary.completed', 'Completed / paid'),
      value: counts.completed,
      tone: 'text-emerald-700 bg-emerald-50 border-emerald-100',
      Icon: CheckCircle2,
    },
    {
      key: label('bookings.summary.cancelled', 'Cancelled / no show'),
      value: counts.cancelled,
      tone: 'text-rose-700 bg-rose-50 border-rose-100',
      Icon: XCircle,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 px-4 py-3 bg-slate-50 border-b border-slate-200 sm:px-6 md:grid-cols-5">
      {items.map((it) => {
        const Icon = it.Icon;
        return (
          <div
            key={it.key}
            className={`flex min-h-[56px] items-center gap-2 rounded-md border px-3 py-2 ${it.tone}`}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-slate-500">
                {it.key}
              </div>
              <div className="text-lg font-semibold tabular-nums text-slate-900">
                {it.value}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ListSkeleton() {
  return (
    <ul className="space-y-2" aria-hidden>
      {Array.from({ length: 4 }).map((_, i) => (
        <li
          key={i}
          className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 rounded-md border border-slate-200 bg-white p-4 sm:grid-cols-[84px_minmax(0,1fr)_96px_220px]"
        >
          <div className="space-y-2">
            <div className="h-7 w-16 rounded bg-slate-100 animate-pulse" />
            <div className="h-3 w-12 rounded bg-slate-100 animate-pulse" />
          </div>
          <div className="min-w-0 space-y-2">
            <div className="h-4 w-44 max-w-full rounded bg-slate-100 animate-pulse" />
            <div className="h-3 w-72 max-w-full rounded bg-slate-100 animate-pulse" />
            <div className="h-3 w-56 max-w-full rounded bg-slate-100 animate-pulse" />
          </div>
          <div className="hidden h-5 w-20 rounded bg-slate-100 animate-pulse sm:block" />
          <div className="hidden h-10 w-full rounded bg-slate-100 animate-pulse sm:block" />
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  label,
  disabled,
  onCreate,
}: {
  label: (k: string, fb: string) => string;
  disabled: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-6 py-10 text-center shadow-sm">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-slate-500">
        <CalendarDays className="h-6 w-6" aria-hidden />
      </div>
      <h2 className="mt-4 text-base font-semibold text-slate-900">
        {label('bookings.today.empty', 'No appointments today')}
      </h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
        {label('bookings.today.empty_hint', 'Walk-ins can still be added from this screen.')}
      </p>
      <button
        type="button"
        onClick={onCreate}
        disabled={disabled}
        className="mt-4 inline-flex items-center justify-center gap-2 h-11 px-4 text-sm font-medium bg-indigo-600 text-white rounded-md shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
      >
        <Plus className="h-4 w-4" aria-hidden />
        {label('bookings.action.new_walkin', 'New walk-in')}
      </button>
    </div>
  );
}
interface BookingRowProps {
  row: BookingRowVM;
  busy: boolean;
  api: any;
  label: (k: string, fb: string) => string;
  onEdit: () => void;
  onCheckIn: () => void;
  onComplete: () => void;
  onCancel: () => void;
}

function BookingRow({
  row,
  busy,
  api,
  label,
  onEdit,
  onCheckIn,
  onComplete,
  onCancel,
}: BookingRowProps) {
  const meta = statusMeta(row.status, label);
  const StatusIcon = meta.Icon;
  const isActive = ACTIVE_STATUSES.has(row.status);
  const isTerminal = TERMINAL_STATUSES.has(row.status);
  const canCheckIn = row.status === 'BOOKED' || row.status === 'PENDING';
  const canComplete = row.status === 'CHECKED_IN' || row.status === 'IN_SERVICE';
  const canCancel =
    row.status !== 'CANCELLED' &&
    row.status !== 'NO_SHOW' &&
    row.status !== 'PAID';

  return (
    <li
      className={`grid grid-cols-[72px_minmax(0,1fr)] gap-3 rounded-md border bg-white p-3 shadow-sm transition-colors hover:bg-slate-50 sm:grid-cols-[84px_minmax(0,1fr)_96px] sm:p-4 xl:grid-cols-[84px_minmax(0,1fr)_96px_minmax(220px,auto)] ${
        isTerminal ? 'border-slate-200 opacity-75' : 'border-slate-200'
      }`}
    >
      {/* Time rail */}
      <div className="flex flex-col items-start min-w-0">
        <div className="text-2xl font-bold tabular-nums text-slate-900 leading-tight">
          {formatTime(row.starts_at)}
        </div>
        <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-slate-500 tabular-nums">
          <Clock className="h-3 w-3" aria-hidden />
          {row.duration_minutes ? `${row.duration_minutes} min` : formatTime(row.ends_at)}
        </div>
      </div>

      {/* Identity + service + notes */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <UserIcon
            className="h-4 w-4 text-slate-400 shrink-0"
            aria-hidden
          />
          <span
            className="max-w-full truncate font-semibold text-slate-900"
            title={row.owner_full_name ?? undefined}
          >
            {row.owner_full_name || '—'}
          </span>
          {row.owner_phone ? (
            <span
              className="inline-flex max-w-full items-center gap-1 truncate text-xs text-slate-500 tabular-nums"
              title={row.owner_phone}
            >
              <PhoneIcon className="h-3 w-3" aria-hidden />
              {row.owner_phone}
            </span>
          ) : null}
          <span
            className={`inline-flex shrink-0 items-center gap-1 px-2 py-0.5 text-xs font-medium border rounded-full ${meta.className}`}
          >
            <StatusIcon className="h-3 w-3" aria-hidden />
            {meta.label}
          </span>
        </div>
        <div
          className="mt-1 text-sm text-slate-600 truncate"
          title={`${row.service_name ?? ''}${row.staff_full_name ? ' · ' + row.staff_full_name : ''}`}
        >
          <span className="font-medium text-slate-700">
            {row.service_name || '—'}
          </span>
          {row.staff_full_name ? (
            <>
              <span className="mx-1 text-slate-300">·</span>
              <span>{row.staff_full_name}</span>
            </>
          ) : null}
        </div>
        {row.customer_notes ? (
          <div
            className="mt-0.5 text-xs text-slate-500 truncate"
            title={row.customer_notes}
          >
            {row.customer_notes}
          </div>
        ) : null}
      </div>

      {/* Price */}
      <div className="col-start-2 text-left sm:col-auto sm:text-right">
        <div className="font-semibold text-slate-900 tabular-nums">
          {formatPriceGrosze(row.total_price_pln)} zł
        </div>
      </div>

      {/* Actions — fixed-width slots so layout doesn't shift between
          terminal / active rows or while a row is busy. */}
      <div className="col-span-2 flex min-w-0 flex-wrap items-center justify-start gap-2 sm:col-span-3 xl:col-span-1 xl:justify-end">
        {isActive ? (
          <>
            {canCheckIn ? (
              <button
                type="button"
                disabled={busy || !api}
                onClick={onEdit}
                className="inline-flex items-center justify-center gap-1.5 h-11 w-[88px] text-sm font-medium bg-white text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
              >
                <Edit2 className="h-4 w-4" aria-hidden />
                {label('bookings.action.edit', 'Edit')}
              </button>
            ) : null}
            {canCheckIn ? (
              <button
                type="button"
                disabled={busy || !api}
                onClick={onCheckIn}
                className="inline-flex items-center justify-center gap-1.5 h-11 w-[110px] text-sm font-medium bg-indigo-600 text-white rounded-md shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
              >
                <LogIn className="h-4 w-4" aria-hidden />
                {label('bookings.action.checkin', 'Check in')}
              </button>
            ) : null}
            {canComplete ? (
              <button
                type="button"
                disabled={busy || !api}
                onClick={onComplete}
                className="inline-flex items-center justify-center gap-1.5 h-11 w-[110px] text-sm font-medium bg-emerald-600 text-white rounded-md shadow-sm hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 disabled:opacity-50"
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                {label('bookings.action.complete', 'Complete')}
              </button>
            ) : null}
            {canCancel ? (
              <button
                type="button"
                disabled={busy || !api}
                onClick={onCancel}
                className="inline-flex items-center justify-center gap-1.5 h-11 w-[88px] text-sm font-medium bg-white text-rose-700 border border-rose-200 rounded-md hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2 disabled:opacity-50"
              >
                <XCircle className="h-4 w-4" aria-hidden />
                {label('bookings.action.cancel', 'Cancel')}
              </button>
            ) : null}
          </>
        ) : (
          <span className="text-xs text-slate-400">
            {label('bookings.action.none', 'No actions')}
          </span>
        )}
      </div>
    </li>
  );
}

function CancelDialog({
  target,
  reason,
  setReason,
  onClose,
  onConfirm,
  label,
  busy,
}: {
  target: { id: string; name: string; serviceName: string | null; startsAt: string };
  reason: string;
  setReason: (v: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  label: (k: string, fb: string) => string;
  busy: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-title"
      onClick={() => {
        // Backdrop click dismisses only when no action is in flight.
        if (!busy) onClose();
      }}
    >
      <div
        className="bg-white rounded-md shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h3 id="cancel-title" className="text-base font-semibold text-slate-900">
            {label('bookings.cancel.title', 'Cancel booking')}
          </h3>
        </header>
        <div className="px-5 py-4 space-y-3">
          <dl className="text-sm space-y-1">
            <div className="flex gap-2">
              <dt className="w-20 text-slate-500">
                {label('bookings.cancel.customer', 'Customer')}
              </dt>
              <dd className="font-medium text-slate-900 truncate" title={target.name}>
                {target.name}
              </dd>
            </div>
            {target.serviceName ? (
              <div className="flex gap-2">
                <dt className="w-20 text-slate-500">
                  {label('bookings.cancel.service', 'Service')}
                </dt>
                <dd className="text-slate-700 truncate" title={target.serviceName}>
                  {target.serviceName}
                </dd>
              </div>
            ) : null}
            <div className="flex gap-2">
              <dt className="w-20 text-slate-500">
                {label('bookings.cancel.starts_at', 'Start')}
              </dt>
              <dd className="text-slate-700 tabular-nums">
                {formatTime(target.startsAt)}
              </dd>
            </div>
          </dl>

          <div>
            <label
              htmlFor="cancel-reason"
              className="block text-sm font-medium text-slate-700 mb-1"
            >
              {label('bookings.cancel.reason', 'Cancel reason')}
            </label>
            <textarea
              id="cancel-reason"
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              disabled={busy}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
              placeholder={label(
                'bookings.cancel.reason_placeholder',
                'Optional — leaves "Cancelled at POS" if blank',
              )}
            />
          </div>
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-md">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex items-center justify-center h-11 px-4 text-sm font-medium bg-white text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
          >
            {label('common.close', 'Close')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center justify-center gap-1.5 h-11 px-4 text-sm font-medium bg-rose-600 text-white rounded-md shadow-sm hover:bg-rose-700 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2 disabled:opacity-50"
          >
            <XCircle className="h-4 w-4" aria-hidden />
            {label('bookings.cancel.confirm', 'Cancel booking')}
          </button>
        </footer>
      </div>
    </div>
  );
}
