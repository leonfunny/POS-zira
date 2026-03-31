import { database } from '../database';

interface HoldOrderRow {
  id: string;
  title: string;
  payload: string;
  items_count: number;
  total: number;
  staff_name?: string | null;
  created_at: string;
}

class HoldOrderRepo {
  create(id: string, title: string, payload: any): void {
    const cart = payload?.cart;
    const itemsCount = Array.isArray(cart?.items) ? cart.items.length : 0;
    const total = Number(cart?.total || 0);
    const staffName = payload?.staffName ?? null;
    database.run(
      `INSERT INTO pos_hold_orders (id, title, payload, items_count, total, staff_name) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, title, JSON.stringify(payload ?? {}), itemsCount, total, staffName],
    );
  }

  list(): Array<{ id: string; title: string; createdAt: string; items: number; total: number; staffName?: string | null }> {
    const rows = database.all<HoldOrderRow>(
      `SELECT id, title, items_count, total, staff_name, created_at FROM pos_hold_orders ORDER BY created_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      items: r.items_count,
      total: r.total,
      staffName: r.staff_name ?? null,
    }));
  }

  get(id: string): { id: string; title: string; payload: any; createdAt: string } | null {
    const row = database.get<HoldOrderRow>(
      `SELECT id, title, payload, created_at FROM pos_hold_orders WHERE id = ?`,
      [id],
    );
    if (!row) return null;
    try {
      return {
        id: row.id,
        title: row.title,
        payload: JSON.parse(row.payload),
        createdAt: row.created_at,
      };
    } catch {
      return null;
    }
  }

  remove(id: string): void {
    database.run(`DELETE FROM pos_hold_orders WHERE id = ?`, [id]);
  }

  prune(limit = 20): void {
    database.run(
      `DELETE FROM pos_hold_orders WHERE id NOT IN (
        SELECT id FROM pos_hold_orders ORDER BY created_at DESC LIMIT ?
      )`,
      [limit],
    );
  }
}

export const holdOrderRepo = new HoldOrderRepo();
