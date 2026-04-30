import { database } from '../database';

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

export const staffRepo = {
  getAll(): StaffRow[] {
    return database.all<StaffRow>('SELECT * FROM pos_staff WHERE is_active = 1 ORDER BY name');
  },

  getById(id: string): StaffRow | null {
    return database.get<StaffRow>('SELECT * FROM pos_staff WHERE id = ?', [id]);
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
};
