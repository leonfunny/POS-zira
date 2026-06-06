import { classifyProductSale, type ProductSaleClassifiable } from '../../shared/product-sale-classifier';

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
