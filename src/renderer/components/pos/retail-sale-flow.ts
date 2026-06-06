import type { Product } from '../../hooks/usePosDb';
import type { CartItem } from '../../hooks/usePosStore';
import type { ScaleReadResult } from '../../../shared/types';
import { classifyProductSale, type ProductSaleClassification } from '../../../shared/product-sale-classifier';
import { calculateLineTotalGrosze } from '../../../shared/pos-sale';

type ScaleRead = (options?: { port?: string }) => Promise<ScaleReadResult>;

const DEFAULT_SCALE_READ_TIMEOUT_MS = 5000;

export type RetailSaleErrorCode =
  | 'SCALE_DISABLED'
  | 'SCALE_UNAVAILABLE'
  | 'SCALE_FAILED'
  | 'SCALE_TIMEOUT'
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
  scaleTimeoutMs?: number;
  generateId?: () => string;
}

export function buildRetailCartItem(product: Product, saleClass: ProductSaleClassification, quantity: number, id: string): CartItem {
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

async function readWeightWithTimeout(
  readWeight: ScaleRead,
  options: { port?: string },
  timeoutMs: number,
): Promise<ScaleReadResult> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      readWeight(options),
      new Promise<ScaleReadResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            success: false,
            protocol: 'DIBAL_GDPOS',
            port: options.port,
            code: 'TIMEOUT',
            error: `Scale read timed out after ${timeoutMs}ms`,
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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

    const result = await readWeightWithTimeout(
      options.readWeight,
      { port: options.scalePort || undefined },
      Math.max(1, options.scaleTimeoutMs || DEFAULT_SCALE_READ_TIMEOUT_MS),
    );
    if (!result?.success) {
      return {
        ok: false,
        saleClass,
        error: { code: result?.code === 'TIMEOUT' ? 'SCALE_TIMEOUT' : 'SCALE_FAILED', message: result?.error },
      };
    }
    if (!result.stable || result.weightKg <= 0) {
      return { ok: false, saleClass, error: { code: 'SCALE_UNSTABLE' } };
    }
    quantity = result.weightKg;
  }

  const generateId = options.generateId || (() => crypto.randomUUID());
  return { ok: true, saleClass, item: buildRetailCartItem(product, saleClass, quantity, generateId()) };
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
    case 'SCALE_TIMEOUT':
      return tOr('pos.scale.timeout', 'Scale read timed out');
    case 'SCALE_UNSTABLE':
      return tOr('pos.scale.unstable', 'Put the product on the scale and wait for a stable weight');
    case 'SCALE_FAILED':
    default:
      return error.message || tOr('pos.scale.failed', 'Scale did not return a weight');
  }
}
