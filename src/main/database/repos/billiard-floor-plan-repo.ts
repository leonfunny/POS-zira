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
        `INSERT OR REPLACE INTO billiard_floor_plans
          (id, name, floor_number, room_width_m, room_height_m, background_image, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
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

  upsertLayouts(layouts: any[]): void {
    for (const l of layouts) {
      database.run(
        `INSERT OR REPLACE INTO billiard_table_layouts
          (id, resource_id, floor_plan_id, position_x, position_y, rotation, width_pct, height_pct, shape, asset_key, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          l.id,
          l.resourceId || l.resource_id,
          l.floorPlanId || l.floor_plan_id || null,
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
