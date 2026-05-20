import type {
  ForecastDailyPoint,
  ForecastOrderingResponse,
  ForecastRecommendationDTO,
  ForecastRunDTO,
  ForecastRiskLevel,
} from '../../../shared/types';
import { database } from '../database';

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapRun(row: any): ForecastRunDTO {
  return {
    id: String(row.id),
    generatedAt: String(row.generated_at),
    asOfDate: String(row.as_of_date),
    horizonDays: Number(row.horizon_days) || 1,
    historyDays: Number(row.history_days) || 90,
    itemCount: Number(row.item_count) || 0,
    totalSuggestedQty: Number(row.total_suggested_qty) || 0,
    totalEstimatedRetailValue: Number(row.total_estimated_retail_value) || 0,
    warnings: parseJsonArray<string>(row.warnings_json),
  };
}

function mapRecommendation(row: any): ForecastRecommendationDTO {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    variantId: String(row.variant_id),
    name: String(row.name),
    sku: row.sku ?? null,
    barcode: row.barcode ?? null,
    categoryId: row.category_id ?? null,
    categoryName: row.category_name ?? null,
    stockOnHand: Number(row.stock_on_hand) || 0,
    avgDailyDemand: Number(row.avg_daily_demand) || 0,
    velocity7d: Number(row.velocity_7d) || 0,
    velocity30d: Number(row.velocity_30d) || 0,
    forecastUnits: Number(row.forecast_units) || 0,
    forecastDaily: parseJsonArray<ForecastDailyPoint>(row.forecast_daily_json),
    leadTimeDays: Number(row.lead_time_days) || 0,
    safetyStockDays: Number(row.safety_stock_days) || 0,
    minDisplayQty: Number(row.min_display_qty) || 0,
    maxStock: row.max_stock == null ? null : Math.max(0, Math.round(Number(row.max_stock) || 0)),
    reorderPoint: Number(row.reorder_point) || 0,
    targetStock: Number(row.target_stock) || 0,
    suggestedOrderQty: Number(row.suggested_order_qty) || 0,
    packSize: Math.max(1, Number(row.pack_size) || 1),
    estimatedRetailValue: Number(row.estimated_retail_value) || 0,
    riskLevel: (row.risk_level || 'ok') as ForecastRiskLevel,
    confidence: Number(row.confidence) || 0,
    reason: String(row.reason || ''),
    warnings: parseJsonArray<string>(row.warnings_json),
    supplierName: row.supplier_name ?? null,
    updatedAt: String(row.updated_at || ''),
  };
}

export const forecastRunRepo = {
  save(response: ForecastOrderingResponse): void {
    database.transaction(() => {
      database.run(
        `INSERT INTO forecast_runs (
           id, generated_at, as_of_date, horizon_days, history_days, item_count,
           total_suggested_qty, total_estimated_retail_value, warnings_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          response.run.id,
          response.run.generatedAt,
          response.run.asOfDate,
          response.run.horizonDays,
          response.run.historyDays,
          response.run.itemCount,
          response.run.totalSuggestedQty,
          response.run.totalEstimatedRetailValue,
          JSON.stringify(response.run.warnings),
        ],
      );

      for (const rec of response.recommendations) {
        database.run(
          `INSERT INTO forecast_recommendations (
             id, run_id, variant_id, name, sku, barcode, category_id, category_name,
             stock_on_hand, avg_daily_demand, velocity_7d, velocity_30d, forecast_units, forecast_daily_json,
             lead_time_days, safety_stock_days, min_display_qty, max_stock, reorder_point, target_stock,
             suggested_order_qty, pack_size, estimated_retail_value, risk_level,
             confidence, reason, warnings_json, supplier_name, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            rec.id,
            rec.runId,
            rec.variantId,
            rec.name,
            rec.sku,
            rec.barcode,
            rec.categoryId,
            rec.categoryName,
            rec.stockOnHand,
            rec.avgDailyDemand,
            rec.velocity7d,
            rec.velocity30d,
            rec.forecastUnits,
            JSON.stringify(rec.forecastDaily),
            rec.leadTimeDays,
            rec.safetyStockDays,
            rec.minDisplayQty,
            rec.maxStock,
            rec.reorderPoint,
            rec.targetStock,
            rec.suggestedOrderQty,
            rec.packSize,
            rec.estimatedRetailValue,
            rec.riskLevel,
            rec.confidence,
            rec.reason,
            JSON.stringify(rec.warnings),
            rec.supplierName,
            rec.updatedAt,
          ],
        );
      }
    });
  },

  getLatest(): ForecastOrderingResponse | null {
    const runRow = database.get<any>(
      'SELECT * FROM forecast_runs ORDER BY generated_at DESC LIMIT 1',
    );
    if (!runRow) return null;
    const run = mapRun(runRow);
    const recommendations = database.all<any>(
      `SELECT * FROM forecast_recommendations
       WHERE run_id = ?
       ORDER BY suggested_order_qty DESC, forecast_units DESC, name ASC`,
      [run.id],
    ).map(mapRecommendation);
    return { run, recommendations };
  },
};
