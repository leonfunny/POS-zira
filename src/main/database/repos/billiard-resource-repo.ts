import { database } from '../database';

export interface BilliardResourceRow {
  id: string;
  name: string;
  code: string | null;
  type_id: string | null;
  type_name: string | null;
  pricing_rules: string; // JSON array
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
    for (const r of resources) {
      database.run(
        `INSERT OR REPLACE INTO billiard_resources
          (id, name, code, type_id, type_name, pricing_rules, is_active, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.id,
          r.name || r.resourceName || '',
          r.code || null,
          r.typeId || r.type_id || null,
          r.typeName || r.type_name || null,
          typeof r.pricingRules === 'string' ? r.pricingRules : JSON.stringify(r.pricingRules || []),
          r.isActive !== undefined ? (r.isActive ? 1 : 0) : 1,
          r.updatedAt || r.updated_at || new Date().toISOString(),
        ],
      );
    }
  },

  clear(): void {
    database.run('DELETE FROM billiard_resources');
  },
};
