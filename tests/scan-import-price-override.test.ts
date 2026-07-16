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
  it('asks the cashier for a selling price and never preloads a supplier price', () => {
    expect(modal).toContain('retailPriceGrosze: number,');
    expect(modal).toContain('stockQty: number,');
    expect(modal).toContain('function parsePriceInput');
    expect(modal).toContain("setPriceInput('')");
    expect(modal).not.toContain("tOr('pos.scanImport.draftPrice', 'Draft price')");
    expect(modal).toContain("tOr('pos.scanImport.salePrice', 'Selling price')");
    expect(modal).toContain('retailPriceGrosze == null ||');
    expect(modal).toContain('selectedCategoryId || undefined,');
  });

  it('passes selling price, optional category, and optional store stock through IPC', () => {
    expect(posLayout).toContain('const confirmScanImport = useCallback(async (');
    expect(posLayout).toContain('stockQty: number,');
    expect(posLayout).toContain('const draftPayload = categoryId');
    expect(posLayout).toContain('window.electronAPI.pos.masterCatalog.importDraft(draftPayload)');
    expect(preload).toContain('categoryId?: string; stockQty?: number');
    expect(electronDts).toContain('categoryId?: string; stockQty?: number');
  });

  it('saves the cashier-entered price into the local sellable variant', () => {
    expect(posModule).toContain('retailPriceGrosze?: number;');
    expect(posModule).toContain('stockQty?: number;');
    expect(posModule).toContain('const importRetailPrice = retailPriceGrosze;');
    expect(posModule).not.toContain(': draft.retail_price;');
    expect(posModule).toContain('retail_price: importRetailPrice');
    expect(posModule).toContain('price_gross: importRetailPrice');
    expect(posModule).toContain('vat_amount: importRetailPrice - Math.round(importRetailPrice * 100 / (100 + (draft.vat_rate || 0)))');
  });

  it('loads every local category and defaults blank store stock to zero', () => {
    expect(modal).toContain("tOr('pos.scanImport.category', 'Danh mục')");
    expect(modal).toContain("tOr('pos.scanImport.defaultCategory', 'Chưa phân loại (mặc định)')");
    expect(modal).toContain('resolveInitialScanImportCategoryId(preview, categoryOptions)');
    expect(modal).toContain('categoryOptions.length > 0');
    expect(modal).toContain('export function parseOptionalScanImportStock');
    expect(modal).toContain('if (!normalized) return 0;');
    expect(posLayout).toContain('window.electronAPI.pos.categories.getAllIncludingEmpty()');
    expect(posLayout).toContain('suggestedCategoryId');
    expect(posLayout).toContain('{ ean, retailPriceGrosze, categoryId, stockQty }');
    expect(posLayout).toContain('{ ean, retailPriceGrosze, stockQty }');
    expect(posModule).not.toContain("error: 'draft-missing-stock'");
  });
});
