/**
 * ServiceRepo — local cache of salon services pulled from the dashboard.
 *
 * Prices stored as grosze (INT) to match orders/bookings. Server sends
 * PLN float in the sync payload; the applicator converts at the
 * boundary.
 */
import { database } from '../database';

export interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  icon_url: string | null;
  is_active: number;
  base_price_pln: number;
  price_net_pln: number | null;
  tax_rate_id: string | null;
  base_duration_minutes: number;
  processing_time_minutes: number;
  processing_start_after: number;
  buffer_before: number;
  buffer_after: number;
  display_order: number;
  category_id: string | null;
  updated_at: string | null;
}

export interface ServiceUpsertInput {
  id: string;
  name: string;
  description?: string | null;
  icon_url?: string | null;
  is_active?: number;
  base_price_pln: number;
  price_net_pln?: number | null;
  tax_rate_id?: string | null;
  base_duration_minutes: number;
  processing_time_minutes?: number;
  processing_start_after?: number;
  buffer_before?: number;
  buffer_after?: number;
  display_order?: number;
  category_id?: string | null;
  updated_at?: string | null;
}

export const serviceRepo = {
  upsert(row: ServiceUpsertInput): void {
    database.run(
      `INSERT INTO services (
        id, name, description, icon_url, is_active,
        base_price_pln, price_net_pln, tax_rate_id,
        base_duration_minutes, processing_time_minutes, processing_start_after,
        buffer_before, buffer_after,
        display_order, category_id, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name                    = excluded.name,
        description             = excluded.description,
        icon_url                = excluded.icon_url,
        is_active               = excluded.is_active,
        base_price_pln          = excluded.base_price_pln,
        price_net_pln           = excluded.price_net_pln,
        tax_rate_id             = excluded.tax_rate_id,
        base_duration_minutes   = excluded.base_duration_minutes,
        processing_time_minutes = excluded.processing_time_minutes,
        processing_start_after  = excluded.processing_start_after,
        buffer_before           = excluded.buffer_before,
        buffer_after            = excluded.buffer_after,
        display_order           = excluded.display_order,
        category_id             = excluded.category_id,
        updated_at              = excluded.updated_at
      WHERE excluded.updated_at IS NULL
         OR updated_at IS NULL
         OR excluded.updated_at >= updated_at`,
      [
        row.id,
        row.name,
        row.description ?? null,
        row.icon_url ?? null,
        row.is_active ?? 1,
        row.base_price_pln,
        row.price_net_pln ?? null,
        row.tax_rate_id ?? null,
        row.base_duration_minutes,
        row.processing_time_minutes ?? 0,
        row.processing_start_after ?? 0,
        row.buffer_before ?? 0,
        row.buffer_after ?? 0,
        row.display_order ?? 0,
        row.category_id ?? null,
        row.updated_at ?? null,
      ],
    );
  },

  softDelete(id: string): void {
    database.run('UPDATE services SET is_active = 0 WHERE id = ?', [id]);
  },

  getById(id: string): ServiceRow | null {
    return database.get<ServiceRow>('SELECT * FROM services WHERE id = ?', [id]) ?? null;
  },

  /** Active services only, ordered by display_order then name. */
  getAllActive(): ServiceRow[] {
    return database.all<ServiceRow>(
      `SELECT * FROM services WHERE is_active = 1
       ORDER BY display_order ASC, name ASC`,
    );
  },
};
