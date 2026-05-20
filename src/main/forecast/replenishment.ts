import type { ForecastRiskLevel, ReplenishmentPolicyDTO } from '../../shared/types';

export interface ReplenishmentInput {
  stockOnHand: number;
  avgDailyDemand: number;
  forecastUnits: number;
  retailPrice: number;
  policy: Pick<ReplenishmentPolicyDTO, 'leadTimeDays' | 'safetyStockDays' | 'minDisplayQty' | 'packSize' | 'maxStock'>;
}

export interface ReplenishmentResult {
  reorderPoint: number;
  targetStock: number;
  suggestedOrderQty: number;
  estimatedRetailValue: number;
  riskLevel: ForecastRiskLevel;
  reason: string;
}

function roundUpToPackSize(quantity: number, packSize: number): number {
  const safePackSize = Math.max(1, Math.round(packSize || 1));
  if (quantity <= 0) return 0;
  return Math.ceil(quantity / safePackSize) * safePackSize;
}

export function calculateReplenishment(input: ReplenishmentInput): ReplenishmentResult {
  const stockOnHand = Math.max(0, Math.round(input.stockOnHand || 0));
  const avgDailyDemand = Math.max(0, input.avgDailyDemand || 0);
  const forecastUnits = Math.max(0, input.forecastUnits || 0);
  const leadTimeDays = Math.max(0, Math.round(input.policy.leadTimeDays || 0));
  const safetyStockDays = Math.max(0, Math.round(input.policy.safetyStockDays || 0));
  const minDisplayQty = Math.max(0, Math.round(input.policy.minDisplayQty || 0));
  const maxStock = input.policy.maxStock == null ? null : Math.max(0, Math.round(input.policy.maxStock));
  const packSize = Math.max(1, Math.round(input.policy.packSize || 1));

  const leadTimeDemand = avgDailyDemand * leadTimeDays;
  const safetyStock = Math.max(minDisplayQty, avgDailyDemand * safetyStockDays);
  const reorderPoint = Math.ceil(leadTimeDemand + safetyStock);
  const targetStockRaw = Math.ceil(forecastUnits + leadTimeDemand + safetyStock);
  const targetStock = maxStock == null ? targetStockRaw : Math.min(targetStockRaw, maxStock);
  const shortage = Math.max(0, targetStock - stockOnHand);
  const roundedOrderQty = roundUpToPackSize(shortage, packSize);
  const suggestedOrderQty = maxStock == null
    ? roundedOrderQty
    : Math.min(roundedOrderQty, Math.max(0, maxStock - stockOnHand));
  const estimatedRetailValue = suggestedOrderQty * Math.max(0, Math.round(input.retailPrice || 0));

  let riskLevel: ForecastRiskLevel = 'ok';
  if (stockOnHand <= 0 && forecastUnits > 0) {
    riskLevel = 'stockout';
  } else if (suggestedOrderQty > 0) {
    riskLevel = 'reorder';
  } else if (stockOnHand <= reorderPoint && (forecastUnits > 0 || avgDailyDemand > 0)) {
    riskLevel = 'watch';
  }

  const reason = suggestedOrderQty > 0
    ? `Order ${suggestedOrderQty} to cover forecast, lead time, and safety stock.`
    : 'Current stock covers forecast, lead time, and safety stock.';

  return {
    reorderPoint,
    targetStock,
    suggestedOrderQty,
    estimatedRetailValue,
    riskLevel,
    reason,
  };
}

export const replenishmentMath = {
  roundUpToPackSize,
};
