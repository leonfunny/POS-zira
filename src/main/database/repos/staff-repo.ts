import { database } from '../database';
import { randomUUID } from 'crypto';

const DEMO_STAFF_IDS = ['staff-1', 'staff-2', 'staff-3', 'staff-4'] as const;

export interface StaffRow {
  id: string;                      // staff_profiles.id (server)
  user_id?: string | null;         // users.id — canonical bookings.staff_user_id FK target
  name: string;
  commission_rate: number;  // basis points (e.g., 1000 = 10%)
  is_active: number;
  updated_at: string | null;
  role?: string | null;
  backend_synced_at?: string | null;
}

export interface StaffWriteInput {
  name: string;
  commissionRate?: number;
  role?: string | null;
  isActive?: boolean;
}

function normalizeStaffInput(input: StaffWriteInput, existing?: StaffRow): StaffRow {
  const name = input.name?.trim();
  if (!name) throw new Error('Staff name is required');

  const now = new Date().toISOString();
  return {
    id: existing?.id ?? randomUUID(),
    user_id: existing?.user_id ?? null,
    name,
    commission_rate: Math.max(0, Math.round(Number(input.commissionRate ?? existing?.commission_rate ?? 0) || 0)),
    is_active: input.isActive === undefined ? (existing?.is_active ?? 1) : (input.isActive ? 1 : 0),
    updated_at: now,
    role: input.role === undefined ? (existing?.role ?? null) : (input.role?.trim() || null),
    backend_synced_at: existing?.backend_synced_at ?? null,
  };
}

export const staffRepo = {
  getAll(): StaffRow[] {
    return database.all<StaffRow>('SELECT * FROM pos_staff WHERE is_active = 1 ORDER BY name');
  },

  getAllForSettings(): StaffRow[] {
    return database.all<StaffRow>('SELECT * FROM pos_staff ORDER BY is_active DESC, name');
  },

  getById(id: string): StaffRow | null {
    return database.get<StaffRow>('SELECT * FROM pos_staff WHERE id = ?', [id]);
  },

  getByUserId(userId: string): StaffRow | null {
    return database.get<StaffRow>('SELECT * FROM pos_staff WHERE user_id = ?', [userId]);
  },

  /**
   * Lookup by either staff_profiles.id OR users.id. The booking pipeline
   * stores users.id (canonical) but POS dropdown may bind to either,
   * depending on whether v24 has populated user_id yet.
   */
  getByBookingStaffId(id: string): StaffRow | null {
    return database.get<StaffRow>(
      'SELECT * FROM pos_staff WHERE id = ? OR user_id = ?',
      [id, id],
    );
  },

  createLocal(input: StaffWriteInput): StaffRow {
    const row = normalizeStaffInput(input);
    database.run(
      `INSERT INTO pos_staff (id, user_id, name, commission_rate, is_active, updated_at, role, backend_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.user_id ?? null,
        row.name,
        row.commission_rate,
        row.is_active,
        row.updated_at,
        row.role ?? null,
        row.backend_synced_at ?? null,
      ],
    );
    database.markDirty();
    return row;
  },

  updateLocal(id: string, input: StaffWriteInput): StaffRow {
    const existing = this.getById(id);
    if (!existing) throw new Error('Staff not found');
    const row = normalizeStaffInput(input, existing);
    database.run(
      `UPDATE pos_staff
       SET name = ?, commission_rate = ?, is_active = ?, updated_at = ?, role = ?
       WHERE id = ?`,
      [row.name, row.commission_rate, row.is_active, row.updated_at, row.role ?? null, id],
    );
    database.markDirty();
    return this.getById(id)!;
  },

  setActive(id: string, active: boolean): StaffRow {
    const existing = this.getById(id);
    if (!existing) throw new Error('Staff not found');
    database.run(
      'UPDATE pos_staff SET is_active = ?, updated_at = ? WHERE id = ?',
      [active ? 1 : 0, new Date().toISOString(), id],
    );
    database.markDirty();
    return this.getById(id)!;
  },

  upsertMany(staff: StaffRow[]): void {
    database.transaction(() => {
      for (const s of staff) {
        database.run(
          `INSERT INTO pos_staff (id, user_id, name, commission_rate, is_active, updated_at, role, backend_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             user_id = COALESCE(excluded.user_id, pos_staff.user_id),
             name = excluded.name,
             commission_rate = excluded.commission_rate,
             is_active = excluded.is_active,
             updated_at = excluded.updated_at,
             role = excluded.role,
             backend_synced_at = excluded.backend_synced_at`,
          [
            s.id,
            s.user_id ?? null,
            s.name,
            s.commission_rate,
            s.is_active,
            s.updated_at,
            s.role ?? null,
            s.backend_synced_at ?? null,
          ],
        );
      }
    });
  },

  reconcileFromBackend(staff: StaffRow[]): void {
    if (staff.length === 0) return;

    const now = new Date().toISOString();
    const syncedIds = staff.map((s) => s.id);
    const placeholders = syncedIds.map(() => '?').join(',');

    database.transaction(() => {
      for (const s of staff) {
        database.run(
          `INSERT INTO pos_staff (id, user_id, name, commission_rate, is_active, updated_at, role, backend_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             user_id = COALESCE(excluded.user_id, pos_staff.user_id),
             name = excluded.name,
             commission_rate = excluded.commission_rate,
             is_active = excluded.is_active,
             updated_at = excluded.updated_at,
             role = excluded.role,
             backend_synced_at = excluded.backend_synced_at`,
          [
            s.id,
            s.user_id ?? null,
            s.name,
            s.commission_rate,
            s.is_active,
            s.updated_at ?? now,
            s.role ?? null,
            s.backend_synced_at ?? now,
          ],
        );
      }

      database.run(
        `DELETE FROM pos_staff
         WHERE user_id IS NULL
           AND id IN (${DEMO_STAFF_IDS.map(() => '?').join(',')})`,
        [...DEMO_STAFF_IDS],
      );

      database.run(
        `UPDATE pos_staff
         SET is_active = 0,
             updated_at = ?,
             backend_synced_at = ?
         WHERE id NOT IN (${placeholders})`,
        [now, now, ...syncedIds],
      );
    });
    database.markDirty();
  },
};
