/**
 * RetailTemplate - category switching must not render stale full-catalog rows.
 *
 * Regression: clicking a category could leave the category gallery and render
 * ProductGrid with the previous async `products` state, often the full catalog,
 * until the category IPC query completed.
 *
 * Fix: non-search category browsing is derived synchronously from the renderer's
 * local `allProducts` cache. Search fetches keep raw async results, while the
 * displayed search rows are derived synchronously from those results plus the
 * active category so category changes do not wait for the search debounce.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const RETAIL_TEMPLATE = path.resolve(
  __dirname,
  '../src/renderer/components/pos/templates/retail/RetailTemplate.tsx',
);

describe('RetailTemplate - category switching uses renderer-side filtering', () => {
  const source = fs.readFileSync(RETAIL_TEMPLATE, 'utf8');

  it('derives non-search category products synchronously from allProducts', () => {
    expect(source).toMatch(/visibleCategoryProducts\s*=\s*useMemo/);
    expect(source).toMatch(
      /allProducts\.filter\(\(product\) => product\.category_id === activeCategoryId\)/,
    );
    expect(source).toMatch(/visibleProducts\s*=\s*searchQuery \? visibleSearchProducts : visibleCategoryProducts/);
  });

  it('derives displayed search products synchronously from raw searchResults and activeCategoryId', () => {
    expect(source).toContain('const visibleSearchProducts = useMemo(() => {');
    expect(source).toContain(
      'searchResults.filter((product) => !product._isDraft && product.category_id === activeCategoryId)',
    );
    expect(source).toContain('const variantBarcodes = new Set(');
    expect(source).toContain(
      '(product) => product._isDraft && (!product.barcode || !variantBarcodes.has(product.barcode)),',
    );
    expect(source).toContain('}, [searchResults, activeCategoryId]);');
    expect(source).toMatch(/visibleProducts\s*=\s*searchQuery \? visibleSearchProducts : visibleCategoryProducts/);
  });

  it('ProductGrid consumes visibleProducts instead of raw async search state directly', () => {
    const idx = source.indexOf('<ProductGrid');
    expect(idx, 'ProductGrid usage not found').toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 350);

    expect(block).toMatch(/products=\{visibleProducts\}/);
    expect(block).not.toMatch(/products=\{searchResults\}/);
    expect(block).not.toMatch(/products=\{visibleSearchProducts\}/);
    expect(block).not.toMatch(/products=\{products\}/);
  });

  it('does not query category rows over IPC for retail category browsing', () => {
    expect(source).not.toMatch(/pos\.products\.getByCategory/);
  });

  it('keeps draft product search/import behavior on the async search path', () => {
    expect(source).toMatch(/pos\.products\.search\(searchQuery\)/);
    expect(source).toMatch(/draftProducts\s*\.\s*searchByCode\(searchQuery\)/);
    expect(source).toMatch(/_isDraft:\s*true/);
    expect(source).not.toMatch(/setSearchResults\(visibleCategoryProducts\)/);
    expect(source).not.toMatch(/setSearchResults\(allProducts\)/);
  });

  it('sync refreshes allProducts and preserves active category or search state', () => {
    const idx = source.indexOf('onProductsSynced(');
    expect(idx, 'onProductsSynced subscription not found').toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 900);

    expect(block).toMatch(/pos\.categories\.getAll\(\)/);
    expect(block).toMatch(/pos\.products\.getAll\(\)/);
    expect(block).toMatch(/setAllProducts\(prods\)/);
    expect(block).toMatch(/if \(searchQuery\)/);
    expect(block).toMatch(/loadSearchResults\(\)/);
    expect(block).not.toMatch(/setProducts/);
  });
});
