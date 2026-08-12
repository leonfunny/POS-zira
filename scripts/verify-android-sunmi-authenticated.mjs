#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ROOT,
  assertViewportLayout,
  createFixtureRouter,
  loadAuthenticatedFixture,
} from './verify-android-authenticated-responsive.mjs';

export const SUNMI_DIAGNOSTICS_DEV_PACKAGE = 'com.ziraai.posdiagnostics.dev.live';

export function parseCurrentWebViewPackage(output) {
  const match = String(output).match(
    /^\s*Current WebView package \(name, version\):\s*\(([^,\s()]+),\s*((\d+)(?:\.\d+){1,3}(?:[-+._A-Za-z0-9]*))\)\s*$/m,
  );
  if (!match) return null;
  return Object.freeze({ packageName: match[1], version: match[2], major: Number(match[3]) });
}

export function webViewHelpSupportsCurrentPackageCommand(helpOutput) {
  return /(?:^|\s)getCurrentWebViewPackage(?:\s|$)/.test(String(helpOutput));
}

export function isExpectedLegacySqlJsFallbackConsole(text) {
  const value = String(text);
  return [
    /script-src.*invalid source: ''wasm-unsafe-eval''.*ignored/i,
    /Content Security Policies delivered via a <meta> element may not contain the frame-ancestors directive/i,
    /^wasm streaming compile failed: CompileError: WebAssembly\.instantiateStreaming\(\): Wasm code generation disallowed by embedder$/,
    /^falling back to ArrayBuffer instantiation$/,
    /^failed to asynchronously prepare wasm: CompileError: WebAssembly\.instantiate\(\): Wasm code generation disallowed by embedder$/,
    /^Aborted\(CompileError: WebAssembly\.instantiate\(\): Wasm code generation disallowed by embedder\)$/,
  ].some((pattern) => pattern.test(value));
}

export function discoverCurrentWebViewPackage(adb) {
  let helpOutput = '';
  try {
    helpOutput = adb('shell', 'cmd', 'webviewupdate', 'help');
  } catch {
    // Older Android builds may not expose command help. dumpsys remains the
    // read-only source of truth and does not change the selected provider.
  }

  if (webViewHelpSupportsCurrentPackageCommand(helpOutput)) {
    try {
      const commandOutput = adb('shell', 'cmd', 'webviewupdate', 'getCurrentWebViewPackage');
      const current = parseCurrentWebViewPackage(commandOutput);
      if (current) return Object.freeze({ ...current, source: 'cmd webviewupdate getCurrentWebViewPackage' });
    } catch {
      // A command advertised by help can still be unavailable on vendor
      // builds. Fall through to the read-only service dump.
    }
  }

  const dumpsysOutput = adb('shell', 'dumpsys', 'webviewupdate');
  const current = parseCurrentWebViewPackage(dumpsysOutput);
  assert.ok(current, `Could not parse current WebView package/version from dumpsys webviewupdate: ${dumpsysOutput}`);
  return Object.freeze({ ...current, source: 'dumpsys webviewupdate' });
}

const LEGACY_WEBVIEW_IGNORED_CDP_METHODS = new Set([
  // Playwright 1.58 initializes a desktop Chromium context by sending this
  // command. Android WebView 83 has no browser-context download manager and
  // rejects it before the first page can be attached. Check-in acceptance
  // never downloads files, so acknowledging only this command is truthful.
  'Browser.setDownloadBehavior',
]);

export function legacyWebViewCdpSyntheticResponse(data, isBinary = false) {
  if (isBinary) return null;
  try {
    const message = JSON.parse(String(data));
    if (!Number.isInteger(message?.id) || !LEGACY_WEBVIEW_IGNORED_CDP_METHODS.has(message?.method)) return null;
    return JSON.stringify({ id: message.id, result: {} });
  } catch {
    return null;
  }
}

/**
 * Keep Playwright's locator/route/screenshot machinery while adapting its one
 * desktop-only initialization command to the real Chromium 83 Android WebView.
 * Every other CDP message and event is forwarded byte-for-byte.
 */
export async function startLegacyWebViewCdpProxy(targetEndpoint) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const sockets = new Set();

  server.on('connection', (client) => {
    const upstream = new WebSocket(targetEndpoint);
    sockets.add(client);
    sockets.add(upstream);
    const pending = [];

    const closePair = () => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close();
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    };

    client.on('message', (data, isBinary) => {
      const synthetic = legacyWebViewCdpSyntheticResponse(data, isBinary);
      if (synthetic !== null) {
        if (client.readyState === WebSocket.OPEN) client.send(synthetic);
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else pending.push([data, isBinary]);
    });
    upstream.on('open', () => {
      for (const [data, isBinary] of pending.splice(0)) upstream.send(data, { binary: isBinary });
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    client.on('error', closePair);
    upstream.on('error', closePair);
    client.on('close', () => {
      sockets.delete(client);
      closePair();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      closePair();
    });
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object', 'Legacy CDP proxy did not bind a local port');
  return Object.freeze({
    endpoint: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  });
}

export async function resolveForwardedWebViewEndpoint(localPort) {
  const response = await fetch(`http://127.0.0.1:${localPort}/json/version`);
  assert.equal(response.ok, true, `WebView CDP version endpoint returned HTTP ${response.status}`);
  const version = await response.json();
  assert.equal(typeof version.webSocketDebuggerUrl, 'string', 'WebView CDP version response has no websocket URL');
  const endpoint = new URL(version.webSocketDebuggerUrl);
  endpoint.hostname = '127.0.0.1';
  endpoint.port = String(localPort);
  return endpoint.toString();
}

export function parsePhysicalDisplaySize(wmSizeOutput) {
  const output = String(wmSizeOutput);
  assert.doesNotMatch(output, /^Override size:/mi, `Refusing physical taps with a wm size override: ${output}`);
  const sizes = [...output.matchAll(/^Physical size:\s*(\d+)x(\d+)\s*$/gmi)];
  assert.equal(sizes.length, 1, `Expected one physical display size from wm size: ${output}`);
  const width = Number(sizes[0][1]);
  const height = Number(sizes[0][2]);
  assert.ok(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0,
    `Invalid physical display size: ${output}`);
  return Object.freeze({ width, height });
}

function assertClose(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1, `${label} mismatch: ${actual} != ${expected}`);
}

/**
 * Map a live WebView box to Android's physical display only when there is no
 * inset, zoom, scroll, override, or scale ambiguity. A failed calibration is
 * a test failure, never a best-effort tap at an unrelated screen location.
 */
export function mapDomBoxToPhysicalTap(snapshot, physicalDisplay) {
  const { box, viewport } = snapshot ?? {};
  const required = [
    box?.x, box?.y, box?.width, box?.height,
    viewport?.innerWidth, viewport?.innerHeight, viewport?.screenWidth, viewport?.screenHeight,
    viewport?.clientWidth, viewport?.clientHeight, viewport?.devicePixelRatio,
    viewport?.scrollX, viewport?.scrollY, viewport?.visualViewport?.width, viewport?.visualViewport?.height,
    viewport?.visualViewport?.scale, viewport?.visualViewport?.offsetLeft, viewport?.visualViewport?.offsetTop,
    viewport?.visualViewport?.pageLeft, viewport?.visualViewport?.pageTop,
    physicalDisplay?.width, physicalDisplay?.height,
  ];
  assert.ok(required.every(Number.isFinite), `DOM-to-physical metrics are incomplete: ${JSON.stringify(snapshot)}`);
  assert.ok(viewport.innerWidth > 0 && viewport.innerHeight > 0, 'WebView viewport has no usable dimensions');
  assert.equal(viewport.scrollX, 0, 'Refusing physical tap from a horizontally scrolled page');
  assert.equal(viewport.scrollY, 0, 'Refusing physical tap from a vertically scrolled page');
  assert.equal(viewport.visualViewport.scale, 1, 'Refusing physical tap with visual viewport zoom');
  assert.equal(viewport.visualViewport.offsetLeft, 0, 'Refusing physical tap with visual viewport X offset');
  assert.equal(viewport.visualViewport.offsetTop, 0, 'Refusing physical tap with visual viewport Y offset');
  assert.equal(viewport.visualViewport.pageLeft, 0, 'Refusing physical tap with visual viewport page X offset');
  assert.equal(viewport.visualViewport.pageTop, 0, 'Refusing physical tap with visual viewport page Y offset');
  assertClose(viewport.clientWidth, viewport.innerWidth, 'document client width');
  assertClose(viewport.clientHeight, viewport.innerHeight, 'document client height');
  assertClose(viewport.visualViewport.width, viewport.innerWidth, 'visual viewport width');
  assertClose(viewport.visualViewport.height, viewport.innerHeight, 'visual viewport height');
  assertClose(viewport.screenWidth, viewport.innerWidth, 'screen width');
  assertClose(viewport.screenHeight, viewport.innerHeight, 'screen height');
  const scaleX = physicalDisplay.width / viewport.innerWidth;
  const scaleY = physicalDisplay.height / viewport.innerHeight;
  assertClose(scaleX, scaleY, 'physical display scale');
  assertClose(scaleX, viewport.devicePixelRatio, 'device pixel ratio');
  assert.ok(box.width >= 44 && box.height >= 44, `Refusing to tap undersized target: ${box.width}x${box.height}`);
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.innerWidth && box.y + box.height <= viewport.innerHeight,
    `Refusing to tap clipped target: ${JSON.stringify(box)}`);
  const x = Math.round((box.x + (box.width / 2)) * scaleX);
  const y = Math.round((box.y + (box.height / 2)) * scaleY);
  assert.ok(x >= 0 && x < physicalDisplay.width && y >= 0 && y < physicalDisplay.height,
    `Mapped physical tap is outside display: ${x}x${y} of ${physicalDisplay.width}x${physicalDisplay.height}`);
  return Object.freeze({ x, y });
}

export async function capturePhysicalTapSnapshot(locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const visual = window.visualViewport;
    if (!visual) throw new Error('WebView exposes no visual viewport; cannot calibrate physical tap');
    return {
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: {
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        screenWidth: window.screen.width, screenHeight: window.screen.height,
        clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
        devicePixelRatio: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY,
        visualViewport: {
          width: visual.width, height: visual.height, scale: visual.scale,
          offsetLeft: visual.offsetLeft, offsetTop: visual.offsetTop,
          pageLeft: visual.pageLeft, pageTop: visual.pageTop,
        },
      },
    };
  });
}

export function createDiagnosticsPhysicalInput({ packageName, adb }) {
  assert.equal(packageName, SUNMI_DIAGNOSTICS_DEV_PACKAGE,
    'Physical ADB input is permitted only for the fixed diagnostics dev package');
  assert.equal(typeof adb, 'function', 'Physical ADB input requires the serial-scoped adb command');
  const physicalDisplay = parsePhysicalDisplaySize(adb('shell', 'wm', 'size'));
  return Object.freeze({
    tap: async (locator) => {
      const snapshot = await capturePhysicalTapSnapshot(locator);
      const { x, y } = mapDomBoxToPhysicalTap(snapshot, physicalDisplay);
      adb('shell', 'input', 'tap', String(x), String(y));
    },
    type: (value) => {
      const text = String(value);
      // adb shell joins arguments remotely; keep the fixture input grammar
      // deliberately narrow so typing can never become a shell command.
      assert.match(text, /^[A-Za-z0-9.@_+-]+$/, `Unsafe adb input text: ${JSON.stringify(text)}`);
      adb('shell', 'input', 'text', text);
    },
  });
}

async function tapAndType(locator, physicalInput, value) {
  await locator.waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(await locator.inputValue(), '', 'Physical text target was not empty after clean dev-package boot');
  await physicalInput.tap(locator);
  physicalInput.type(value);
  assert.equal(await locator.inputValue(), value, 'Physical tap/text did not reach the selected input');
}

async function submitPhysicalLogin(page, viewport, fixtureModule, screenshotRoot, screenshotName, physicalInput) {
  const fixture = fixtureModule.authenticatedFixture;
  const identifier = page.locator('input[autocomplete="username"]');
  await tapAndType(identifier, physicalInput, fixture.credentials.identifier);
  await tapAndType(page.locator('input[autocomplete="current-password"]'), physicalInput, fixture.credentials.password);
  const loginSubmit = page.getByRole('button', { name: 'Đăng nhập', exact: true });
  await assertViewportLayout(page, viewport, loginSubmit, 'physical login submit');
  await mkdir(screenshotRoot, { recursive: true });
  await page.screenshot({ path: resolve(screenshotRoot, `${screenshotName}.png`), fullPage: true });
  await physicalInput.tap(loginSubmit);
}

async function main() {

const serial = String(process.env.ANDROID_SERIAL || '').trim();
assert.ok(serial && !/\s/.test(serial), 'ANDROID_SERIAL must be one exact adb serial');
const packageName = SUNMI_DIAGNOSTICS_DEV_PACKAGE;
const activityName = `${packageName}/com.ziraai.posdiagnostics.dev.MainActivity`;
const clearAcknowledgement = 'I_ACKNOWLEDGE_CLEAR_DEV_PACKAGE';
assert.equal(
  process.env.ANDROID_W6_CLEAR_DEV_PACKAGE,
  clearAcknowledgement,
  `Set ANDROID_W6_CLEAR_DEV_PACKAGE=${clearAcknowledgement} to allow clearing only ${packageName}`,
);
assert.match(packageName, /^com\.ziraai\.posdiagnostics\.dev\./, 'SUNMI harness may target only the fixed diagnostics dev package');
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' }).trim();

const deviceRow = execFileSync('adb', ['devices'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/))
  .find(([id]) => id === serial);
assert.deepEqual(deviceRow, [serial, 'device'], `ANDROID_SERIAL ${serial} is not one connected, authorized device`);

const currentWebView = discoverCurrentWebViewPackage(adb);
assert.equal(currentWebView.major, 83, `SUNMI acceptance requires WebView major 83, got ${currentWebView.version}`);

assert.match(adb('shell', 'pm', 'path', packageName), /^package:/, `Exact dev package ${packageName} is not installed`);
adb('shell', 'am', 'force-stop', packageName);
assert.equal(
  adb('shell', 'pm', 'clear', packageName),
  'Success',
  `Could not clear exact dev package ${packageName}`,
);
adb('shell', 'am', 'start', '-W', '-n', activityName);
const pid = adb('shell', 'pidof', packageName).split(/\s+/)[0];
assert.match(pid, /^\d+$/, `Could not resolve PID for exact package ${packageName}`);
const socket = `webview_devtools_remote_${pid}`;
const unixSockets = adb('shell', 'cat', '/proc/net/unix');
assert.ok(unixSockets.includes(`@${socket}`), `CDP socket ${socket} is absent; install/run the debuggable liveDebug APK`);
const localPort = execFileSync('adb', ['-s', serial, 'forward', 'tcp:0', `localabstract:${socket}`], { encoding: 'utf8' }).trim();
assert.match(localPort, /^\d+$/, 'adb did not allocate an exact local CDP port');

const fixtureModule = await loadAuthenticatedFixture();
const screenshotRoot = resolve(ROOT, 'test-results/android-sunmi-authenticated');
await mkdir(screenshotRoot, { recursive: true });
let browser;
let legacyCdpProxy;
try {
  const forwardedWebViewEndpoint = await resolveForwardedWebViewEndpoint(localPort);
  legacyCdpProxy = await startLegacyWebViewCdpProxy(forwardedWebViewEndpoint);
  browser = await chromium.connectOverCDP(legacyCdpProxy.endpoint);
  const context = browser.contexts()[0];
  assert.ok(context, 'SUNMI WebView exposed no CDP browser context');
  const page = context.pages()[0] ?? await context.newPage();
  const identifier = page.locator('input[autocomplete="username"]');
  await identifier.waitFor({ state: 'visible', timeout: 20000 });
  const preRouteApiEntries = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => /\/api\/v1\//.test(name)));
  assert.deepEqual(
    preRouteApiEntries,
    [],
    'Fresh dev-package boot issued backend traffic before Login; acceptance cannot start safely',
  );

  const appUrl = new URL(page.url());
  const appOrigin = appUrl.origin === 'null' ? `${appUrl.protocol}//${appUrl.host}` : appUrl.origin;
  // Chrome 83's CDP Request object omits POST data on this WebView even though
  // the network request itself is correct. Body contracts remain pinned by the
  // API-client unit tests and desktop production harness.
  const router = createFixtureRouter(fixtureModule, appOrigin, { allowMissingPostData: true });
  await page.route('**/*', router.handle);
  // Android WebView 83 does not reliably expose cross-origin fetches to
  // Playwright routing. Keep the dev-package API on its secure app origin so
  // every /api/v1 request is intercepted by the exact allowlist and no real
  // backend traffic can escape during acceptance.
  await page.evaluate((origin) => localStorage.setItem('zira.dev.apiUrl', origin), appOrigin);
  const errors = [];
  page.on('console', (message) => {
    const text = message.text();
    // The app intentionally falls back from blocked WASM to sql.js asm.js on
    // Chromium 83. Ignore only the exact first-attempt messages; every other
    // console/CSP error remains fatal below.
    if (isExpectedLegacySqlJsFallbackConsole(text)) return;
    if (message.type() === 'error' || /Content Security Policy|Refused to (connect|load|compile)/i.test(text)) errors.push(text);
  });
  // The first native boot necessarily precedes CDP interception. It is safe
  // only because pm clear yielded a real unauthenticated Login and the resource
  // timeline proved no API request. Acceptance starts on this intercepted reload.
  await page.reload({ waitUntil: 'load' });
  await identifier.waitFor({ state: 'visible', timeout: 20000 });
  // Emulation.setDeviceMetricsOverride is broken on this WebView 83: it
  // duplicates the rendered document and returns boxes outside the requested
  // viewport. Desktop production-bundle tests own the synthetic 800/1024/1336
  // anchors; SUNMI acceptance uses only its truthful physical viewport.
  const deviceViewport = await page.evaluate(() => ({
    name: `sunmi-${window.innerWidth}x${window.innerHeight}`,
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const physicalInput = createDiagnosticsPhysicalInput({ packageName, adb });
  await submitPhysicalLogin(
    page,
    deviceViewport,
    fixtureModule,
    screenshotRoot,
    `login-${deviceViewport.name}`,
    physicalInput,
  );
  const salonSales = page.getByRole('button', { name: 'Ban hang', exact: true });
  await salonSales.waitFor({ state: 'visible', timeout: 25000 });
  await page.getByRole('button', { name: 'Lich tho', exact: true }).waitFor({ state: 'visible' });
  await assertViewportLayout(page, deviceViewport, salonSales, 'SUNMI Salon sales tab');
  await page.screenshot({ path: resolve(screenshotRoot, `salon-pos-${deviceViewport.name}.png`) });

  // A fresh dev-package boot has no kiosk PIN by design. Configure it through
  // the real OWNER Settings UI so the acceptance covers the native SecureKV
  // plugin rather than seeding browser storage.
  await physicalInput.tap(page.getByTestId('android-settings-entry'));
  const pinInput = page.getByTestId('settings-kiosk-exit-pin-input');
  await pinInput.waitFor({ state: 'visible', timeout: 10000 });
  await tapAndType(pinInput, physicalInput, '2468');
  await tapAndType(page.getByTestId('settings-kiosk-exit-pin-confirm'), physicalInput, '2468');
  await physicalInput.tap(page.getByTestId('settings-kiosk-exit-pin-save'));
  await page.getByText('Đã lưu PIN thoát kiosk an toàn trên thiết bị này.', { exact: true })
    .waitFor({ state: 'visible', timeout: 10000 });
  await physicalInput.tap(page.getByRole('button', { name: 'POS', exact: true }));
  const checkinEntry = page.getByTestId('android-customer-checkin-entry');
  await checkinEntry.waitFor({ state: 'visible', timeout: 10000 });
  await physicalInput.tap(checkinEntry);

  const appointmentFlow = page.getByRole('button', { name: /Mam umówioną wizytę/ });
  await appointmentFlow.waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.getByRole('button', { name: 'POS', exact: true }).count(), 0, 'SUNMI kiosk exposed POS navigation');
  assert.equal(await page.getByTestId('android-settings-entry').count(), 0, 'SUNMI kiosk exposed Settings');
  await assertViewportLayout(page, deviceViewport, appointmentFlow, 'SUNMI customer appointment entry');
  await page.screenshot({ path: resolve(screenshotRoot, `customer-checkin-entry-${deviceViewport.name}.png`) });

  // The native MainActivity callback must keep a customer inside the kiosk.
  adb('shell', 'input', 'keyevent', '4');
  await page.waitForTimeout(300);
  await appointmentFlow.waitFor({ state: 'visible' });

  await physicalInput.tap(appointmentFlow);
  const search = page.getByTestId('checkin-booking-search');
  await tapAndType(search, physicalInput, 'Anna');
  const appointment = page.getByRole('button', { name: /Anna Kowalska/ });
  await appointment.waitFor({ state: 'visible', timeout: 10000 });
  await assertViewportLayout(page, deviceViewport, appointment, 'SUNMI customer appointment result');
  await page.screenshot({ path: resolve(screenshotRoot, `customer-checkin-search-${deviceViewport.name}.png`) });
  await physicalInput.tap(appointment);
  const confirm = page.getByRole('button', { name: 'Potwierdź rejestrację', exact: true });
  await confirm.waitFor({ state: 'visible' });
  await assertViewportLayout(page, deviceViewport, confirm, 'SUNMI customer check-in confirmation');
  await page.screenshot({ path: resolve(screenshotRoot, `customer-checkin-confirm-${deviceViewport.name}.png`) });
  await physicalInput.tap(confirm);
  const success = page.getByText('Zarejestrowano!', { exact: true });
  await success.waitFor({ state: 'visible', timeout: 10000 });
  await page.screenshot({ path: resolve(screenshotRoot, `customer-checkin-success-${deviceViewport.name}.png`) });
  await physicalInput.tap(page.getByRole('button', { name: 'Nowa rejestracja', exact: true }));

  // Returning to POS requires the device-local PIN configured above.
  await physicalInput.tap(page.getByTestId('android-checkin-staff-exit'));
  const exitPin = page.getByRole('textbox', { name: 'Kod wyjścia z kiosku', exact: true });
  await tapAndType(exitPin, physicalInput, '2468');
  await physicalInput.tap(page.locator('form').filter({ has: exitPin }).locator('button[type="submit"]'));
  await page.getByRole('button', { name: 'POS', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  assert.ok(router.hits.includes('POST /api/v1/auth/login'), 'Real Login form did not issue the allowlisted login request after intercepted reload');
  assert.ok(router.hits.includes('POST /api/v1/checkin/kiosk-search'), 'SUNMI customer search did not issue the privacy-minimized kiosk request');
  assert.ok(router.hits.includes('POST /api/v1/checkin/arrive'), 'SUNMI customer confirmation did not issue the check-in arrival request');
  assert.deepEqual(router.unexpected, [], `SUNMI outbound request outside exact allowlist: ${router.unexpected.join(' | ')}`);
  assert.deepEqual(errors, [], `SUNMI console/CSP errors: ${errors.join(' | ')}`);
  console.log(`PASS SUNMI physical hit-test ${serial}: WebView ${currentWebView.packageName} ${currentWebView.version} via ${currentWebView.source}, exact package ${packageName}, DOM boxes calibrated to wm physical display before every tap; Salon + customer Check-in + Back/PIN handlers captured`);
} finally {
  if (browser) await browser.close();
  if (legacyCdpProxy) await legacyCdpProxy.close();
  execFileSync('adb', ['-s', serial, 'forward', '--remove', `tcp:${localPort}`], { stdio: 'ignore' });
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
