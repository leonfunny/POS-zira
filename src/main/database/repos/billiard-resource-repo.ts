import { database } from '../database';
import {
  replaceBilliardResources,
  upsertBilliardResources,
} from './billiard-resource-cache';

export interface BilliardResourceRow {
  id: string;
  name: string;
  code: string | null;
  type_id: string | null;
  type_name: string | null;
  pricing_rules: string; // JSON object
  payload_json: string | null;
  is_active: number;
  updated_at: string | null;
}

export const billiardResourceRepo = {
  getAll(): BilliardResourceRow[] {
    return database.all<BilliardResourceRow>(
      'SELECT * FROM billiard_resources WHERE is_active = 1 ORDER BY name',
    );
  },

  getById(id: string): BilliardResourceRow | null {
    return database.get<BilliardResourceRow>(
      'SELECT * FROM billiard_resources WHERE id = ?',
      [id],
    );
  },

  upsertMany(resources: any[]): void {
    upsertBilliardResources(database, resources);
  },

  /** Replace the active pool-table cache with the authoritative dashboard set. */
  replaceAll(resources: any[]): void {
    replaceBilliardResources(database, resources);
  },

  clear(): void {
    database.run('DELETE FROM billiard_resources');
  },
};
