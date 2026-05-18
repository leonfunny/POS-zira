import { database } from '../database';

export interface DraftProductRow {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  retail_price: number;
  category_id: string | null;
  image_url: string | null;
  in_stock: number;
  vat_rate: number;
  status: string;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
}

export const draftProductRepo = {
  getAll(): DraftProductRow[] {
    return database.all<DraftProductRow>(
      'SELECT * FROM draft_products WHERE deleted_at IS NULL ORDER BY updated_at DESC, name',
    );
  },

  getByStatus(status: string): DraftProductRow[] {
    return database.all<DraftProductRow>(
      'SELECT * FROM draft_products WHERE status = ? AND deleted_at IS NULL ORDER BY updated_at DESC',
      [status],
    );
  },

  getById(id: string): DraftProductRow | null {
    return database.get<DraftProductRow>('SELECT * FROM draft_products WHERE id = ?', [id]);
  },

  getByBarcode(barcode: string): DraftProductRow | null {
    return database.get<DraftProductRow>(
      'SELECT * FROM draft_products WHERE barcode = ? AND deleted_at IS NULL',
      [barcode],
    );
  },

  // Code-only search for the retail till — mirrors productRepo.searchByCode
  // but against the draft mirror so cashiers can find unimported items by
  // typing the EAN/SKU printed on the package. Cap at 50 since drafts can
  // run into thousands and the grid only renders a handful.
  searchByCode(query: string): DraftProductRow[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const like = `%${trimmed}%`;
    return database.all<DraftProductRow>(
      `SELECT * FROM draft_products
         WHERE deleted_at IS NULL AND (barcode LIKE ? OR sku LIKE ?)
         ORDER BY name LIMIT 50`,
      [like, like],
    );
  },

  upsertMany(drafts: DraftProductRow[]): void {
    if (drafts.length === 0) return;
    for (const d of drafts) {
      if (!d.id || !d.name) {
        throw new Error(`Invalid draft product: missing id or name (id=${d.id})`);
      }
      database.run(
        `INSERT OR REPLACE INTO draft_products
           (id, name, sku, barcode, retail_price, category_id, image_url, in_stock, vat_rate, status, created_by, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          d.id,
          d.name,
          d.sku,
          d.barcode,
          d.retail_price ?? 0,
          d.category_id,
          d.image_url,
          d.in_stock ?? 0,
          d.vat_rate ?? 23,
          d.status || 'DRAFT',
          d.created_by,
          d.created_at,
          d.updated_at,
          d.deleted_at,
        ],
      );
    }
  },

  softDeleteByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    for (const id of ids) {
      database.run('UPDATE draft_products SET deleted_at = ? WHERE id = ?', [now, id]);
    }
  },

  getLatestUpdatedAt(): string | null {
    const row = database.get<{ ts: string | null }>(
      "SELECT MAX(updated_at) AS ts FROM draft_products WHERE deleted_at IS NULL",
    );
    return row?.ts ?? null;
  },

  clearAll(): void {
    database.run('DELETE FROM draft_products');
  },
};
