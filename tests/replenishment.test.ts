import { describe, expect, it } from 'vitest';
import { calculateReplenishment, replenishmentMath } from '../src/main/forecast/replenishment';

describe('replenishment math', () => {
  it('rounds suggested orders up to pack size', () => {
    const result = calculateReplenishment({
      stockOnHand: 2,
      avgDailyDemand: 3,
      forecastUnits: 9,
      retailPrice: 500,
      policy: {
        leadTimeDays: 1,
        safetyStockDays: 1,
        minDisplayQty: 5,
        packSize: 6,
        maxStock: null,
      },
    });

    expect(result.reorderPoint).toBe(8);
    expect(result.targetStock).toBe(17);
    expect(result.suggestedOrderQty).toBe(18);
    expect(result.estimatedRetailValue).toBe(9000);
    expect(result.riskLevel).toBe('reorder');
  });

  it('treats zero stock with forecast demand as stockout risk', () => {
    const result = calculateReplenishment({
      stockOnHand: 0,
      avgDailyDemand: 1,
      forecastUnits: 3,
      retailPrice: 1000,
      policy: {
        leadTimeDays: 1,
        safetyStockDays: 1,
        minDisplayQty: 0,
        packSize: 1,
        maxStock: null,
      },
    });

    expect(result.riskLevel).toBe('stockout');
    expect(result.suggestedOrderQty).toBeGreaterThan(0);
  });

  it('respects hard max stock caps', () => {
    const result = calculateReplenishment({
      stockOnHand: 8,
      avgDailyDemand: 2,
      forecastUnits: 10,
      retailPrice: 100,
      policy: {
        leadTimeDays: 1,
        safetyStockDays: 1,
        minDisplayQty: 0,
        packSize: 5,
        maxStock: 10,
      },
    });

    expect(result.targetStock).toBe(10);
    expect(result.suggestedOrderQty).toBe(2);
  });

  it('exposes pack rounding for edge cases', () => {
    expect(replenishmentMath.roundUpToPackSize(0, 12)).toBe(0);
    expect(replenishmentMath.roundUpToPackSize(1, 12)).toBe(12);
    expect(replenishmentMath.roundUpToPackSize(24, 12)).toBe(24);
  });
});
