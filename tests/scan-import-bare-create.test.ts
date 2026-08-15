import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BARE_CREATE_DEFAULT_STOCK,
  BARE_CREATE_DEFAULT_VAT,
  BARE_CREATE_VAT_OPTIONS,
  bareScanCreateIdempotencyKey,
  buildBareScanImportPreview,
  isBareCreateSource,
  normalizeBareCreateName,
} from '../src/renderer/components/pos/scan-import-bare';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const modal = readSource('../src/renderer/components/pos/ScanImportModal.tsx');
const posLayout = readSource('../src/renderer/components/pos/POSLayout.tsx');
const posModule = readSource('../src/main/modules/pos.module.ts');
const apiClient = readSource('../src/main/network/api-client.ts');
const preload = readSource('../src/preload/preload-pos.ts');

describe('bare-create helpers', () => {
  it('builds a sellable preview whose name is the scanned code', () => {
    const preview = buildBareScanImportPreview('5901234123457');
    expect(preview.name).toBe('5901234123457');
    expect(preview.barcode).toBe('5901234123457');
    expect(preview.retail_price).toBe(0);
    expect(preview.vat_rate).toBe(BARE_CREATE_DEFAULT_VAT);
    expect(isBareCreateSource(preview.source)).toBe(true);
    expect(isBareCreateSource('draft')).toBe(false);
    expect(isBareCreateSource(undefined)).toBe(false);
  });

  it('keeps VAT choices to the Polish retail set with 8% default and stock 24', () => {
    expect(BARE_CREATE_VAT_OPTIONS).toEqual([5, 8, 23]);
    expect(BARE_CREATE_DEFAULT_VAT).toBe(8);
    expect(BARE_CREATE_DEFAULT_STOCK).toBe(24);
  });

  it('mints a deterministic idempotency key within the 80-char backend cap', () => {
    const args = {
      ean: '5901234123457',
      retailPriceGrosze: 1250,
      vatRate: 8,
      stockQty: 24,
      categoryId: null,
    };
    const key = bareScanCreateIdempotencyKey(args);
    expect(key).toBe('bare-5901234123457-1250-8-24-auto');
    expect(key).toBe(bareScanCreateIdempotencyKey({ ...args }));
    expect(bareScanCreateIdempotencyKey({ ...args, retailPriceGrosze: 1300 })).not.toBe(key);
    const long = bareScanCreateIdempotencyKey({
      ean: '12345678901234',
      retailPriceGrosze: 999_999_999_999,
      vatRate: 23,
      stockQty: 999_999_999,
      categoryId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    expect(long.length).toBeLessThanOrEqual(80);
  });
});

describe('bare-create wiring', () => {
  it('opens the bare form instead of a dead-end toast when every lookup misses', () => {
    expect(posLayout).toContain('preview = buildBareScanImportPreview(code);');
    expect(posLayout).toContain('preview: buildBareScanImportPreview(code)');
    expect(posLayout).not.toContain('Barcode not found');
  });

  it('sends bare creates through scan-create with createIfMiss and złoty price', () => {
    expect(posLayout).toContain('window.electronAPI.pos.masterCatalog.scanCreate({');
    expect(posLayout).toContain('retailPrice: retailPriceGrosze / 100,');
    expect(posLayout).toContain('createIfMiss: true,');
    expect(posLayout).toContain('taxRate: vatRate,');
    expect(posLayout).toContain('idempotencyKey: bareScanCreateIdempotencyKey({');
    // the draft and external paths are untouched
    expect(posLayout).toContain('window.electronAPI.pos.masterCatalog.importDraft(draftPayload)');
    expect(posLayout).toContain('window.electronAPI.pos.masterCatalog.importExternal({ ean, retailPriceGrosze, quantity: 1 })');
  });

  it('passes the cashier VAT pick and default stock through the modal confirm', () => {
    expect(modal).toContain('vatRate: number,');
    expect(modal).toContain('selectedVatRate,');
    expect(modal).toContain('BARE_CREATE_VAT_OPTIONS.map((rate) =>');
    expect(modal).toContain('String(BARE_CREATE_DEFAULT_STOCK)');
  });

  it('forwards createIfMiss end to end and mirrors the created variant locally', () => {
    expect(preload).toContain('createIfMiss?: boolean');
    expect(apiClient).toContain('if (payload.createIfMiss === true) body.createIfMiss = true;');
    expect(posModule).toContain('createIfMiss?: boolean;');
    expect(posModule).toContain("result?.mode === 'CREATED' && result?.variantId");
    expect(posModule).toContain("sku: `QS-${String(payload.ean).toUpperCase()}`");
  });
});

describe('bare-create custom name', () => {
  it('normalizes the typed name and treats the untouched EAN default as absent', () => {
    expect(normalizeBareCreateName('  Trân châu ô long  ', '5901234123457')).toBe('Trân châu ô long');
    expect(normalizeBareCreateName('5901234123457', '5901234123457')).toBeNull();
    expect(normalizeBareCreateName('   ', '5901234123457')).toBeNull();
    expect(normalizeBareCreateName(undefined, '5901234123457')).toBeNull();
  });

  it('keeps the legacy key byte-identical without a custom name, distinct+stable with one', () => {
    const base = {
      ean: '5901234123457',
      retailPriceGrosze: 1250,
      vatRate: 8,
      stockQty: 24,
      categoryId: null,
    };
    expect(bareScanCreateIdempotencyKey(base)).toBe('bare-5901234123457-1250-8-24-auto');
    expect(bareScanCreateIdempotencyKey({ ...base, name: null })).toBe('bare-5901234123457-1250-8-24-auto');
    expect(bareScanCreateIdempotencyKey({ ...base, name: base.ean })).toBe('bare-5901234123457-1250-8-24-auto');
    const named = bareScanCreateIdempotencyKey({ ...base, name: 'Trân châu ô long' });
    expect(named).not.toBe(bareScanCreateIdempotencyKey(base));
    expect(named).toBe(bareScanCreateIdempotencyKey({ ...base, name: ' Trân châu ô long ' }));
    expect(bareScanCreateIdempotencyKey({ ...base, name: 'Khác hẳn' })).not.toBe(named);
  });

  it('keeps the name token inside the 80-char cap even with a UUID category', () => {
    const wide = {
      ean: '12345678901234',
      retailPriceGrosze: 999_999_999_999,
      vatRate: 23,
      stockQty: 999_999_999,
      categoryId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    };
    const a = bareScanCreateIdempotencyKey({ ...wide, name: 'x'.repeat(300) });
    const b = bareScanCreateIdempotencyKey({ ...wide, name: 'y'.repeat(300) });
    expect(a.length).toBeLessThanOrEqual(80);
    expect(a).not.toBe(b);
  });
});

describe('bare-create custom name wiring', () => {
  it('lets the cashier edit the product name in the bare form', () => {
    expect(modal).toContain('nameInput');
    expect(modal).toContain('setNameInput(event.target.value)');
    expect(modal).toContain('name: string,');
  });

  it('sends the custom name through scan-create end to end', () => {
    expect(posLayout).toContain('normalizeBareCreateName(');
    expect(posLayout).toContain('name: bareCreateName ?? undefined,');
    expect(posLayout).toContain('result.productName || bareCreateName || ean');
    expect(apiClient).toContain('body.name = bareName;');
    expect(posModule).toContain('name?: string;');
    expect(posModule).toContain('result.productName || payload.name || payload.ean');
    expect(preload).toContain('name?: string;');
  });
});
