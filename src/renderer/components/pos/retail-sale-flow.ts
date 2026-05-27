import type { Product } from '../../hooks/usePosDb';
import type { CartItem } from '../../hooks/usePosStore';
import type { ScaleReadResult } from '../../../shared/types';
import { classifyProductSale, type ProductSaleClassification } from '../../../shared/product-sale-classifier';
import { calculateLineTotalGrosze } from '../../../shared/pos-sale';

type ScaleRead = (options?: { port?: string }) => Promise<ScaleReadResult>;

export type RetailSaleErrorCode =
  | 'SCALE_DISABLED'
  | 'SCALE_UNAVAILABLE'
  | 'SCALE_FAILED'
  | 'SCALE_UNSTABLE';

export interface RetailSaleError {
  code: RetailSaleErrorCode;
  message?: string;
}

export type RetailCartItemResult =
  | { ok: true; item: CartItem; saleClass: ProductSaleClassification }
  | { ok: false; error: RetailSaleError; saleClass: ProductSaleClassification };

export interface ResolveRetailCartItemOptions {
  scaleEnabled?: boolean;
  scalePort?: string | null;
  readWeight?: ScaleRead;
  generateId?: () => string;
}

function buildCartItem(product: Product, saleClass: ProductSaleClassification, quantity: number, id: string): CartItem {
  return {
    id,
    variantId: product.id,
    name: product.name,
    sku: product.sku || '',
    price: product.retail_price,
    quantity,
    total: calculateLineTotalGrosze(product.retail_price, quantity, saleClass.sellBy),
    saleUnit: saleClass.saleUnit,
    sellBy: saleClass.sellBy,
    imageUrl: product.image_url || undefined,
    vatRate: product.vat_rate,
    name_translations: product.name_translations ?? null,
  };
}

export async function resolveRetailCartItem(
  product: Product,
  options: ResolveRetailCartItemOptions = {},
): Promise<RetailCartItemResult> {
  const saleClass = classifyProductSale(product);
  let quantity = 1;

  if (saleClass.requiresScale) {
    if (options.scaleEnabled !== true) {
      return { ok: false, saleClass, error: { code: 'SCALE_DISABLED' } };
    }
    if (!options.readWeight) {
      return { ok: false, saleClass, error: { code: 'SCALE_UNAVAILABLE' } };
    }

    const result = await options.readWeight({ port: options.scalePort || undefined });
    if (!result?.success) {
      return {
        ok: false,
        saleClass,
        error: { code: 'SCALE_FAILED', message: result?.error },
      };
    }
    if (!result.stable || result.weightKg <= 0) {
      return { ok: false, saleClass, error: { code: 'SCALE_UNSTABLE' } };
    }
    quantity = result.weightKg;
  }

  const generateId = options.generateId || (() => crypto.randomUUID());
  return { ok: true, saleClass, item: buildCartItem(product, saleClass, quantity, generateId()) };
}

export function formatRetailSaleError(
  error: RetailSaleError,
  tOr: (key: string, fallback: string) => string,
): string {
  switch (error.code) {
    case 'SCALE_DISABLED':
      return tOr('pos.scale.disabled', 'Scale is disabled in Settings');
    case 'SCALE_UNAVAILABLE':
      return tOr('pos.scale.unavailable', 'Scale reader is not available');
    case 'SCALE_UNSTABLE':
      return tOr('pos.scale.unstable', 'Put the product on the scale and wait for a stable weight');
    case 'SCALE_FAILED':
    default:
      return error.message || tOr('pos.scale.failed', 'Scale did not return a weight');
  }
}
