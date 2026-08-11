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
