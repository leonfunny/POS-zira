/**
 * Single source of truth for "does this item hold countable stock?".
 *
 * Backend contract (product-admin / public catalog sync):
 *  - `item_type` / `itemType` / `productType`: 'stockable' | 'service' | 'consumable' | 'recipe'
 *  - `track_inventory` / `trackInventory`: template-level flag (default true)
 *
 * Only `stockable` items with tracking on hold stock. Everything else hides
 * stock UI (badges, filters, adjustment) and the backend refuses stock
 * mutations with 409 STOCK_NOT_TRACKED. Absent fields (old backend rows)
 * default to tracked so behaviour matches today's catalog.
 */

export interface StockTrackable {
  item_type?: string | null;
  itemType?: string | null;
  track_inventory?: number | boolean | null;
  trackInventory?: number | boolean | null;
}

export interface StockSellable extends StockTrackable {
  category_id?: string | null;
  categoryId?: string | null;
}

export function productItemType(product: StockTrackable): string {
  const raw = product.item_type ?? product.itemType;
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized || 'stockable';
}

export function isStockTracked(product: StockTrackable): boolean {
  if (productItemType(product) !== 'stockable') return false;
  const flag = product.track_inventory ?? product.trackInventory;
  if (flag === undefined || flag === null) return true;
  return !(flag === 0 || flag === false);
}

/**
 * Shared POS sale guard for countable stock.
 *
 * A zero/negative quantity blocks only genuinely tracked goods. Explicitly
 * non-tracked items and the legacy service category remain sellable. Keeping
 * this decision here prevents card-click and barcode paths from drifting.
 */
export function isSaleBlockedByStock(
  product: StockSellable,
  stockQuantity: unknown,
  allowOversell = false,
): boolean {
  if (allowOversell) return false;
  const categoryId = product.category_id ?? product.categoryId;
  if (categoryId === 'cat-5' || !isStockTracked(product)) return false;

  const quantity = Number(stockQuantity);
  return Number.isFinite(quantity) && quantity <= 0;
}

export interface ProductItemTypePolicy {
  stockApplies: boolean;
  sellBySelectable: boolean;
  sellBy: 'PIECE' | 'WEIGHT';
}

export function getProductItemTypePolicy(itemType: string, sellBy: string): ProductItemTypePolicy {
  const normalizedType = String(itemType || 'stockable').trim().toLowerCase();
  const normalizedSellBy = String(sellBy).trim().toUpperCase() === 'WEIGHT' ? 'WEIGHT' : 'PIECE';
  const isService = normalizedType === 'service';

  return {
    stockApplies: normalizedType === 'stockable',
    sellBySelectable: !isService,
    sellBy: isService ? 'PIECE' : normalizedSellBy,
  };
}
