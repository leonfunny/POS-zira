import { normalizeSaleUnit, normalizeSellBy, type SellBy } from './pos-sale';

export type ProductSaleKind = 'NORMAL' | 'WEIGHTED';
export type ProductQuantityInputMode = 'integer' | 'decimal';

export interface ProductSaleClassifiable {
  sellBy?: string | null;
  sell_by?: string | null;
  saleUnit?: string | null;
  sale_unit?: string | null;
}

export interface ProductSaleClassification {
  kind: ProductSaleKind;
  sellBy: SellBy;
  saleUnit: string;
  isWeighted: boolean;
  isNormal: boolean;
  requiresScale: boolean;
  quantityInputMode: ProductQuantityInputMode;
  priceSuffix: string;
}

function saleUnitImpliesWeight(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'kg' || normalized === 'kilogram' || normalized === 'kilograms';
}

export function classifyProductSale(product: ProductSaleClassifiable): ProductSaleClassification {
  const rawSaleUnit = product.saleUnit ?? product.sale_unit;
  const normalizedSellBy = normalizeSellBy(product.sellBy ?? product.sell_by);
  const sellBy = normalizedSellBy === 'WEIGHT' || saleUnitImpliesWeight(rawSaleUnit)
    ? 'WEIGHT'
    : 'PIECE';
  const saleUnit = normalizeSaleUnit({
    saleUnit: product.saleUnit,
    sale_unit: product.sale_unit,
    sellBy,
  });
  const isWeighted = sellBy === 'WEIGHT';

  return {
    kind: isWeighted ? 'WEIGHTED' : 'NORMAL',
    sellBy,
    saleUnit,
    isWeighted,
    isNormal: !isWeighted,
    requiresScale: isWeighted,
    quantityInputMode: isWeighted ? 'decimal' : 'integer',
    priceSuffix: isWeighted ? `/${saleUnit}` : '',
  };
}

export function isWeightedProduct(product: ProductSaleClassifiable): boolean {
  return classifyProductSale(product).isWeighted;
}

export function isNormalProduct(product: ProductSaleClassifiable): boolean {
  return classifyProductSale(product).isNormal;
}
