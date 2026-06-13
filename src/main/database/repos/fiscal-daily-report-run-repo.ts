import { randomUUID } from 'crypto';
import { database } from '../database';
import type { FiscalDailyReportResult } from '../../../shared/types';

export type FiscalDailyReportRunStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
export type FiscalDailyReportRunTrigger = 'auto' | 'manual' | 'test';

export interface FiscalDailyReportRunRow {
  id: string;
  report_date: string;
  scheduled_for: string;
  trigger: FiscalDailyReportRunTrigger;
  status: FiscalDailyReportRunStatus;
  attempts: number;
  last_error: string | null;
  created_at: string | null;
  updated_at: string | null;
  printed_at: string | null;
  report_no_before: number | null;
  report_no_after: number | null;
  confirmation_unknown: number;
}

interface BeginDailyReportRunInput {
  reportDate: string;
  scheduledFor: string;
  trigger: FiscalDailyReportRunTrigger;
}

export const fiscalDailyReportRunRepo = {
  getLatestSuccess(): FiscalDailyReportRunRow | null {
    return database.get<FiscalDailyReportRunRow>(
      `SELECT * FROM fiscal_daily_report_runs
       WHERE status = 'SUCCESS'
       ORDER BY printed_at DESC, updated_at DESC
       LIMIT 1`,
    );
  },

  getLatestForSchedule(scheduledFor: string, trigger: FiscalDailyReportRunTrigger): FiscalDailyReportRunRow | null {
    return database.get<FiscalDailyReportRunRow>(
      `SELECT * FROM fiscal_daily_report_runs
       WHERE scheduled_for = ? AND trigger = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [scheduledFor, trigger],
    );
  },

  hasSuccessfulFiscalReceiptAfter(printedAt: string): boolean {
    const row = database.get<{ id: string }>(
      `SELECT id FROM fiscal_attempts
       WHERE status = 'SUCCESS_CONFIRMED'
         AND COALESCE(resolved_at, sent_at, created_at) > ?
       ORDER BY COALESCE(resolved_at, sent_at, created_at) ASC
       LIMIT 1`,
      [printedAt],
    );
    return !!row;
  },

  begin(input: BeginDailyReportRunInput): FiscalDailyReportRunRow {
    const existing = this.getLatestForSchedule(input.scheduledFor, input.trigger);
    if (existing && existing.status !== 'SUCCESS') {
      database.run(
        `UPDATE fiscal_daily_report_runs
         SET status = 'RUNNING',
             attempts = attempts + 1,
             updated_at = datetime('now'),
             last_error = NULL,
             confirmation_unknown = 0
         WHERE id = ?`,
        [existing.id],
      );
      database.markDirty();
      return database.get<FiscalDailyReportRunRow>(
        'SELECT * FROM fiscal_daily_report_runs WHERE id = ?',
        [existing.id],
      )!;
    }

    const id = randomUUID();
    database.run(
      `INSERT INTO fiscal_daily_report_runs (
        id, report_date, scheduled_for, trigger, status, attempts
       ) VALUES (?, ?, ?, ?, 'RUNNING', 1)`,
      [id, input.reportDate, input.scheduledFor, input.trigger],
    );
    database.markDirty();
    return database.get<FiscalDailyReportRunRow>(
      'SELECT * FROM fiscal_daily_report_runs WHERE id = ?',
      [id],
    )!;
  },

  markSuccess(id: string, result?: FiscalDailyReportResult): void {
    database.run(
      `UPDATE fiscal_daily_report_runs
       SET status = 'SUCCESS',
           printed_at = datetime('now'),
           updated_at = datetime('now'),
           last_error = NULL,
           report_no_before = ?,
           report_no_after = ?,
           confirmation_unknown = ?
       WHERE id = ?`,
      [
        numberOrNull(result?.beforeReportNumber),
        numberOrNull(result?.afterReportNumber),
        result?.confirmationUnknown ? 1 : 0,
        id,
      ],
    );
    database.markDirty();
  },

  markFailed(id: string, error: string): void {
    database.run(
      `UPDATE fiscal_daily_report_runs
       SET status = 'FAILED',
           last_error = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
      [error.slice(0, 1000), id],
    );
    database.markDirty();
  },

  markFailedFinal(id: string, error: string, maxAttempts: number): void {
    const finalAttempts = Math.max(1, Math.floor(Number(maxAttempts) || 1));
    database.run(
      `UPDATE fiscal_daily_report_runs
       SET status = 'FAILED',
           attempts = CASE WHEN attempts < ? THEN ? ELSE attempts END,
           last_error = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
      [finalAttempts, finalAttempts, error.slice(0, 1000), id],
    );
    database.markDirty();
  },
};

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
