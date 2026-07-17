#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const webRoot = resolve(root, 'dist/android-web');
const viewports = [
  { name: 'tablet-landscape', width: 1280, height: 800 },
  { name: 'phone-portrait', width: 412, height: 915 },
  { name: 'short-landscape-split', width: 915, height: 412 },
];

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const server = createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const relativePath = requestPath === '/' ? 'index.html' : decodeURIComponent(requestPath.slice(1));
    const filePath = resolve(webRoot, relativePath);
    if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('not a file');
    response.writeHead(200, { 'Content-Type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream' });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
assert.ok(address && typeof address === 'object', 'responsive test server did not bind');
const pageUrl = `http://127.0.0.1:${address.port}/`;
const browser = await chromium.launch({ headless: true });

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    await page.goto(pageUrl, { waitUntil: 'load' });

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert.ok(
      dimensions.scrollWidth <= dimensions.clientWidth,
      `${viewport.name}: horizontal page overflow ${dimensions.scrollWidth} > ${dimensions.clientWidth}`,
    );

    const checkout = page.locator('#checkout-lock');
    assert.equal(await checkout.isDisabled(), true, `${viewport.name}: checkout must remain disabled`);

    await page.locator('label[for="category-gel"]').click();
    assert.equal(
      await page.locator('.product-card:visible').count(),
      2,
      `${viewport.name}: CSS-only gel filter must expose exactly two synthetic cards`,
    );

    if (viewport.name === 'short-landscape-split') {
      const safetyNote = page.locator('.lock-note');
      for (const [name, locator] of [['checkout', checkout], ['safety note', safetyNote]]) {
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        assert.ok(box, `${viewport.name}: ${name} has no layout box`);
        assert.ok(box.y >= 0, `${viewport.name}: ${name} remains above the viewport`);
        assert.ok(
          box.y + box.height <= viewport.height,
          `${viewport.name}: ${name} remains below the viewport after scrolling`,
        );
      }
    }

    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

console.log('PASS Android responsive policy: tablet, portrait, and short landscape/split viewports verified');
