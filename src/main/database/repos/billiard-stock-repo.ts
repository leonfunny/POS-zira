import { database } from '../database';

export interface BilliardStockRow {
  variant_id: string;
  variant_name: string;
  quantity: number;
  low_threshold: number;
  unit: string;
  updated_at: string;
}

export const billiardStockRepo = {
  /** Get all stock records ordered by name */
  getAll(): BilliardStockRow[] {
    return database.all<BilliardStockRow>(
      'SELECT * FROM billiard_stock ORDER BY variant_name',
    );
  },

  /** Get stock for a specific variant */
  getByVariant(variantId: string): BilliardStockRow | null {
    return (
      database.get<BilliardStockRow>(
        'SELECT * FROM billiard_stock WHERE variant_id = ?',
        [variantId],
      ) || null
    );
  },

  /** Upsert stock record (set absolute quantity) */
  upsert(row: { variantId: string; variantName: string; quantity: number; lowThreshold?: number; unit?: string }): void {
    database.run(
      `INSERT INTO billiard_stock (variant_id, variant_name, quantity, low_threshold, unit, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(variant_id) DO UPDATE SET
         variant_name = excluded.variant_name,
         quantity = excluded.quantity,
         low_threshold = COALESCE(excluded.low_threshold, low_threshold),
         unit = COALESCE(excluded.unit, unit),
         updated_at = datetime('now')`,
      [
        row.variantId,
        row.variantName,
        row.quantity,
        row.lowThreshold ?? 5,
        row.unit ?? 'szt',
      ],
    );
  },

  /**
   * Adjust stock by delta (negative = deduct, positive = restock).
   * Creates the row if it doesn't exist (with quantity = delta).
   * Returns the new quantity.
   */
  adjustQuantity(variantId: string, variantName: string, delta: number): number {
    // Upsert with 0 if not exists, then update with delta
    database.run(
      `INSERT INTO billiard_stock (variant_id, variant_name, quantity, updated_at)
       VALUES (?, ?, 0, datetime('now'))
       ON CONFLICT(variant_id) DO NOTHING`,
      [variantId, variantName],
    );
    database.run(
      `UPDATE billiard_stock SET quantity = MAX(0, quantity + ?), updated_at = datetime('now')
       WHERE variant_id = ?`,
      [delta, variantId],
    );
    const row = database.get<{ quantity: number }>(
      'SELECT quantity FROM billiard_stock WHERE variant_id = ?',
      [variantId],
    );
    return row?.quantity ?? 0;
  },

  /** Update low stock threshold */
  setThreshold(variantId: string, threshold: number): void {
    database.run(
      'UPDATE billiard_stock SET low_threshold = ?, updated_at = datetime(\'now\') WHERE variant_id = ?',
      [threshold, variantId],
    );
  },

  /** Get items below their low-stock threshold */
  getLowStock(): BilliardStockRow[] {
    return database.all<BilliardStockRow>(
      'SELECT * FROM billiard_stock WHERE quantity <= low_threshold ORDER BY quantity ASC',
    );
  },

  /** Get count of low-stock items (for badge) */
  getLowStockCount(): number {
    const row = database.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM billiard_stock WHERE quantity <= low_threshold',
    );
    return row?.cnt ?? 0;
  },
};
