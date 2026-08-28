import { database } from '../database';

export type EodRunStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface EodRunRow {
  business_date: string;
  status: EodRunStatus;
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
  shifts_closed: number;
  purged: number;
  kept: number;
  error: string | null;
  updated_at: string | null;
}

export const eodRunRepo = {
  get(businessDate: string): EodRunRow | null {
    return database.get<EodRunRow>('SELECT * FROM pos_eod_runs WHERE business_date = ?', [businessDate]);
  },

  latestSuccessDate(): string | null {
    const row = database.get<{ business_date: string }>(
      "SELECT business_date FROM pos_eod_runs WHERE status = 'SUCCESS' ORDER BY business_date DESC LIMIT 1",
    );
    return row?.business_date ?? null;
  },

  begin(businessDate: string): EodRunRow {
    const existing = this.get(businessDate);
    if (existing) {
      database.run(
        `UPDATE pos_eod_runs SET status = 'RUNNING', attempts = attempts + 1,
           started_at = datetime('now'), updated_at = datetime('now'), error = NULL
         WHERE business_date = ?`,
        [businessDate],
      );
    } else {
      database.run(
        `INSERT INTO pos_eod_runs (business_date, status, attempts, started_at, updated_at)
         VALUES (?, 'RUNNING', 1, datetime('now'), datetime('now'))`,
        [businessDate],
      );
    }
    database.markDirty();
    return this.get(businessDate)!;
  },

  finish(businessDate: string, result: { shiftsClosed: number; purged: number; kept: number }): void {
    database.run(
      `UPDATE pos_eod_runs SET status = 'SUCCESS', finished_at = datetime('now'), updated_at = datetime('now'),
         shifts_closed = ?, purged = ?, kept = ?, error = NULL
       WHERE business_date = ?`,
      [result.shiftsClosed, result.purged, result.kept, businessDate],
    );
    database.markDirty();
  },

  fail(businessDate: string, error: string): void {
    database.run(
      `UPDATE pos_eod_runs SET status = 'FAILED', updated_at = datetime('now'), error = ? WHERE business_date = ?`,
      [error.slice(0, 500), businessDate],
    );
    database.markDirty();
  },
};
