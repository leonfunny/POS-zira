// Opt-in real Chromium CSS regression; no Electron, account or network access.
// PowerShell: $env:RUN_RESTAURANT_BROWSER_TESTS='1'; npx vitest run tests/restaurant-theme.browser.test.tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import ProductCard from '../src/renderer/components/pos/ProductCard';
import RestaurantMenu, { RestaurantCategoryRail } from '../src/renderer/components/pos/templates/restaurant/RestaurantMenu';
import Cart from '../src/renderer/components/pos/Cart';
import DiningOptions from '../src/renderer/components/pos/templates/restaurant/DiningOptions';
import { getTranslation } from '../src/renderer/i18n/translations';

const root = resolve(__dirname, '..');
const t = getTranslation('en');
const noop = () => {};
const categories = ['Shareables', 'Salads', 'Handhelds', 'Mains', 'Desserts', 'Beverages'].map((name, i) => ({ id: String(i), name }));
const names = ['Truffle Fries', 'Spinach Dip', 'Calamari', 'Brussels Sprouts', 'Short Rib', 'Cobb Salad'];
// Deliberately synthetic image; never copied into the app catalog.
const thumbnail = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#292d36"/><ellipse cx="150" cy="107" rx="91" ry="60" fill="#ddd9c8"/><ellipse cx="150" cy="103" rx="75" ry="44" fill="#607146"/><path d="M100 110L155 60L190 107L136 142Z" fill="#bc8c4c"/></svg>');
const products = categories.flatMap((category, c) => names.map((name, i) => ({ id: `${c}-${i}`, category_id: category.id,
  name: c === 0 ? name : `${category.name} ${i + 1}`, retail_price: 1590 + i * 200, track_stock: false,
  thumbnail_url: i === 5 ? null : thumbnail,
}))) as any[];
const cart = { items: products.slice(0, 4).map((p, i) => ({ id: p.id, variantId: p.id, name: p.name,
  price: p.retail_price, quantity: 1, total: p.retail_price, vatRate: 8, notes: i === 1 ? 'No onion' : null })),
  subtotal: 7560, total: 7560, discount: 0, tax: 560 } as any;

function fixture(android = false) {
  const markup = renderToStaticMarkup(<div className="pos-layout" data-pos-mode="restaurant" style={{ height: android ? '100%' : '100vh', display: 'flex', flexDirection: 'column' }}>
    <header className="pos-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span>Zira POS · UI test fixture</span><span>Online · 4:45 PM</span>
    </header>
    <div className="restaurant-pos">
      <RestaurantCategoryRail categories={categories as any} activeId={null} onSelect={noop} lang="en" t={t} />
      <main className="restaurant-workspace">
        <div className="restaurant-toolbar"><div className="restaurant-view-tabs">
          <button>Tables</button><button aria-pressed="true">Menu</button><button>Checks</button>
        </div></div>
        <RestaurantMenu products={products} categories={categories as any} loading={false} error={null} searchQuery="" resetScrollKey=""
          onRetry={noop} onClearSearch={noop} onAddProduct={noop} lang="en" t={t} />
      </main>
      <aside className="restaurant-order">
        <div className="restaurant-order-context"><div className="restaurant-order-owner"><span>{android ? 'Staff · UI fixture' : 'Jack · Table 21'}</span></div>
          {android && <DiningOptions orderType="takeout" onChange={noop} t={t} />}
        </div>
        <div className="restaurant-cart-host"><Cart cart={cart} dispatch={noop} onPay={noop} compactItems t={t} lang="en" /></div>
      </aside>
    </div>
  </div>);
  return android ? `<div class="android-pos-shell h-screen flex flex-col" data-pos-mode="restaurant"><nav class="flex shrink-0 border-b bg-white"><button class="flex-1 py-3" aria-pressed="true">POS</button><button class="flex-1 py-3">Bi-a</button></nav><div class="flex-1 min-h-0">${markup}</div></div>` : markup;
}

const luminance = (rgb: string) => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) || []).slice(0, 3).map(Number).map(x => x / 255)
    .map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
};
const contrast = (a: string, b: string) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
};

describe.skipIf(process.env.RUN_RESTAURANT_BROWSER_TESTS !== '1')('Restaurant real-browser theme', () => {
  let browser: Browser;
  let shared: string;
  let theme: string;
  const builtCss = (directory: string) => readdirSync(resolve(root, directory)).filter(file => file.endsWith('.css'))
    .map(file => readFileSync(resolve(root, directory, file), 'utf8')).join('\n');
  beforeAll(async () => {
    try { browser = await chromium.launch({ headless: true }); }
    catch { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
    const source = readFileSync(resolve(root, 'src/renderer/index.css'), 'utf8');
    shared = (await postcss([tailwindcss(resolve(root, 'tailwind.config.js'))]).process(source, { from: resolve(root, 'src/renderer/index.css') })).css;
    theme = readFileSync(resolve(root, 'src/renderer/components/pos/templates/restaurant/restaurant-pos.css'), 'utf8');
  }, 30000);
  afterAll(async () => { await browser?.close(); });

  for (const order of ['theme-first', 'theme-last', 'built', 'android-built'] as const) {
    it(`retains category bands, text contrast and retail styling (${order})`, async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        let css = order === 'theme-first' ? theme + shared : shared + theme;
        if (order === 'built' || order === 'android-built') {
          const assets = resolve(root, order === 'android-built' ? 'dist/android-web/assets' : 'dist/renderer/assets');
          const sheets = readdirSync(assets).filter(file => file.endsWith('.css'));
          expect(sheets.length).toBeGreaterThan(0);
          css = sheets.map(file => readFileSync(resolve(assets, file), 'utf8')).join('\n');
        }
        const retail = renderToStaticMarkup(<div id="retail" style={{ width: 180 }}><ProductCard product={products[0]} onAdd={noop} t={t} /></div>);
        await page.setContent(`<style>${css}</style>${fixture()}${retail}`);
        const cards = await page.locator('.restaurant-product').evaluateAll(nodes => nodes.map(node => ({
          color: getComputedStyle(node).backgroundColor,
          band: (node as HTMLElement).style.getPropertyValue('--restaurant-category-color'),
          padding: getComputedStyle(node).padding,
          text: getComputedStyle(node.querySelector('.pos-product-name p')!).color,
          price: getComputedStyle(node.querySelector('.pos-product-price > span')!).color,
        })));
        expect(cards).toHaveLength(products.length);
        for (const card of cards) {
          const rgb = card.band.slice(1).match(/../g)!.map(x => parseInt(x, 16));
          expect(card.color).toBe(`rgb(${rgb.join(', ')})`);
          expect(card.padding).toBe('0px');
          expect(contrast(card.text, card.color)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(card.price, card.color)).toBeGreaterThanOrEqual(4.5);
        }
        const retailStyle = await page.locator('#retail > div').evaluate(node => ({ bg: getComputedStyle(node).backgroundColor,
          text: getComputedStyle(node.querySelector('p')!).color, padding: getComputedStyle(node).padding }));
        expect(retailStyle.bg).toBe('rgb(255, 255, 255)');
        expect(retailStyle.padding).toBe('6px');
        expect(contrast(retailStyle.text, retailStyle.bg)).toBeGreaterThanOrEqual(4.5);
        // Inspect the actual focus indicator, not just the presence of a class.
        if (order !== 'built') {
          await page.locator('.restaurant-product').first().focus();
          const focus = await page.locator('.restaurant-product').first().evaluate(node => ({
            style: getComputedStyle(node).outlineStyle, width: getComputedStyle(node).outlineWidth,
            color: getComputedStyle(node).outlineColor, bg: getComputedStyle(node).backgroundColor,
          }));
          expect(focus.style).toBe('solid');
          expect(focus.width).toBe('2px');
          expect(contrast(focus.color, focus.bg)).toBeGreaterThanOrEqual(3);
        }
      } finally { await page.close(); }
    });
  }

  for (const [width, height] of [[2560, 1440], [1920, 1080], [1440, 900], [1024, 768], [768, 1024], [390, 844]]) {
    it(`keeps the menu and checkout within ${width}x${height}`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        // Worst-case dev/HMR order, not only the production bundle order.
        await page.setContent(`<style>${theme}${shared}</style>${fixture()}`);
        await page.locator('.restaurant-product').first().waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        const pay = await page.locator('.pos-pay-button').boundingBox();
        expect(pay).not.toBeNull();
        expect(pay!.y + pay!.height).toBeLessThanOrEqual(height + 1);
        const menu = await page.locator('.restaurant-menu-scroll').boundingBox();
        expect(menu!.height).toBeGreaterThan(100);
        const tile = await page.locator('.restaurant-product').first().boundingBox();
        expect(tile!.width).toBeGreaterThanOrEqual(140);
        const columns = await page.locator('.restaurant-menu-grid').first().evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
        expect(columns).toBeLessThanOrEqual(7);
        if (width >= 1024) {
          const rail = await page.locator('.restaurant-categories').boundingBox();
          const order = await page.locator('.restaurant-order').boundingBox();
          expect(rail!.x + rail!.width).toBeLessThanOrEqual(menu!.x + 1);
          expect(menu!.x + menu!.width).toBeLessThanOrEqual(order!.x + 1);
        }
        if (process.env.RESTAURANT_THEME_SCREENSHOTS) {
          const output = resolve(process.env.RESTAURANT_THEME_SCREENSHOTS);
          mkdirSync(output, { recursive: true });
          await page.screenshot({ path: resolve(output, `restaurant-${width}x${height}.png`) });
        }
      } finally { await page.close(); }
    });
  }

  for (const [width, height] of [[1280, 800], [1024, 768], [800, 1280]]) {
    it(`Android bundled theme fits a touch POS ${width}x${height}`, async () => {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
      try {
        await page.setContent(`<style>${builtCss('dist/android-web/assets')}</style>${fixture(true)}`);
        const nav = await page.locator('.android-pos-shell > nav').evaluate(node => getComputedStyle(node).backgroundColor);
        expect(nav).toBe('rgb(25, 30, 44)');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        const pay = (await page.locator('.pos-pay-button').boundingBox())!;
        expect(pay.height).toBeGreaterThanOrEqual(48);
        expect(pay.y + pay.height).toBeLessThanOrEqual(height + 1);
        const menu = (await page.locator('.restaurant-menu-scroll').boundingBox())!;
        expect(menu.height).toBeGreaterThan(250);
        const first = page.locator('.restaurant-product').first();
        expect((await first.boundingBox())!.width).toBeGreaterThanOrEqual(140);
        await first.tap();
        if (process.env.RESTAURANT_THEME_SCREENSHOTS) {
          const output = resolve(process.env.RESTAURANT_THEME_SCREENSHOTS); mkdirSync(output, { recursive: true });
          await page.screenshot({ path: resolve(output, `android-counter-fixture-${width}x${height}.png`) });
        }
      } finally { await page.close(); }
    });
  }
});
