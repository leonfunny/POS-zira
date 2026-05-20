import type { ProductVariantRow, CategoryRow } from '../database/repos/product-repo';

export type ProductSyncGuardMode = 'full' | 'delta';

export interface ProductSyncGuardLocalRow {
  id: string;
  sku: string | null;
  barcode: string | null;
  retail_price: number;
  price_gross?: number | null;
  is_active: number;
}

export interface ProductSyncGuardBaseline {
  products: ProductSyncGuardLocalRow[];
  activeProductCount: number;
  categoryCount: number;
}

export interface ProductSyncGuardInput {
  mode: ProductSyncGuardMode;
  baseline: ProductSyncGuardBaseline;
  products: ProductVariantRow[];
  categories: CategoryRow[];
  deletedIds?: string[];
}

export interface ProductSyncGuardRejection {
  code: 'existing-price-loss' | 'empty-full-sync' | 'category-collapse' | 'active-product-collapse';
  message: string;
  samples?: Array<{ id: string; sku: string | null; barcode: string | null; name?: string; oldPrice: number; newPrice: number }>;
}

export interface ProductSyncGuardResult {
  allowed: boolean;
  rejection?: ProductSyncGuardRejection;
  stats: {
    incomingActiveCount: number;
    existingMatchedCount: number;
    existingPriceLossCount: number;
    newZeroPriceCount: number;
    missingExistingActiveCount: number;
  };
}

export class ProductSyncGuardError extends Error {
  constructor(public readonly rejection: ProductSyncGuardRejection, public readonly stats: ProductSyncGuardResult['stats']) {
    super(rejection.message);
    this.name = 'ProductSyncGuardError';
  }
}

function effectivePrice(row: Pick<ProductVariantRow, 'retail_price' | 'price_gross'> | ProductSyncGuardLocalRow): number {
  return Math.max(0, Number(row.retail_price || 0), Number(row.price_gross || 0));
}

function isActive(row: Pick<ProductVariantRow, 'is_active'> | ProductSyncGuardLocalRow): boolean {
  return row.is_active !== 0;
}

export function evaluateProductSyncGuard(input: ProductSyncGuardInput): ProductSyncGuardResult {
  const { mode, baseline, products, categories, deletedIds = [] } = input;
  const localActive = baseline.products.filter(isActive);
  const localById = new Map(localActive.map((row) => [row.id, row]));
  const incomingActive = products.filter(isActive);
  const incomingActiveIds = new Set(incomingActive.map((row) => row.id));
  const deletedIdSet = new Set(deletedIds);

  let existingMatchedCount = 0;
  let newZeroPriceCount = 0;
  const losingPrice: ProductSyncGuardRejection['samples'] = [];

  for (const product of incomingActive) {
    const old = localById.get(product.id);
    const newPrice = effectivePrice(product);
    if (!old) {
      if (newPrice <= 0) newZeroPriceCount++;
      continue;
    }

    existingMatchedCount++;
    const oldPrice = effectivePrice(old);
    if (oldPrice > 0 && newPrice <= 0) {
      losingPrice.push({
        id: product.id,
        sku: product.sku,
        barcode: product.barcode,
        name: product.name,
        oldPrice,
        newPrice,
      });
    }
  }

  const missingExistingActiveCount = mode === 'full'
    ? localActive.filter((row) => !incomingActiveIds.has(row.id) && !deletedIdSet.has(row.id)).length
    : 0;

  const stats = {
    incomingActiveCount: incomingActive.length,
    existingMatchedCount,
    existingPriceLossCount: losingPrice.length,
    newZeroPriceCount,
    missingExistingActiveCount,
  };

  const existingPriceLossRatio = losingPrice.length / Math.max(1, existingMatchedCount);
  const massExistingPriceLoss =
    losingPrice.length >= 100 ||
    (losingPrice.length >= 20 && existingPriceLossRatio >= 0.05) ||
    (losingPrice.length >= 10 && existingPriceLossRatio >= 0.25);

  if (massExistingPriceLoss) {
    return {
      allowed: false,
      stats,
      rejection: {
        code: 'existing-price-loss',
        message: `Product sync rejected: ${losingPrice.length} existing priced product(s) would become zero-priced. Keeping the local catalogue.`,
        samples: losingPrice.slice(0, 8),
      },
    };
  }

  if (mode === 'full') {
    if (baseline.activeProductCount > 0 && products.length === 0) {
      return {
        allowed: false,
        stats,
        rejection: {
          code: 'empty-full-sync',
          message: `Product full sync rejected: backend returned 0 products while local catalogue has ${baseline.activeProductCount} active product(s).`,
        },
      };
    }

    if (baseline.categoryCount >= 3 && categories.length === 0 && incomingActive.length >= 20) {
      return {
        allowed: false,
        stats,
        rejection: {
          code: 'category-collapse',
          message: `Product full sync rejected: backend returned 0 categories while local catalogue has ${baseline.categoryCount}.`,
        },
      };
    }

    const activeDropRatio = missingExistingActiveCount / Math.max(1, baseline.activeProductCount);
    if (baseline.activeProductCount >= 50 && missingExistingActiveCount >= 50 && activeDropRatio >= 0.5) {
      return {
        allowed: false,
        stats,
        rejection: {
          code: 'active-product-collapse',
          message: `Product full sync rejected: ${missingExistingActiveCount} existing active product(s) are missing from the backend response without explicit deletion ids.`,
        },
      };
    }
  }

  return { allowed: true, stats };
}
