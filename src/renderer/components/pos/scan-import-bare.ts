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
 * The bare form prefills the name with the scanned code. Only a real edit
 * counts as a custom name — an untouched/blank field means "no name yet"
 * (server falls back to the EAN), keeping payloads and idempotency keys
 * byte-identical to the pre-name builds.
 */
export function normalizeBareCreateName(
  raw: string | null | undefined,
  ean: string,
): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed || trimmed === ean.trim()) return null;
  return trimmed;
}

/** Tiny stable hash (djb2) so a long unicode name fits the 80-char key cap. */
function nameHashToken(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface AttachCandidateRow {
  id: string;
  name: string;
  barcode: string | null;
  is_active: number;
  retail_price: number;
  in_stock: number;
}

export const ATTACH_CANDIDATE_LIMIT = 6;

/**
 * Fix 4: candidates for "gán EAN vào SP có sẵn" — active local products that
 * carry NO barcode at all (products with an INTERNAL barcode keep their
 * supplier-SKU upgrade lane). Input is `pos.products.search(query)` output,
 * already active-filtered and relevance-ordered; this narrows and caps it.
 */
export function filterAttachCandidates<T extends AttachCandidateRow>(
  rows: T[],
): T[] {
  return rows
    .filter((row) => row.is_active === 1 && !(row.barcode ?? '').trim())
    .slice(0, ATTACH_CANDIDATE_LIMIT);
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
  name?: string | null;
  attachVariantId?: string | null;
}): string {
  const category = args.categoryId ? String(args.categoryId) : 'auto';
  // Custom name / attach target join the key as short tokens BEFORE the
  // category so they survive the 80-char slice even with a UUID category.
  // Neither present → key stays byte-identical to the pre-name format.
  const customName = normalizeBareCreateName(args.name, args.ean);
  const nameToken = customName ? `-n${nameHashToken(customName)}` : '';
  const attach = String(args.attachVariantId ?? '').trim();
  const attachToken = attach ? `-a${attach.replace(/-/g, '').slice(0, 12)}` : '';
  const key = `bare-${args.ean}-${args.retailPriceGrosze}-${args.vatRate}-${args.stockQty}${nameToken}${attachToken}-${category}`;
  return key.slice(0, 80);
}
