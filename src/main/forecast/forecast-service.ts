import { randomUUID } from 'crypto';
import type {
  ForecastOrderingResponse,
  ForecastOrderDraftCreateInput,
  ForecastOrderDraftDTO,
  ForecastRecommendationDTO,
  ForecastRunOptions,
  ForecastRunDTO,
  ReplenishmentPolicyDTO,
  TodaySalesReportDTO,
} from '../../shared/types';
import { forecastRunRepo } from '../database/repos/forecast-run-repo';
import { forecastOrderDraftRepo } from '../database/repos/forecast-order-draft-repo';
import { replenishmentPolicyRepo, type ReplenishmentPolicyInput } from '../database/repos/replenishment-policy-repo';
import { salesForecastRepo, type ForecastProductSnapshot, type ForecastSalesRow } from '../database/repos/sales-forecast-repo';
import { addDays, clampInteger, todayDateOnly } from './date-utils';
import { buildDailyForecast, type SalesHistoryPoint } from './forecast-engine';
import { calculateReplenishment } from './replenishment';

interface NormalizedOptions {
  asOfDate: string;
  horizonDays: number;
  historyDays: number;
  historyStartDate: string;
  categoryId?: string;
}

function normalizeOptions(options: ForecastRunOptions = {}): NormalizedOptions {
  const asOfDate = options.asOfDate?.trim() || todayDateOnly();
  const horizonDays = clampInteger(options.horizonDays, 1, 14, 3);
  const historyDays = clampInteger(options.historyDays, 14, 365, 90);
  return {
    asOfDate,
    horizonDays,
    historyDays,
    historyStartDate: addDays(asOfDate, -(historyDays - 1)),
    categoryId: options.categoryId?.trim() || undefined,
  };
}

function groupSalesByVariant(rows: ForecastSalesRow[]): Map<string, SalesHistoryPoint[]> {
  const grouped = new Map<string, SalesHistoryPoint[]>();
  for (const row of rows) {
    const list = grouped.get(row.variant_id) ?? [];
    list.push({ date: row.sale_date, units: Number(row.units) || 0 });
    grouped.set(row.variant_id, list);
  }
  return grouped;
}

function categoryFallbacks(
  rows: ForecastSalesRow[],
  products: ForecastProductSnapshot[],
  historyDays: number,
): Map<string, number> {
  const productCategory = new Map(products.map((product) => [product.variantId, product.categoryId ?? 'uncategorized']));
  const totals = new Map<string, number>();
  const soldVariants = new Map<string, Set<string>>();

  for (const row of rows) {
    const categoryId = productCategory.get(row.variant_id);
    if (!categoryId) continue;
    totals.set(categoryId, (totals.get(categoryId) ?? 0) + (Number(row.units) || 0));
    const set = soldVariants.get(categoryId) ?? new Set<string>();
    set.add(row.variant_id);
    soldVariants.set(categoryId, set);
  }

  const fallback = new Map<string, number>();
  for (const [categoryId, totalUnits] of totals) {
    const itemCount = Math.max(1, soldVariants.get(categoryId)?.size ?? 1);
    fallback.set(categoryId, totalUnits / Math.max(1, historyDays) / itemCount);
  }
  return fallback;
}

function riskRank(risk: string): number {
  switch (risk) {
    case 'stockout': return 0;
    case 'reorder': return 1;
    case 'watch': return 2;
    default: return 3;
  }
}

function mergeWarnings(recommendations: ForecastRecommendationDTO[]): string[] {
  const warnings = new Set<string>();
  for (const rec of recommendations) {
    for (const warning of rec.warnings) warnings.add(warning);
  }
  return Array.from(warnings);
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildVelocityMap(rows: ForecastSalesRow[], asOfDate: string, days: number): Map<string, number> {
  const startDate = addDays(asOfDate, -(days - 1));
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.sale_date < startDate || row.sale_date > asOfDate) continue;
    totals.set(row.variant_id, (totals.get(row.variant_id) ?? 0) + (Number(row.units) || 0));
  }
  return new Map(Array.from(totals.entries()).map(([variantId, units]) => [variantId, round2(units / days)]));
}

function buildItemVelocityMap(
  rows: Array<{ itemKey: string; saleDate: string; units: number }>,
  asOfDate: string,
  days: number,
): Map<string, number> {
  const startDate = addDays(asOfDate, -(days - 1));
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.saleDate < startDate || row.saleDate > asOfDate) continue;
    totals.set(row.itemKey, (totals.get(row.itemKey) ?? 0) + (Number(row.units) || 0));
  }
  return new Map(Array.from(totals.entries()).map(([itemKey, units]) => [itemKey, round2(units / days)]));
}

export class ForecastService {
  getRecommendations(options?: ForecastRunOptions): ForecastOrderingResponse {
    const normalized = normalizeOptions(options);
    const latest = forecastRunRepo.getLatest();
    if (
      !normalized.categoryId
      && latest
      && latest.run.asOfDate === normalized.asOfDate
      && latest.run.horizonDays === normalized.horizonDays
      && latest.run.historyDays === normalized.historyDays
    ) {
      return latest;
    }
    return this.recompute(options);
  }

  recompute(options?: ForecastRunOptions): ForecastOrderingResponse {
    const normalized = normalizeOptions(options);
    const products = salesForecastRepo.getProductSnapshots(normalized.categoryId);
    const sales = salesForecastRepo.getDailySales(
      normalized.historyStartDate,
      normalized.asOfDate,
      normalized.categoryId,
    );
    const groupedSales = groupSalesByVariant(sales);
    const velocity7d = buildVelocityMap(sales, normalized.asOfDate, 7);
    const velocity30d = buildVelocityMap(sales, normalized.asOfDate, 30);
    const policies = replenishmentPolicyRepo.getByVariantIds(products.map((product) => product.variantId));
    const fallbackByCategory = categoryFallbacks(sales, products, normalized.historyDays);
    const runId = randomUUID();
    const generatedAt = new Date().toISOString();

    const recommendations = products.map((product) => {
      const policy = policies.get(product.variantId) ?? replenishmentPolicyRepo.getDefault(product.variantId);
      const categoryKey = product.categoryId ?? 'uncategorized';
      const forecast = buildDailyForecast(groupedSales.get(product.variantId) ?? [], {
        asOfDate: normalized.asOfDate,
        historyStartDate: normalized.historyStartDate,
        horizonDays: normalized.horizonDays,
        categoryFallbackDailyDemand: fallbackByCategory.get(categoryKey) ?? 0,
      });
      const effectiveDailyDemand = Math.max(
        forecast.avgDailyDemand,
        forecast.forecastUnits / Math.max(1, normalized.horizonDays),
      );
      const replenishment = calculateReplenishment({
        stockOnHand: product.stockOnHand,
        avgDailyDemand: effectiveDailyDemand,
        forecastUnits: forecast.forecastUnits,
        retailPrice: product.retailPrice,
        policy,
      });

      return {
        id: randomUUID(),
        runId,
        variantId: product.variantId,
        name: product.name,
        sku: product.sku,
        barcode: product.barcode,
        categoryId: product.categoryId,
        categoryName: product.categoryName,
        stockOnHand: product.stockOnHand,
        avgDailyDemand: forecast.avgDailyDemand,
        velocity7d: velocity7d.get(product.variantId) ?? 0,
        velocity30d: velocity30d.get(product.variantId) ?? 0,
        forecastUnits: forecast.forecastUnits,
        forecastDaily: forecast.forecastDaily,
        leadTimeDays: policy.leadTimeDays,
        safetyStockDays: policy.safetyStockDays,
        minDisplayQty: policy.minDisplayQty,
        maxStock: policy.maxStock,
        reorderPoint: replenishment.reorderPoint,
        targetStock: replenishment.targetStock,
        suggestedOrderQty: replenishment.suggestedOrderQty,
        packSize: policy.packSize,
        estimatedRetailValue: replenishment.estimatedRetailValue,
        riskLevel: replenishment.riskLevel,
        confidence: forecast.confidence,
        reason: replenishment.reason,
        warnings: forecast.warnings,
        supplierName: policy.supplierName,
        updatedAt: generatedAt,
      } satisfies ForecastRecommendationDTO;
    }).sort((a, b) => {
      const riskDiff = riskRank(a.riskLevel) - riskRank(b.riskLevel);
      if (riskDiff !== 0) return riskDiff;
      if (b.suggestedOrderQty !== a.suggestedOrderQty) return b.suggestedOrderQty - a.suggestedOrderQty;
      return a.name.localeCompare(b.name);
    });

    const run: ForecastRunDTO = {
      id: runId,
      generatedAt,
      asOfDate: normalized.asOfDate,
      horizonDays: normalized.horizonDays,
      historyDays: normalized.historyDays,
      itemCount: recommendations.length,
      totalSuggestedQty: recommendations.reduce((sum, rec) => sum + rec.suggestedOrderQty, 0),
      totalEstimatedRetailValue: recommendations.reduce((sum, rec) => sum + rec.estimatedRetailValue, 0),
      warnings: recommendations.length === 0
        ? ['No active products found in the local POS catalog.']
        : mergeWarnings(recommendations),
    };

    const response = { run, recommendations };
    forecastRunRepo.save(response);
    return response;
  }

  getPolicies(variantIds?: string[]): ReplenishmentPolicyDTO[] {
    if (!variantIds || variantIds.length === 0) {
      return replenishmentPolicyRepo.getAll();
    }
    const policies = replenishmentPolicyRepo.getByVariantIds(variantIds);
    return variantIds.map((variantId) => policies.get(variantId) ?? replenishmentPolicyRepo.getDefault(variantId));
  }

  savePolicy(input: ReplenishmentPolicyInput): ReplenishmentPolicyDTO {
    if (!input.variantId?.trim()) {
      throw new Error('variantId is required');
    }
    return replenishmentPolicyRepo.upsert(input);
  }

  getTodaySales(date = todayDateOnly()): TodaySalesReportDTO {
    const salesRows = salesForecastRepo.getItemSalesSummary(date, date);
    const velocityRows = salesForecastRepo.getDailyItemSales(addDays(date, -29), date);
    const velocity7d = buildItemVelocityMap(velocityRows, date, 7);
    const velocity30d = buildItemVelocityMap(velocityRows, date, 30);
    const items = salesRows.map((row) => ({
      variantId: row.variantId,
      name: row.name,
      sku: row.sku,
      barcode: row.barcode,
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      quantity: row.quantity,
      revenue: row.revenue,
      orderCount: row.orderCount,
      avgUnitPrice: row.avgUnitPrice,
      stockOnHand: row.stockOnHand,
      velocity7d: velocity7d.get(row.variantId) ?? 0,
      velocity30d: velocity30d.get(row.variantId) ?? 0,
      lastSoldAt: row.lastSoldAt,
    }));

    return {
      date,
      itemCount: items.length,
      totalUnits: round2(items.reduce((sum, item) => sum + item.quantity, 0)),
      totalRevenue: items.reduce((sum, item) => sum + item.revenue, 0),
      totalOrders: salesForecastRepo.getOrderCount(date, date),
      items,
    };
  }

  createOrderDraft(input: ForecastOrderDraftCreateInput): ForecastOrderDraftDTO {
    if (!input.asOfDate?.trim()) {
      throw new Error('asOfDate is required');
    }
    return forecastOrderDraftRepo.create(input);
  }

  listOrderDrafts(limit?: number): ForecastOrderDraftDTO[] {
    return forecastOrderDraftRepo.listRecent(limit);
  }

  getOrderDraft(id: string): ForecastOrderDraftDTO | null {
    if (!id?.trim()) return null;
    return forecastOrderDraftRepo.getById(id);
  }

  exportCsv(recommendations: ForecastRecommendationDTO[]): string {
    const header = [
      'sku',
      'barcode',
      'name',
      'category',
      'stock_on_hand',
      'velocity_7d_units_per_day',
      'velocity_30d_units_per_day',
      'forecast_units',
      'reorder_point',
      'target_stock',
      'suggested_order_qty',
      'pack_size',
      'supplier',
      'risk',
      'confidence',
    ];
    const rows = recommendations.map((rec) => [
      rec.sku ?? '',
      rec.barcode ?? '',
      rec.name,
      rec.categoryName ?? '',
      rec.stockOnHand,
      rec.velocity7d,
      rec.velocity30d,
      rec.forecastUnits,
      rec.reorderPoint,
      rec.targetStock,
      rec.suggestedOrderQty,
      rec.packSize,
      rec.supplierName ?? '',
      rec.riskLevel,
      rec.confidence,
    ]);
    return [header, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
  }
}
