export type SellBy = 'PIECE' | 'WEIGHT';

export interface SaleQuantityLike {
  quantity?: number | null;
  saleQuantity?: number | null;
  sale_quantity?: number | null;
  saleUnit?: string | null;
  sale_unit?: string | null;
  sellBy?: string | null;
  sell_by?: string | null;
}

export function normalizeSellBy(value: unknown): SellBy {
  return String(value ?? '').trim().toUpperCase() === 'WEIGHT' ? 'WEIGHT' : 'PIECE';
}

export function isWeightedSale(value: unknown): boolean {
  return normalizeSellBy(value) === 'WEIGHT';
}

export function isValidSaleQuantity(quantity: unknown, sellBy: SellBy): boolean {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) return false;
  const numeric = quantity;
  if (sellBy === 'PIECE') return Number.isInteger(numeric);
  const millis = numeric * 1000;
  return Math.abs(millis - Math.round(millis)) <= 1e-8;
}

export function isValidManualWeightQuantity(quantity: unknown): quantity is number {
  return typeof quantity === 'number'
    && isValidSaleQuantity(quantity, 'WEIGHT')
    && quantity > 0
    && quantity <= 999;
}

export function normalizeSaleUnit(line: SaleQuantityLike): string {
  const explicit = String(line.saleUnit ?? line.sale_unit ?? '').trim();
  if (explicit) return explicit;
  return isWeightedSale(line.sellBy ?? line.sell_by) ? 'kg' : 'szt';
}

export function roundSaleQuantity(quantity: number, sellBy: SellBy): number {
  if (!Number.isFinite(quantity)) return sellBy === 'WEIGHT' ? 0 : 1;
  if (sellBy === 'WEIGHT') {
    return Math.max(0, Math.round(quantity * 1000) / 1000);
  }
  return Math.max(0, Math.round(quantity));
}

export function resolveSaleQuantity(line: SaleQuantityLike): number {
  const sellBy = normalizeSellBy(line.sellBy ?? line.sell_by);
  const raw = sellBy === 'WEIGHT'
    ? Number(line.saleQuantity ?? line.sale_quantity ?? line.quantity ?? 0)
    : Number(line.quantity ?? line.saleQuantity ?? line.sale_quantity ?? 1);
  return roundSaleQuantity(raw, sellBy);
}

export function calculateLineTotalGrosze(unitPriceGrosze: number, quantity: number, sellBy: SellBy): number {
  const price = Math.max(0, Math.round(Number(unitPriceGrosze) || 0));
  if (sellBy === 'WEIGHT') {
    const grams = Math.max(0, Math.round((Number(quantity) || 0) * 1000));
    return Math.floor((grams * price + 500) / 1000);
  }
  return price * Math.max(0, Math.round(Number(quantity) || 0));
}

export function formatSaleQuantity(quantity: number, sellBy: SellBy): string {
  if (sellBy === 'WEIGHT') {
    return (Math.round((Number(quantity) || 0) * 1000) / 1000)
      .toFixed(3)
      .replace(/\.?0+$/, '');
  }
  return String(Math.max(0, Math.round(Number(quantity) || 0)));
}
