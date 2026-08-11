/**
 * Bare-create scan import — the launch-day "sell it now, fix it later" path.
 *
 * When a scanned EAN misses the local catalog, the draft mirror, the master
 * catalog AND the external EAN databases, the POS offers to create a sellable
 * product on the spot: name = the scanned code, cashier types the selling
 * price, picks VAT, stock defaults to a nominal buffer so the sale is never
 * blocked. The office renames/refines the product later in the dashboard.
 */
import type { ScanImportDraftPreview } from './ScanImportModal';

export const BARE_CREATE_SOURCE = 'bare_create';
export const BARE_CREATE_DEFAULT_VAT = 8;
export const BARE_CREATE_VAT_OPTIONS = [5, 8, 23];
export const BARE_CREATE_DEFAULT_STOCK = 24;

export function isBareCreateSource(source: string | undefined): boolean {
  return source === BARE_CREATE_SOURCE;
}

export function buildBareScanImportPreview(ean: string): ScanImportDraftPreview {
  return {
    name: ean,
    barcode: ean,
    retail_price: 0,
    vat_rate: BARE_CREATE_DEFAULT_VAT,
    image_url: null,
    source: BARE_CREATE_SOURCE,
  };
}

/**
 * Deterministic Idempotency-Key: an identical payload always maps to the same
 * key, so a retry after a lost response replays server-side instead of
 * double-creating, while any edit (price/VAT/stock/category) mints a new key
 * so the backend never 409s an intentional change. Backend caps keys at 80
 * chars.
 */
export function bareScanCreateIdempotencyKey(args: {
  ean: string;
  retailPriceGrosze: number;
  vatRate: number;
  stockQty: number;
  categoryId?: string | null;
}): string {
  const category = args.categoryId ? String(args.categoryId) : 'auto';
  const key = `bare-${args.ean}-${args.retailPriceGrosze}-${args.vatRate}-${args.stockQty}-${category}`;
  return key.slice(0, 80);
}
