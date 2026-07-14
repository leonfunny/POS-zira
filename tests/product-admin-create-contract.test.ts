import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('Product Admin create app contract', () => {
  it('uses backend priceGrossGrosze only for create requests', () => {
    const dialog = source('src/renderer/components/products/ProductCreateDialog.tsx');
    const apiClient = source('src/main/network/api-client.ts');
    const types = source('src/shared/types.ts');

    const createInput = types.match(/export interface ProductAdminCreateProductInput \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(createInput).not.toContain('retailPrice?:');

    // Shared fields are snapshotted with barcode + idempotencyKey before the
    // first dispatch. Only a confirmed generated-barcode collision may rotate.
    const payloadBlock = dialog.match(/const basePayload: Omit<ProductAdminCreateProductInput, 'barcode' \| 'idempotencyKey'> = \{[\s\S]*?\n\s+\};/)?.[0] ?? '';
    expect(payloadBlock).toContain('priceGrossGrosze: validation.priceGrossGrosze');
    expect(payloadBlock).not.toContain('retailPrice:');

    const createMethod = apiClient.match(/async createProductVariant\([\s\S]*?\n  \}/)?.[0] ?? '';
    expect(createMethod).toContain('retailPrice: _ignoredRetailPrice');
  });

  it('blocks locally known duplicate barcodes before backend create submit', () => {
    const moduleSource = source('src/renderer/components/products/ProductModule.tsx');
    const dialog = source('src/renderer/components/products/ProductCreateDialog.tsx');

    expect(moduleSource).toContain('products={allProducts}');
    expect(dialog).toContain("import { findDuplicateBarcodeSet } from './scan-match'");
    expect(dialog).toContain('findDuplicateBarcodeSet(normalizedBarcode, activeProducts)');
    expect(dialog).toContain('products.create.duplicateBarcode');
    expect(dialog).toContain('products.create.duplicateSku');
    expect(dialog).toContain('product.sku?.trim() === normalizedSku');

    const submit = dialog.match(/const handleSubmit = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
    const createCallIndex = submit.indexOf('window.electronAPI.pos.productAdmin.createProduct(createAttempt)');
    const barcodeDuplicateIndex = submit.indexOf('getDuplicateBarcodeMessage(normalizedBarcode)');
    const skuDuplicateIndex = submit.indexOf('product.sku?.trim() === normalizedSku');
    expect(createCallIndex).toBeGreaterThanOrEqual(0);
    expect(barcodeDuplicateIndex).toBeGreaterThanOrEqual(0);
    expect(skuDuplicateIndex).toBeGreaterThanOrEqual(0);
    expect(barcodeDuplicateIndex).toBeLessThan(createCallIndex);
    expect(skuDuplicateIndex).toBeLessThan(createCallIndex);
  });

  it('captures scanner input into the create barcode field and detects duplicates immediately', () => {
    const dialog = source('src/renderer/components/products/ProductCreateDialog.tsx');

    expect(dialog).toContain('const barcodeInputRef = useRef<HTMLInputElement | null>(null)');
    expect(dialog).toContain('const applyBarcodeScan = useCallback((rawBarcode: string) => {');
    expect(dialog).toContain('setBarcode(normalizedScan)');
    expect(dialog).toContain('const duplicateMessage = getDuplicateBarcodeMessage(normalizedScan)');
    expect(dialog).toContain('setError(duplicateMessage)');
    expect(dialog).toContain('window.electronAPI.onBarcodeScanned((scannedBarcode: string) => {');
    expect(dialog).toContain('applyBarcodeScan(scannedBarcode)');
    expect(dialog).toContain('barcodeInputRef.current?.focus()');
    expect(dialog).toContain('ref={barcodeInputRef}');
    expect(dialog).toContain('onChange={(event) => applyBarcodeScan(event.target.value)}');
  });
});
