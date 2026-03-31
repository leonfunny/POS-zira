import { database } from '../database';

export interface BilliardHappyHourRow {
  id: string;
  name: string;
  day_of_week: number;    // 0=Sun .. 6=Sat
  start_time: string;     // 'HH:MM'
  end_time: string;       // 'HH:MM'
  discount_type: 'percent' | 'fixed';
  discount_value: number; // % (0-100) or PLN amount
  scope: 'time' | 'fnb' | 'all';
  is_active: number;      // 0 or 1
  created_at: string;
}

export const billiardHappyHourRepo = {
  /** Get all happy hour rules ordered by day + start time */
  getAll(): BilliardHappyHourRow[] {
    return database.all<BilliardHappyHourRow>(
      'SELECT * FROM billiard_happy_hours ORDER BY day_of_week, start_time',
    );
  },

  /** Upsert a happy hour rule */
  upsert(row: {
    id: string;
    name: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    discountType: 'percent' | 'fixed';
    discountValue: number;
    scope: 'time' | 'fnb' | 'all';
    isActive?: boolean;
  }): void {
    database.run(
      `INSERT INTO billiard_happy_hours (id, name, day_of_week, start_time, end_time, discount_type, discount_value, scope, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         day_of_week = excluded.day_of_week,
         start_time = excluded.start_time,
         end_time = excluded.end_time,
         discount_type = excluded.discount_type,
         discount_value = excluded.discount_value,
         scope = excluded.scope,
         is_active = excluded.is_active`,
      [
        row.id,
        row.name,
        row.dayOfWeek,
        row.startTime,
        row.endTime,
        row.discountType,
        row.discountValue,
        row.scope,
        row.isActive !== false ? 1 : 0,
      ],
    );
  },

  /** Delete a happy hour rule */
  delete(id: string): void {
    database.run('DELETE FROM billiard_happy_hours WHERE id = ?', [id]);
  },

  /**
   * Get active happy hour rules matching current day and time.
   * Returns all matching rules (there may be overlapping windows).
   */
  getActive(): BilliardHappyHourRow[] {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun .. 6=Sat
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    return database.all<BilliardHappyHourRow>(
      `SELECT * FROM billiard_happy_hours
       WHERE is_active = 1
         AND day_of_week = ?
         AND start_time <= ?
         AND end_time > ?
       ORDER BY discount_value DESC`,
      [dayOfWeek, hhmm, hhmm],
    );
  },
};
