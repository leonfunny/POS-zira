import type {
  FabricTagArtwork,
  FabricTagArtworkSourceType,
  FabricTagArtworkStatus,
} from '../../../shared/types';
import { database } from '../database';

export interface FabricTagArtworkRow {
  id: string;
  salon_id: string;
  customer_name: string;
  order_code: string | null;
  variant: string;
  revision: string;
  original_filename: string;
  source_type: FabricTagArtworkSourceType;
  status: FabricTagArtworkStatus;
  source_sha256: string;
  source_path: string;
  production_filename: string | null;
  production_sha256: string | null;
  production_path: string | null;
  width_px: number | null;
  height_px: number | null;
  physical_width_mm: number | null;
  physical_length_mm: number | null;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}

export interface InsertFabricTagArtworkInput {
  id: string;
  salonId: string;
  customerName: string;
  orderCode: string | null;
  variant: string;
  revision: string;
  originalFilename: string;
  sourceType: FabricTagArtworkSourceType;
  status: FabricTagArtworkStatus;
  sourceSha256: string;
  sourcePath: string;
  productionFilename: string | null;
  productionSha256: string | null;
  productionPath: string | null;
  widthPx: number | null;
  heightPx: number | null;
  physicalWidthMm: number | null;
  physicalLengthMm: number | null;
  now: string;
}

export interface AttachFabricTagProductionInput {
  productionFilename: string;
  productionSha256: string;
  productionPath: string;
  widthPx: number;
  heightPx: number;
  physicalWidthMm: number;
  physicalLengthMm: number;
  now: string;
}

export function toFabricTagArtwork(row: FabricTagArtworkRow): FabricTagArtwork {
  return {
    id: row.id,
    salonId: row.salon_id,
    customerName: row.customer_name,
    orderCode: row.order_code,
    variant: row.variant,
    revision: row.revision,
    originalFilename: row.original_filename,
    sourceType: row.source_type,
    status: row.status,
    sourceSha256: row.source_sha256,
    productionFilename: row.production_filename,
    productionSha256: row.production_sha256,
    widthPx: row.width_px == null ? null : Number(row.width_px),
    heightPx: row.height_px == null ? null : Number(row.height_px),
    physicalWidthMm: row.physical_width_mm == null ? null : Number(row.physical_width_mm),
    physicalLengthMm: row.physical_length_mm == null ? null : Number(row.physical_length_mm),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at,
  };
}

export const fabricTagArtworkRepo = {
  insert(input: InsertFabricTagArtworkInput): FabricTagArtwork {
    database.run(
      `INSERT INTO fabric_tag_artworks (
         id, salon_id, customer_name, order_code, variant, revision,
         original_filename, source_type, status, source_sha256, source_path,
         production_filename, production_sha256, production_path,
         width_px, height_px, physical_width_mm, physical_length_mm,
         created_at, updated_at, retired_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        input.id,
        input.salonId,
        input.customerName,
        input.orderCode,
        input.variant,
        input.revision,
        input.originalFilename,
        input.sourceType,
        input.status,
        input.sourceSha256,
        input.sourcePath,
        input.productionFilename,
        input.productionSha256,
        input.productionPath,
        input.widthPx,
        input.heightPx,
        input.physicalWidthMm,
        input.physicalLengthMm,
        input.now,
        input.now,
      ],
    );
    const row = this.getRow(input.salonId, input.id);
    if (!row) throw new Error('Fabric artwork insert did not produce a row');
    return toFabricTagArtwork(row);
  },

  getRow(salonId: string, assetId: string): FabricTagArtworkRow | null {
    return database.get<FabricTagArtworkRow>(
      'SELECT * FROM fabric_tag_artworks WHERE salon_id = ? AND id = ?',
      [salonId, assetId],
    );
  },

  get(salonId: string, assetId: string): FabricTagArtwork | null {
    const row = this.getRow(salonId, assetId);
    return row ? toFabricTagArtwork(row) : null;
  },

  list(salonId: string, includeRetired = false): FabricTagArtwork[] {
    const rows = database.all<FabricTagArtworkRow>(
      `SELECT * FROM fabric_tag_artworks
       WHERE salon_id = ?${includeRetired ? '' : " AND status <> 'RETIRED'"}
       ORDER BY updated_at DESC, customer_name COLLATE NOCASE, variant COLLATE NOCASE`,
      [salonId],
    );
    return rows.map(toFabricTagArtwork);
  },

  attachProduction(
    salonId: string,
    assetId: string,
    input: AttachFabricTagProductionInput,
  ): FabricTagArtwork | null {
    database.run(
      `UPDATE fabric_tag_artworks
       SET status = 'READY',
           production_filename = ?, production_sha256 = ?, production_path = ?,
           width_px = ?, height_px = ?, physical_width_mm = ?, physical_length_mm = ?,
           updated_at = ?, retired_at = NULL
       WHERE salon_id = ? AND id = ?
         AND source_type = 'BTW'
         AND status = 'NEEDS_CONVERSION'
         AND production_filename IS NULL
         AND production_sha256 IS NULL
         AND production_path IS NULL
         AND width_px IS NULL
         AND height_px IS NULL
         AND physical_width_mm IS NULL
         AND physical_length_mm IS NULL`,
      [
        input.productionFilename,
        input.productionSha256,
        input.productionPath,
        input.widthPx,
        input.heightPx,
        input.physicalWidthMm,
        input.physicalLengthMm,
        input.now,
        salonId,
        assetId,
      ],
    );
    const changed = database.get<{ count: number }>('SELECT changes() AS count')?.count ?? 0;
    if (changed !== 1) return null;
    return this.get(salonId, assetId);
  },

  retire(salonId: string, assetId: string, now: string): FabricTagArtwork | null {
    database.run(
      `UPDATE fabric_tag_artworks
       SET status = 'RETIRED', retired_at = ?, updated_at = ?
       WHERE salon_id = ? AND id = ?`,
      [now, now, salonId, assetId],
    );
    return this.get(salonId, assetId);
  },
};
