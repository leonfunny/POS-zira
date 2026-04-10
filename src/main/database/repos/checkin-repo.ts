import { database } from '../database';
import { getConfigValue, setConfigValue } from '../../config/store';

/**
 * Derive a stable single-letter register code (A-Z) from the device's machineId.
 * Each device in a multi-register salon gets a unique prefix so booking numbers
 * like "A001/0410" and "B001/0410" cannot collide across devices.
 *
 * The derived code is persisted the first time it is needed so later calls are
 * O(1) and so the user can override it in settings without losing continuity.
 */
function getOrDeriveRegisterCode(): string {
  const existing = getConfigValue('registerCode');
  if (typeof existing === 'string' && existing.length > 0) return existing;

  const machineId = (getConfigValue('machineId') as string | undefined) || '';
  if (!machineId) return ''; // Fall back to legacy format if machineId missing

  // FNV-like rolling hash → letter A-Z (26 combos; collision at ~6 devices).
  // Multi-register chains should set a manual code via settings UI (future phase).
  let hash = 0;
  for (let i = 0; i < machineId.length; i++) {
    hash = (hash * 31 + machineId.charCodeAt(i)) & 0x7fffffff;
  }
  const letter = String.fromCharCode(65 + (hash % 26));

  setConfigValue('registerCode', letter);
  return letter;
}

export interface CheckinRow {
  id: string;
  booking_number: string | null; // e.g. "001/0204"
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
  // v13 sync fields
  synced: number;          // 0=pending, 1=synced, 2=in-flight
  backend_id: string | null;
  synced_at: string | null;
}

export interface CheckinCreateData {
  id: string;
  booking_number?: string;
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
  /**
   * Generate the next booking number for today.
   *
   * Format: `{registerCode}{seq}/{DDMM}` — e.g. "A001/0410", "B001/0410".
   *
   * The `seq` counter is scoped to the current register so two devices in the
   * same salon never issue the same number. Legacy single-device installs with
   * no machineId fall back to the old `{seq}/{DDMM}` format for backward compat.
   */
  nextBookingNumber(): string {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const ddmm = `${dd}${mm}`;
    const code = getOrDeriveRegisterCode();

    // Count only rows produced by this register today — a different device's
    // numbers share the table but belong to its own independent sequence.
    const likePattern = code ? `${code}___/${ddmm}` : `___/${ddmm}`;
    const count = database.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM checkins
        WHERE date(checked_in_at) = date('now')
          AND booking_number LIKE ?`,
      [likePattern],
    )?.cnt || 0;

    const seq = String(count + 1).padStart(3, '0');
    return `${code}${seq}/${ddmm}`;
  },

  create(data: CheckinCreateData): void {
    database.run(
      `INSERT INTO checkins (id, booking_number, customer_name, customer_phone, customer_email, service_name, staff_name, booking_id, booking_source, is_walkin, notes, customer_id, service_id, staff_id, estimated_duration, services_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        data.booking_number || null,
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

  // ── Sync helpers (v13) ──────────────────────────────
  /** Return check-ins that still need to be pushed to the server. */
  getUnsynced(): CheckinRow[] {
    return database.all<CheckinRow>('SELECT * FROM checkins WHERE synced = 0 ORDER BY checked_in_at ASC');
  },

  /** Mark a check-in as currently being sent (prevents double-send). */
  markSyncing(id: string): void {
    database.run('UPDATE checkins SET synced = 2 WHERE id = ? AND synced = 0', [id]);
  },

  /** Mark a check-in as successfully synced, recording the server's backend id. */
  markSynced(id: string, backendId: string): void {
    database.run(
      "UPDATE checkins SET synced = 1, backend_id = ?, synced_at = datetime('now') WHERE id = ?",
      [backendId, id],
    );
  },

  /** Revert a failed sync attempt so it will be retried on the next cycle. */
  markSyncFailed(id: string): void {
    database.run('UPDATE checkins SET synced = 0 WHERE id = ? AND synced = 2', [id]);
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
