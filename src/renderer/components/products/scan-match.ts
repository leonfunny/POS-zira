import type { ProductListItem } from '../../hooks/useProducts';

export type ScanResolution =
  | { kind: 'one'; product: ProductListItem }
  | { kind: 'many'; products: ProductListItem[] }
  | { kind: 'none'; code: string };

export type ProductBarcodeLookup = (code: string) => Promise<ProductListItem | null>;

export function barcodeKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 4) return trimmed.replace(/^0+/, '');
  return trimmed;
}

function alphanumericKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '');
}

function barcodeMatchesScan(scanCode: string, normalizedScanCode: string, scanAlnum: string, barcode: string): boolean {
  if (!barcode) return false;
  if (barcode === scanCode) return true;
  if (normalizedScanCode.length > 0 && barcodeKey(barcode) === normalizedScanCode) return true;
  if (barcode.length >= 4 && scanCode.includes(barcode)) return true;

  const barcodeAlnum = alphanumericKey(barcode);
  return scanAlnum.length >= 8
    && barcodeAlnum.length >= 4
    && scanAlnum.includes(barcodeAlnum);
}

export function findDuplicateBarcodeSet(
  code: string,
  products: ProductListItem[],
): ProductListItem[] {
  const trimmed = code.trim();
  if (!trimmed) return [];
  const normalized = barcodeKey(trimmed);
  const scanAlnum = alphanumericKey(trimmed);

  return products.filter((product) => {
    const barcode = product.barcode?.trim() || '';
    const sameSku = product.sku?.trim() === trimmed;
    return sameSku || barcodeMatchesScan(trimmed, normalized, scanAlnum, barcode);
  });
}

export async function resolveScan(
  code: string,
  products: ProductListItem[],
  getByBarcode: ProductBarcodeLookup,
): Promise<ScanResolution> {
  const trimmed = code.trim();
  const duplicates = findDuplicateBarcodeSet(trimmed, products);
  if (duplicates.length > 1) return { kind: 'many', products: duplicates };

  const product = trimmed ? await getByBarcode(trimmed) : null;
  return product
    ? { kind: 'one', product }
    : { kind: 'none', code: trimmed };
}
