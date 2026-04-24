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

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatPriceGrosze(grosze: number): string {
  return (grosze / 100).toFixed(2);
}

function statusColor(status: string): string {
  switch (status) {
    case 'PENDING':
      return 'bg-amber-100 text-amber-800';
    case 'BOOKED':
      return 'bg-blue-100 text-blue-800';
    case 'CHECKED_IN':
      return 'bg-indigo-100 text-indigo-800';
    case 'IN_SERVICE':
      return 'bg-purple-100 text-purple-800';
    case 'COMPLETED':
      return 'bg-emerald-100 text-emerald-800';
    case 'PAID':
      return 'bg-green-100 text-green-800';
    case 'CANCELLED':
      return 'bg-rose-100 text-rose-800';
    case 'NO_SHOW':
      return 'bg-gray-200 text-gray-700';
    default:
      return 'bg-gray-100 text-gray-600';
  }
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

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <header className="flex items-center justify-between px-6 py-4 bg-white border-b">
        <div>
          <h1 className="text-2xl font-semibold">
            {label('bookings.today.title', "Today's Bookings")}
          </h1>
          <p className="text-sm text-gray-500">
            {sorted.length}{' '}
            {label('bookings.today.count', 'appointment(s)')}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreate(true)}
            className="px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700"
          >
            + {label('bookings.action.new_walkin', 'New walk-in')}
          </button>
          <button
            onClick={refresh}
            className="px-3 py-2 text-sm bg-gray-100 rounded hover:bg-gray-200"
          >
            {label('common.refresh', 'Refresh')}
          </button>
          {onBack && (
            <button
              onClick={onBack}
              className="px-3 py-2 text-sm bg-gray-800 text-white rounded hover:bg-gray-900"
            >
              {label('common.back', 'Back')}
            </button>
          )}
        </div>
      </header>

      {showCreate && (
        <BookingCreateForm
          t={t}
          onClose={() => setShowCreate(false)}
          onCreated={() => refresh()}
        />
      )}

      {editing && (
        <BookingEditForm
          t={t}
          booking={editing}
          onClose={() => setEditing(null)}
          onSaved={() => refresh()}
        />
      )}

      {error && (
        <div className="mx-6 mt-4 p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded">
          {error}
        </div>
      )}

      <main className="flex-1 overflow-auto px-6 py-4">
        {loading && !rows.length ? (
          <div className="text-center text-gray-400 py-12">
            {label('common.loading', 'Loading…')}
          </div>
        ) : sorted.length === 0 ? (
          <div className="text-center text-gray-400 py-12">
            {label('bookings.today.empty', 'No appointments today')}
          </div>
        ) : (
          <ul className="space-y-2">
            {sorted.map((b) => {
              const busy = actionId === b.id;
              return (
                <li
                  key={b.id}
                  className="bg-white rounded-lg shadow-sm border p-4 flex items-center gap-4"
                >
                  <div className="flex flex-col items-center min-w-[80px]">
                    <div className="text-2xl font-bold">
                      {formatTime(b.starts_at)}
                    </div>
                    <div className="text-xs text-gray-400">
                      {formatTime(b.ends_at)}
                    </div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">
                        {b.owner_full_name || '—'}
                      </span>
                      <span
                        className={`px-2 py-0.5 text-xs rounded ${statusColor(b.status)}`}
                      >
                        {b.status}
                      </span>
                    </div>
                    <div className="text-sm text-gray-600 truncate">
                      {b.service_name || '—'}
                      {b.staff_full_name ? ` · ${b.staff_full_name}` : ''}
                    </div>
                    {b.customer_notes && (
                      <div className="text-xs text-gray-400 truncate mt-0.5">
                        {b.customer_notes}
                      </div>
                    )}
                  </div>

                  <div className="text-right">
                    <div className="font-semibold">
                      {formatPriceGrosze(b.total_price_pln)} zł
                    </div>
                  </div>

                  <div className="flex gap-2">
                    {b.status === 'BOOKED' || b.status === 'PENDING' ? (
                      <>
                        <button
                          disabled={busy}
                          onClick={() =>
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
                          className="px-3 py-2 text-sm bg-gray-100 text-gray-800 rounded hover:bg-gray-200 disabled:opacity-50"
                        >
                          {label('bookings.action.edit', 'Edit')}
                        </button>
                        <button
                          disabled={busy || !api}
                          onClick={() =>
                            runAction(b.id, () =>
                              api.changeStatus(b.id, 'CHECKED_IN'),
                            )
                          }
                          className="px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                        >
                          {label('bookings.action.checkin', 'Check in')}
                        </button>
                      </>
                    ) : null}

                    {b.status === 'CHECKED_IN' || b.status === 'IN_SERVICE' ? (
                      <button
                        disabled={busy || !api}
                        onClick={() =>
                          runAction(b.id, () =>
                            api.changeStatus(b.id, 'COMPLETED'),
                          )
                        }
                        className="px-3 py-2 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {label('bookings.action.complete', 'Complete')}
                      </button>
                    ) : null}

                    {b.status !== 'CANCELLED' &&
                    b.status !== 'NO_SHOW' &&
                    b.status !== 'PAID' ? (
                      <button
                        disabled={busy || !api}
                        onClick={() => {
                          const reason = window.prompt(
                            label('bookings.cancel.reason', 'Cancel reason'),
                            '',
                          );
                          if (reason === null) return;
                          runAction(b.id, () =>
                            api.cancel(b.id, reason || 'Cancelled at POS'),
                          );
                        }}
                        className="px-3 py-2 text-sm bg-rose-100 text-rose-800 rounded hover:bg-rose-200 disabled:opacity-50"
                      >
                        {label('bookings.action.cancel', 'Cancel')}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
