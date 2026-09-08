import { normalizeSaleUnit, normalizeSellBy } from './pos-sale';

interface MergeableCartLine {
  variantId: string;
  price: number;
  vatRate?: number;
  staffId?: string;
  course?: number;
  notes?: string;
  saleUnit?: string | null;
  sellBy?: string | null;
  lineDiscountType?: string;
  lineDiscountValue?: number;
  lineDiscount?: number;
  locked?: boolean;
  billiard?: unknown;
}

/** Only combine interchangeable, unallocated sale lines on either platform. */
export function canMergeCartLines(a: MergeableCartLine, b: MergeableCartLine): boolean {
  // A discount belongs to its line; merging can lose fixed amounts or alter rounding.
  if (a.locked || b.locked || a.billiard || b.billiard
    || (a.lineDiscountValue ?? 0) > 0 || (b.lineDiscountValue ?? 0) > 0
    || (a.lineDiscount ?? 0) > 0 || (b.lineDiscount ?? 0) > 0) return false;
  return a.variantId === b.variantId
    && a.price === b.price
    && (a.vatRate ?? 0) === (b.vatRate ?? 0)
    && (a.staffId ?? null) === (b.staffId ?? null)
    && (a.course ?? null) === (b.course ?? null)
    && (a.notes ?? '').trim() === (b.notes ?? '').trim()
    && normalizeSellBy(a.sellBy) === normalizeSellBy(b.sellBy)
    && normalizeSaleUnit(a) === normalizeSaleUnit(b);
}
