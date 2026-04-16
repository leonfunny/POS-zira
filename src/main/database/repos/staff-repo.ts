import { database } from '../database';

export interface StaffRow {
  id: string;
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

  upsertMany(staff: StaffRow[]): void {
    database.transaction(() => {
      for (const s of staff) {
        database.run(
          `INSERT OR REPLACE INTO pos_staff (id, name, commission_rate, is_active, updated_at, role, backend_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [s.id, s.name, s.commission_rate, s.is_active, s.updated_at, s.role ?? null, s.backend_synced_at ?? null],
        );
      }
    });
  },
};
