import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Products core UX', () => {
  it('keeps mutation success feedback at module level', () => {
    const moduleSource = source('src/renderer/components/products/ProductModule.tsx');
    const editForm = source('src/renderer/components/products/ProductEditForm.tsx');
    const stockDialog = source('src/renderer/components/products/StockAdjustmentDialog.tsx');

    expect(moduleSource).toContain("products.create.success");
    expect(moduleSource).toContain("products.edit.success");
    expect(moduleSource).toContain("products.stock.successDetail");
    expect(editForm).toContain('disabled={busy || !dirty}');
    expect(stockDialog).toContain('onAdjusted(result.data');
  });

  it('uses basic and advanced disclosure and correct uncategorised labels', () => {
    const create = source('src/renderer/components/products/ProductCreateDialog.tsx');
    const edit = source('src/renderer/components/products/ProductEditForm.tsx');

    expect(create).toContain('advancedOpen');
    expect(edit).toContain('advancedOpen');
    expect(create).toContain("products.advanced");
    expect(edit).toContain("products.advanced");
    expect(create).toContain("products.uncategorised");
    expect(edit).toContain("products.uncategorised");
  });

  it('uses touch-safe toolbar controls and neutral product tiles', () => {
    const moduleSource = source('src/renderer/components/products/ProductModule.tsx');
    const tile = source('src/renderer/components/products/ProductTile.tsx');

    expect(moduleSource).not.toContain('min-h-8');
    expect(moduleSource).not.toContain('className="inline-flex h-9');
    expect(tile).not.toContain('stockTileClasses(stock)');
    expect(tile).toContain('bg-white text-slate-950');
    expect(tile).toContain('product.sku || product.barcode');
    expect(tile).toContain('motion-reduce:transition-none');
  });
});
