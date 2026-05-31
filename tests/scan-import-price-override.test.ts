import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const modal = readSource('../src/renderer/components/pos/ScanImportModal.tsx');
const posLayout = readSource('../src/renderer/components/pos/POSLayout.tsx');
const posModule = readSource('../src/main/modules/pos.module.ts');
const preload = readSource('../src/preload/preload-pos.ts');
const electronDts = readSource('../src/shared/electron.d.ts');

describe('POS scan-import draft price override', () => {
  it('asks the cashier for a selling price before importing a draft product', () => {
    expect(modal).toContain('onConfirm: (retailPriceGrosze: number)');
    expect(modal).toContain('function parsePriceInput');
    expect(modal).toContain("tOr('pos.scanImport.draftPrice', 'Draft price')");
    expect(modal).toContain("tOr('pos.scanImport.salePrice', 'Selling price')");
    expect(modal).toContain('disabled={loading || !preview || retailPriceGrosze == null}');
    expect(modal).toContain('onConfirm(retailPriceGrosze)');
  });

  it('passes the entered selling price through POS import-draft IPC', () => {
    expect(posLayout).toContain('const confirmScanImport = useCallback(async (retailPriceGrosze: number) => {');
    expect(posLayout).toContain('window.electronAPI.pos.masterCatalog.importDraft({ ean, retailPriceGrosze })');
    expect(preload).toContain('importDraft: (payload: { ean: string; retailPriceGrosze?: number })');
    expect(electronDts).toContain('importDraft: (payload: { ean: string; retailPriceGrosze?: number })');
  });

  it('saves the cashier-entered price into the local sellable variant', () => {
    expect(posModule).toContain('payload: { ean: string; retailPriceGrosze?: number }');
    expect(posModule).toContain('const importRetailPrice = retailPriceGrosze != null && retailPriceGrosze >= 1');
    expect(posModule).toContain('retail_price: importRetailPrice');
    expect(posModule).toContain('price_gross: importRetailPrice');
    expect(posModule).toContain('vat_amount: importRetailPrice - Math.round(importRetailPrice * 100 / (100 + (draft.vat_rate || 0)))');
  });
});
