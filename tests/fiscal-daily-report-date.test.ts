import { describe, expect, it } from 'vitest';
import {
  getFiscalDailyReportDateFromDbTimestamp,
  resolveFiscalDailyReportTarget,
} from '../src/main/fiscal/fiscal-daily-report-date';

describe('fiscal daily report date helpers', () => {
  it('catches up a previous fiscal day before today scheduled time', () => {
    expect(resolveFiscalDailyReportTarget({
      nowDate: '2026-07-11',
      currentMinute: 10 * 60 + 10,
      hour: 23,
      minute: 30,
      timezone: 'Europe/Warsaw',
      latestReceiptAt: '2026-07-10 19:54:25',
    })).toEqual({
      due: true,
      reportDate: '2026-07-10',
      scheduledFor: '2026-07-10T23:30:00[Europe/Warsaw]',
      catchUp: true,
      reason: 'catch_up',
    });
  });

  it('waits when only today receipts exist and scheduled time has not arrived', () => {
    expect(resolveFiscalDailyReportTarget({
      nowDate: '2026-07-11',
      currentMinute: 10 * 60 + 10,
      hour: 23,
      minute: 30,
      timezone: 'Europe/Warsaw',
      latestReceiptAt: '2026-07-11 07:54:25',
    })).toEqual({
      due: false,
      reportDate: '2026-07-11',
      scheduledFor: '2026-07-11T23:30:00[Europe/Warsaw]',
      catchUp: false,
      reason: 'not_due',
    });
  });

  it('runs today scheduled report after scheduled time', () => {
    expect(resolveFiscalDailyReportTarget({
      nowDate: '2026-07-11',
      currentMinute: 23 * 60 + 31,
      hour: 23,
      minute: 30,
      timezone: 'Europe/Warsaw',
    }).reason).toBe('scheduled');
  });

  it('interprets sqlite timestamps as UTC when deriving Warsaw date', () => {
    expect(getFiscalDailyReportDateFromDbTimestamp('2026-07-10 19:54:25')).toBe('2026-07-10');
  });
});
