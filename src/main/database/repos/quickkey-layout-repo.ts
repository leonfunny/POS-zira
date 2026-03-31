import { database } from '../database';

interface QuickKeyLayoutRow {
  id: string;
  name: string;
  mode: string;
  cols: number;
  tiles: string;
  created_at: string;
  updated_at: string | null;
}

class QuickKeyLayoutRepo {
  list(mode?: string): QuickKeyLayoutRow[] {
    if (mode) {
      return database.all<QuickKeyLayoutRow>(
        `SELECT * FROM pos_quickkey_layouts WHERE mode = ? ORDER BY created_at DESC`,
        [mode],
      );
    }
    return database.all<QuickKeyLayoutRow>(`SELECT * FROM pos_quickkey_layouts ORDER BY created_at DESC`);
  }

  get(id: string): QuickKeyLayoutRow | null {
    return database.get<QuickKeyLayoutRow>(`SELECT * FROM pos_quickkey_layouts WHERE id = ?`, [id]);
  }

  create(id: string, data: { name: string; mode: string; cols: number; tiles: any[] }): void {
    database.run(
      `INSERT INTO pos_quickkey_layouts (id, name, mode, cols, tiles) VALUES (?, ?, ?, ?, ?)`,
      [id, data.name, data.mode, data.cols, JSON.stringify(data.tiles)],
    );
  }

  update(id: string, data: { name: string; cols: number; tiles: any[] }): void {
    database.run(
      `UPDATE pos_quickkey_layouts SET name = ?, cols = ?, tiles = ?, updated_at = datetime('now') WHERE id = ?`,
      [data.name, data.cols, JSON.stringify(data.tiles), id],
    );
  }

  remove(id: string): void {
    database.run(`DELETE FROM pos_quickkey_layouts WHERE id = ?`, [id]);
    database.run(`DELETE FROM pos_quickkey_assignments WHERE layout_id = ?`, [id]);
  }

  assign(registerId: string, mode: string, layoutId: string): void {
    database.run(
      `INSERT INTO pos_quickkey_assignments (register_id, mode, layout_id, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(register_id, mode) DO UPDATE SET layout_id = excluded.layout_id, updated_at = datetime('now')`,
      [registerId, mode, layoutId],
    );
  }

  getAssigned(registerId: string, mode: string): string | null {
    const row = database.get<{ layout_id: string }>(
      `SELECT layout_id FROM pos_quickkey_assignments WHERE register_id = ? AND mode = ?`,
      [registerId, mode],
    );
    return row?.layout_id ?? null;
  }
}

export const quickKeyLayoutRepo = new QuickKeyLayoutRepo();
