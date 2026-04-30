/**
 * BookingCreateForm — POS walk-in booking create.
 *
 * Pulls local master data (services, service_rules, staff) for pickers
 * and submits via electronAPI.bookings.create. The server resolves the
 * owner by phone (auto-creates if not found) so we collect phone+name
 * instead of searching for an existing Owner row.
 *
 * Touch / keyboard safety (Scope 1b):
 * - Phone field uses the native OS keyboard only. The previous custom
 *   numeric keypad created the exact failure it tried to avoid on
 *   Windows touch: native OSK plus an in-app keypad stacked together.
 *   The form now hints numeric/tel input and rejects non-digits at the
 *   input boundary.
 * - Phone, name, email, and notes get a deterministic focus
 *   scroll: ensureFieldVisible walks visualViewport when present,
 *   falls back to a 380px keyboard reserve, and re-runs at 0/250/600ms
 *   to catch the Windows on-screen keyboard's reveal animation. The
 *   scrollable body also reserves extra bottom padding while a
 *   keyboard-relevant field is focused so the field can scroll above
 *   the keyboard.
 * - Backdrop click does NOT close the modal — accidentally tapping
 *   outside used to wipe form input. Closing only happens via the
 *   explicit X / Cancel control, and a dirty guard surfaces an in-app
 *   discard confirmation (no window.confirm) when there is pending
 *   input. The default rounded-up start time is captured at mount so
 *   it does not count as user-entered.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  CalendarClock,
  RefreshCw,
  StickyNote,
  User as UserIcon,
  X as CloseIcon,
  type LucideIcon,
} from 'lucide-react';

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
 * Phone sanitization: digits only.
 *
 * Product decision: the stored phone is `\d+`, no `+`, space, dash,
 * or parentheses. A paste of "+48 (600) 123-456" lands as
 * "48600123456".
 */
function sanitizePhone(input: string): string {
  return input.replace(/\D/g, '');
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

/**
 * Reserve in pixels we assume the on-screen keyboard occupies when
 * visualViewport is unavailable. Windows touch keyboard varies between
 * 320 and 420px depending on layout; 380 is a safe middle that pushes
 * Notes/email above its top edge with a comfortable margin on a
 * 533x957 / 720x1280 viewport.
 */
const KEYBOARD_RESERVE_FALLBACK_PX = 380;

/**
 * ensureFieldVisible — keyboard-aware focus scroll.
 *
 * Computes the visible region as either window.visualViewport.height
 * (modern Edge/Chromium reports the keyboard-clipped area here) or
 * window.innerHeight minus a fallback reserve on small/touch viewports.
 * Adjusts the scroll
 * container so the focused field's bottom sits 24px above the safe
 * boundary. Up-scroll handles the case where a small field at the
 * very top of a long form would otherwise disappear above the visible
 * region after a keyboard reveal pushes content.
 *
 * The 0/250/600ms fan-out catches the Windows keyboard reveal
 * animation: a single immediate call lands before the keyboard renders
 * and the visualViewport metric updates; the later calls re-anchor
 * once the layout settles.
 */
function ensureFieldVisible(
  field: HTMLElement,
  body: HTMLElement | null,
): void {
  if (!body) return;
  const viewport = (window as any).visualViewport as
    | { height: number; offsetTop?: number }
    | undefined;
  let safeBottom: number;
  if (viewport && viewport.height + 1 < window.innerHeight) {
    // Keyboard is up — visualViewport reports the visible area.
    safeBottom = (viewport.offsetTop ?? 0) + viewport.height;
  } else {
    const hasCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const shouldReserveFallback = hasCoarsePointer || window.innerHeight <= 900;
    safeBottom = window.innerHeight - (shouldReserveFallback ? KEYBOARD_RESERVE_FALLBACK_PX : 0);
  }
  const margin = 24;
  const fieldRect = field.getBoundingClientRect();
  if (fieldRect.bottom > safeBottom - margin) {
    body.scrollTop += fieldRect.bottom - (safeBottom - margin);
  } else if (fieldRect.top < 80) {
    body.scrollTop -= 80 - fieldRect.top;
  }
}

function scheduleEnsureVisible(
  target: EventTarget | null,
  body: HTMLElement | null,
) {
  if (!(target instanceof HTMLElement)) return;
  // Immediate, then 250ms, then 600ms — covers the typical Windows
  // touch keyboard reveal animation envelope.
  ensureFieldVisible(target, body);
  setTimeout(() => ensureFieldVisible(target, body), 250);
  setTimeout(() => ensureFieldVisible(target, body), 600);
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
  const [masterReloadTick, setMasterReloadTick] = useState(0);

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

  // Capture the initial default start time so the dirty guard does
  // not flag a freshly-opened form as dirty (the rounded-up timestamp
  // is set by us, not the user).
  const initialStartsAtRef = useRef<string>(
    toLocalInput(roundUpTo5Min(new Date(Date.now() + 15 * 60_000))),
  );
  const [startsAtLocal, setStartsAtLocal] = useState<string>(
    initialStartsAtRef.current,
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

  // Dirty-state discard confirmation modal.
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  // Scrollable body container — used by ensureFieldVisible to compute
  // the safe scroll target for any focused input.
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Track whether ANY text-like field currently has focus so the
  // body can reserve extra bottom padding for the on-screen keyboard.
  const [keyboardActive, setKeyboardActive] = useState(false);

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
    setMasterError(null);
    (async () => {
      try {
        const [svcList, staffList] = await Promise.all([
          api.services.getAllActive() as Promise<ServiceRow[]>,
          api.pos.staff.getAll() as Promise<StaffRow[]>,
        ]);
        if (cancelled) return;
        setServices(svcList || []);
        setStaff((staffList || []).filter((s) => s.is_active !== 0));
      } catch (err: any) {
        if (cancelled) return;
        setMasterError(err.message || String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, masterReloadTick]);

  // No auto-focus on master-data load — focusing a select on touch
  // viewport would pop the wrong keyboard layout and steal focus from
  // a cashier mid-tap. The user picks the first field manually.

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

  // Dirty state: ANY user-entered value diverges from the initial
  // state. Default startsAt comes from initialStartsAtRef so re-mounting
  // with a fresh time never marks the form dirty.
  const isDirty =
    serviceId !== '' ||
    ruleId !== '' ||
    staffUserId !== '' ||
    startsAtLocal !== initialStartsAtRef.current ||
    customerPhone !== '' ||
    customerName !== '' ||
    customerEmail !== '' ||
    customerNotes !== '';

  // Each missing-required entry feeds the inline helper so the cashier
  // sees *why* Create is disabled instead of a mute button.
  const missingFields: string[] = [];
  if (!serviceId) missingFields.push(label('bookings.create.field.service', 'Service'));
  if (
    serviceId &&
    !rulesAreLoading &&
    !selectedRule &&
    !(noRulesAvailable && effectiveDurationMin != null && effectivePricePln != null)
  ) {
    missingFields.push(label('bookings.create.field.rule', 'Pricing / duration'));
  }
  if (!staffUserId) missingFields.push(label('bookings.create.field.staff', 'Staff'));
  if (!startsAtLocal) missingFields.push(label('bookings.create.field.starts_at', 'Start time'));
  if (!customerPhone.trim()) missingFields.push(label('bookings.create.field.phone', 'Phone'));
  if (!customerName.trim()) missingFields.push(label('bookings.create.field.name', 'Customer name'));

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
    label,
    onClose,
    onCreated,
  ]);

  // Explicit close path — used by both X and Cancel. Prompts an
  // in-app discard confirmation when the form has user input. Submit
  // in flight short-circuits the path so the cashier never abandons a
  // running create.
  const requestClose = useCallback(() => {
    if (submittingRef.current || submitting) return;
    if (isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }, [submitting, isDirty, onClose]);

  // Handler for keyboard-relevant fields: marks the body keyboardActive
  // and runs the keyboard-safe scroll cascade.
  const handleTextFocus = useCallback((e: React.FocusEvent<HTMLElement>) => {
    setKeyboardActive(true);
    scheduleEnsureVisible(e.target, bodyRef.current);
  }, []);
  const handleTextBlur = useCallback(() => {
    setKeyboardActive(false);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 sm:flex sm:items-center sm:justify-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="booking-create-title"
      // Backdrop click is intentionally NOT bound to close. A stray tap
      // outside used to wipe the entire form. Close requires the
      // explicit X / Cancel control, which respects the dirty guard.
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) submit();
        }}
        className="bg-white shadow-xl flex flex-col w-full h-full sm:h-auto sm:max-h-[90vh] sm:max-w-[640px] sm:rounded-md"
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-gray-200 shrink-0">
          <h2 id="booking-create-title" className="text-lg font-semibold text-gray-900">
            {label('bookings.create.title', 'New walk-in booking')}
          </h2>
          <button
            type="button"
            onClick={requestClose}
            disabled={submitting}
            className="inline-flex items-center justify-center h-9 w-9 text-gray-500 rounded-md hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 disabled:opacity-30"
            aria-label={label('common.close', 'Close')}
          >
            <CloseIcon className="h-4 w-4" aria-hidden />
          </button>
        </header>

        {/* Scrollable body. Bottom padding grows when a keyboard field is
            focused (keyboardActive) so Notes/email can scroll above the
            on-screen keyboard. */}
        <div
          ref={bodyRef}
          className={`flex-1 overflow-y-auto px-5 py-4 space-y-6 ${
            keyboardActive ? 'pb-[420px]' : 'pb-4'
          }`}
        >
          {masterError && (
            <div
              role="alert"
              className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-md text-sm flex items-start gap-2"
            >
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <div className="break-words">{masterError}</div>
                <button
                  type="button"
                  onClick={() => setMasterReloadTick((n) => n + 1)}
                  className="mt-1 inline-flex items-center gap-1 text-xs font-medium underline hover:no-underline"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden />
                  {label('common.retry', 'Retry')}
                </button>
              </div>
            </div>
          )}

          {/* ─── Appointment ──────────────────────────────────────── */}
          <Section
            icon={CalendarClock}
            title={label('bookings.create.section.appointment', 'Appointment')}
          >
            <Field label={label('bookings.create.service', 'Service')} required>
              <select
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
                onFocus={handleTextFocus}
                onBlur={handleTextBlur}
                className={inputClassName}
                required
              >
                <option value="">— {label('common.select', 'select')} —</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>

            {rules.length > 1 && (
              <Field label={label('bookings.create.rule', 'Pricing / duration')}>
                <select
                  value={ruleId}
                  onChange={(e) => setRuleId(e.target.value)}
                  onFocus={handleTextFocus}
                  onBlur={handleTextBlur}
                  className={inputClassName}
                >
                  {rules.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name ?? r.size_category ?? `Rule ${r.id.slice(0, 4)}`} ·{' '}
                      {r.duration_min}min · {formatGrosze(r.base_price_pln)} zł
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {/* Show effective duration/price even when the service has no
                rules — pulled from service.base_* in that case. The hint
                clarifies the source so cashiers know it's a service-level
                default, not a tier they picked. */}
            {effectiveDurationMin != null && effectivePricePln != null && (
              <div className="flex items-baseline justify-between rounded-md bg-gray-50 border border-gray-200 px-3 py-2 text-sm">
                <span className="text-gray-600 tabular-nums">
                  {effectiveDurationMin} {label('common.minutes', 'min')}
                  {noRulesAvailable ? (
                    <span className="ml-2 text-xs text-gray-500">
                      {label('bookings.create.no_rules', '(service default)')}
                    </span>
                  ) : null}
                </span>
                <span className="font-semibold text-gray-900 tabular-nums">
                  {formatGrosze(effectivePricePln)} zł
                </span>
              </div>
            )}

            <Field label={label('bookings.create.staff', 'Staff')} required>
              <select
                value={staffUserId}
                onChange={(e) => setStaffUserId(e.target.value)}
                onFocus={handleTextFocus}
                onBlur={handleTextBlur}
                className={inputClassName}
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
            </Field>

            <Field label={label('bookings.create.starts_at', 'Start time')} required>
              <input
                type="datetime-local"
                value={startsAtLocal}
                onChange={(e) => setStartsAtLocal(e.target.value)}
                onFocus={handleTextFocus}
                onBlur={handleTextBlur}
                step={300}
                className={inputClassName}
                required
              />
            </Field>
          </Section>

          {/* ─── Customer ─────────────────────────────────────────── */}
          <Section
            icon={UserIcon}
            title={label('bookings.create.section.customer', 'Customer')}
          >
            <Field label={label('bookings.create.phone', 'Phone')} required>
              <input
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="tel"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(sanitizePhone(e.target.value))}
                onKeyDown={(e) => {
                  // Native keyboard hinting is not validation. Allow
                  // modifier shortcuts, navigation keys, backspace/delete;
                  // block any single character that is not a digit.
                  if (e.ctrlKey || e.metaKey || e.altKey) return;
                  if (e.key.length > 1) return;
                  if (!/^\d$/.test(e.key)) {
                    e.preventDefault();
                  }
                }}
                onBeforeInput={(e: React.FormEvent<HTMLInputElement>) => {
                  // IME composition / virtual-keyboard taps surface here.
                  // Block at the input-event level so non-digits never
                  // reach state.
                  const data = (e.nativeEvent as InputEvent).data;
                  if (typeof data === 'string' && /\D/.test(data)) {
                    e.preventDefault();
                  }
                }}
                onPaste={(e) => {
                  e.preventDefault();
                  const pastedDigits = sanitizePhone(e.clipboardData.getData('text'));
                  const start = e.currentTarget.selectionStart ?? customerPhone.length;
                  const end = e.currentTarget.selectionEnd ?? start;
                  setCustomerPhone((prev) => {
                    const safeStart = Math.max(0, Math.min(start, prev.length));
                    const safeEnd = Math.max(safeStart, Math.min(end, prev.length));
                    return sanitizePhone(
                      prev.slice(0, safeStart) + pastedDigits + prev.slice(safeEnd),
                    );
                  });
                }}
                onFocus={handleTextFocus}
                onBlur={handleTextBlur}
                placeholder="600123456"
                className={`${inputClassName} tabular-nums`}
                required
              />
            </Field>

            <Field label={label('bookings.create.name', 'Customer name')} required>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                onFocus={handleTextFocus}
                onBlur={handleTextBlur}
                className={inputClassName}
                required
              />
            </Field>

            <Field label={label('bookings.create.email', 'Email (optional)')}>
              <input
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                onFocus={handleTextFocus}
                onBlur={handleTextBlur}
                className={inputClassName}
              />
            </Field>
          </Section>

          {/* ─── Notes ────────────────────────────────────────────── */}
          <Section
            icon={StickyNote}
            title={label('bookings.create.section.notes', 'Notes')}
          >
            <Field label={label('bookings.create.notes', 'Customer notes (optional)')}>
              <textarea
                value={customerNotes}
                onChange={(e) => setCustomerNotes(e.target.value)}
                onFocus={handleTextFocus}
                onBlur={handleTextBlur}
                rows={2}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </Field>
          </Section>

          {submitError && (
            <div
              role="alert"
              className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-md text-sm flex items-start gap-2"
            >
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
              <div>{submitError}</div>
            </div>
          )}
        </div>

        <footer className="shrink-0 border-t border-gray-200 bg-white px-5 py-3 space-y-2">
          {/* Helper line tells the user *which* fields still block submit
              when the button is disabled. Min-height keeps the footer
              from jumping when the message appears/disappears. */}
          <div className="min-h-[1.25rem]">
            {!canSubmit && missingFields.length > 0 && !submitting ? (
              <p className="text-xs text-gray-500">
                {label('bookings.create.required_hint', 'Fill in')}{' '}
                <span className="font-medium text-gray-700">
                  {missingFields.join(', ')}
                </span>{' '}
                {label('bookings.create.required_hint_suffix', 'to enable Create.')}
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={requestClose}
              disabled={submitting}
              className="inline-flex items-center justify-center h-11 px-4 text-sm font-medium bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {label('common.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center justify-center h-11 min-w-[160px] px-4 text-sm font-medium bg-indigo-600 text-white rounded-md shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {submitting
                ? label('common.submitting', 'Submitting…')
                : label('bookings.create.submit', 'Create booking')}
            </button>
          </div>
        </footer>
      </form>

      {showDiscardConfirm && (
        <DiscardConfirm
          onCancel={() => setShowDiscardConfirm(false)}
          onConfirm={() => {
            setShowDiscardConfirm(false);
            onClose();
          }}
          label={label}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Local helpers — small enough to live alongside the form.
// ─────────────────────────────────────────────────────────────────────

const inputClassName =
  'w-full h-11 border border-gray-300 rounded-md px-3 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {required ? (
          <span className="text-rose-600" aria-hidden>
            {' *'}
          </span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

function DiscardConfirm({
  onCancel,
  onConfirm,
  label,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  label: (k: string, fb: string) => string;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="discard-title"
    >
      <div className="bg-white rounded-md shadow-xl w-full max-w-sm">
        <header className="px-5 py-3 border-b border-gray-200">
          <h3 id="discard-title" className="text-base font-semibold text-gray-900">
            {label('bookings.create.discard.title', 'Discard booking?')}
          </h3>
        </header>
        <div className="px-5 py-4 text-sm text-gray-700">
          {label(
            'bookings.create.discard.body',
            'You have unsaved input. Closing now will lose it.',
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b-md">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center justify-center h-11 px-4 text-sm font-medium bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
          >
            {label('bookings.create.discard.keep', 'Keep editing')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center justify-center h-11 px-4 text-sm font-medium bg-rose-600 text-white rounded-md shadow-sm hover:bg-rose-700 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2"
          >
            {label('bookings.create.discard.confirm', 'Discard')}
          </button>
        </footer>
      </div>
    </div>
  );
}
