import type { ReplenishmentPolicyDTO } from '../../../shared/types';
import { database } from '../database';

export type ReplenishmentPolicyInput = Partial<Omit<ReplenishmentPolicyDTO, 'updatedAt'>> & {
  variantId: string;
};

const DEFAULT_POLICY: Omit<ReplenishmentPolicyDTO, 'variantId' | 'updatedAt'> = {
  leadTimeDays: 1,
  safetyStockDays: 1,
  minDisplayQty: 0,
  packSize: 1,
  maxStock: null,
  supplierName: null,
};

function sanitizePolicy(input: ReplenishmentPolicyInput): ReplenishmentPolicyDTO {
  return {
    variantId: input.variantId.trim(),
    leadTimeDays: Math.max(0, Math.round(Number(input.leadTimeDays ?? DEFAULT_POLICY.leadTimeDays) || 0)),
    safetyStockDays: Math.max(0, Math.round(Number(input.safetyStockDays ?? DEFAULT_POLICY.safetyStockDays) || 0)),
    minDisplayQty: Math.max(0, Math.round(Number(input.minDisplayQty ?? DEFAULT_POLICY.minDisplayQty) || 0)),
    packSize: Math.max(1, Math.round(Number(input.packSize ?? DEFAULT_POLICY.packSize) || 1)),
    maxStock: input.maxStock == null ? null : Math.max(0, Math.round(Number(input.maxStock) || 0)),
    supplierName: input.supplierName?.trim() || null,
    updatedAt: new Date().toISOString(),
  };
}

function intOrDefault(value: unknown, fallback: number): number {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapRow(row: any): ReplenishmentPolicyDTO {
  return {
    variantId: String(row.variant_id),
    leadTimeDays: Math.max(0, intOrDefault(row.lead_time_days, DEFAULT_POLICY.leadTimeDays)),
    safetyStockDays: Math.max(0, intOrDefault(row.safety_stock_days, DEFAULT_POLICY.safetyStockDays)),
    minDisplayQty: Math.max(0, intOrDefault(row.min_display_qty, DEFAULT_POLICY.minDisplayQty)),
    packSize: Math.max(1, intOrDefault(row.pack_size, DEFAULT_POLICY.packSize)),
    maxStock: row.max_stock == null ? null : Math.max(0, Math.round(Number(row.max_stock) || 0)),
    supplierName: row.supplier_name ?? null,
    updatedAt: String(row.updated_at || ''),
  };
}

export const replenishmentPolicyRepo = {
  getDefault(variantId: string): ReplenishmentPolicyDTO {
    return {
      variantId,
      ...DEFAULT_POLICY,
      updatedAt: new Date(0).toISOString(),
    };
  },

  getByVariantIds(variantIds: string[]): Map<string, ReplenishmentPolicyDTO> {
    if (variantIds.length === 0) return new Map();
    const placeholders = variantIds.map(() => '?').join(',');
    const rows = database.all<any>(
      `SELECT * FROM replenishment_policies WHERE variant_id IN (${placeholders})`,
      variantIds,
    );
    return new Map(rows.map((row) => [String(row.variant_id), mapRow(row)]));
  },

  getAll(): ReplenishmentPolicyDTO[] {
    return database.all<any>('SELECT * FROM replenishment_policies ORDER BY updated_at DESC').map(mapRow);
  },

  upsert(input: ReplenishmentPolicyInput): ReplenishmentPolicyDTO {
    const policy = sanitizePolicy(input);
    database.run(
      `INSERT INTO replenishment_policies (
         variant_id, lead_time_days, safety_stock_days, min_display_qty, pack_size, max_stock, supplier_name, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(variant_id) DO UPDATE SET
         lead_time_days = excluded.lead_time_days,
         safety_stock_days = excluded.safety_stock_days,
         min_display_qty = excluded.min_display_qty,
         pack_size = excluded.pack_size,
         max_stock = excluded.max_stock,
         supplier_name = excluded.supplier_name,
         updated_at = excluded.updated_at`,
      [
        policy.variantId,
        policy.leadTimeDays,
        policy.safetyStockDays,
        policy.minDisplayQty,
        policy.packSize,
        policy.maxStock,
        policy.supplierName,
        policy.updatedAt,
      ],
    );
    return policy;
  },
};
