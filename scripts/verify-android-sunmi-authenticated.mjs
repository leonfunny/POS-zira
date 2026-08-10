#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';
import {
  AUTHENTICATED_VIEWPORTS,
  ROOT,
  assertAuthenticatedViewport,
  createFixtureRouter,
  loadAuthenticatedFixture,
  submitRealLogin,
} from './verify-android-authenticated-responsive.mjs';

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

async function main() {

const serial = String(process.env.ANDROID_SERIAL || '').trim();
assert.ok(serial && !/\s/.test(serial), 'ANDROID_SERIAL must be one exact adb serial');
const packageName = 'com.ziraai.posdiagnostics.dev.live';
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
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${localPort}`);
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
  const router = createFixtureRouter(fixtureModule, appOrigin);
  await page.route('**/*', router.handle);
  const errors = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/frame-ancestors.*ignored when delivered via a <meta>/i.test(text)) return;
    if (message.type() === 'error' || /Content Security Policy|Refused to (connect|load|compile)/i.test(text)) errors.push(text);
  });
  // The first native boot necessarily precedes CDP interception. It is safe
  // only because pm clear yielded a real unauthenticated Login and the resource
  // timeline proved no API request. Acceptance starts on this intercepted reload.
  await page.reload({ waitUntil: 'load' });
  await identifier.waitFor({ state: 'visible', timeout: 20000 });
  const cdp = await context.newCDPSession(page);
  let first = true;
  for (const viewport of AUTHENTICATED_VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
    });
    if (first) {
      await submitRealLogin(page, viewport, fixtureModule, screenshotRoot, `login-${viewport.name}`);
    }
    await assertAuthenticatedViewport(page, viewport, fixtureModule, screenshotRoot, false);
    first = false;
  }
  assert.ok(router.hits.includes('POST /api/v1/auth/login'), 'Real Login form did not issue the allowlisted login request after intercepted reload');
  assert.deepEqual(router.unexpected, [], `SUNMI outbound request outside exact allowlist: ${router.unexpected.join(' | ')}`);
  assert.deepEqual(errors, [], `SUNMI console/CSP errors: ${errors.join(' | ')}`);
  console.log(`PASS SUNMI ${serial}: WebView ${currentWebView.packageName} ${currentWebView.version} via ${currentWebView.source}, exact package ${packageName}, authenticated screenshots captured`);
} finally {
  if (browser) await browser.close();
  execFileSync('adb', ['-s', serial, 'forward', '--remove', `tcp:${localPort}`], { stdio: 'ignore' });
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
