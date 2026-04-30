/**
 * BookingCreateForm — POS walk-in booking create.
 *
 * Pulls local master data (services, service_rules, staff) for pickers
 * and submits via electronAPI.bookings.create. The server resolves the
 * owner by phone (auto-creates if not found) so we collect phone+name
 * instead of searching for an existing Owner row.
 *
 * Scope: minimal booking flow. Reschedule, existing-owner search, and
 * deposit/extras pickers are out of scope — Phase 1/2 deliver those
 * elsewhere.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface ServiceRow {
  id: string;
  name: string;
  base_price_pln: number;         // grosze
  base_duration_minutes: number;
  is_active: number;
}

interface ServiceRuleRow {
  id: string;
  service_id: string;
  size_category: string | null;
  duration_min: number;
  base_price_pln: number;         // grosze
  deposit_pln: number;
  name: string | null;
}

interface StaffRow {
  id: string;                      // staff_profiles.id
  user_id?: string | null;         // canonical users.id (post backend v24)
  name: string;
  is_active: number;
}

interface Props {
  t?: (key: string) => string;
  onClose: () => void;
  onCreated?: (bookingId: string) => void;
}

function formatGrosze(g: number): string {
  return (g / 100).toFixed(2);
}

/**
 * Round a Date up to the next 5-minute mark so default picker value is
 * a sensible "close enough to now" slot.
 */
function roundUpTo5Min(d: Date): Date {
  const out = new Date(d);
  const rem = out.getMinutes() % 5;
  if (rem) out.setMinutes(out.getMinutes() + (5 - rem));
  out.setSeconds(0);
  out.setMilliseconds(0);
  return out;
}

/**
 * datetime-local input wants "YYYY-MM-DDTHH:mm" in LOCAL time (no tz
 * suffix). Produce that from a Date.
 */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function BookingCreateForm({ t, onClose, onCreated }: Props) {
  const label = useCallback(
    (key: string, fallback: string) => (t ? t(key) : fallback),
    [t],
  );

  // Master data
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [rules, setRules] = useState<ServiceRuleRow[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [masterError, setMasterError] = useState<string | null>(null);

  // Form state
  const [serviceId, setServiceId] = useState<string>('');
  const [ruleId, setRuleId] = useState<string>('');
  // Track which serviceId we're currently fetching rules for. Prevents
  // submit firing with a stale ruleId left over from a previous service
  // selection: if the user clicks Service A → A's rules load + first
  // rule auto-selected → user picks Service B → before B's rules
  // arrive, ruleId still references A's rule. Without this guard the
  // form is briefly submittable with an A-rule + B-service mismatch.
  const [rulesLoadingForServiceId, setRulesLoadingForServiceId] = useState<string | null>(null);
  const [staffUserId, setStaffUserId] = useState<string>('');
  const [startsAtLocal, setStartsAtLocal] = useState<string>(() =>
    toLocalInput(roundUpTo5Min(new Date(Date.now() + 15 * 60_000))),
  );
  const [customerPhone, setCustomerPhone] = useState<string>('');
  const [customerName, setCustomerName] = useState<string>('');
  const [customerEmail, setCustomerEmail] = useState<string>('');
  const [customerNotes, setCustomerNotes] = useState<string>('');

  // Submission state. submittingRef locks immediately (not subject to
  // React's state-commit delay) so a double Enter / fast click can't
  // issue two IPC create calls with different generated UUIDs, which
  // would otherwise create two bookings (one accepted, one
  // SCHEDULE_CONFLICT) for the same user intent.
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const api = (window as any).electronAPI;

  // Initial load: services + staff. Uses a cancellation flag so
  // `setState` doesn't fire on an unmounted component when the user
  // closes the modal before the IPC round-trip completes — this
  // otherwise triggers a React warning and can leak state transitions
  // into the next mount's initial render if React re-uses the fiber.
  useEffect(() => {
    if (!api?.services || !api?.pos?.staff) {
      setMasterError('required APIs unavailable');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [svcList, staffList] = await Promise.all([
          api.services.getAllActive() as Promise<ServiceRow[]>,
          api.pos.staff.getAll() as Promise<StaffRow[]>,
        ]);
        if (cancelled) return;
        setServices(svcList || []);
        setStaff((staffList || []).filter((s) => s.is_active !== 0));
        setMasterError(null);
      } catch (err: any) {
        if (cancelled) return;
        setMasterError(err.message || String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // When service changes, load rules + auto-pick first. Two safeties
  // against the stale-ruleId trap:
  //   1. Clear `rules` + `ruleId` SYNCHRONOUSLY at the top so canSubmit
  //      can't see a leftover rule from the previous service while the
  //      new fetch is in flight.
  //   2. `rulesLoadingForServiceId` blocks submit until we know whether
  //      the service has rules.
  useEffect(() => {
    setRules([]);
    setRuleId('');
    if (!serviceId || !api?.services) {
      setRulesLoadingForServiceId(null);
      return;
    }
    setRulesLoadingForServiceId(serviceId);
    let cancelled = false;
    (async () => {
      try {
        const list: ServiceRuleRow[] = await api.services.getRulesByService(
          serviceId,
        );
        if (cancelled) return;
        setRules(list || []);
        setRuleId(list?.[0]?.id ?? '');
      } catch {
        if (cancelled) return;
        setRules([]);
        setRuleId('');
      } finally {
        if (!cancelled) setRulesLoadingForServiceId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serviceId, api]);

  const selectedService = useMemo(
    () => services.find((s) => s.id === serviceId) ?? null,
    [services, serviceId],
  );
  // Only honor a rule that belongs to the currently-selected service.
  // Defensive — if a stale ruleId leaks through (eg. fast service flip
  // before the new fetch lands) we'd otherwise read it as legitimate.
  const selectedRule = useMemo(() => {
    const r = rules.find((rr) => rr.id === ruleId) ?? null;
    if (!r) return null;
    return r.service_id === serviceId ? r : null;
  }, [rules, ruleId, serviceId]);

  // Effective duration/price for display + submit. Prefer the selected
  // rule (multi-tier services); fall back to the service's base fields
  // for services that have no rules at all (23 active services in the
  // current Dzai dataset). Without this fallback, canSubmit would never
  // flip true and the cashier sees a Create button stuck disabled.
  const effectiveDurationMin = selectedRule?.duration_min ?? selectedService?.base_duration_minutes ?? null;
  const effectivePricePln = selectedRule?.base_price_pln ?? selectedService?.base_price_pln ?? null;
  const rulesAreLoading = rulesLoadingForServiceId === serviceId && !!serviceId;
  const noRulesAvailable = !!serviceId && !rulesAreLoading && rules.length === 0;

  const canSubmit =
    !!serviceId &&
    // Block while the rule fetch for the *current* service is still in
    // flight. Without this, the cashier could click Create after the
    // initial render of the new service while ruleId still points at
    // the previous service's rule.
    !rulesAreLoading &&
    // Either an explicit rule pick (selectedRule is null when ruleId
    // belongs to a different service — see useMemo guard above), OR a
    // service with no rules but valid base duration+price.
    (!!selectedRule || (noRulesAvailable && effectiveDurationMin != null && effectivePricePln != null)) &&
    !!staffUserId &&
    !!startsAtLocal &&
    !!customerPhone.trim() &&
    !!customerName.trim() &&
    !submitting;

  const submit = useCallback(async () => {
    // Ref lock — runs BEFORE state commit so a double Enter or fast
    // double-click doesn't spawn two IPC calls (see Bug H).
    if (submittingRef.current) return;
    submittingRef.current = true;

    if (!api?.bookings) {
      setSubmitError('bookings API unavailable');
      submittingRef.current = false;
      return;
    }
    setSubmitting(true);
    setSubmitError(null);

    // Interpret datetime-local as local time, send UTC ISO to server.
    // Guard against Invalid Date — `toISOString()` on Invalid Date
    // throws RangeError which would bubble as an unhandled rejection
    // since it's outside the try.
    const parsed = new Date(startsAtLocal);
    if (Number.isNaN(parsed.getTime())) {
      setSubmitError(label('bookings.create.invalid_time', 'Invalid start time'));
      setSubmitting(false);
      submittingRef.current = false;
      return;
    }
    const startsAtIso = parsed.toISOString();
    try {
      const result = await api.bookings.create({
        serviceId,
        staffUserId,
        startsAt: startsAtIso,
        ruleId: ruleId || undefined,
        customerPhone: customerPhone.trim(),
        customerName: customerName.trim(),
        customerEmail: customerEmail.trim() || undefined,
        customerNotes: customerNotes.trim() || undefined,
      });
      if (result && result.success === false) {
        setSubmitError(result.error || 'create failed');
        return;
      }
      onCreated?.(result?.bookingId || '');
      onClose();
    } catch (err: any) {
      setSubmitError(err.message || String(err));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }, [
    api,
    serviceId,
    ruleId,
    staffUserId,
    startsAtLocal,
    customerPhone,
    customerName,
    customerEmail,
    customerNotes,
    onClose,
    onCreated,
  ]);

  // Prevent closing while a submit is in flight — the IPC call is
  // already running in the main process; abandoning the modal leaves
  // the user guessing whether the booking was created.
  const safeClose = useCallback(() => {
    if (submittingRef.current || submitting) return;
    onClose();
  }, [submitting, onClose]);

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
          <h2 className="text-lg font-semibold">
            {label('bookings.create.title', 'New walk-in booking')}
          </h2>
          <button
            onClick={safeClose}
            disabled={submitting}
            className="text-gray-500 hover:text-gray-700 disabled:opacity-30"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {masterError && (
          <div className="mx-5 mt-4 p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded text-sm">
            {masterError}
          </div>
        )}

        <form
          className="p-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) submit();
          }}
        >
          {/* Service + rule (combined row) */}
          <div>
            <label className="block text-sm font-medium mb-1">
              {label('bookings.create.service', 'Service')}
            </label>
            <select
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              className="w-full border rounded px-3 py-2 bg-white"
              required
            >
              <option value="">— {label('common.select', 'select')} —</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          {rules.length > 1 && (
            <div>
              <label className="block text-sm font-medium mb-1">
                {label('bookings.create.rule', 'Pricing / duration')}
              </label>
              <select
                value={ruleId}
                onChange={(e) => setRuleId(e.target.value)}
                className="w-full border rounded px-3 py-2 bg-white"
              >
                {rules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name ?? r.size_category ?? `Rule ${r.id.slice(0, 4)}`} ·{' '}
                    {r.duration_min}min · {formatGrosze(r.base_price_pln)} zł
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Show effective duration/price even when the service has no
              rules — pulled from service.base_* in that case. Note label
              clarifies the source so cashiers know it's a service-level
              default, not a tier they picked. */}
          {effectiveDurationMin != null && effectivePricePln != null && (
            <div className="flex justify-between text-sm text-gray-600">
              <span>
                {effectiveDurationMin} {label('common.minutes', 'min')}
                {noRulesAvailable ? (
                  <span className="ml-2 text-xs text-gray-500">
                    {label('bookings.create.no_rules', '(service default)')}
                  </span>
                ) : null}
              </span>
              <span className="font-semibold">
                {formatGrosze(effectivePricePln)} zł
              </span>
            </div>
          )}

          {/* Staff */}
          <div>
            <label className="block text-sm font-medium mb-1">
              {label('bookings.create.staff', 'Staff')}
            </label>
            <select
              value={staffUserId}
              onChange={(e) => setStaffUserId(e.target.value)}
              className="w-full border rounded px-3 py-2 bg-white"
              required
            >
              <option value="">— {label('common.select', 'select')} —</option>
              {staff.map((s) => (
                // Bind to canonical users.id when the backend has shipped it
                // (v24+); fall back to staff_profiles.id so older local DBs
                // still pick a usable id. The server's resolveStaffUserId
                // tolerates both, so any combination round-trips correctly.
                <option key={s.id} value={s.user_id || s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          {/* Time */}
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
              required
            />
          </div>

          <hr className="my-2" />

          {/* Customer */}
          <div>
            <label className="block text-sm font-medium mb-1">
              {label('bookings.create.phone', 'Phone')}
            </label>
            <input
              type="tel"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              placeholder="+48..."
              className="w-full border rounded px-3 py-2"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              {label('bookings.create.name', 'Customer name')}
            </label>
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              className="w-full border rounded px-3 py-2"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              {label('bookings.create.email', 'Email (optional)')}
            </label>
            <input
              type="email"
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              className="w-full border rounded px-3 py-2"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              {label('bookings.create.notes', 'Notes (optional)')}
            </label>
            <textarea
              value={customerNotes}
              onChange={(e) => setCustomerNotes(e.target.value)}
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
                : label('bookings.create.submit', 'Create booking')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
