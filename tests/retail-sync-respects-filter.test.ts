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
import type { Category, Product } from '../src/renderer/hooks/usePosDb';
import {
  countForRetailUnitFilter,
  countRetailProductsByCategory,
  filterRetailBrowseProducts,
  getVisibleRetailCategories,
} from '../src/renderer/components/pos/templates/retail/retailBrowseFilters';

const RETAIL_TEMPLATE = path.resolve(
  __dirname,
  '../src/renderer/components/pos/templates/retail/RetailTemplate.tsx',
);
const PRODUCT_CARD = path.resolve(
  __dirname,
  '../src/renderer/components/pos/ProductCard.tsx',
);

function product(overrides: Partial<Product>): Product {
  return {
    id: 'product',
    template_id: null,
    name: 'Product',
    sku: null,
    barcode: null,
    retail_price: 100,
    category_id: null,
    image_url: null,
    in_stock: 10,
    vat_rate: 23,
    is_active: 1,
    updated_at: null,
    available_qty: 10,
    sale_unit: 'szt.',
    sell_by: 'PIECE',
    ...overrides,
  };
}

const categories: Category[] = [
  { id: 'piece-cat', name: 'Piece Cat', icon: null, color: null, sort_order: 1, updated_at: null },
  { id: 'weight-cat', name: 'Weight Cat', icon: null, color: null, sort_order: 2, updated_at: null },
  { id: 'mixed-cat', name: 'Mixed Cat', icon: null, color: null, sort_order: 3, updated_at: null },
  { id: 'empty-cat', name: 'Empty Cat', icon: null, color: null, sort_order: 4, updated_at: null },
];

const products: Product[] = [
  product({ id: 'piece-1', category_id: 'piece-cat', sale_unit: 'szt.', sell_by: 'PIECE' }),
  product({ id: 'mixed-piece', category_id: 'mixed-cat', sale_unit: 'szt.', sell_by: 'PIECE' }),
  product({ id: 'weight-1', category_id: 'weight-cat', sale_unit: 'kg', sell_by: 'WEIGHT' }),
  product({ id: 'mixed-weight', category_id: 'mixed-cat', sale_unit: 'kg', sell_by: 'PIECE' }),
  product({ id: 'uncategorized-weight', category_id: null, sale_unit: 'kg', sell_by: 'WEIGHT' }),
];

describe('RetailTemplate - category switching uses renderer-side filtering', () => {
  const source = fs.readFileSync(RETAIL_TEMPLATE, 'utf8');

  it('derives non-search category products synchronously from allProducts and active unit filter', () => {
    expect(source).toMatch(/visibleCategoryProducts\s*=\s*useMemo/);
    expect(source).toContain('filterRetailBrowseProducts(allProducts, activeCategoryId, activeUnitFilter);');
    expect(source).toMatch(/visibleProducts\s*=\s*searchQuery \? visibleSearchProducts : visibleCategoryProducts/);
  });

  it('keeps displayed search products global while preserving variant/draft de-dupe', () => {
    expect(source).toContain('const visibleSearchProducts = useMemo(() => {');
    expect(source).toContain(
      'const variants = searchResults.filter((product) => !product._isDraft);',
    );
    expect(source).toContain('const variantBarcodes = new Set(');
    expect(source).toContain(
      '(product) => product._isDraft && (!product.barcode || !variantBarcodes.has(product.barcode)),',
    );
    expect(source).toContain('}, [searchResults]);');
    const start = source.indexOf('const visibleSearchProducts = useMemo(() => {');
    const end = source.indexOf('}, [searchResults]);', start);
    const block = source.slice(start, end);
    expect(block).not.toContain('activeUnitFilter');
    expect(block).not.toContain('productMatchesRetailUnitFilter');
    expect(block).not.toContain('category_id === activeCategoryId');
    expect(source).toMatch(/visibleProducts\s*=\s*searchQuery \? visibleSearchProducts : visibleCategoryProducts/);
  });

  it('clears and ignores browse active state while search is active', () => {
    expect(source).toContain('if (searchQuery && activeCategoryId !== null) setActiveCategoryId(null);');
    expect(source).toContain('const browseActiveCategoryId = searchQuery ? null : activeCategoryId;');
    expect(source).toContain("const browseUnitFilter = searchQuery ? 'all' : activeUnitFilter;");
    expect(source).toContain('const showCategoryGallery = !searchQuery && browseActiveCategoryId === null;');
    expect(source).toContain('!searchQuery && browseActiveCategoryId === null');
    expect(source).toContain('const isActive = browseUnitFilter === filter.id;');
    expect(source).toContain('const isActive = browseActiveCategoryId === cat.id;');
    expect(source).toContain('aria-disabled={searchQuery ? true : undefined}');
    expect(source).toContain('if (searchQuery) return;');
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

  it('renders category counts from the active unit filter and hides zero-count categories', () => {
    expect(source).toContain('countRetailProductsByCategory(allProducts)');
    expect(source).toContain('getVisibleRetailCategories(categories, categoryUnitCounts, browseUnitFilter)');
    expect(source).toContain('countForRetailUnitFilter(categoryUnitCounts.get(cat.id), browseUnitFilter)');
    expect(source).toContain('visibleCategories.map((cat) => {');
  });
});

describe('retail browse unit filter model', () => {
  it('All keeps total counts clear while exposing piece and kg counts separately', () => {
    const counts = countRetailProductsByCategory(products);

    expect(getVisibleRetailCategories(categories, counts, 'all').map((category) => category.id)).toEqual([
      'piece-cat',
      'weight-cat',
      'mixed-cat',
    ]);
    expect(countForRetailUnitFilter(counts.get('mixed-cat'), 'all')).toBe(2);
    expect(counts.get('mixed-cat')).toMatchObject({ piece: 1, kg: 1, total: 2 });
  });

  it('Piece shows only piece categories and piece product counts', () => {
    const counts = countRetailProductsByCategory(products);

    expect(getVisibleRetailCategories(categories, counts, 'piece').map((category) => category.id)).toEqual([
      'piece-cat',
      'mixed-cat',
    ]);
    expect(countForRetailUnitFilter(counts.get('piece-cat'), 'piece')).toBe(1);
    expect(countForRetailUnitFilter(counts.get('weight-cat'), 'piece')).toBe(0);
    expect(filterRetailBrowseProducts(products, 'mixed-cat', 'piece').map((item) => item.id)).toEqual([
      'mixed-piece',
    ]);
  });

  it('Kg shows weighted categories and products by sale metadata, not category names', () => {
    const counts = countRetailProductsByCategory(products);

    expect(getVisibleRetailCategories(categories, counts, 'kg').map((category) => category.id)).toEqual([
      'weight-cat',
      'mixed-cat',
    ]);
    expect(countForRetailUnitFilter(counts.get('mixed-cat'), 'kg')).toBe(1);
    expect(countForRetailUnitFilter(counts.get('piece-cat'), 'kg')).toBe(0);
    expect(filterRetailBrowseProducts(products, 'mixed-cat', 'kg').map((item) => item.id)).toEqual([
      'mixed-weight',
    ]);
  });

  it('browse category and unit filtering still works after search state is cleared', () => {
    expect(filterRetailBrowseProducts(products, null, 'kg').map((item) => item.id)).toEqual([
      'weight-1',
      'mixed-weight',
      'uncategorized-weight',
    ]);
    expect(filterRetailBrowseProducts(products, 'piece-cat', 'piece').map((item) => item.id)).toEqual([
      'piece-1',
    ]);
  });
});

describe('retail weighted product affordance', () => {
  const source = fs.readFileSync(PRODUCT_CARD, 'utf8');

  it('badges weighted product cards using the existing small badge style', () => {
    expect(source).toContain('saleClass.isWeighted && !soldOut');
    expect(source).toContain("saleClass.saleUnit.toLowerCase() === 'kg' ? 'kg' : 'WEIGHT'");
  });
});
