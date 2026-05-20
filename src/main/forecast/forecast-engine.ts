import type { ForecastDailyPoint } from '../../shared/types';
import { addDays, dayOfWeek, daysBetweenInclusive } from './date-utils';

export interface SalesHistoryPoint {
  date: string;
  units: number;
  stockout?: boolean;
}

export interface ForecastEngineOptions {
  asOfDate: string;
  historyStartDate: string;
  horizonDays: number;
  categoryFallbackDailyDemand?: number;
}

export interface ForecastEngineResult {
  avgDailyDemand: number;
  forecastUnits: number;
  forecastDaily: ForecastDailyPoint[];
  confidence: number;
  warnings: string[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function recentAverage(series: SalesHistoryPoint[], days: number): number {
  return average(series.slice(-days).map((point) => point.units));
}

function normalizeHistory(history: SalesHistoryPoint[], startDate: string, endDate: string): SalesHistoryPoint[] {
  const byDate = new Map<string, SalesHistoryPoint>();
  for (const point of history) {
    const existing = byDate.get(point.date);
    const units = Math.max(0, Number(point.units) || 0);
    if (existing) {
      existing.units += units;
      existing.stockout = existing.stockout || point.stockout;
    } else {
      byDate.set(point.date, { date: point.date, units, stockout: Boolean(point.stockout) });
    }
  }

  return daysBetweenInclusive(startDate, endDate).map((date) => byDate.get(date) ?? { date, units: 0 });
}

export function buildDailyForecast(
  history: SalesHistoryPoint[],
  options: ForecastEngineOptions,
): ForecastEngineResult {
  const horizonDays = Math.max(1, Math.round(options.horizonDays));
  const series = normalizeHistory(history, options.historyStartDate, options.asOfDate);
  const warnings: string[] = [];
  const units = series.map((point) => point.units);
  const historyDays = series.length;
  const stockoutDays = series.filter((point) => point.stockout).length;
  const nonZeroDays = units.filter((value) => value > 0).length;

  const allAverage = average(units);
  const avg7 = recentAverage(series, Math.min(7, historyDays));
  const avg14 = recentAverage(series, Math.min(14, historyDays));
  const avg28 = recentAverage(series, Math.min(28, historyDays));
  const fallback = Math.max(0, options.categoryFallbackDailyDemand ?? 0);

  if (historyDays < 14) {
    warnings.push('Limited local sales history. Forecast is low confidence.');
  }
  if (nonZeroDays < 3 && fallback > 0) {
    warnings.push('Sparse item sales. Category fallback demand is being used.');
  } else if (nonZeroDays < 3) {
    warnings.push('Sparse item sales. Recommendation may under-order new or slow-moving stock.');
  }
  if (stockoutDays > 0) {
    warnings.push('Recent stockout days may hide true demand.');
  }

  const recentBlend =
    (avg7 * 0.5) +
    (avg14 * 0.3) +
    (avg28 * 0.2);

  const prevWindow = series.slice(Math.max(0, historyDays - 28), Math.max(0, historyDays - 7));
  const previousAverage = average(prevWindow.map((point) => point.units));
  const trendRatio = previousAverage > 0 ? Math.min(1.35, Math.max(0.7, avg7 / previousAverage)) : 1;

  const positiveAverage = average(units.filter((value) => value > 0));
  const sparseAverage = positiveAverage * (historyDays > 0 ? nonZeroDays / historyDays : 0);

  const forecastDaily: ForecastDailyPoint[] = [];
  for (let offset = 1; offset <= horizonDays; offset++) {
    const date = addDays(options.asOfDate, offset);
    const targetDow = dayOfWeek(date);
    const sameWeekdayAverage = average(
      series
        .filter((point) => dayOfWeek(point.date) === targetDow)
        .map((point) => point.units),
    );

    let dailyDemand = recentBlend;
    if (sameWeekdayAverage > 0) {
      dailyDemand = (dailyDemand * 0.75) + (sameWeekdayAverage * 0.25);
    }

    if (nonZeroDays < 3) {
      dailyDemand = Math.max(sparseAverage, fallback * 0.5);
    } else if (allAverage === 0 && fallback > 0) {
      dailyDemand = fallback * 0.5;
    }

    dailyDemand *= trendRatio;
    forecastDaily.push({ date, units: round2(Math.max(0, dailyDemand)) });
  }

  const forecastUnits = round2(forecastDaily.reduce((sum, point) => sum + point.units, 0));
  let confidence = 0.85;
  if (historyDays < 30) confidence -= 0.2;
  if (nonZeroDays < 7) confidence -= 0.25;
  if (stockoutDays > 0) confidence -= Math.min(0.2, stockoutDays * 0.03);
  if (forecastUnits === 0) confidence -= 0.15;

  return {
    avgDailyDemand: round2(allAverage),
    forecastUnits,
    forecastDaily,
    confidence: round2(Math.min(0.95, Math.max(0.15, confidence))),
    warnings,
  };
}
