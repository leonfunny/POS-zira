import type { ProductVariantRow } from '../database/repos/product-repo';

function encodeNameTranslations(raw: any): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key === 'string' && typeof value === 'string' && value.trim() !== '') {
      cleaned[key.toLowerCase()] = value;
    }
  }
  return Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned) : null;
}

/**
 * Convert the immediate quick-add response into the same local row shape
 * ProductSync eventually writes. The mutation response is the freshest truth;
 * using it lets the POS sell the just-created item even if the poller has not
 * observed it yet.
 */
export function toQuickAddVariantRow(
  product: any,
  variant: any,
  fallback: { retailPriceGrosze: number; quantity: number },
): ProductVariantRow | null {
  if (!variant?.id) return null;
  const name = variant.name ?? product?.name ?? '';
  if (!name) return null;

  const translationSource =
    variant.nameTranslations ??
    variant.name_translations ??
    product?.nameTranslations ??
    product?.name_translations;

  return {
    id: String(variant.id),
    template_id: variant.templateId ?? variant.template_id ?? product?.id ?? null,
    name,
    sku: variant.sku ?? null,
    barcode: variant.barcode ?? product?.ean ?? product?.barcode ?? null,
    retail_price: fallback.retailPriceGrosze,
    category_id: variant.categoryId ?? variant.category_id ?? product?.categoryId ?? product?.category_id ?? null,
    image_url: variant.imageUrl ?? variant.image_url ?? product?.imageUrl ?? product?.image_url ?? null,
    in_stock: variant.totalStockQty ?? variant.in_stock ?? fallback.quantity,
    vat_rate: Number(variant.taxRate ?? variant.vat_rate ?? product?.taxRate ?? product?.vat_rate ?? 23) || 23,
    is_active: variant.isActive === false || variant.is_active === 0 ? 0 : 1,
    updated_at: variant.updatedAt ?? variant.updated_at ?? product?.updatedAt ?? product?.updated_at ?? new Date().toISOString(),
    available_qty: variant.availableQty ?? variant.available_qty ?? variant.totalStockQty ?? variant.in_stock ?? fallback.quantity,
    price_gross: fallback.retailPriceGrosze,
    price_net: 0,
    vat_amount: 0,
    is_on_sale: variant.isOnSale ? 1 : (variant.is_on_sale ?? 0),
    thumbnail_url: variant.thumbnailUrl ?? variant.thumbnail_url ?? null,
    sale_unit: variant.saleUnit ?? variant.sale_unit ?? product?.weightUnit ?? product?.weight_unit ?? null,
    name_translations: encodeNameTranslations(translationSource),
  };
}
