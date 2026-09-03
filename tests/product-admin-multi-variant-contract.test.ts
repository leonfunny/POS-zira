import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source assertions, not behaviour: the three wiring points below live inside
 * `pos.module.ts`, whose closures cannot be reached without standing up the
 * whole Electron main process. They are cheap to delete by accident and each
 * deletion is silent — a grid would still create eighteen rows on the server
 * and show one on the machine — so they are pinned here in the same style as
 * `product-admin-create-contract.test.ts` rather than left uncovered.
 *
 * Everything with real behaviour behind it is tested for real: the payload in
 * `order-to-product.test.ts`, the button in `print-order-file-product.test.tsx`,
 * the sync mapping in `entity-applicators-variant-colour-size.test.ts`.
 */

const root = resolve(__dirname, '..');

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('multi-variant create wiring', () => {
  it('mirrors every row a grid create returns, not only the first', () => {
    const module = source('src/main/modules/pos.module.ts');
    const applyBranch =
      module.match(/case 'CREATE_PRODUCT':\n {12}await runProductAdminLocalMutationAfterPendingCatalogSync[\s\S]*?\n {12}break;/)?.[0] ?? '';

    expect(applyBranch).toContain('response?.variants');
    expect(applyBranch).toMatch(/for \(const createdVariant of created\)/);
  });

  it('carries colour and size into the local mirror row', () => {
    const module = source('src/main/modules/pos.module.ts');
    const mirror =
      module.match(/const mirrorProductAdminVariant = [\s\S]*?productRepo\.upsertMany\(\[row\]\);/)?.[0] ?? '';

    expect(mirror).toContain('color_name:');
    expect(mirror).toContain('size_name:');
    expect(mirror).toContain("hasOwnProperty.call(variant, 'colorName')");
  });

  it('checks the price and quantity of every cell before dispatching', () => {
    const module = source('src/main/modules/pos.module.ts');
    const dispatch =
      module.match(/case 'CREATE_PRODUCT': \{[\s\S]*?return apiClient\.createProductVariant/)?.[0] ?? '';

    expect(dispatch).toContain('Array.isArray(payload.variants)');
    expect(dispatch).toContain('variants[${index}].initialStockQty');
  });

  it('writes the colour and size columns on every upsert', () => {
    const repo = source('src/main/database/repos/product-repo.ts');
    const upsert = repo.match(/upsertMany\(products: ProductVariantRow\[\]\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? '';

    expect(upsert).toContain('color_name, size_name');
    // INSERT OR REPLACE rewrites the row, so an older payload must not blank
    // what is stored.
    expect(upsert).toContain('SELECT color_name FROM product_variants WHERE id = ?');
    expect(upsert).toContain('SELECT size_name FROM product_variants WHERE id = ?');
  });

  it('keeps the fabric branch migration off main’s numbering', () => {
    const migrations = source('src/main/database/migrations.ts');
    const added = migrations.match(/version: 900,[\s\S]*?\n {2}\},/)?.[0] ?? '';

    expect(added).toContain("name: 'variant_colour_and_size'");
    expect(added).toContain('ALTER TABLE product_variants ADD COLUMN color_name TEXT');
    expect(added).toContain('ALTER TABLE product_variants ADD COLUMN size_name TEXT');
  });
});
