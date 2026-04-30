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
import {
  AlertCircle,
  CalendarClock,
  StickyNote,
  X as CloseIcon,
  type LucideIcon,
} from 'lucide-react';

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

function statusToneClass(status: string): string {
  switch (status) {
    case 'PENDING':
      return 'bg-amber-50 text-amber-800 border-amber-200';
    case 'BOOKED':
      return 'bg-blue-50 text-blue-800 border-blue-200';
    case 'CHECKED_IN':
      return 'bg-indigo-50 text-indigo-800 border-indigo-200';
    case 'IN_SERVICE':
      return 'bg-violet-50 text-violet-800 border-violet-200';
    case 'COMPLETED':
    case 'PAID':
      return 'bg-emerald-50 text-emerald-800 border-emerald-200';
    case 'CANCELLED':
    case 'NO_SHOW':
      return 'bg-gray-100 text-gray-700 border-gray-300';
    default:
      return 'bg-gray-100 text-gray-700 border-gray-300';
  }
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

  const firstFieldRef = useRef<HTMLSelectElement | null>(null);

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

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

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
      aria-labelledby="booking-edit-title"
      onClick={safeClose}
    >
      <div
        className="bg-white rounded-md shadow-xl w-full max-w-lg max-h-full overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 px-5 py-3 border-b border-gray-200">
          <div className="min-w-0">
            <h2 id="booking-edit-title" className="text-lg font-semibold text-gray-900">
              {label('bookings.edit.title', 'Edit booking')}
            </h2>
            <div className="mt-1 flex items-center flex-wrap gap-x-2 gap-y-1 text-xs">
              <span className="font-medium text-gray-700 truncate">
                {booking.owner_full_name || '—'}
              </span>
              {booking.service_name ? (
                <>
                  <span className="text-gray-300">·</span>
                  <span className="text-gray-600 truncate">{booking.service_name}</span>
                </>
              ) : null}
              <span
                className={`inline-flex items-center px-2 py-0.5 border rounded-full ${statusToneClass(booking.status)}`}
              >
                {booking.status}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={safeClose}
            disabled={submitting}
            className="inline-flex items-center justify-center h-9 w-9 text-gray-500 rounded-md hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 disabled:opacity-30 shrink-0"
            aria-label={label('common.close', 'Close')}
          >
            <CloseIcon className="h-4 w-4" aria-hidden />
          </button>
        </header>

        {loadError && (
          <div
            role="alert"
            className="mx-5 mt-4 p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-md text-sm flex items-start gap-2"
          >
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <div>{loadError}</div>
          </div>
        )}

        <form
          className="p-5 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) submit();
          }}
        >
          <section className="space-y-3">
            <SectionHeader
              icon={CalendarClock}
              title={label('bookings.edit.section.appointment', 'Appointment')}
            />

            <Field label={label('bookings.create.staff', 'Staff')}>
              <select
                ref={firstFieldRef}
                value={staffUserId}
                onChange={(e) => setStaffUserId(e.target.value)}
                className="w-full h-11 border border-gray-300 rounded-md px-3 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
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
            </Field>

            <Field label={label('bookings.create.starts_at', 'Start time')}>
              <input
                type="datetime-local"
                value={startsAtLocal}
                onChange={(e) => setStartsAtLocal(e.target.value)}
                step={300}
                className="w-full h-11 border border-gray-300 rounded-md px-3 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </Field>
          </section>

          <section className="space-y-3">
            <SectionHeader
              icon={StickyNote}
              title={label('bookings.edit.section.notes', 'Notes')}
            />
            <Field label={label('bookings.create.notes', 'Customer notes')}>
              <textarea
                value={customerNotes}
                onChange={(e) => setCustomerNotes(e.target.value)}
                rows={2}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </Field>
            <Field label={label('bookings.edit.internal_notes', 'Internal notes')}>
              <textarea
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
                rows={2}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </Field>
          </section>

          {submitError && (
            <div
              role="alert"
              className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-md text-sm flex items-start gap-2"
            >
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
              <div>{submitError}</div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={safeClose}
              disabled={submitting}
              className="inline-flex items-center justify-center h-11 px-4 text-sm font-medium bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {label('common.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center justify-center h-11 min-w-[140px] px-4 text-sm font-medium bg-indigo-600 text-white rounded-md shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
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

// ─────────────────────────────────────────────────────────────────────
// Local helpers — small enough to live alongside the form.
// ─────────────────────────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  title,
}: {
  icon: LucideIcon;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span>{title}</span>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      {children}
    </label>
  );
}
