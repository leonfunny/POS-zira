/**
 * ServiceRuleRepo — pricing tiers per service (short/long/gel/etc).
 * Populated from sync_log; POS uses these when composing a walk-in
 * booking so it can pass the correct rule_id + display price/duration.
 */
import { database } from '../database';

export interface ServiceRuleRow {
  id: string;
  service_id: string;
  size_category: string | null;
  duration_min: number;
  base_price_pln: number;
  deposit_pln: number;
  name: string | null;
  updated_at: string | null;
}

export interface ServiceRuleUpsertInput {
  id: string;
  service_id: string;
  size_category?: string | null;
  duration_min: number;
  base_price_pln: number;
  deposit_pln?: number;
  name?: string | null;
  updated_at?: string | null;
}

export const serviceRuleRepo = {
  upsert(row: ServiceRuleUpsertInput): void {
    database.run(
      `INSERT INTO service_rules (
        id, service_id, size_category, duration_min,
        base_price_pln, deposit_pln, name, updated_at
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        service_id     = excluded.service_id,
        size_category  = excluded.size_category,
        duration_min   = excluded.duration_min,
        base_price_pln = excluded.base_price_pln,
        deposit_pln    = excluded.deposit_pln,
        name           = excluded.name,
        updated_at     = excluded.updated_at
      WHERE excluded.updated_at IS NULL
         OR updated_at IS NULL
         OR excluded.updated_at >= updated_at`,
      [
        row.id,
        row.service_id,
        row.size_category ?? null,
        row.duration_min,
        row.base_price_pln,
        row.deposit_pln ?? 0,
        row.name ?? null,
        row.updated_at ?? null,
      ],
    );
  },

  delete(id: string): void {
    database.run('DELETE FROM service_rules WHERE id = ?', [id]);
  },

  getById(id: string): ServiceRuleRow | null {
    return database.get<ServiceRuleRow>(
      'SELECT * FROM service_rules WHERE id = ?',
      [id],
    ) ?? null;
  },

  getByService(serviceId: string): ServiceRuleRow[] {
    return database.all<ServiceRuleRow>(
      `SELECT * FROM service_rules WHERE service_id = ?
       ORDER BY duration_min ASC`,
      [serviceId],
    );
  },
};
