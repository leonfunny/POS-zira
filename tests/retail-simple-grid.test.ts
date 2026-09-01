/**
 * Retail "simple grid" (fair / market-stall) mode.
 *
 * A till taken to a fair sells a short fixed menu of home-cooked items: no
 * scanner, no categories, just tap the product and pay. With the per-device
 * switch on, the retail template shows the whole catalogue as one product
 * grid from the first render and hides the category strip and the unit
 * filter. With it off, nothing changes: the category gallery still greets the
 * cashier and the strip still drives browsing.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { shouldShowCategoryGallery } from '../src/renderer/components/pos/templates/retail/retailBrowseFilters';

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

describe('shouldShowCategoryGallery', () => {
  it('keeps the category gallery as the retail home when simple grid is off', () => {
    expect(shouldShowCategoryGallery({ simpleGrid: false, gridSearchQuery: '', activeCategoryId: null })).toBe(true);
    expect(shouldShowCategoryGallery({ simpleGrid: false, gridSearchQuery: '', activeCategoryId: 'cat-1' })).toBe(false);
    expect(shouldShowCategoryGallery({ simpleGrid: false, gridSearchQuery: '590', activeCategoryId: null })).toBe(false);
  });

  it('never shows the gallery in simple grid mode -- the product grid is the home screen', () => {
    expect(shouldShowCategoryGallery({ simpleGrid: true, gridSearchQuery: '', activeCategoryId: null })).toBe(false);
    expect(shouldShowCategoryGallery({ simpleGrid: true, gridSearchQuery: '', activeCategoryId: 'cat-1' })).toBe(false);
    expect(shouldShowCategoryGallery({ simpleGrid: true, gridSearchQuery: 'pho', activeCategoryId: null })).toBe(false);
  });
});

describe('retailSimpleGrid wiring', () => {
  it('is a persisted per-device config key with a false default', () => {
    const store = read('src/main/config/store.ts');
    expect(store).toMatch(/retailSimpleGrid:\s*\{\s*type:\s*'boolean',\s*default:\s*false\s*\}/);
    expect(store).toMatch(/^\s*retailSimpleGrid:\s*false,/m);
    expect(read('src/shared/types.ts')).toMatch(/retailSimpleGrid\?:\s*boolean/);
  });

  it('drives the retail template home screen and hides the category strip + unit filter', () => {
    const source = read('src/renderer/components/pos/templates/retail/RetailTemplate.tsx');
    expect(source).toMatch(/const simpleGrid = config\?\.retailSimpleGrid === true;/);
    expect(source).toMatch(/const showCategoryGallery = shouldShowCategoryGallery\(\{\s*simpleGrid,/);
    // Unit filter (kg / szt) is hidden: its role="group" block is gated.
    const unitFilterIdx = source.indexOf("aria-label={tOr('pos.unitFilter.label'");
    expect(unitFilterIdx).toBeGreaterThan(-1);
    expect(source.slice(unitFilterIdx - 400, unitFilterIdx)).toMatch(/\{!simpleGrid && \(/);
    // The "All" pill + category tiles are gated too.
    const allIdx = source.indexOf("{tOr('pos.allCategories', 'All')}");
    expect(allIdx).toBeGreaterThan(-1);
    expect(source.slice(allIdx - 1200, allIdx)).toMatch(/\{!simpleGrid && \(/);
    // The sync button must survive so the fair till can still refresh its menu.
    expect(source).toMatch(/onClick=\{handleManualSync\}/);
  });

  it('is switchable from Settings > POS and saved with the other POS settings', () => {
    const settings = read('src/renderer/components/Settings.tsx');
    expect(settings).toMatch(/useState\(config\?\.retailSimpleGrid \?\? false\)/);
    expect(settings).toMatch(/setRetailSimpleGrid\(config\.retailSimpleGrid \?\? false\)/);
    expect(settings).toMatch(/aria-checked=\{retailSimpleGrid\}/);
    expect(settings).toMatch(/^\s*retailSimpleGrid,\s*$/m);
    const translations = read('src/renderer/i18n/translations.ts');
    for (const key of ['settings.retailSimpleGrid', 'settings.retailSimpleGridDesc']) {
      expect((translations.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g')) || []).length).toBeGreaterThanOrEqual(3);
    }
  });
});
