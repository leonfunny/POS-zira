import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  lookupExternalProductByEan,
  lookupOpenFoodFactsProduct,
  normalizeEan,
  parseGoogleSearchProduct,
  parseOpenFoodFactsProduct,
} from '../src/main/pos/external-product-lookup';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const posLayout = readSource('../src/renderer/components/pos/POSLayout.tsx');
const posModule = readSource('../src/main/modules/pos.module.ts');
const preload = readSource('../src/preload/preload-pos.ts');
const electronDts = readSource('../src/shared/electron.d.ts');
const externalLookup = readSource('../src/main/pos/external-product-lookup.ts');

describe('external EAN lookup flow', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('normalizes supported EAN and UPC barcodes before external lookup', () => {
    expect(normalizeEan(' 590-1234 567890 ')).toBe('5901234567890');
    expect(normalizeEan('12345678')).toBe('12345678');
    expect(normalizeEan('ABC123')).toBeNull();
    expect(normalizeEan('12345')).toBeNull();
  });

  it('maps an Open Food Facts payload into the scan-import preview shape', () => {
    expect(parseOpenFoodFactsProduct({
      status: 1,
      product: {
        code: '5901234567890',
        product_name_pl: 'Sok jablkowy',
        brands: 'Brand A',
        quantity: '1 l',
        image_front_url: 'https://images.openfoodfacts.org/front.jpg',
      },
    }, '5901234567890')).toMatchObject({
      source: 'open_food_facts',
      id: 'open-food-facts:5901234567890',
      ean: '5901234567890',
      barcode: '5901234567890',
      name: 'Sok jablkowy',
      brand: 'Brand A',
      quantity: '1 l',
      imageUrl: 'https://images.openfoodfacts.org/front.jpg',
      retailPriceGrosze: 0,
      stockQty: 1,
      vatRate: 23,
      status: 'OPEN_FOOD_FACTS',
    });
  });

  it('maps a Google Custom Search result into a low-confidence external preview', () => {
    expect(parseGoogleSearchProduct({
      items: [{
        title: '5901234567890 - Sok jablkowy 1 l - Sklep spozywczy',
        snippet: 'Kod kreskowy 5901234567890. Napoj owocowy Brand A.',
        link: 'https://example.test/products/sok-jablkowy',
        pagemap: {
          metatags: [{
            'og:image': 'https://example.test/sok.jpg',
          }],
        },
      }],
    }, '5901234567890')).toMatchObject({
      source: 'google_custom_search',
      id: 'google-custom-search:5901234567890',
      ean: '5901234567890',
      barcode: '5901234567890',
      name: 'Sok jablkowy 1 l',
      quantity: '1 l',
      imageUrl: 'https://example.test/sok.jpg',
      retailPriceGrosze: 0,
      stockQty: 1,
      vatRate: 23,
      status: 'GOOGLE_SEARCH',
      sourceUrl: 'https://example.test/products/sok-jablkowy',
    });
  });

  it('calls Open Food Facts with a custom User-Agent and field-limited URL', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      expect(String(url)).toContain('https://world.openfoodfacts.org/api/v2/product/5901234567890.json');
      expect(String(url)).toContain('fields=');
      expect((options?.headers as Record<string, string>)['User-Agent']).toContain('ZiraAI-POS');
      return new Response(JSON.stringify({
        status: 1,
        product: {
          code: '5901234567890',
          product_name: 'Apple juice',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    await expect(lookupOpenFoodFactsProduct('5901234567890')).resolves.toMatchObject({
      name: 'Apple juice',
      source: 'open_food_facts',
    });
  });

  it('falls back from Open Food Facts to Google Custom Search when Google is configured', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href.includes('openfoodfacts.org')) {
        return new Response('', { status: 404 });
      }
      expect(href).toContain('https://www.googleapis.com/customsearch/v1?');
      expect(href).toContain('key=test-key');
      expect(href).toContain('cx=test-cx');
      return new Response(JSON.stringify({
        items: [{
          title: '5901234567890 - Sok jablkowy 1 l - Sklep',
          snippet: 'EAN 5901234567890',
          link: 'https://example.test/sok',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    await expect(lookupExternalProductByEan('5901234567890', {
      google: { apiKey: 'test-key', cx: 'test-cx' },
    })).resolves.toMatchObject({
      name: 'Sok jablkowy 1 l',
      source: 'google_custom_search',
    });
    expect(calls[0]).toContain('openfoodfacts.org');
    expect(calls[1]).toContain('googleapis.com/customsearch');
  });

  it('falls back to external lookup only after local draft and master catalog miss', () => {
    expect(posLayout).toContain('pos.draftProducts.getByBarcode(code)');
    expect(posLayout).toContain('pos.masterCatalog.lookupByEan(code)');
    expect(posLayout).toContain('pos.masterCatalog.lookupExternalByEan(code)');
    expect(posLayout.indexOf('pos.masterCatalog.lookupByEan(code)'))
      .toBeLessThan(posLayout.indexOf('pos.masterCatalog.lookupExternalByEan(code)'));
  });

  it('imports external matches through backend quick-add instead of local-only draft import', () => {
    expect(posLayout).toContain("source === 'open_food_facts' || source === 'google_custom_search'");
    expect(posLayout).toContain('window.electronAPI.pos.masterCatalog.importExternal({ ean, retailPriceGrosze, quantity: 1 })');
    expect(posModule).toContain("'pos:master-catalog:lookup-external-by-ean'");
    expect(posModule).toContain("'pos:master-catalog:import-external'");
    expect(posModule).toContain('apiClient.quickAddCreate(token, {');
    expect(posModule).toContain("outcome: 'EXTERNAL_IMPORT'");
    expect(posModule).toContain('lookupExternalProductByEan(ean, getExternalProductLookupOptions())');
  });

  it('exposes the external lookup IPC contract in preloads and typings', () => {
    expect(preload).toContain('lookupExternalByEan: (ean: string)');
    expect(preload).toContain("'pos:master-catalog:lookup-external-by-ean'");
    expect(preload).toContain('importExternal: (payload: { ean: string; retailPriceGrosze?: number; quantity?: number })');
    expect(preload).toContain("'pos:master-catalog:import-external'");
    expect(electronDts).toContain('lookupExternalByEan: (ean: string)');
    expect(electronDts).toContain('importExternal: (payload: { ean: string; retailPriceGrosze?: number; quantity?: number })');
    expect(externalLookup).toContain('OPEN_FOOD_FACTS_USER_AGENT');
  });
});
