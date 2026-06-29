export type StockColor = 'red' | 'amber' | 'green';

export const LOW_STOCK_THRESHOLD = 5;

export function stockColor(quantity: number): StockColor {
  const normalized = Number(quantity) || 0;
  if (normalized <= 0) return 'red';
  if (normalized <= LOW_STOCK_THRESHOLD) return 'amber';
  return 'green';
}

export function stockTileClasses(quantity: number): string {
  switch (stockColor(quantity)) {
    case 'red':
      return 'bg-rose-500 text-white border-rose-600';
    case 'amber':
      return 'bg-amber-400 text-amber-950 border-amber-500';
    case 'green':
      return 'bg-emerald-500 text-white border-emerald-600';
  }
}
