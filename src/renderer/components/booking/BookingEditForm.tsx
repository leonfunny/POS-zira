/**
 * BookingEditForm — edit an existing booking's time / staff / notes.
 *
 * Reuses the push path via electronAPI.bookings.update. Server validates
 * schedule conflict (pessimistic lock) and rejects if the new slot
 * overlaps another booking for the selected staff. We don't edit
 * service / customer identity here — those are ownership changes and
 * belong on the dashboard.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface StaffRow {
  id: string;                      // staff_profiles.id
  user_id?: string | null;         // canonical users.id (post backend v24)
  name: string;
  is_active: number;
}

export interface EditableBooking {
  id: string;
  starts_at: string;       // ISO UTC from local row
  staff_user_id: string | null;
  staff_full_name: string | null;
  service_name: string | null;
  owner_full_name: string | null;
  owner_phone: string | null;
  customer_notes: string | null;
  internal_notes: string | null;
  status: string;
}

interface Props {
  t?: (key: string) => string;
  booking: EditableBooking;
  onClose: () => void;
  onSaved?: () => void;
}

/**
 * Convert an ISO UTC string into the "YYYY-MM-DDTHH:mm" shape that
 * <input type="datetime-local"> expects, rendered in the user's local
 * timezone so the picker reads naturally.
 */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function BookingEditForm({ t, booking, onClose, onSaved }: Props) {
  const label = useCallback(
    (key: string, fallback: string) => (t ? t(key) : fallback),
    [t],
  );

  const api = (window as any).electronAPI;

  // Staff list for picker
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Editable fields — seeded from the existing booking
  const [staffUserId, setStaffUserId] = useState(booking.staff_user_id || '');
  const [startsAtLocal, setStartsAtLocal] = useState(
    isoToLocalInput(booking.starts_at),
  );
  const [customerNotes, setCustomerNotes] = useState(booking.customer_notes || '');
  const [internalNotes, setInternalNotes] = useState(booking.internal_notes || '');

  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Load staff (same cancellation pattern as BookingCreateForm)
  useEffect(() => {
    if (!api?.pos?.staff) {
      setLoadError('staff API unavailable');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list: StaffRow[] = await api.pos.staff.getAll();
        if (cancelled) return;
        setStaff((list || []).filter((s) => s.is_active !== 0));
        setLoadError(null);
      } catch (err: any) {
        if (cancelled) return;
        setLoadError(err.message || String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Only send fields the user actually changed — prevents the server
  // from running availability checks against unchanged values.
  const patch = useMemo(() => {
    const out: Record<string, any> = {};
    if (staffUserId && staffUserId !== booking.staff_user_id) {
      out.staffUserId = staffUserId;
    }
    const originalLocal = isoToLocalInput(booking.starts_at);
    if (startsAtLocal && startsAtLocal !== originalLocal) {
      const parsed = new Date(startsAtLocal);
      if (!Number.isNaN(parsed.getTime())) {
        out.startsAt = parsed.toISOString();
      }
    }
    if (customerNotes !== (booking.customer_notes || '')) {
      out.customerNotes = customerNotes || null;
    }
    if (internalNotes !== (booking.internal_notes || '')) {
      out.internalNotes = internalNotes || null;
    }
    return out;
  }, [staffUserId, startsAtLocal, customerNotes, internalNotes, booking]);

  const hasChanges = Object.keys(patch).length > 0;
  const canSubmit = hasChanges && !submitting;

  const safeClose = useCallback(() => {
    if (submittingRef.current || submitting) return;
    onClose();
  }, [submitting, onClose]);

  const submit = useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    if (!api?.bookings) {
      setSubmitError('bookings API unavailable');
      submittingRef.current = false;
      return;
    }
    setSubmitting(true);
    setSubmitError(null);

    // Validate startsAt one more time — the memo already dropped
    // Invalid Date values but defensive check blocks empty submit on
    // edge races.
    if (patch.startsAt !== undefined) {
      const parsed = new Date(patch.startsAt);
      if (Number.isNaN(parsed.getTime())) {
        setSubmitError(label('bookings.create.invalid_time', 'Invalid start time'));
        setSubmitting(false);
        submittingRef.current = false;
        return;
      }
    }

    try {
      const result = await api.bookings.update(booking.id, patch);
      if (result && result.success === false) {
        setSubmitError(result.error || 'update failed');
        return;
      }
      onSaved?.();
      onClose();
    } catch (err: any) {
      setSubmitError(err.message || String(err));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }, [api, booking.id, patch, label, onClose, onSaved]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      onClick={safeClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-full overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b">
          <div>
            <h2 className="text-lg font-semibold">
              {label('bookings.edit.title', 'Edit booking')}
            </h2>
            <p className="text-xs text-gray-500">
              {booking.owner_full_name || '—'} · {booking.service_name || '—'}
            </p>
          </div>
          <button
            onClick={safeClose}
            disabled={submitting}
            className="text-gray-500 hover:text-gray-700 disabled:opacity-30"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {loadError && (
          <div className="mx-5 mt-4 p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded text-sm">
            {loadError}
          </div>
        )}

        <form
          className="p-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) submit();
          }}
        >
          <div>
            <label className="block text-sm font-medium mb-1">
              {label('bookings.create.staff', 'Staff')}
            </label>
            <select
              value={staffUserId}
              onChange={(e) => setStaffUserId(e.target.value)}
              className="w-full border rounded px-3 py-2 bg-white"
            >
              <option value="">— {label('common.select', 'select')} —</option>
              {staff.map((s) => (
                // See BookingCreateForm for rationale: prefer canonical
                // users.id; fall back to staff_profiles.id pre-v24.
                <option key={s.id} value={s.user_id || s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              {label('bookings.create.starts_at', 'Start time')}
            </label>
            <input
              type="datetime-local"
              value={startsAtLocal}
              onChange={(e) => setStartsAtLocal(e.target.value)}
              step={300}
              className="w-full border rounded px-3 py-2"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              {label('bookings.create.notes', 'Customer notes')}
            </label>
            <textarea
              value={customerNotes}
              onChange={(e) => setCustomerNotes(e.target.value)}
              rows={2}
              className="w-full border rounded px-3 py-2 resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              {label('bookings.edit.internal_notes', 'Internal notes')}
            </label>
            <textarea
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              rows={2}
              className="w-full border rounded px-3 py-2 resize-none"
            />
          </div>

          {submitError && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded text-sm">
              {submitError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={safeClose}
              disabled={submitting}
              className="px-4 py-2 text-sm bg-gray-100 text-gray-800 rounded hover:bg-gray-200 disabled:opacity-50"
            >
              {label('common.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting
                ? label('common.submitting', 'Submitting…')
                : label('bookings.edit.save', 'Save changes')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
