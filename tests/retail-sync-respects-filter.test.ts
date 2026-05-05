/**
 * RetailTemplate — pos:products-synced must respect the active filter.
 *
 * Regression: the previous handler called `setProducts(all)` on every
 * sync event. With the new 30s periodic ProductSync that fires every 30s
 * regardless of cashier activity, the visible grid was being reset to
 * the full catalogue while the cashier was filtering by category or
 * typing a search query. Not a data bug, but disruptive at the till.
 *
 * Fix: extract one `loadFilteredProducts()` helper that respects the
 * current `searchQuery` + `activeCategoryId` and reuse it from both the
 * filter-change effect and the sync-event effect.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const RETAIL_TEMPLATE = path.resolve(
  __dirname,
  '../src/renderer/components/pos/templates/retail/RetailTemplate.tsx',
);

describe('RetailTemplate — pos:products-synced respects current filter', () => {
  const source = fs.readFileSync(RETAIL_TEMPLATE, 'utf8');

  it('defines the shared loadFilteredProducts helper', () => {
    expect(source).toMatch(/loadFilteredProducts\s*=\s*useCallback/);
  });

  it('loadFilteredProducts useCallback depends on searchQuery and activeCategoryId', () => {
    // Capture the dep array of the loadFilteredProducts useCallback.
    const match = source.match(
      /loadFilteredProducts\s*=\s*useCallback\([\s\S]*?,\s*\[([^\]]*)\]\s*\)/,
    );
    expect(match, 'loadFilteredProducts useCallback dep array not found').not.toBeNull();
    const deps = match![1];
    expect(deps).toMatch(/searchQuery/);
    expect(deps).toMatch(/activeCategoryId/);
  });

  it('the onProductsSynced handler reuses loadFilteredProducts (no setProducts(all))', () => {
    // Locate the onProductsSynced subscription block.
    const idx = source.indexOf('onProductsSynced(');
    expect(idx, 'onProductsSynced subscription not found').toBeGreaterThan(-1);
    // Inspect the next ~600 chars — comfortably covers the callback body
    // and the surrounding useEffect cleanup.
    const block = source.slice(idx, idx + 600);
    // Regression guard: the old `setProducts(all)` pattern must not be
    // present in this block. (Without the substring guard the broader
    // file might still contain the legacy pattern elsewhere.)
    expect(block).not.toMatch(/setProducts\(\s*all\s*\)/);
    // Forward guard: the new handler must call loadFilteredProducts so
    // the grid honours the cashier's current category / search filter.
    expect(block).toMatch(/loadFilteredProducts\(\)/);
  });

  it('reuses loadFilteredProducts in BOTH the filter-change effect and the sync handler', () => {
    // The whole point of extracting the helper is to share it between
    // the two callers — the filter-change effect AND the
    // pos:products-synced handler. If a future contributor re-inlines
    // the branches into one of them, we want this test to fail.
    const callCount = (source.match(/loadFilteredProducts\s*\(\s*\)/g) ?? []).length;
    expect(
      callCount,
      'loadFilteredProducts() must be invoked from at least 2 sites (filter effect + sync handler)',
    ).toBeGreaterThanOrEqual(2);
  });
});
