import { database } from '../database';

export interface BilliardFloorPlanRow {
  id: string;
  name: string;
  floor_number: number;
  room_width_m: number | null;
  room_height_m: number | null;
  background_image: string | null;
  updated_at: string | null;
}

export interface BilliardTableLayoutRow {
  id: string;
  resource_id: string;
  floor_plan_id: string | null;
  position_x: number;
  position_y: number;
  rotation: number;
  width_pct: number;
  height_pct: number;
  shape: string;
  asset_key: string | null;
  updated_at: string | null;
}

export const billiardFloorPlanRepo = {
  getAll(): BilliardFloorPlanRow[] {
    return database.all<BilliardFloorPlanRow>(
      'SELECT * FROM billiard_floor_plans ORDER BY floor_number',
    );
  },

  getLayouts(floorPlanId?: string): BilliardTableLayoutRow[] {
    if (floorPlanId) {
      return database.all<BilliardTableLayoutRow>(
        'SELECT * FROM billiard_table_layouts WHERE floor_plan_id = ?',
        [floorPlanId],
      );
    }
    return database.all<BilliardTableLayoutRow>(
      'SELECT * FROM billiard_table_layouts',
    );
  },

  upsertMany(plans: any[]): void {
    for (const p of plans) {
      database.run(
        `INSERT INTO billiard_floor_plans
          (id, name, floor_number, room_width_m, room_height_m, background_image, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          floor_number = excluded.floor_number,
          room_width_m = excluded.room_width_m,
          room_height_m = excluded.room_height_m,
          background_image = excluded.background_image,
          updated_at = excluded.updated_at`,
        [
          p.id,
          p.name || '',
          p.floorNumber ?? p.floor_number ?? 0,
          p.roomWidthM ?? p.room_width_m ?? null,
          p.roomHeightM ?? p.room_height_m ?? null,
          p.backgroundImage ?? p.background_image ?? null,
          p.updatedAt || p.updated_at || new Date().toISOString(),
        ],
      );
    }
  },

  syncSnapshot(plans: any[]): void {
    this.upsertMany(plans);

    const ids = Array.from(
      new Set(
        plans
          .map((plan) => plan.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );
    if (ids.length === 0) {
      database.run('UPDATE billiard_table_layouts SET floor_plan_id = NULL');
      database.run('DELETE FROM billiard_floor_plans');
      return;
    }

    const placeholders = ids.map(() => '?').join(', ');
    database.run(
      `UPDATE billiard_table_layouts
       SET floor_plan_id = NULL
       WHERE floor_plan_id NOT IN (${placeholders})`,
      ids,
    );
    database.run(
      `DELETE FROM billiard_floor_plans
       WHERE id NOT IN (${placeholders})`,
      ids,
    );
  },

  upsertLayouts(layouts: any[]): void {
    for (const l of layouts) {
      const resourceId = l.resourceId || l.resource_id;
      const floorPlanId = l.floorPlanId || l.floor_plan_id || null;
      if (!resourceId || !database.get(
        'SELECT id FROM billiard_resources WHERE id = ?',
        [resourceId],
      )) {
        continue;
      }
      if (floorPlanId && !database.get(
        'SELECT id FROM billiard_floor_plans WHERE id = ?',
        [floorPlanId],
      )) {
        continue;
      }
      database.run(
        `INSERT INTO billiard_table_layouts
          (id, resource_id, floor_plan_id, position_x, position_y, rotation, width_pct, height_pct, shape, asset_key, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          resource_id = excluded.resource_id,
          floor_plan_id = excluded.floor_plan_id,
          position_x = excluded.position_x,
          position_y = excluded.position_y,
          rotation = excluded.rotation,
          width_pct = excluded.width_pct,
          height_pct = excluded.height_pct,
          shape = excluded.shape,
          asset_key = excluded.asset_key,
          updated_at = excluded.updated_at`,
        [
          l.id,
          resourceId,
          floorPlanId,
          l.positionX ?? l.position_x ?? 50,
          l.positionY ?? l.position_y ?? 50,
          l.rotation ?? 0,
          l.widthPct ?? l.width_pct ?? 10,
          l.heightPct ?? l.height_pct ?? 10,
          l.shape || 'rectangle',
          l.assetKey || l.asset_key || null,
          l.updatedAt || l.updated_at || new Date().toISOString(),
        ],
      );
    }
  },

  clear(): void {
    database.run('DELETE FROM billiard_table_layouts');
    database.run('DELETE FROM billiard_floor_plans');
  },
};
