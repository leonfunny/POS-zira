import { classifyProductSale, type ProductSaleClassification } from '../../../shared/product-sale-classifier';
import type { ProductAdminVariant } from '../../../shared/types';
import type { Product } from '../../hooks/usePosDb';
import { buildRetailCartItem } from '../pos/retail-sale-flow';

/** Canonical product-admin response -> the local POS catalogue row shape. */
export function productAdminVariantToProduct(variant: ProductAdminVariant): Product {
  const saleUnit = variant.saleUnit ?? null;
  const vatRate = Number(variant.vatRate);
  return {
    id: variant.id,
    template_id: variant.templateId ?? null,
    name: variant.name || variant.id,
    sku: variant.sku ?? null,
    barcode: variant.barcode ?? null,
    retail_price: Number(variant.priceGrossGrosze) || Math.round((Number(variant.retailPrice) || 0) * 100),
    category_id: variant.categoryId ?? null,
    image_url: variant.imageUrl ?? null,
    in_stock: Number(variant.totalStockQty) || 0,
    vat_rate: Number.isFinite(vatRate) && vatRate >= 0 ? vatRate : 23,
    is_active: variant.isActive === false ? 0 : 1,
    updated_at: variant.canonicalUpdatedAt ?? variant.updatedAt ?? null,
    available_qty: Number(variant.availableQty) || 0,
    sale_unit: saleUnit,
    sell_by: variant.sellBy === 'WEIGHT' || String(saleUnit || '').toLowerCase() === 'kg' ? 'WEIGHT' : 'PIECE',
    item_type: variant.itemType != null ? String(variant.itemType).toLowerCase() : null,
    track_inventory: variant.trackInventory === false ? 0 : 1,
    name_translations: variant.nameTranslations ? JSON.stringify(variant.nameTranslations) : null,
  };
}

export type ProductAdminVariantCartOutcome =
  | { kind: 'cart-line'; line: ReturnType<typeof buildRetailCartItem> }
  | { kind: 'manual-weight'; product: Product; saleClass: ProductSaleClassification };

/**
 * A native create never assumes one kilogram for a weighed variant. Piece
 * variants join the cart using the same grosze/VAT contract as retail; weighed
 * variants are handed back to the POS so it can run its existing manual-weight
 * flow before any quantity is committed.
 */
export function productAdminVariantToCartLine(variant: ProductAdminVariant, id: string): ProductAdminVariantCartOutcome {
  const product = productAdminVariantToProduct(variant);
  const saleClass = classifyProductSale(product);
  if (saleClass.requiresScale) return { kind: 'manual-weight', product, saleClass };
  return { kind: 'cart-line', line: buildRetailCartItem(product, saleClass, 1, id) };
}
