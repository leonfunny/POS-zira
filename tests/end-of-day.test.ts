import { describe, expect, it } from 'vitest';
import {
  isShiftEligibleForEndOfDay,
  isRetryDue,
  localDateKey,
  purgeCutoffForBusinessDate,
  resolveEndOfDayTarget,
} from '../src/main/pos/end-of-day';

const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min, 0, 0);

describe('resolveEndOfDayTarget', () => {
  it('is not due before the scheduled time when yesterday is already done', () => {
    const t = resolveEndOfDayTarget({ now: at(2026, 8, 27, 15, 0), hour: 23, minute: 59, lastSuccessDate: '2026-08-26' });
    expect(t).toEqual({ due: false, businessDate: '2026-08-26', catchUp: false, reason: 'already_done' });
  });

  it('is due for today once the scheduled minute is reached', () => {
    const t = resolveEndOfDayTarget({ now: at(2026, 8, 27, 23, 59), hour: 23, minute: 59, lastSuccessDate: '2026-08-26' });
    expect(t).toEqual({ due: true, businessDate: '2026-08-27', catchUp: false, reason: 'scheduled' });
  });

  it('catches up yesterday when the device was off at the scheduled time', () => {
    // Baohan: counter switched off 22:00, booted 08:00 next morning.
    const t = resolveEndOfDayTarget({ now: at(2026, 8, 28, 8, 0), hour: 23, minute: 59, lastSuccessDate: '2026-08-26' });
    expect(t).toEqual({ due: true, businessDate: '2026-08-27', catchUp: true, reason: 'catch_up' });
  });

  it('catches up yesterday on a fresh device with no ledger', () => {
    const t = resolveEndOfDayTarget({ now: at(2026, 8, 28, 8, 0), hour: 23, minute: 59, lastSuccessDate: null });
    expect(t.due).toBe(true);
    expect(t.businessDate).toBe('2026-08-27');
  });

  it('does not run twice for the same business date', () => {
    const t = resolveEndOfDayTarget({ now: at(2026, 8, 28, 0, 30), hour: 23, minute: 59, lastSuccessDate: '2026-08-27' });
    expect(t.due).toBe(false);
  });

  it('handles a month boundary for the catch-up date', () => {
    const t = resolveEndOfDayTarget({ now: at(2026, 9, 1, 9, 0), hour: 23, minute: 59, lastSuccessDate: null });
    expect(t.businessDate).toBe('2026-08-31');
  });
});

describe('isShiftEligibleForEndOfDay', () => {
  it('does not close a current-day shift while catching up yesterday', () => {
    expect(isShiftEligibleForEndOfDay('2026-08-27 08:08:48', '2026-08-26')).toBe(false);
  });

  it('closes a shift that belongs to the target business date', () => {
    expect(isShiftEligibleForEndOfDay('2026-08-27 08:08:48', '2026-08-27')).toBe(true);
  });

  it('accepts restored server ISO timestamps and fails safe on invalid values', () => {
    expect(isShiftEligibleForEndOfDay('2026-08-26T20:00:00.000Z', '2026-08-26')).toBe(true);
    expect(isShiftEligibleForEndOfDay('not-a-date', '2026-08-26')).toBe(false);
  });
});

describe('purgeCutoffForBusinessDate', () => {
  it('cuts at the midnight after the business date', () => {
    const iso = purgeCutoffForBusinessDate('2026-08-27', at(2026, 8, 28, 8, 0));
    const d = new Date(iso);
    expect(localDateKey(d)).toBe('2026-08-28');
    expect(d.getHours()).toBe(0);
  });

  it('never cuts into today when EOD runs at 23:59 of the business date', () => {
    // At 23:59 on the 27th the cutoff must be the START of the 27th, not the 28th,
    // so today's rows survive until tomorrow's run.
    const iso = purgeCutoffForBusinessDate('2026-08-27', at(2026, 8, 27, 23, 59));
    expect(localDateKey(new Date(iso))).toBe('2026-08-27');
  });
});

describe('isRetryDue', () => {
  it('accepts sqlite datetime("now") shape and respects the interval', () => {
    const last = '2026-08-27 21:00:00'; // UTC
    const lastMs = Date.parse('2026-08-27T21:00:00Z');
    expect(isRetryDue(last, 5, lastMs + 4 * 60_000)).toBe(false);
    expect(isRetryDue(last, 5, lastMs + 5 * 60_000)).toBe(true);
    expect(isRetryDue(null, 5, lastMs)).toBe(true);
  });
});
