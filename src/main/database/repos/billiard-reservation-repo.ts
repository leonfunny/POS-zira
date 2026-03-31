import { database } from '../database';

export interface BilliardReservationRow {
  id: string;
  resource_id: string;
  date: string;           // 'YYYY-MM-DD'
  start_time: string;     // 'HH:MM'
  end_time: string;       // 'HH:MM'
  customer_name: string;
  customer_phone: string;
  notes: string;
  status: 'active' | 'cancelled' | 'completed' | 'no_show';
  created_at: string;
  updated_at: string;
  // Recurring / guest fields (v16)
  guest_id: string | null;
  parent_id: string | null;
  is_recurring: number;        // 0 or 1
  recur_day: number | null;    // 0=Sun .. 6=Sat
  recur_until: string | null;  // 'YYYY-MM-DD'
}

export const billiardReservationRepo = {
  /** Get reservations filtered by optional date range, excludes cancelled */
  getAll(dateFrom?: string, dateTo?: string): BilliardReservationRow[] {
    let sql = `SELECT * FROM billiard_reservations WHERE status != 'cancelled'`;
    const params: string[] = [];

    if (dateFrom) {
      sql += ' AND date >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      sql += ' AND date <= ?';
      params.push(dateTo);
    }

    sql += ' ORDER BY date, start_time';
    return database.all<BilliardReservationRow>(sql, params);
  },

  /** Get today + future active reservations */
  getUpcoming(): BilliardReservationRow[] {
    const today = new Date().toISOString().slice(0, 10);
    return database.all<BilliardReservationRow>(
      `SELECT * FROM billiard_reservations
       WHERE status = 'active' AND date >= ?
       ORDER BY date, start_time`,
      [today],
    );
  },

  /** Get reservations for a specific resource on a specific date (for overlap check) */
  getByResourceDate(resourceId: string, date: string): BilliardReservationRow[] {
    return database.all<BilliardReservationRow>(
      `SELECT * FROM billiard_reservations
       WHERE resource_id = ? AND date = ? AND status = 'active'
       ORDER BY start_time`,
      [resourceId, date],
    );
  },

  /** Get today's active reservations arriving within N minutes from now */
  getArrivingSoon(minutes: number): BilliardReservationRow[] {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const future = new Date(now.getTime() + minutes * 60_000);
    const futureHhmm = `${String(future.getHours()).padStart(2, '0')}:${String(future.getMinutes()).padStart(2, '0')}`;

    return database.all<BilliardReservationRow>(
      `SELECT * FROM billiard_reservations
       WHERE status = 'active'
         AND date = ?
         AND start_time >= ?
         AND start_time <= ?
       ORDER BY start_time`,
      [today, hhmm, futureHhmm],
    );
  },

  /** Insert or update a reservation */
  upsert(row: {
    id: string;
    resourceId: string;
    date: string;
    startTime: string;
    endTime: string;
    customerName?: string;
    customerPhone?: string;
    notes?: string;
    status?: 'active' | 'cancelled' | 'completed' | 'no_show';
    guestId?: string | null;
    parentId?: string | null;
    isRecurring?: boolean;
    recurDay?: number | null;
    recurUntil?: string | null;
  }): void {
    database.run(
      `INSERT INTO billiard_reservations
         (id, resource_id, date, start_time, end_time, customer_name, customer_phone, notes, status,
          guest_id, parent_id, is_recurring, recur_day, recur_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         resource_id = excluded.resource_id,
         date = excluded.date,
         start_time = excluded.start_time,
         end_time = excluded.end_time,
         customer_name = excluded.customer_name,
         customer_phone = excluded.customer_phone,
         notes = excluded.notes,
         status = excluded.status,
         guest_id = excluded.guest_id,
         parent_id = excluded.parent_id,
         is_recurring = excluded.is_recurring,
         recur_day = excluded.recur_day,
         recur_until = excluded.recur_until,
         updated_at = datetime('now')`,
      [
        row.id,
        row.resourceId,
        row.date,
        row.startTime,
        row.endTime,
        row.customerName || '',
        row.customerPhone || '',
        row.notes || '',
        row.status || 'active',
        row.guestId ?? null,
        row.parentId ?? null,
        row.isRecurring ? 1 : 0,
        row.recurDay ?? null,
        row.recurUntil ?? null,
      ],
    );
  },

  /** Hard delete a reservation */
  delete(id: string): void {
    database.run('DELETE FROM billiard_reservations WHERE id = ?', [id]);
  },

  /** Get all instances belonging to a recurring series */
  getByParentId(parentId: string): BilliardReservationRow[] {
    return database.all<BilliardReservationRow>(
      `SELECT * FROM billiard_reservations
       WHERE parent_id = ?
       ORDER BY date, start_time`,
      [parentId],
    );
  },

  /** Delete future instances of a recurring series (date >= today) */
  deleteFutureByParentId(parentId: string): number {
    const today = new Date().toISOString().slice(0, 10);
    database.run(
      `DELETE FROM billiard_reservations
       WHERE parent_id = ? AND date >= ?`,
      [parentId, today],
    );
    // Also delete the template itself
    database.run('DELETE FROM billiard_reservations WHERE id = ?', [parentId]);
    return 0;
  },

  /**
   * Generate individual reservation instances from a recurring template.
   * Skips dates that already have an active reservation on the same resource
   * at overlapping times.
   * @param templateId - ID of the template row (is_recurring=1)
   * @param horizonWeeks - how many weeks ahead to generate (default 8)
   * @returns number of instances created
   */
  generateRecurring(templateId: string, horizonWeeks = 8): number {
    const template = database.get<BilliardReservationRow>(
      'SELECT * FROM billiard_reservations WHERE id = ?',
      [templateId],
    );
    if (!template || !template.is_recurring || template.recur_day == null) return 0;

    const targetDay = template.recur_day; // 0=Sun..6=Sat
    const until = template.recur_until
      ? new Date(template.recur_until + 'T23:59:59')
      : new Date(Date.now() + horizonWeeks * 7 * 86400000);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Start from tomorrow to avoid duplicating the template's own date
    const cursor = new Date(today.getTime() + 86400000);

    let created = 0;

    while (cursor <= until) {
      if (cursor.getDay() === targetDay) {
        const dateStr = cursor.toISOString().slice(0, 10);

        // Check for existing active reservation at this resource+date+time
        const existing = database.all<BilliardReservationRow>(
          `SELECT id FROM billiard_reservations
           WHERE resource_id = ? AND date = ? AND status = 'active'
             AND start_time < ? AND end_time > ?`,
          [template.resource_id, dateStr, template.end_time, template.start_time],
        );

        if (existing.length === 0) {
          const instanceId = `rsv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          database.run(
            `INSERT INTO billiard_reservations
               (id, resource_id, date, start_time, end_time, customer_name, customer_phone, notes, status,
                guest_id, parent_id, is_recurring, recur_day, recur_until, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, NULL, NULL, datetime('now'), datetime('now'))`,
            [
              instanceId,
              template.resource_id,
              dateStr,
              template.start_time,
              template.end_time,
              template.customer_name,
              template.customer_phone,
              template.notes,
              template.guest_id,
              template.id, // parent_id points to template
            ],
          );
          created++;
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    return created;
  },
};
