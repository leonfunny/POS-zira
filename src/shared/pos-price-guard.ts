export interface LinePriceAnomaly {
  actualPrice: number;
  expectedPrice: number;
  multiplier: number;
  delta: number;
}

const MIN_ABSOLUTE_DELTA_GROSZE = 5_000;
const MAX_PRICE_MULTIPLIER = 3;

function normalizeGrosze(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function findLinePriceAnomaly(
  actualPrice: unknown,
  expectedCatalogPrice: unknown,
): LinePriceAnomaly | null {
  const actual = normalizeGrosze(actualPrice);
  const expected = normalizeGrosze(expectedCatalogPrice);
  if (actual <= 0 || expected <= 0 || actual <= expected) return null;

  const delta = actual - expected;
  const multiplier = actual / expected;
  if (delta < MIN_ABSOLUTE_DELTA_GROSZE || multiplier < MAX_PRICE_MULTIPLIER) return null;

  return {
    actualPrice: actual,
    expectedPrice: expected,
    multiplier,
    delta,
  };
}

export function formatGroszePLN(value: number): string {
  return `${(Math.round(value) / 100).toFixed(2)} zl`;
}

export function formatPriceAnomalyMessage(productName: string, anomaly: LinePriceAnomaly): string {
  return `Price anomaly: ${productName} is ${formatGroszePLN(anomaly.actualPrice)}, catalog is ${formatGroszePLN(anomaly.expectedPrice)}. Refresh product price before selling.`;
}
