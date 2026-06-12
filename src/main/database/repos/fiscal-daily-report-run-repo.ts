import { randomUUID } from 'crypto';
import { database } from '../database';

export type FiscalDailyReportRunStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface FiscalDailyReportRunRow {
  id: string;
  report_date: string;
  scheduled_for: string;
  status: FiscalDailyReportRunStatus;
  attempts: number;
  last_error: string | null;
  created_at: string | null;
  updated_at: string | null;
  printed_at: string | null;
}

export const fiscalDailyReportRunRepo = {
  get(reportDate: string): FiscalDailyReportRunRow | null {
    return database.get<FiscalDailyReportRunRow>(
      'SELECT * FROM fiscal_daily_report_runs WHERE report_date = ? LIMIT 1',
      [reportDate],
    );
  },

  begin(reportDate: string, scheduledFor: string): FiscalDailyReportRunRow {
    const existing = this.get(reportDate);
    if (existing) {
      database.run(
        `UPDATE fiscal_daily_report_runs
         SET scheduled_for = ?,
             status = 'RUNNING',
             attempts = attempts + 1,
             updated_at = datetime('now'),
             last_error = NULL
         WHERE id = ?`,
        [scheduledFor, existing.id],
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
        id, report_date, scheduled_for, status, attempts
       ) VALUES (?, ?, ?, 'RUNNING', 1)`,
      [id, reportDate, scheduledFor],
    );
    database.markDirty();
    return database.get<FiscalDailyReportRunRow>(
      'SELECT * FROM fiscal_daily_report_runs WHERE id = ?',
      [id],
    )!;
  },

  markSuccess(id: string): void {
    database.run(
      `UPDATE fiscal_daily_report_runs
       SET status = 'SUCCESS',
           printed_at = datetime('now'),
           updated_at = datetime('now'),
           last_error = NULL
       WHERE id = ?`,
      [id],
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
};
