import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/config/store', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../src/main/database/database', () => ({
  database: { save: vi.fn() },
}));

vi.mock('../src/main/database/repos/fiscal-daily-report-run-repo', () => ({
  fiscalDailyReportRunRepo: {},
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { shouldAttemptFiscalDailyReport } from '../src/main/modules/fiscal-daily-report.module';

describe('FiscalDailyReportModule scheduling policy', () => {
  it('allows the first scheduled report when no prior successful report is known', () => {
    expect(shouldAttemptFiscalDailyReport({
      latestSuccess: null,
      hasReceiptAfterLatestSuccess: true,
      scheduledRun: null,
      retryMinutes: 5,
      maxAttempts: 3,
    })).toEqual({ shouldRun: true, reason: 'ready' });
  });

  it('skips when no confirmed fiscal receipt exists after the latest successful report', () => {
    expect(shouldAttemptFiscalDailyReport({
      latestSuccess: { printed_at: '2026-06-13 13:14:41' },
      hasReceiptAfterLatestSuccess: false,
      scheduledRun: null,
      retryMinutes: 5,
      maxAttempts: 3,
    })).toEqual({ shouldRun: false, reason: 'no_receipts_after_last_success' });
  });

  it('allows another scheduled report when receipts exist after the latest successful report', () => {
    expect(shouldAttemptFiscalDailyReport({
      latestSuccess: { printed_at: '2026-06-13 13:14:41' },
      hasReceiptAfterLatestSuccess: true,
      scheduledRun: null,
      retryMinutes: 5,
      maxAttempts: 3,
    })).toEqual({ shouldRun: true, reason: 'ready' });
  });

  it('does not rerun a scheduled slot that already succeeded', () => {
    expect(shouldAttemptFiscalDailyReport({
      latestSuccess: { printed_at: '2026-06-13 21:58:20' },
      hasReceiptAfterLatestSuccess: true,
      scheduledRun: { status: 'SUCCESS', attempts: 1, updated_at: '2026-06-13 21:58:20' },
      retryMinutes: 5,
      maxAttempts: 3,
    })).toEqual({ shouldRun: false, reason: 'schedule_already_success' });
  });

  it('waits for retryMinutes before retrying a failed scheduled slot', () => {
    expect(shouldAttemptFiscalDailyReport({
      latestSuccess: null,
      hasReceiptAfterLatestSuccess: true,
      scheduledRun: { status: 'FAILED', attempts: 1, updated_at: '2026-06-13 21:58:00' },
      retryMinutes: 5,
      maxAttempts: 3,
      nowMs: Date.parse('2026-06-13T22:02:59Z'),
    })).toEqual({ shouldRun: false, reason: 'retry_not_due' });

    expect(shouldAttemptFiscalDailyReport({
      latestSuccess: null,
      hasReceiptAfterLatestSuccess: true,
      scheduledRun: { status: 'FAILED', attempts: 1, updated_at: '2026-06-13 21:58:00' },
      retryMinutes: 5,
      maxAttempts: 3,
      nowMs: Date.parse('2026-06-13T22:03:01Z'),
    })).toEqual({ shouldRun: true, reason: 'ready' });
  });

  it('stops retrying after max attempts within the same Warsaw day', () => {
    // updated_at 21:58Z = 23:58 Warsaw (CEST) on 06-13; nowMs 21:59Z = 23:59
    // Warsaw, still 06-13 — budget exhausted, no retry.
    expect(shouldAttemptFiscalDailyReport({
      latestSuccess: null,
      hasReceiptAfterLatestSuccess: true,
      scheduledRun: { status: 'FAILED', attempts: 3, updated_at: '2026-06-13 21:58:00' },
      retryMinutes: 5,
      maxAttempts: 3,
      nowMs: Date.parse('2026-06-13T21:59:00Z'),
    })).toEqual({ shouldRun: false, reason: 'max_attempts_reached' });
  });

  it('resets the exhausted budget once the Warsaw day rolls over (missed Z-report is overdue)', () => {
    // Same exhausted 06-13 slot, but now it is 00:10 Warsaw on 06-14
    // (22:10Z) — the missed raport dobowy must print, not stay blocked forever.
    expect(shouldAttemptFiscalDailyReport({
      latestSuccess: null,
      hasReceiptAfterLatestSuccess: true,
      scheduledRun: { status: 'FAILED', attempts: 3, updated_at: '2026-06-13 21:58:00' },
      retryMinutes: 5,
      maxAttempts: 3,
      nowMs: Date.parse('2026-06-13T22:10:00Z'),
    })).toEqual({ shouldRun: true, reason: 'ready' });
  });
});
