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
