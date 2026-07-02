/**
 * BookingCreateForm - POS walk-in booking create.
 *
 * Scope: UI mechanics only. Booking creation still flows through
 * electronAPI.bookings.create with the same payload shape, ruleless
 * service fallback, stale-rule guard, staff user-id contract, double
 * submit lock, and in-app dirty close guard.
 */
import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  CalendarClock,
  Check,
  ChevronDown,
  Clock3,
  RefreshCw,
  Search,
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

interface PickerOption {
  value: string;
  label: string;
  description?: string;
  meta?: string;
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
 * Produce the local timestamp shape used by existing submit logic:
 * "YYYY-MM-DDTHH:mm" with no timezone suffix.
 */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseLocalInput(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLocalDisplay(value: string): string {
  const parsed = parseLocalInput(value);
  if (!parsed) return 'Select start time';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(parsed.getDate())}/${pad(parsed.getMonth() + 1)}/${parsed.getFullYear()} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function getVisibleBodyHeight(body: HTMLElement): number {
  const bodyRect = body.getBoundingClientRect();
  let visibleBottom = bodyRect.bottom;
  const viewport = (window as any).visualViewport as
    | { height: number; offsetTop?: number }
    | undefined;
  if (viewport) {
    visibleBottom = Math.min(
      visibleBottom,
      (viewport.offsetTop ?? 0) + viewport.height,
    );
  }
  const keyboardRect = (navigator as any).virtualKeyboard?.boundingRect as
    | { height: number; y: number }
    | undefined;
  if (keyboardRect && keyboardRect.height > 0) {
    visibleBottom = Math.min(visibleBottom, keyboardRect.y);
  }
  return Math.max(160, visibleBottom - bodyRect.top);
}

function computeFocusTailSpacer(
  field: HTMLElement,
  body: HTMLElement | null,
  currentTailSpacerPx: number,
): number {
  if (!body) return 0;
  const bodyRect = body.getBoundingClientRect();
  const fieldRect = field.getBoundingClientRect();
  const visibleHeight = getVisibleBodyHeight(body);
  const fieldCenter =
    fieldRect.top - bodyRect.top + body.scrollTop + fieldRect.height / 2;
  const targetTop = Math.max(0, fieldCenter - visibleHeight / 2);
  const contentScrollHeight = Math.max(
    body.clientHeight,
    body.scrollHeight - currentTailSpacerPx,
  );
  const currentMaxTop = Math.max(0, contentScrollHeight - body.clientHeight);
  const deficit = Math.max(0, targetTop - currentMaxTop);
  return deficit > 0 ? Math.ceil(deficit + 16) : 0;
}

function ensureFieldVisible(
  field: HTMLElement,
  body: HTMLElement | null,
): void {
  if (!body) return;
  const bodyRect = body.getBoundingClientRect();
  const fieldRect = field.getBoundingClientRect();
  const visibleHeight = getVisibleBodyHeight(body);
  const fieldCenter =
    fieldRect.top - bodyRect.top + body.scrollTop + fieldRect.height / 2;
  const targetTop = Math.max(0, fieldCenter - visibleHeight / 2);
  body.scrollTo({ top: targetTop, behavior: 'smooth' });
}

function scheduleEnsureVisible(
  target: EventTarget | null,
  body: HTMLElement | null,
  getFocusTailSpacerPx: () => number,
  setFocusTailSpacerPx: (px: number) => void,
) {
  if (!(target instanceof HTMLElement)) return;
  const run = () => {
    if (!target.isConnected) return;
    if (document.activeElement !== target) return;
    setFocusTailSpacerPx(computeFocusTailSpacer(
      target,
      body,
      getFocusTailSpacerPx(),
    ));
    window.requestAnimationFrame(() => ensureFieldVisible(target, body));
  };
  run();
  [250, 600, 1000].forEach((delay) => setTimeout(run, delay));
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
  // selection.
  const [rulesLoadingForServiceId, setRulesLoadingForServiceId] = useState<string | null>(null);
  const [staffUserId, setStaffUserId] = useState<string>('');

  // Capture the initial default start time so the dirty guard does
  // not flag a freshly-opened form as dirty.
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

  // Submission state. submittingRef locks immediately so fast double
  // clicks cannot issue two IPC create calls before React commits state.
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Dirty-state discard confirmation modal.
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  // Scrollable body container used for light focus-scroll of text inputs.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const focusTailSpacerRef = useRef(0);
  const [focusTailSpacerPx, setFocusTailSpacerPx] = useState(0);

  const api = (window as any).electronAPI;

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

  // No auto-focus on master-data load. Touch users should not get an
  // unexpected keyboard or picker as soon as the modal opens.

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
  const selectedRule = useMemo(() => {
    const r = rules.find((rr) => rr.id === ruleId) ?? null;
    if (!r) return null;
    return r.service_id === serviceId ? r : null;
  }, [rules, ruleId, serviceId]);

  const effectiveDurationMin = selectedRule?.duration_min ?? selectedService?.base_duration_minutes ?? null;
  const effectivePricePln = selectedRule?.base_price_pln ?? selectedService?.base_price_pln ?? null;
  const rulesAreLoading = rulesLoadingForServiceId === serviceId && !!serviceId;
  const noRulesAvailable = !!serviceId && !rulesAreLoading && rules.length === 0;

  const serviceOptions = useMemo<PickerOption[]>(
    () => services.map((s) => ({
      value: s.id,
      label: s.name,
      description: `${s.base_duration_minutes} ${label('common.minutes', 'min')} · ${formatGrosze(s.base_price_pln)} zł`,
    })),
    [services, label],
  );

  const ruleOptions = useMemo<PickerOption[]>(
    () => rules.map((r) => ({
      value: r.id,
      label: r.name ?? r.size_category ?? `Rule ${r.id.slice(0, 4)}`,
      description: `${r.duration_min} ${label('common.minutes', 'min')} · ${formatGrosze(r.base_price_pln)} zł`,
    })),
    [rules, label],
  );

  const staffOptions = useMemo<PickerOption[]>(
    () => staff.map((s) => ({
      // Bind to canonical users.id when available; fall back to
      // staff_profiles.id for older local DBs.
      value: s.user_id || s.id,
      label: s.name,
    })),
    [staff],
  );

  const isDirty =
    serviceId !== '' ||
    ruleId !== '' ||
    staffUserId !== '' ||
    startsAtLocal !== initialStartsAtRef.current ||
    customerPhone !== '' ||
    customerName !== '' ||
    customerEmail !== '' ||
    customerNotes !== '';

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
    !rulesAreLoading &&
    (!!selectedRule || (noRulesAvailable && effectiveDurationMin != null && effectivePricePln != null)) &&
    !!staffUserId &&
    !!startsAtLocal &&
    !!customerPhone.trim() &&
    !!customerName.trim() &&
    !submitting;

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

  const requestClose = useCallback(() => {
    if (submittingRef.current || submitting) return;
    if (isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }, [submitting, isDirty, onClose]);

  const handleTextFocus = useCallback((e: React.FocusEvent<HTMLElement>) => {
    scheduleEnsureVisible(
      e.target,
      bodyRef.current,
      () => focusTailSpacerRef.current,
      (px) => {
        focusTailSpacerRef.current = px;
        setFocusTailSpacerPx(px);
      },
    );
  }, []);
  const handleTextBlur = useCallback(() => {
    setTimeout(() => {
      const active = document.activeElement;
      if (!bodyRef.current?.contains(active)) {
        focusTailSpacerRef.current = 0;
        setFocusTailSpacerPx(0);
      }
    }, 0);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 sm:flex sm:items-center sm:justify-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="booking-create-title"
      // Backdrop click is intentionally not bound to close. Close goes
      // through X / Cancel and the dirty guard.
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) submit();
        }}
        className="bg-white shadow-xl flex flex-col w-full h-full sm:h-[760px] sm:max-h-[88vh] sm:max-w-[720px] sm:rounded-md"
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-slate-200 shrink-0">
          <div>
            <h2 id="booking-create-title" className="text-lg font-semibold text-slate-900">
              {label('bookings.create.title', 'New walk-in booking')}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {formatLocalDisplay(startsAtLocal)}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={submitting}
            className="inline-flex items-center justify-center h-9 w-9 text-slate-500 rounded-md hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 disabled:opacity-30"
            aria-label={label('common.close', 'Close')}
          >
            <CloseIcon className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div
          ref={bodyRef}
          className="flex-1 overflow-y-auto px-5 py-4 space-y-5"
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

          <Section
            icon={CalendarClock}
            title={label('bookings.create.section.appointment', 'Appointment')}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field
                label={label('bookings.create.service', 'Service')}
                required
                className="md:col-span-2"
              >
                <PickerField
                  label={label('bookings.create.service', 'Service')}
                  value={serviceId}
                  onChange={setServiceId}
                  options={serviceOptions}
                  placeholder={label('bookings.create.service.placeholder', 'Select service')}
                  emptyLabel={label('bookings.create.service.empty', 'No services found')}
                  searchable
                  required
                />
              </Field>

              {rules.length > 1 && (
                <Field
                  label={label('bookings.create.rule', 'Pricing / duration')}
                  className="md:col-span-2"
                >
                  <PickerField
                    label={label('bookings.create.rule', 'Pricing / duration')}
                    value={ruleId}
                    onChange={setRuleId}
                    options={ruleOptions}
                    placeholder={label('bookings.create.rule.placeholder', 'Select pricing / duration')}
                    emptyLabel={label('bookings.create.rule.empty', 'No pricing rules found')}
                  />
                </Field>
              )}

              {effectiveDurationMin != null && effectivePricePln != null && (
                <div className="md:col-span-2 flex items-baseline justify-between rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-sm">
                  <span className="text-slate-600 tabular-nums">
                    {effectiveDurationMin} {label('common.minutes', 'min')}
                    {noRulesAvailable ? (
                      <span className="ml-2 text-xs text-slate-500">
                        {label('bookings.create.no_rules', '(service default)')}
                      </span>
                    ) : null}
                  </span>
                  <span className="font-semibold text-slate-900 tabular-nums">
                    {formatGrosze(effectivePricePln)} zł
                  </span>
                </div>
              )}

              <Field label={label('bookings.create.staff', 'Staff')} required>
                <PickerField
                  label={label('bookings.create.staff', 'Staff')}
                  value={staffUserId}
                  onChange={setStaffUserId}
                  options={staffOptions}
                  placeholder={label('bookings.create.staff.placeholder', 'Select staff')}
                  emptyLabel={label('bookings.create.staff.empty', 'No staff found')}
                  searchable={staffOptions.length > 8}
                  required
                />
              </Field>

              <Field label={label('bookings.create.starts_at', 'Start time')} required>
                <StartTimeControl
                  label={label('bookings.create.starts_at', 'Start time')}
                  value={startsAtLocal}
                  onChange={setStartsAtLocal}
                />
              </Field>
            </div>
          </Section>

          <Section
            icon={UserIcon}
            title={label('bookings.create.section.customer', 'Customer')}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label={label('bookings.create.phone', 'Phone')} required>
                <input
                  aria-label={label('bookings.create.phone', 'Phone')}
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="tel"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(sanitizePhone(e.target.value))}
                  onKeyDown={(e) => {
                    if (e.ctrlKey || e.metaKey || e.altKey) return;
                    if (e.key.length > 1) return;
                    if (!/^\d$/.test(e.key)) {
                      e.preventDefault();
                    }
                  }}
                  onBeforeInput={(e: React.FormEvent<HTMLInputElement>) => {
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
                  aria-label={label('bookings.create.name', 'Customer name')}
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  onFocus={handleTextFocus}
                  onBlur={handleTextBlur}
                  className={inputClassName}
                  required
                />
              </Field>

              <Field label={label('bookings.create.email', 'Email (optional)')} className="md:col-span-2">
                <input
                  aria-label={label('bookings.create.email', 'Email (optional)')}
                  type="email"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  onFocus={handleTextFocus}
                  onBlur={handleTextBlur}
                  className={inputClassName}
                />
              </Field>
            </div>
          </Section>

          <Section
            icon={StickyNote}
            title={label('bookings.create.section.notes', 'Notes')}
          >
            <Field label={label('bookings.create.notes', 'Customer notes (optional)')}>
              <textarea
                aria-label={label('bookings.create.notes', 'Customer notes (optional)')}
                value={customerNotes}
                onChange={(e) => setCustomerNotes(e.target.value)}
                onFocus={handleTextFocus}
                onBlur={handleTextBlur}
                rows={3}
                className="w-full min-h-[96px] border border-slate-300 rounded-md px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
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

          {focusTailSpacerPx > 0 ? (
            <div
              aria-hidden
              style={{ height: focusTailSpacerPx }}
            />
          ) : null}
        </div>

        <footer className="shrink-0 border-t border-slate-200 bg-white px-5 py-3 space-y-2">
          <div className="min-h-[1.25rem]">
            {!canSubmit && missingFields.length > 0 && !submitting ? (
              <p className="text-xs text-slate-500">
                {label('bookings.create.required_hint', 'Fill in')}{' '}
                <span className="font-medium text-slate-700">
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
              className="inline-flex items-center justify-center h-11 px-4 text-sm font-medium bg-white text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {label('common.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center justify-center h-11 min-w-[160px] px-4 text-sm font-medium bg-indigo-600 text-white rounded-md shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {submitting
                ? label('common.submitting', 'Submitting...')
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

const inputClassName =
  'w-full h-11 border border-slate-300 rounded-md px-3 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';

const pickerButtonClassName =
  'w-full h-11 border border-slate-300 rounded-md px-3 bg-white text-sm text-left focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';

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
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
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
  className = '',
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <div className="block text-sm font-medium text-slate-700 mb-1">
        {label}
        {required ? (
          <span className="text-rose-600" aria-hidden>
            {' *'}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function useOutsideClose(
  ref: React.RefObject<HTMLElement>,
  open: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [open, onClose, ref]);
}

function PickerField({
  label,
  value,
  onChange,
  options,
  placeholder,
  emptyLabel,
  searchable = false,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: PickerOption[];
  placeholder: string;
  emptyLabel: string;
  searchable?: boolean;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value) ?? null;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = normalizedQuery
    ? options.filter((option) => {
      const haystack = `${option.label} ${option.description ?? ''} ${option.meta ?? ''}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    : options;

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  useOutsideClose(rootRef, open, close);

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-required={required || undefined}
        onClick={() => setOpen((next) => !next)}
        className={`${pickerButtonClassName} flex items-center justify-between gap-2`}
      >
        <span className="min-w-0 flex-1">
          <span className={selected ? 'block truncate text-slate-900' : 'block truncate text-slate-400'}>
            {selected?.label ?? placeholder}
          </span>
          {selected?.description ? (
            <span className="block truncate text-xs text-slate-500">
              {selected.description}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg">
          {searchable && (
            <div className="border-b border-slate-200 p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search"
                  className="h-10 w-full rounded-md border border-slate-300 bg-white pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>
          )}
          <div
            id={listboxId}
            role="listbox"
            aria-label={label}
            className="max-h-72 overflow-y-auto py-1"
          >
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-3 text-sm text-slate-500">{emptyLabel}</div>
            ) : (
              filteredOptions.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onChange(option.value);
                      close();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      {isSelected ? (
                        <Check className="h-4 w-4 text-indigo-600" aria-hidden />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-900">
                        {option.label}
                      </span>
                      {option.description ? (
                        <span className="block truncate text-xs text-slate-500">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StartTimeControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const quickSlots = useMemo(() => {
    const first = roundUpTo5Min(new Date());
    return [0, 15, 30, 45].map((minutes) => {
      const slot = new Date(first);
      slot.setMinutes(first.getMinutes() + minutes);
      return slot;
    });
  }, [open]);

  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(rootRef, open, close);

  const shiftMinutes = (minutes: number) => {
    const base = parseLocalInput(value) ?? roundUpTo5Min(new Date());
    base.setMinutes(base.getMinutes() + minutes);
    onChange(toLocalInput(base));
  };

  const setDateOffset = (offsetDays: number) => {
    const base = parseLocalInput(value) ?? roundUpTo5Min(new Date());
    const now = new Date();
    base.setFullYear(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
    onChange(toLocalInput(base));
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
        className={`${pickerButtonClassName} flex items-center justify-between gap-2 tabular-nums`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Clock3 className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <span className="truncate text-slate-900">{formatLocalDisplay(value)}</span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-slate-200 bg-white p-3 shadow-lg">
          <div className="mb-3 text-sm font-medium text-slate-900 tabular-nums">
            {formatLocalDisplay(value)}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <QuickTimeButton onClick={() => setDateOffset(0)}>Today</QuickTimeButton>
            <QuickTimeButton onClick={() => setDateOffset(1)}>Tomorrow</QuickTimeButton>
            <QuickTimeButton onClick={() => shiftMinutes(-15)}>-15 min</QuickTimeButton>
            <QuickTimeButton onClick={() => shiftMinutes(15)}>+15 min</QuickTimeButton>
            <QuickTimeButton onClick={() => shiftMinutes(-5)}>-5 min</QuickTimeButton>
            <QuickTimeButton onClick={() => shiftMinutes(5)}>+5 min</QuickTimeButton>
          </div>
          <div className="mt-3 border-t border-slate-200 pt-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
              Quick slots
            </div>
            <div className="grid grid-cols-2 gap-2">
              {quickSlots.map((slot) => (
                <QuickTimeButton
                  key={slot.toISOString()}
                  onClick={() => {
                    onChange(toLocalInput(slot));
                    close();
                  }}
                >
                  {formatLocalDisplay(toLocalInput(slot)).slice(11)}
                </QuickTimeButton>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function QuickTimeButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-10 items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1"
    >
      {children}
    </button>
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
        <header className="px-5 py-3 border-b border-slate-200">
          <h3 id="discard-title" className="text-base font-semibold text-slate-900">
            {label('bookings.create.discard.title', 'Discard booking?')}
          </h3>
        </header>
        <div className="px-5 py-4 text-sm text-slate-700">
          {label(
            'bookings.create.discard.body',
            'You have unsaved input. Closing now will lose it.',
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-md">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center justify-center h-11 px-4 text-sm font-medium bg-white text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
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
