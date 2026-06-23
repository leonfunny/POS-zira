import type { SearchProduct } from './types';

export function getProductPriceGrosze(product: SearchProduct): number {
  const value = product.retail_price ?? product.price ?? product.price_gross;
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
}

export function getProductStock(product: SearchProduct): number | undefined {
  const value = product.in_stock ?? product.available_qty;
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

export type ProductAvailabilityReason = 'no_price' | 'out_of_stock' | 'weighted' | null;

/** Weighted products cannot be sold at the kiosk because it has no scale. */
export function isWeightedProduct(product: Pick<SearchProduct, 'sell_by'>): boolean {
  return String(product.sell_by || '').toUpperCase() === 'WEIGHT';
}

export interface ProductAvailability {
  canAdd: boolean;
  reason: ProductAvailabilityReason;
  priceGrosze: number;
  stock?: number;
}

export function getProductAvailability(
  product: SearchProduct,
  opts?: { allowOversell?: boolean },
): ProductAvailability {
  const priceGrosze = getProductPriceGrosze(product);
  const stock = getProductStock(product);
  if (isWeightedProduct(product)) {
    return { canAdd: false, reason: 'weighted', priceGrosze, stock };
  }
  if (priceGrosze <= 0) {
    return { canAdd: false, reason: 'no_price', priceGrosze, stock };
  }
  if (!opts?.allowOversell && typeof stock === 'number' && stock <= 0) {
    return { canAdd: false, reason: 'out_of_stock', priceGrosze, stock };
  }
  return { canAdd: true, reason: null, priceGrosze, stock };
}

export function normalizeCatalogText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
