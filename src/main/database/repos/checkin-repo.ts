import { database } from '../database';

export interface CheckinRow {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  service_name: string | null;
  staff_name: string | null;
  booking_id: string | null;
  booking_source: string | null;  // 'booksy' | 'backend' | null
  is_walkin: number;
  status: string;  // waiting | in_service | completed | no_show
  checked_in_at: string;
  started_at: string | null;
  completed_at: string | null;
  upsells_added: string | null;  // JSON array
  notes: string | null;
  // v9+ columns
  customer_id: string | null;
  service_id: string | null;
  staff_id: string | null;
  estimated_duration: number | null;
  services_json: string | null;  // JSON array of {id, name, price, duration}
}

export interface CheckinCreateData {
  id: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  service_name?: string;
  staff_name?: string;
  booking_id?: string;
  booking_source?: string;
  is_walkin?: number;
  notes?: string;
  // v9+ fields
  customer_id?: string;
  service_id?: string;
  staff_id?: string;
  estimated_duration?: number;
  services_json?: string;
}

export const checkinRepo = {
  create(data: CheckinCreateData): void {
    database.run(
      `INSERT INTO checkins (id, customer_name, customer_phone, customer_email, service_name, staff_name, booking_id, booking_source, is_walkin, notes, customer_id, service_id, staff_id, estimated_duration, services_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        data.customer_name,
        data.customer_phone || null,
        data.customer_email || null,
        data.service_name || null,
        data.staff_name || null,
        data.booking_id || null,
        data.booking_source || null,
        data.is_walkin ?? 0,
        data.notes || null,
        data.customer_id || null,
        data.service_id || null,
        data.staff_id || null,
        data.estimated_duration || null,
        data.services_json || null,
      ],
    );
  },

  getToday(): CheckinRow[] {
    return database.all<CheckinRow>(
      `SELECT * FROM checkins WHERE date(checked_in_at) = date('now') ORDER BY checked_in_at DESC`,
    );
  },

  getByDate(date: string): CheckinRow[] {
    return database.all<CheckinRow>(
      `SELECT * FROM checkins WHERE date(checked_in_at) = date(?) ORDER BY checked_in_at DESC`,
      [date],
    );
  },

  updateStatus(id: string, status: string): void {
    database.run('UPDATE checkins SET status = ? WHERE id = ?', [status, id]);
  },

  startService(id: string): void {
    database.run(
      `UPDATE checkins SET status = 'in_service', started_at = datetime('now') WHERE id = ?`,
      [id],
    );
  },

  complete(id: string): void {
    database.run(
      `UPDATE checkins SET status = 'completed', completed_at = datetime('now') WHERE id = ?`,
      [id],
    );
  },

  markNoShow(id: string): void {
    database.run(`UPDATE checkins SET status = 'no_show' WHERE id = ?`, [id]);
  },

  searchByPhone(phone: string): CheckinRow[] {
    const pattern = `%${phone}%`;
    return database.all<CheckinRow>(
      'SELECT * FROM checkins WHERE customer_phone LIKE ? ORDER BY checked_in_at DESC LIMIT 50',
      [pattern],
    );
  },

  addUpsells(id: string, upsellsJson: string): void {
    database.run('UPDATE checkins SET upsells_added = ? WHERE id = ?', [upsellsJson, id]);
  },

  updateNotes(id: string, notes: string): void {
    database.run('UPDATE checkins SET notes = ? WHERE id = ?', [notes, id]);
  },

  getStats(date?: string): { total: number; waiting: number; inService: number; completed: number; noShow: number; walkIns: number } {
    const dateFilter = date ? `date(checked_in_at) = date(?)` : `date(checked_in_at) = date('now')`;
    const params = date ? [date] : [];

    const row = database.get<{
      total: number;
      waiting: number;
      in_service: number;
      completed: number;
      no_show: number;
      walk_ins: number;
    }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) as waiting,
        SUM(CASE WHEN status = 'in_service' THEN 1 ELSE 0 END) as in_service,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) as no_show,
        SUM(CASE WHEN is_walkin = 1 THEN 1 ELSE 0 END) as walk_ins
      FROM checkins WHERE ${dateFilter}`,
      params,
    );

    return {
      total: row?.total ?? 0,
      waiting: row?.waiting ?? 0,
      inService: row?.in_service ?? 0,
      completed: row?.completed ?? 0,
      noShow: row?.no_show ?? 0,
      walkIns: row?.walk_ins ?? 0,
    };
  },
};
