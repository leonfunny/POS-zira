import { database } from '../database';

export interface BilliardComboRow {
  id: string;
  name: string;
  combo_price: number;
  combo_type: string | null;
  play_minutes: number;
  is_active: number;
  updated_at: string | null;
}

export interface BilliardComboItemRow {
  id: string;
  combo_id: string;
  variant_id: string | null;
  name: string | null;
  quantity: number;
  unit_price: number;
}

export const billiardComboRepo = {
  getAll(activeOnly?: boolean): (BilliardComboRow & { items: BilliardComboItemRow[] })[] {
    const combos = activeOnly
      ? database.all<BilliardComboRow>('SELECT * FROM billiard_combos WHERE is_active = 1')
      : database.all<BilliardComboRow>('SELECT * FROM billiard_combos');

    return combos.map((c) => ({
      ...c,
      items: database.all<BilliardComboItemRow>(
        'SELECT * FROM billiard_combo_items WHERE combo_id = ?',
        [c.id],
      ),
    }));
  },

  upsertMany(combos: any[]): void {
    for (const c of combos) {
      database.run(
        `INSERT OR REPLACE INTO billiard_combos
          (id, name, combo_price, combo_type, play_minutes, is_active, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          c.id,
          c.name || '',
          c.comboPrice ?? c.combo_price ?? 0,
          c.comboType ?? c.combo_type ?? null,
          c.playMinutes ?? c.play_minutes ?? 0,
          c.isActive !== undefined ? (c.isActive ? 1 : 0) : 1,
          c.updatedAt || c.updated_at || new Date().toISOString(),
        ],
      );

      // Upsert items
      const items = c.items || c.comboItems || [];
      // Clear old items for this combo
      database.run('DELETE FROM billiard_combo_items WHERE combo_id = ?', [c.id]);
      for (const item of items) {
        database.run(
          `INSERT INTO billiard_combo_items
            (id, combo_id, variant_id, name, quantity, unit_price)
          VALUES (?, ?, ?, ?, ?, ?)`,
          [
            item.id || `${c.id}_${item.variantId || item.variant_id || Math.random().toString(36).slice(2)}`,
            c.id,
            item.variantId || item.variant_id || null,
            item.name || null,
            item.quantity ?? 1,
            item.unitPrice ?? item.unit_price ?? 0,
          ],
        );
      }
    }
  },

  clear(): void {
    database.run('DELETE FROM billiard_combo_items');
    database.run('DELETE FROM billiard_combos');
  },
};
