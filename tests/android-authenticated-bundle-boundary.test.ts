import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(__dirname, '..');
const fixtureSource = readFileSync(resolve(root, 'tests/fixtures/android-pos/authenticated-fixture.ts'), 'utf8');

function filesBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? filesBelow(full) : [full];
  });
}

describe('authenticated visual harness production boundary', () => {
  test('pins Android JavaScript and CSS transforms to Chrome 83', () => {
    const config = readFileSync(resolve(root, 'vite.android.config.ts'), 'utf8');
    expect(config).toContain("target: 'chrome83'");
    expect(config).toContain("cssTarget: 'chrome83'");
  });

  test('production Android bundle contains no fixture marker, credential, route, or auth-bypass symbol', () => {
    const bundleFiles = filesBelow(resolve(root, 'dist/android-web'))
      .filter((file) => /\.(?:html|js|css)$/.test(file));
    expect(bundleFiles.length).toBeGreaterThan(0);
    const bundle = bundleFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    const forbidden = [
      'ANDROID_E2E_AUTH_FIXTURE_V1',
      'android-e2e@example.invalid',
      'route-mocked-password',
      'fixture-staff-access-token',
      'AUTH_BYPASS',
      'TEST_AUTH_BYPASS',
      '/__android-test-auth',
    ];
    for (const value of forbidden) {
      expect(fixtureSource.includes(value) || /BYPASS|__android/.test(value)).toBe(true);
      expect(bundle, `production bundle leaked ${value}`).not.toContain(value);
    }
  });

  test('shipping renderer graph never imports the external fixture', () => {
    const rendererFiles = filesBelow(resolve(root, 'src/renderer')).filter((file) => /\.[jt]sx?$/.test(file));
    for (const file of rendererFiles) {
      expect(readFileSync(file, 'utf8')).not.toContain('authenticated-fixture');
    }
  });

  test('SUNMI WebView discovery uses the supported command or read-only dumpsys fallback', async () => {
    const {
      discoverCurrentWebViewPackage,
      parseCurrentWebViewPackage,
    } = await import('../scripts/verify-android-sunmi-authenticated.mjs');
    const dump = `
      WebView Update Service state
      Current WebView package (name, version): (com.android.webview, 83.0.4103.120)
      Minimum WebView version code: 410412000
    `;
    expect(parseCurrentWebViewPackage(dump)).toEqual({
      packageName: 'com.android.webview',
      version: '83.0.4103.120',
      major: 83,
    });
    expect(parseCurrentWebViewPackage('Unknown command: getCurrentWebViewPackage')).toBeNull();

    const legacyCalls: string[] = [];
    const legacyAdb = (...args: string[]) => {
      legacyCalls.push(args.join(' '));
      if (args.at(-1) === 'help') return 'help\nset-webview-implementation\nenable-redundant-packages\ndisable-redundant-packages';
      if (args.join(' ') === 'shell dumpsys webviewupdate') return dump;
      throw new Error(`unexpected legacy adb call: ${args.join(' ')}`);
    };
    expect(discoverCurrentWebViewPackage(legacyAdb)).toEqual({
      packageName: 'com.android.webview',
      version: '83.0.4103.120',
      major: 83,
      source: 'dumpsys webviewupdate',
    });
    expect(legacyCalls).toEqual([
      'shell cmd webviewupdate help',
      'shell dumpsys webviewupdate',
    ]);

    const supportedCalls: string[] = [];
    const supportedAdb = (...args: string[]) => {
      supportedCalls.push(args.join(' '));
      if (args.at(-1) === 'help') return 'help\ngetCurrentWebViewPackage';
      if (args.at(-1) === 'getCurrentWebViewPackage') {
        return 'Current WebView package (name, version): (com.google.android.webview, 83.0.4103.120)';
      }
      throw new Error(`unexpected supported adb call: ${args.join(' ')}`);
    };
    expect(discoverCurrentWebViewPackage(supportedAdb)).toEqual({
      packageName: 'com.google.android.webview',
      version: '83.0.4103.120',
      major: 83,
      source: 'cmd webviewupdate getCurrentWebViewPackage',
    });
    expect(supportedCalls).toEqual([
      'shell cmd webviewupdate help',
      'shell cmd webviewupdate getCurrentWebViewPackage',
    ]);
  });

  test('SUNMI acceptance is pinned to exact serial, package, WebView 83 and PID-scoped CDP', () => {
    const script = readFileSync(resolve(root, 'scripts/verify-android-sunmi-authenticated.mjs'), 'utf8');
    expect(script).toContain('process.env.ANDROID_SERIAL');
    expect(script).toContain("['-s', serial");
    expect(script).toContain("'getCurrentWebViewPackage'");
    expect(script).toContain("adb('shell', 'dumpsys', 'webviewupdate')");
    expect(script).toContain('assert.equal(currentWebView.major, 83');
    expect(script).not.toMatch(/webviewupdate',\s*'(?:set|enable|disable)/);
    expect(script).toContain("const packageName = 'com.ziraai.posdiagnostics.dev.live'");
    expect(script).toContain('process.env.ANDROID_W6_CLEAR_DEV_PACKAGE');
    expect(script).toContain("const clearAcknowledgement = 'I_ACKNOWLEDGE_CLEAR_DEV_PACKAGE'");
    expect(script).toContain("adb('shell', 'pm', 'clear', packageName)");
    expect(script).toContain("adb('shell', 'pm', 'path', packageName)");
    expect(script.indexOf("adb('shell', 'pm', 'clear', packageName)")).toBeLessThan(script.indexOf("adb('shell', 'am', 'start'"));
    expect(script.indexOf("await page.route('**/*', router.handle)")).toBeLessThan(script.indexOf("await page.reload({ waitUntil: 'load' })"));
    expect(script).toContain('preRouteApiEntries');
    expect(script).toContain("router.hits.includes('POST /api/v1/auth/login')");
    expect(script).toContain('webview_devtools_remote_${pid}');
    expect(script).toContain("'forward', 'tcp:0'");
  });

  test('desktop acceptance names every approved W6 flow and explicitly excludes Order History', () => {
    const script = readFileSync(resolve(root, 'scripts/verify-android-authenticated-responsive.mjs'), 'utf8');
    for (const flow of ['login-', 'retail-pos', 'salon-pos', 'settings', 'billiard', 'cart-shift-payment-modal']) {
      expect(script).toContain(flow);
    }
    expect(script).toContain('Order History is deliberately not exercised');
    expect(script).toContain("router.hits.includes('POST /api/v1/auth/login')");
  });
});
