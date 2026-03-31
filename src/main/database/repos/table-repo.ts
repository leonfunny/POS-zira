import { database } from '../database';
import logger from '../../logger';

export interface TableRow {
  id: string;
  name: string;
  zone: string | null;
  capacity: number;
  sort_order: number;
  is_active: number;
  status: string;  // 'free' | 'occupied' | 'reserved' | 'bill'
  current_order_id: string | null;
  covers: number;
  opened_at: string | null;
}

export const tableRepo = {
  getAll(): TableRow[] {
    return database.all<TableRow>('SELECT * FROM pos_tables ORDER BY sort_order, name');
  },

  getActive(): TableRow[] {
    return database.all<TableRow>('SELECT * FROM pos_tables WHERE is_active = 1 ORDER BY sort_order, name');
  },

  getById(id: string): TableRow | null {
    return database.get<TableRow>('SELECT * FROM pos_tables WHERE id = ?', [id]);
  },

  updateStatus(id: string, status: string, orderId?: string | null): void {
    if (status === 'occupied' && orderId) {
      database.run(
        "UPDATE pos_tables SET status = ?, current_order_id = ?, opened_at = datetime('now') WHERE id = ?",
        [status, orderId, id],
      );
    } else {
      database.run(
        'UPDATE pos_tables SET status = ?, current_order_id = CASE WHEN ? = \'free\' THEN NULL ELSE current_order_id END WHERE id = ?',
        [status, status, id],
      );
    }
    logger.debug(`[TableRepo] Table ${id} → ${status}`);
  },

  setCovers(id: string, covers: number): void {
    database.run('UPDATE pos_tables SET covers = ? WHERE id = ?', [covers, id]);
  },

  clear(id: string): void {
    database.run(
      'UPDATE pos_tables SET status = \'free\', current_order_id = NULL, covers = 0, opened_at = NULL WHERE id = ?',
      [id],
    );
    logger.debug(`[TableRepo] Table ${id} cleared`);
  },

  upsertMany(tables: TableRow[]): void {
    database.transaction(() => {
      for (const t of tables) {
        database.run(
          `INSERT OR REPLACE INTO pos_tables (id, name, zone, capacity, sort_order, is_active, status, current_order_id, covers, opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [t.id, t.name, t.zone, t.capacity, t.sort_order, t.is_active, t.status, t.current_order_id, t.covers, t.opened_at],
        );
      }
    });
  },
};
