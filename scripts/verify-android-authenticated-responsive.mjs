#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

export const ROOT = resolve(import.meta.dirname, '..');
export const WEB_ROOT = resolve(ROOT, 'dist/android-web');
export const SCREENSHOT_ROOT = resolve(ROOT, 'test-results/android-authenticated-responsive');
export const AUTHENTICATED_VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'desktop-800x600', width: 800, height: 600 }),
  Object.freeze({ name: 'desktop-1024x768', width: 1024, height: 768 }),
  Object.freeze({ name: 'desktop-1336x736', width: 1336, height: 736 }),
]);

const CONFIG_STORAGE_KEY = 'zira-android-pos-config';

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.wasm', 'application/wasm'],
]);

export async function loadAuthenticatedFixture() {
  const fixturePath = resolve(ROOT, 'tests/fixtures/android-pos/authenticated-fixture.ts');
  const source = await readFile(fixturePath, 'utf8');
  // The fixture is deliberately JS-valid TypeScript. Loading it from a data URL
  // keeps Node 20 from needing a TS loader and cannot make it part of Vite's graph.
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

export function createFixtureRouter(fixtureModule, appOrigin, { allowMissingPostData = false } = {}) {
  const fixture = fixtureModule.authenticatedFixture;
  const unexpected = [];
  const hits = [];
  const json = (route, body, status = 200) => route.fulfill({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });
  const exactRoutes = new Map([
    ['POST /api/v1/auth/login', (route) => json(route, fixture.login)],
    ['GET /api/v1/auth/me', (route) => json(route, { user: fixture.login.user, salon: fixture.login.user.salon })],
    ['GET /api/v1/admin/desktop/entitlements', (route) => json(route, fixture.entitlements)],
    ['GET /api/v1/print-agent/my-key', (route) => json(route, {})],
    ['GET /api/v1/print-agent/salons/me/printer-assignments', (route) => json(route, { assignments: [] })],
    ['GET /api/v1/nail-turns/today', (route) => json(route, null)],
    ['GET /api/v1/staff', (route) => json(route, [{ id: 'fixture-owner-1', user_id: 'fixture-owner-1', name: 'Fixture Owner', role: 'OWNER', active: true }])],
    ['GET /api/v1/warehouse/product-admin/capabilities', (route) => json(route, { canCreateProduct: false, canUpdateProduct: false, canAdjustStock: false })],
    ['GET /api/v1/warehouse/public/categories', (route) => json(route, fixture.categories)],
    ['POST /api/v1/checkin/arrive', (route) => {
      const body = route.request().postDataJSON();
      if (body == null && allowMissingPostData) {
        json(route, fixture.checkin.arrived);
        return;
      }
      assert.equal(body.mode, 'BOOKING');
      assert.equal(body.booking_id, fixture.checkin.arrived.booking_id);
      assert.equal(body.source_device, 'POS_ANDROID');
      assert.equal(body.assign.type, 'STAFF');
      assert.equal(body.assign.staff_profile_id, fixture.checkin.arrived.assigned_staff.profile_id);
      assert.equal(body.assign.client_requested, true);
      assert.equal(body.expected_booked_staff_profile_id, fixture.checkin.arrived.assigned_staff.profile_id);
      assert.equal(typeof body.idempotency_key, 'string');
      assert.ok(body.idempotency_key.length > 8);
      json(route, fixture.checkin.arrived);
    }],
    ['POST /api/v1/pos/shifts/open', (route) => json(route, { shiftId: 'fixture-backend-shift-1' })],
    ['GET /api/v1/billiard/dashboard', (route) => json(route, fixture.billiard.dashboard)],
    ['GET /api/v1/billiard/floor-plans', (route) => json(route, [fixture.billiard.floorPlan])],
    ['GET /api/v1/billiard/sessions/pending-payments', (route) => json(route, [])],
    ['GET /api/v1/billiard/shifts/current', (route) => json(route, { shift: null })],
  ]);

  const handle = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const requestOrigin = url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
    const key = `${request.method()} ${url.pathname}`;
    // liveDebug intentionally serves both the renderer and its API override
    // from the Vite origin. Static assets may continue, but API traffic must
    // still pass through the exact allowlist below.
    if (requestOrigin === appOrigin && !url.pathname.startsWith('/api/v1/')) {
      await route.continue();
      return;
    }
    hits.push(`${key}${url.search}`);
    if (key === 'GET /api/v1/warehouse/public/products/sync-v2') {
      const allowed = [...url.searchParams.keys()].every((name) => ['limit', 'syncCursor', 'pageCursor'].includes(name))
        && url.searchParams.get('limit') === '100';
      if (allowed) {
        await json(route, fixture.products);
        return;
      }
    }
    if (key === 'POST /api/v1/checkin/kiosk-search') {
      const body = request.postDataJSON();
      const allowed = url.search === ''
        && (body == null
          ? allowMissingPostData
          : Object.keys(body).every((name) => name === 'query') && body.query === 'Anna');
      if (allowed) {
        await json(route, fixture.checkin.search);
        return;
      }
    }
    if (key === 'GET /api/v1/pos/shifts/active') {
      const allowed = [...url.searchParams.keys()].every((name) => name === 'machineId')
        && url.searchParams.get('machineId') === 'fixture-register-1';
      if (allowed) {
        // Mirror the generated local id so the PaymentModal exercises the real
        // server-consistency success path without hard-coding a random UUID.
        const active = await request.frame().page().evaluate(() => window.electronAPI.pos.shift.getActive());
        await json(route, active?.shift?.id ? {
          id: active.shift.id,
          staffId: active.shift.staff_id,
          staffName: active.shift.staff_name,
          openedAt: active.shift.opened_at,
        } : { active: false });
        return;
      }
    }
    const responder = exactRoutes.get(key);
    if (responder && url.search === '') {
      await responder(route);
      return;
    }
    unexpected.push(`${request.method()} ${request.url()}`);
    await route.abort('blockedbyclient');
  };
  return { handle, hits, unexpected };
}

export async function seedAndroidConfig(context, posMode) {
  assert.ok(posMode === 'retail' || posMode === 'salon');
  // This is intentionally configuration-only. Auth identity/tokens are never
  // seeded: every scenario below must render and submit the real Login form.
  const salt = Buffer.from('fixture-kiosk-salt').toString('base64');
  const digest = createHash('sha256').update(`${salt}:2468`).digest('base64');
  const pinRecord = JSON.stringify({
    version: 1, salt, digest, failedAttempts: 0, lockedUntil: null,
  });
  await context.addInitScript(({ storageKey, mode, securePinRecord }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      posMode: mode,
      language: 'pl',
      posLanguage: 'pl',
      machineId: 'fixture-machine-1',
      agentId: 'fixture-agent-1',
      registerCode: 'fixture-register-1',
    }));
    const secureValues = new Map([['kiosk_exit_pin_v1', securePinRecord]]);
    const capacitor = window.Capacitor || {};
    capacitor.Plugins = capacitor.Plugins || {};
    capacitor.Plugins.SecureKV = {
      get: async ({ key }) => ({ value: secureValues.get(key) ?? null }),
      set: async ({ key, value }) => { secureValues.set(key, value); },
      remove: async ({ key }) => { secureValues.delete(key); },
      clear: async () => { secureValues.clear(); },
    };
    window.Capacitor = capacitor;
  }, { storageKey: CONFIG_STORAGE_KEY, mode: posMode, securePinRecord: pinRecord });
}

export async function assertViewportLayout(page, viewport, locator, name) {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(metrics.scrollWidth <= metrics.clientWidth, `${viewport.name}: horizontal overflow ${metrics.scrollWidth} > ${metrics.clientWidth}`);
  const box = await locator.boundingBox();
  assert.ok(box, `${viewport.name}: ${name} has no layout box`);
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
    `${viewport.name}: ${name} is clipped (${JSON.stringify(box)})`);
  assert.ok(box.height >= 44 && box.width >= 44, `${viewport.name}: ${name} touch target is ${box.width}x${box.height}`);
}

export async function submitRealLogin(
  page,
  viewport,
  fixtureModule,
  screenshotRoot,
  screenshotName,
  clickSubmit = (locator) => locator.click(),
) {
  const fixture = fixtureModule.authenticatedFixture;
  const identifier = page.locator('input[autocomplete="username"]');
  await identifier.waitFor({ state: 'visible', timeout: 20000 });
  await identifier.fill(fixture.credentials.identifier);
  await page.locator('input[autocomplete="current-password"]').fill(fixture.credentials.password);
  const loginSubmit = page.getByRole('button', { name: 'Đăng nhập', exact: true });
  await assertViewportLayout(page, viewport, loginSubmit, 'real login submit');
  if (screenshotName) {
    await mkdir(screenshotRoot, { recursive: true });
    await page.screenshot({ path: resolve(screenshotRoot, `${screenshotName}.png`), fullPage: true });
  }
  await clickSubmit(loginSubmit);
}

export async function assertAuthenticatedViewport(page, viewport, fixtureModule, screenshotRoot = SCREENSHOT_ROOT, login = true) {
  if (login) await submitRealLogin(page, viewport, fixtureModule, screenshotRoot);
  const product = await revealFixtureProductThroughSearch(page);
  await assertViewportLayout(page, viewport, product, 'authenticated Retail product tile');
  await mkdir(screenshotRoot, { recursive: true });
  await page.screenshot({ path: resolve(screenshotRoot, `${viewport.name}.png`), fullPage: true });
}

export async function createStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
      const filePath = resolve(WEB_ROOT, relativePath);
      if (filePath !== WEB_ROOT && !filePath.startsWith(`${WEB_ROOT}${sep}`)) return void response.writeHead(403).end();
      if (!(await stat(filePath)).isFile()) throw new Error('not a file');
      response.writeHead(200, { 'Content-Type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream' });
      createReadStream(filePath).pipe(response);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function captureNamedScreen(page, viewport, screenshotRoot, name, anchor) {
  await anchor.waitFor({ state: 'visible', timeout: 25000 });
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(metrics.scrollWidth <= metrics.clientWidth, `${name}/${viewport.name}: horizontal overflow`);
  await mkdir(screenshotRoot, { recursive: true });
  await page.screenshot({ path: resolve(screenshotRoot, `${name}-${viewport.name}.png`), fullPage: true });
}

async function revealFixtureProductThroughSearch(page) {
  await page.waitForFunction(async () => {
    const rows = await window.electronAPI.pos.products.getAll();
    return rows.some((row) => row.name === 'Test manicure');
  }, undefined, { timeout: 15000 });
  const search = page.locator('input[placeholder*="Szukaj"]').first();
  await search.waitFor({ state: 'visible' });
  await search.fill('Test manicure');
  const product = page.getByRole('button', { name: 'Add Test manicure', exact: true });
  await product.waitFor({ state: 'visible', timeout: 10000 });
  return product;
}

async function runScenario({ browser, url, fixtureModule, viewport, posMode, name, assertion, captureLogin = false }) {
  const context = await browser.newContext({ viewport });
  await seedAndroidConfig(context, posMode);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    const value = message.text();
    if (/frame-ancestors.*ignored when delivered via a <meta>/i.test(value)) return;
    if (message.type() === 'error' || /Content Security Policy|Refused to (connect|load|compile)/i.test(value)) consoleErrors.push(value);
  });
  const router = createFixtureRouter(fixtureModule, new URL(url).origin);
  await page.route('**/*', router.handle);
  try {
    await page.goto(url, { waitUntil: 'load' });
    await submitRealLogin(
      page,
      viewport,
      fixtureModule,
      SCREENSHOT_ROOT,
      captureLogin ? `login-${viewport.name}` : undefined,
    );
    await assertion(page, viewport);
    await page.waitForTimeout(300);
    assert.ok(router.hits.includes('POST /api/v1/auth/login'), `${name}: real Login form did not issue POST /api/v1/auth/login`);
    assert.deepEqual(router.unexpected, [], `${name}/${viewport.name}: outbound request outside fixture allowlist`);
    assert.deepEqual(consoleErrors, [], `${name}/${viewport.name}: console/CSP errors: ${consoleErrors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

async function assertRetailPos(page, viewport) {
  const product = await revealFixtureProductThroughSearch(page);
  await page.getByText('Koszyk', { exact: true }).waitFor({ state: 'visible' });
  await page.getByText('Koszyk jest pusty', { exact: true }).first().waitFor({ state: 'visible' });
  await assertViewportLayout(page, viewport, product, 'Retail POS product tile');
  await captureNamedScreen(page, viewport, SCREENSHOT_ROOT, 'retail-pos', product);
}

async function assertSalonPos(page, viewport) {
  const salesTab = page.getByRole('button', { name: 'Ban hang', exact: true });
  await salesTab.waitFor({ state: 'visible', timeout: 25000 });
  await page.getByRole('button', { name: 'Lich tho', exact: true }).waitFor({ state: 'visible' });
  await revealFixtureProductThroughSearch(page);
  await captureNamedScreen(page, viewport, SCREENSHOT_ROOT, 'salon-pos', salesTab);
}

async function assertCustomerCheckin(page, viewport) {
  const entry = page.getByTestId('android-customer-checkin-entry');
  await entry.waitFor({ state: 'visible', timeout: 25000 });
  await assertViewportLayout(page, viewport, entry, 'customer Check-in tab');
  await entry.click();
  assert.equal(await page.getByRole('button', { name: 'POS', exact: true }).count(), 0, 'customer kiosk exposed the POS navigation');
  assert.equal(await page.getByTestId('android-settings-entry').count(), 0, 'customer kiosk exposed Settings');
  await page.getByRole('button', { name: /Mam umówioną wizytę/ }).click();
  const search = page.getByTestId('checkin-booking-search');
  await search.waitFor({ state: 'visible', timeout: 10000 });
  await search.fill('Anna');
  const appointment = page.getByRole('button', { name: /Anna Kowalska/ });
  await appointment.waitFor({ state: 'visible' });
  await assertViewportLayout(page, viewport, appointment, 'customer appointment result');
  await captureNamedScreen(page, viewport, SCREENSHOT_ROOT, 'customer-checkin-search', appointment);
  await appointment.click();
  const confirm = page.getByRole('button', { name: 'Potwierdź rejestrację', exact: true });
  await confirm.waitFor({ state: 'visible' });
  await assertViewportLayout(page, viewport, confirm, 'customer check-in confirmation');
  await confirm.click();
  const success = page.getByText('Zarejestrowano!', { exact: true });
  await success.waitFor({ state: 'visible' });
  await captureNamedScreen(page, viewport, SCREENSHOT_ROOT, 'customer-checkin-success', success);
}

async function assertSettings(page, viewport) {
  await page.getByTestId('android-settings-entry').click();
  const salonMode = page.getByTestId('settings-pos-mode-salon');
  const retailMode = page.getByTestId('settings-pos-mode-retail');
  await retailMode.waitFor({ state: 'visible' });
  assert.equal(await retailMode.isChecked(), true, 'Settings did not render the deterministic retail config');
  assert.equal(await salonMode.isChecked(), false, 'Settings rendered both POS mode radios selected');
  await page.getByRole('heading', { name: 'Chế độ bán', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('heading', { name: 'Ngôn ngữ', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('settings-pos-language').inputValue(), 'pl');
  await captureNamedScreen(page, viewport, SCREENSHOT_ROOT, 'settings', retailMode);
}

async function assertBilliard(page, viewport) {
  await page.getByRole('button', { name: 'Bi-a', exact: true }).click();
  const heading = page.getByRole('heading', { name: 'Plan sali', exact: true });
  await heading.waitFor({ state: 'visible', timeout: 25000 });
  await page.getByText('Fixture Table 1', { exact: true }).waitFor({ state: 'visible' });
  await page.getByText('Fixture Floor', { exact: true }).waitFor({ state: 'visible' });
  await captureNamedScreen(page, viewport, SCREENSHOT_ROOT, 'billiard', heading);
}

async function assertCartShiftPayment(page, viewport) {
  await page.getByRole('button', { name: 'Otwórz zmianę', exact: true }).first().click();
  const staff = page.getByRole('button', { name: /Fixture Owner/ });
  await staff.waitFor({ state: 'visible', timeout: 10000 });
  await staff.click();
  const shiftDialogSubmit = page.getByRole('button', { name: 'Otwórz zmianę', exact: true }).last();
  await shiftDialogSubmit.click();
  await page.getByRole('button', { name: 'Zamknij zmianę', exact: true }).waitFor({ state: 'visible' });

  await (await revealFixtureProductThroughSearch(page)).click();
  assert.ok(await page.getByText('Test manicure', { exact: true }).count() >= 2, 'Cart did not render the selected fixture line');
  const pay = page.getByRole('button', { name: /^Zapłać\s/i }).last();
  await pay.click();
  const paymentDialog = page.getByRole('dialog', { name: 'Płatność', exact: true });
  await paymentDialog.waitFor({ state: 'visible', timeout: 10000 });
  await paymentDialog.getByText('Gotówka', { exact: true }).first().waitFor({ state: 'visible' });
  await paymentDialog.getByText(/49[.,]00\s*zł/i).first().waitFor({ state: 'visible' });
  await captureNamedScreen(page, viewport, SCREENSHOT_ROOT, 'cart-shift-payment-modal', paymentDialog);
}

async function main() {
  const fixtureModule = await loadAuthenticatedFixture();
  const { server, url } = await createStaticServer();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of AUTHENTICATED_VIEWPORTS) {
      await runScenario({
        browser, url, fixtureModule, viewport, posMode: 'retail', name: 'retail-pos',
        captureLogin: true, assertion: assertRetailPos,
      });
    }
    await runScenario({ browser, url, fixtureModule, viewport: AUTHENTICATED_VIEWPORTS[1], posMode: 'salon', name: 'salon-pos', assertion: assertSalonPos });
    for (const viewport of AUTHENTICATED_VIEWPORTS) {
      await runScenario({ browser, url, fixtureModule, viewport, posMode: 'salon', name: 'customer-checkin', assertion: assertCustomerCheckin });
    }
    await runScenario({ browser, url, fixtureModule, viewport: AUTHENTICATED_VIEWPORTS[0], posMode: 'retail', name: 'settings', assertion: assertSettings });
    await runScenario({ browser, url, fixtureModule, viewport: AUTHENTICATED_VIEWPORTS[2], posMode: 'retail', name: 'billiard', assertion: assertBilliard });
    await runScenario({ browser, url, fixtureModule, viewport: AUTHENTICATED_VIEWPORTS[1], posMode: 'retail', name: 'cart-shift-payment-modal', assertion: assertCartShiftPayment });
    // Order History is deliberately not exercised: it was not part of the
    // approved W6 acceptance packet. The six named flows above are the scope.
  } finally {
    await browser.close();
    await new Promise((ok, fail) => server.close((error) => error ? fail(error) : ok()));
  }
  console.log(`PASS Login + Retail POS at ${AUTHENTICATED_VIEWPORTS.map((v) => `${v.width}x${v.height}`).join(', ')}; Salon POS + customer Check-in + Settings + Billiard + cart/shift/PaymentModal named flows`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
