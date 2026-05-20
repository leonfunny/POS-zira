import { describe, expect, it } from 'vitest';
import { buildDailyForecast, type SalesHistoryPoint } from '../src/main/forecast/forecast-engine';
import { addDays } from '../src/main/forecast/date-utils';

function constantHistory(startDate: string, days: number, units: number): SalesHistoryPoint[] {
  return Array.from({ length: days }, (_, index) => ({
    date: addDays(startDate, index),
    units,
  }));
}

describe('forecast engine', () => {
  it('projects deterministic demand for the requested horizon', () => {
    const result = buildDailyForecast(constantHistory('2026-04-21', 30, 2), {
      asOfDate: '2026-05-20',
      historyStartDate: '2026-04-21',
      horizonDays: 3,
    });

    expect(result.forecastDaily).toHaveLength(3);
    expect(result.forecastUnits).toBe(6);
    expect(result.avgDailyDemand).toBe(2);
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('uses category fallback for sparse item sales', () => {
    const result = buildDailyForecast([{ date: '2026-05-19', units: 1 }], {
      asOfDate: '2026-05-20',
      historyStartDate: '2026-04-21',
      horizonDays: 2,
      categoryFallbackDailyDemand: 4,
    });

    expect(result.forecastUnits).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.includes('Sparse'))).toBe(true);
    expect(result.confidence).toBeLessThan(0.7);
  });

  it('lowers confidence when stockouts are present', () => {
    const clean = buildDailyForecast(constantHistory('2026-04-21', 30, 2), {
      asOfDate: '2026-05-20',
      historyStartDate: '2026-04-21',
      horizonDays: 1,
    });
    const stockoutHistory = constantHistory('2026-04-21', 30, 2).map((point, index) => ({
      ...point,
      stockout: index > 24,
    }));
    const withStockouts = buildDailyForecast(stockoutHistory, {
      asOfDate: '2026-05-20',
      historyStartDate: '2026-04-21',
      horizonDays: 1,
    });

    expect(withStockouts.confidence).toBeLessThan(clean.confidence);
    expect(withStockouts.warnings.some((warning) => warning.includes('stockout'))).toBe(true);
  });
});
