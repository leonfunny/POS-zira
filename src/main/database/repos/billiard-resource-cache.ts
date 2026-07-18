export interface BilliardSqlRunner {
  run(sql: string, params?: any[]): unknown;
}

function resourceValues(resource: any): any[] {
  return [
    resource.id,
    resource.name || resource.resourceName || '',
    resource.code || null,
    resource.typeId || resource.type_id || resource.resourceTypeId || resource.resource_type_id
      || resource.resourceType?.id || resource.resource_type?.id || null,
    resource.typeName || resource.type_name || resource.resourceType?.code || resource.resource_type?.code
      || resource.resourceType?.name || resource.resource_type?.name || null,
    typeof resource.pricingRules === 'string'
      ? resource.pricingRules
      : JSON.stringify(resource.pricingRules || {}),
    JSON.stringify(resource),
    resource.isActive !== undefined ? (resource.isActive ? 1 : 0) : 1,
    resource.updatedAt || resource.updated_at || new Date().toISOString(),
  ];
}

/** Upsert without SQLite REPLACE, which would delete FK-referenced rows first. */
export function upsertBilliardResources(db: BilliardSqlRunner, resources: any[]): void {
  for (const resource of resources) {
    db.run(
      `INSERT INTO billiard_resources
        (id, name, code, type_id, type_name, pricing_rules, payload_json, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        code = excluded.code,
        type_id = excluded.type_id,
        type_name = excluded.type_name,
        pricing_rules = excluded.pricing_rules,
        payload_json = excluded.payload_json,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at`,
      resourceValues(resource),
    );
  }
}

/** Replace the authoritative pool-table set while respecting cached layout FKs. */
export function replaceBilliardResources(db: BilliardSqlRunner, resources: any[]): void {
  upsertBilliardResources(db, resources);

  const ids = resources
    .map((resource) => resource?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) {
    db.run('DELETE FROM billiard_table_layouts');
    db.run('DELETE FROM billiard_resources');
    return;
  }

  const placeholders = ids.map(() => '?').join(', ');
  db.run(
    `DELETE FROM billiard_table_layouts WHERE resource_id NOT IN (${placeholders})`,
    ids,
  );
  db.run(
    `DELETE FROM billiard_resources WHERE id NOT IN (${placeholders})`,
    ids,
  );
}
