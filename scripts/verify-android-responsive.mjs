#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

import { chromium } from 'playwright';

// S6+S7: the built Android bundle now boots the REAL app — with no persisted
// session the boot component resolves auth.getUser() → unauthenticated and
// renders the staff LoginScreen. This smoke verifies that real boot path at
// tablet/phone/split viewports without any network call (no token → the shim
// transport short-circuits before HTTP; the login form is rendered, not
// submitted).

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
  ['.wasm', 'application/wasm'],
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
    const externalRequests = [];
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith(pageUrl)) {
        await route.continue();
        return;
      }
      // The unauthenticated boot must not call any backend — record + block.
      externalRequests.push(url);
      await route.abort();
    });
    await page.goto(pageUrl, { waitUntil: 'load' });

    // Boot resolves to the staff login screen (no persisted session).
    const emailInput = page.locator('input[type="email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    const passwordInput = page.locator('input[type="password"]');
    const submit = page.locator('button[type="submit"]');
    assert.equal(await passwordInput.isVisible(), true, `${viewport.name}: password field visible`);
    assert.equal(await submit.isEnabled(), true, `${viewport.name}: submit button enabled`);

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert.ok(
      dimensions.scrollWidth <= dimensions.clientWidth,
      `${viewport.name}: horizontal page overflow ${dimensions.scrollWidth} > ${dimensions.clientWidth}`,
    );

    if (viewport.name === 'short-landscape-split') {
      await submit.scrollIntoViewIfNeeded();
      const box = await submit.boundingBox();
      assert.ok(box, `${viewport.name}: submit has no layout box`);
      assert.ok(box.y >= 0, `${viewport.name}: submit remains above the viewport`);
      assert.ok(
        box.y + box.height <= viewport.height,
        `${viewport.name}: submit remains below the viewport after scrolling`,
      );
    }

    assert.equal(
      externalRequests.length,
      0,
      `${viewport.name}: unauthenticated boot made external requests: ${externalRequests.join(', ')}`,
    );

    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

console.log('PASS Android responsive policy: real boot renders the login screen at tablet, portrait, and split viewports with no external requests');
