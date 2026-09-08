import type { AndroidDatabase } from './db';
import type { RestaurantLayoutTable } from '../restaurant-layout';

export const ANDROID_RESTAURANT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pos_device_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pos_table_layout_sync (salon_id TEXT PRIMARY KEY, synced_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pos_tables (
    salon_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, zone TEXT,
    capacity INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'free',
    current_order_id TEXT, covers INTEGER NOT NULL DEFAULT 0, opened_at TEXT,
    PRIMARY KEY (salon_id, id)
  );
`;

export interface RestaurantTableRow {
  id: string; name: string; zone: string | null; capacity: number; sort_order: number;
  is_active: number; status: string; current_order_id: string | null; covers: number; opened_at: string | null;
}

/** Device-local layout, tenant scoped. Live occupancy derives from unfinished
 * checks on this device, including checks owned by another staff member. */
export function createRestaurantTableRepo(db: AndroidDatabase, salonId: string) {
  const getById = (id: string) => db.get<RestaurantTableRow>('SELECT * FROM pos_tables WHERE salon_id = ? AND id = ?', [salonId, id]);
  const requireTable = (id: string) => {
    const row = getById(id);
    if (!row) throw new Error('Restaurant table not found on this device.');
    return row;
  };
  return {
    getById,
    lastSyncedAt: () => db.get<{ synced_at: string }>('SELECT synced_at FROM pos_table_layout_sync WHERE salon_id = ?', [salonId])?.synced_at ?? null,
    replaceLayout(rows: RestaurantLayoutTable[], syncedAt: string) {
      db.transaction(() => {
        // Keep tombstones: unpaid checks and a live cart can still reference a
        // table removed from the server. Never overwrite local operational data.
        db.run('UPDATE pos_tables SET is_active = 0 WHERE salon_id = ?', [salonId]);
        for (const row of rows) db.run(`INSERT INTO pos_tables(salon_id,id,name,zone,capacity,sort_order,is_active)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(salon_id,id) DO UPDATE SET
          name=excluded.name,zone=excluded.zone,capacity=excluded.capacity,sort_order=excluded.sort_order,is_active=excluded.is_active`,
        [salonId, row.id, row.name, row.zone, row.capacity, row.sortOrder, row.active ? 1 : 0]);
        db.run('INSERT INTO pos_table_layout_sync(salon_id,synced_at) VALUES (?,?) ON CONFLICT(salon_id) DO UPDATE SET synced_at=excluded.synced_at', [salonId, syncedAt]);
      });
    },
    list(activeOnly = false, retainedTableId: string | null = null): RestaurantTableRow[] {
      return db.all<RestaurantTableRow>(`SELECT t.id,t.name,t.zone,t.capacity,t.sort_order,t.is_active,
        CASE WHEN c.id IS NOT NULL THEN 'occupied' ELSE t.status END AS status,
        COALESCE(c.id,t.current_order_id) AS current_order_id, COALESCE(c.covers,t.covers) AS covers,
        COALESCE(c.created_at,t.opened_at) AS opened_at
        FROM pos_tables t LEFT JOIN pos_restaurant_checks c ON c.salon_id = t.salon_id AND c.table_id = t.id
          AND c.status NOT IN ('PAID','CANCELLED')
        WHERE t.salon_id = ? ${activeOnly ? 'AND (t.is_active = 1 OR c.id IS NOT NULL OR t.id = ?)' : ''} ORDER BY t.sort_order,t.name`, activeOnly ? [salonId, retainedTableId] : [salonId]);
    },
    setCovers(id: string, covers: number) {
      requireTable(id);
      if (!Number.isSafeInteger(covers) || covers < 0) throw new Error('Invalid guest count.');
      db.run('UPDATE pos_tables SET covers = ? WHERE salon_id = ? AND id = ?', [covers, salonId, id]);
    },
    updateStatus(id: string, status: string, orderId?: string | null) {
      requireTable(id);
      if (!['free','occupied','reserved','bill'].includes(status)) throw new Error('Invalid table status.');
      if (db.get("SELECT id FROM pos_restaurant_checks WHERE salon_id = ? AND table_id = ? AND status NOT IN ('PAID','CANCELLED')", [salonId, id])) {
        throw new Error('Save or finish the check before changing table status.');
      }
      db.run(`UPDATE pos_tables SET status = ?, current_order_id = ?, covers = CASE WHEN ? = 'free' THEN 0 ELSE covers END,
        opened_at = CASE WHEN ? = 'free' THEN NULL ELSE opened_at END WHERE salon_id = ? AND id = ?`,
      [status, status === 'free' ? null : orderId ?? null, status, status, salonId, id]);
    },
  };
}
