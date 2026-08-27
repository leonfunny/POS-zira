/**
 * End-of-day (EOD) scheduling — pure helpers, no I/O.
 *
 * Every POS (primary or secondary, fiscal master or not) runs its own EOD:
 * auto-close the open shift, push pending sync, purge yesterday's local
 * history. EOD is keyed by *business date* (local calendar day) so a device
 * that was switched off at the scheduled time catches up on next boot.
 */
export interface EndOfDayTargetInput {
  now: Date;
  hour: number;
  minute: number;
  /** business_date of the latest SUCCESS ledger row, or null */
  lastSuccessDate: string | null;
}

export interface EndOfDayTarget {
  due: boolean;
  businessDate: string;
  catchUp: boolean;
  reason: 'scheduled' | 'catch_up' | 'not_due' | 'already_done';
}

export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * The latest business date whose EOD time has already passed is "due". If
 * the ledger already has SUCCESS for that date, nothing is due. A due date
 * earlier than today is a catch-up (device was off at the scheduled time).
 */
export function resolveEndOfDayTarget(input: EndOfDayTargetInput): EndOfDayTarget {
  const today = localDateKey(input.now);
  const nowMinute = input.now.getHours() * 60 + input.now.getMinutes();
  const scheduledMinute = input.hour * 60 + input.minute;
  const dueDate = nowMinute >= scheduledMinute ? today : localDateKey(addDays(input.now, -1));

  if (input.lastSuccessDate && input.lastSuccessDate >= dueDate) {
    return { due: false, businessDate: dueDate, catchUp: false, reason: 'already_done' };
  }
  if (dueDate === today) {
    return { due: true, businessDate: dueDate, catchUp: false, reason: 'scheduled' };
  }
  return { due: true, businessDate: dueDate, catchUp: true, reason: 'catch_up' };
}

/** Local midnight following the business date = purge cutoff after that EOD. */
export function purgeCutoffForBusinessDate(businessDate: string, now: Date): string {
  const [y, m, d] = businessDate.split('-').map(Number);
  const cutoff = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  // Never purge today's rows even if a stale ledger points into the future.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return (cutoff.getTime() > startOfToday.getTime() ? startOfToday : cutoff).toISOString();
}

export function isRetryDue(lastAttemptIso: string | null, retryMinutes: number, nowMs: number): boolean {
  if (!lastAttemptIso) return true;
  const last = Date.parse(lastAttemptIso.includes('T') ? lastAttemptIso : lastAttemptIso.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= retryMinutes * 60_000;
}
