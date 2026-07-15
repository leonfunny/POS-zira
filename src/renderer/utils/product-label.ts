import { classifyProductSale, type ProductSaleClassifiable } from '../../shared/product-sale-classifier';

export type LabelLanguage = 'vi' | 'pl';

export interface PrintableLabelProduct {
  is_active?: number | null;
  _isDraft?: boolean;
}

export function coerceLabelLanguage(value: unknown): LabelLanguage {
  return value === 'pl' || value === 'vi' ? value : 'vi';
}

export function isPrintableLabelProduct(product: PrintableLabelProduct): boolean {
  return product._isDraft !== true && product.is_active !== 0;
}

export function normalizeLabelSelectionIds(ids: readonly unknown[]): string[] {
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

export function toggleLabelSelectionId(ids: readonly string[], id: string): string[] {
  const current = normalizeLabelSelectionIds(ids);
  const normalizedId = String(id || '').trim();
  if (!normalizedId) return current;
  return current.includes(normalizedId)
    ? current.filter((currentId) => currentId !== normalizedId)
    : [...current, normalizedId];
}

export function filterValidLabelSelectionIds(
  ids: readonly string[],
  validIds: ReadonlySet<string>,
): string[] {
  return normalizeLabelSelectionIds(ids).filter((id) => validIds.has(id));
}

export function labelSelectionIdsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export interface ProductLabelPriceSource extends ProductSaleClassifiable {
  retail_price?: number | null;
}

export function formatProductLabelPriceText(
  product: ProductLabelPriceSource,
  currency: string = 'zl',
): string | undefined {
  const priceGrosze = Number(product.retail_price) || 0;
  if (priceGrosze <= 0) return undefined;
  const saleClass = classifyProductSale(product);
  return `${(priceGrosze / 100).toFixed(2)} ${currency}${saleClass.priceSuffix}`;
}
