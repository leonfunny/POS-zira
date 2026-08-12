import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

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

  test('live Android development server supports an isolated explicit port', () => {
    const config = readFileSync(resolve(root, 'vite.android.live.config.ts'), 'utf8');
    expect(config).toContain('process.env.ANDROID_LIVE_PORT');
    expect(config).toContain('requestedLivePort < 1024');
    expect(config).toContain('requestedLivePort > 65_535');
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

  test('SUNMI console filter permits only the known SQL.js asm fallback messages', async () => {
    const { isExpectedLegacySqlJsFallbackConsole } = await import('../scripts/verify-android-sunmi-authenticated.mjs');
    expect(isExpectedLegacySqlJsFallbackConsole(
      'wasm streaming compile failed: CompileError: WebAssembly.instantiateStreaming(): Wasm code generation disallowed by embedder',
    )).toBe(true);
    expect(isExpectedLegacySqlJsFallbackConsole('falling back to ArrayBuffer instantiation')).toBe(true);
    expect(isExpectedLegacySqlJsFallbackConsole(
      "The source list for Content Security Policy directive 'script-src' contains an invalid source: ''wasm-unsafe-eval''. It will be ignored.",
    )).toBe(true);
    expect(isExpectedLegacySqlJsFallbackConsole('CompileError: unrelated wasm corruption')).toBe(false);
    expect(isExpectedLegacySqlJsFallbackConsole('Refused to connect to https://evil.example')).toBe(false);
  });

  test('SUNMI physical hit-testing maps live DOM boxes only with an unambiguous full-screen calibration', async () => {
    const {
      SUNMI_DIAGNOSTICS_DEV_PACKAGE,
      createDiagnosticsPhysicalInput,
      mapDomBoxToPhysicalTap,
      parsePhysicalDisplaySize,
    } = await import('../scripts/verify-android-sunmi-authenticated.mjs');
    const display = parsePhysicalDisplaySize('Physical size: 1280x720\n');
    const snapshot = {
      box: { x: 100, y: 200, width: 200, height: 60 },
      viewport: {
        innerWidth: 1280, innerHeight: 720, screenWidth: 1280, screenHeight: 720,
        clientWidth: 1280, clientHeight: 720, devicePixelRatio: 1, scrollX: 0, scrollY: 0,
        visualViewport: { width: 1280, height: 720, scale: 1, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0 },
      },
    };
    expect(mapDomBoxToPhysicalTap(snapshot, display)).toEqual({ x: 200, y: 230 });
    expect(() => parsePhysicalDisplaySize('Physical size: 1280x720\nOverride size: 1024x600\n')).toThrow(/override/i);
    expect(() => mapDomBoxToPhysicalTap({ ...snapshot, viewport: { ...snapshot.viewport, innerHeight: 680 } }, display)).toThrow(/height mismatch/i);
    expect(() => mapDomBoxToPhysicalTap({ ...snapshot, box: { ...snapshot.box, width: 40 } }, display)).toThrow(/undersized/i);
    expect(() => createDiagnosticsPhysicalInput({ packageName: 'com.ziraai.pos', adb: () => 'Physical size: 1280x720' })).toThrow(/diagnostics dev package/i);
    const calls: string[][] = [];
    const physicalInput = createDiagnosticsPhysicalInput({
      packageName: SUNMI_DIAGNOSTICS_DEV_PACKAGE,
      adb: (...args: string[]) => { calls.push(args); return 'Physical size: 1280x720'; },
    });
    expect(() => physicalInput.type('unsafe;command')).toThrow(/Unsafe adb input text/);
    await physicalInput.tap({ evaluate: async () => snapshot });
    physicalInput.type('android-e2e@example.invalid');
    expect(calls).toEqual([
      ['shell', 'wm', 'size'],
      ['shell', 'input', 'tap', '200', '230'],
      ['shell', 'input', 'text', 'android-e2e@example.invalid'],
    ]);
  });

  test('legacy WebView CDP proxy suppresses only the unsupported download command', async () => {
    const {
      legacyWebViewCdpSyntheticResponse,
      startLegacyWebViewCdpProxy,
    } = await import('../scripts/verify-android-sunmi-authenticated.mjs');
    expect(legacyWebViewCdpSyntheticResponse(
      JSON.stringify({ id: 7, method: 'Browser.setDownloadBehavior', params: { behavior: 'deny' } }),
    )).toBe(JSON.stringify({ id: 7, result: {} }));
    expect(legacyWebViewCdpSyntheticResponse(
      JSON.stringify({ id: 8, method: 'Runtime.enable' }),
    )).toBeNull();

    const upstreamServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(upstreamServer, 'listening');
    const upstreamAddress = upstreamServer.address();
    expect(upstreamAddress && typeof upstreamAddress === 'object').toBe(true);
    const forwarded: string[] = [];
    let upstreamSocket: WebSocket | null = null;
    const forwardedMessage = new Promise<void>((resolveForwarded) => {
      upstreamServer.on('connection', (socket) => {
        upstreamSocket = socket;
        socket.on('message', (data) => {
          const text = String(data);
          forwarded.push(text);
          const message = JSON.parse(text);
          socket.send(JSON.stringify({ id: message.id, result: { forwarded: true } }));
          resolveForwarded();
        });
      });
    });
    const proxy = await startLegacyWebViewCdpProxy(
      `ws://127.0.0.1:${(upstreamAddress as { port: number }).port}`,
    );
    const client = new WebSocket(proxy.endpoint);
    try {
      await once(client, 'open');
      const responses: string[] = [];
      const twoResponses = new Promise<void>((resolveResponses) => {
        client.on('message', (data) => {
          responses.push(String(data));
          if (responses.length === 2) resolveResponses();
        });
      });
      client.send(JSON.stringify({ id: 11, method: 'Browser.setDownloadBehavior', params: { behavior: 'deny' } }));
      client.send(JSON.stringify({ id: 12, method: 'Runtime.enable' }));
      await Promise.all([forwardedMessage, twoResponses]);
      expect(forwarded).toEqual([JSON.stringify({ id: 12, method: 'Runtime.enable' })]);
      expect(responses.map((value) => JSON.parse(value))).toEqual(expect.arrayContaining([
        { id: 11, result: {} },
        { id: 12, result: { forwarded: true } },
      ]));
    } finally {
      client.terminate();
      upstreamSocket?.terminate();
      await proxy.close();
      await new Promise<void>((resolveClose) => upstreamServer.close(() => resolveClose()));
    }
  });

  test('fixture router intercepts API calls even when liveDebug shares the renderer origin', async () => {
    const {
      createFixtureRouter,
      loadAuthenticatedFixture,
    } = await import('../scripts/verify-android-authenticated-responsive.mjs');
    const fixture = await loadAuthenticatedFixture();
    const fulfilled: Array<{ status: number; body: string }> = [];
    let continued = 0;
    const router = createFixtureRouter(fixture, 'http://100.72.205.122:5173');
    const route = {
      request: () => ({
        method: () => 'POST',
        url: () => 'http://100.72.205.122:5173/api/v1/auth/login',
      }),
      fulfill: async (response: { status: number; body: string }) => { fulfilled.push(response); },
      continue: async () => { continued += 1; },
      abort: async () => { throw new Error('allowlisted login was aborted'); },
    };

    await router.handle(route);

    expect(continued).toBe(0);
    expect(router.hits).toEqual(['POST /api/v1/auth/login']);
    expect(fulfilled).toHaveLength(1);
    expect(JSON.parse(fulfilled[0].body)).toEqual(fixture.authenticatedFixture.login);
  });

  test('SUNMI acceptance is pinned to exact serial, package, WebView 83 and PID-scoped CDP', () => {
    const script = readFileSync(resolve(root, 'scripts/verify-android-sunmi-authenticated.mjs'), 'utf8');
    expect(script).toContain('process.env.ANDROID_SERIAL');
    expect(script).toContain("['-s', serial");
    expect(script).toContain("'getCurrentWebViewPackage'");
    expect(script).toContain("adb('shell', 'dumpsys', 'webviewupdate')");
    expect(script).toContain('assert.equal(currentWebView.major, 83');
    expect(script).not.toMatch(/webviewupdate',\s*'(?:set|enable|disable)/);
    expect(script).toContain("SUNMI_DIAGNOSTICS_DEV_PACKAGE = 'com.ziraai.posdiagnostics.dev.live'");
    expect(script).toContain('process.env.ANDROID_W6_CLEAR_DEV_PACKAGE');
    expect(script).toContain("const clearAcknowledgement = 'I_ACKNOWLEDGE_CLEAR_DEV_PACKAGE'");
    expect(script).toContain("adb('shell', 'pm', 'clear', packageName)");
    expect(script).toContain("adb('shell', 'pm', 'path', packageName)");
    expect(script.indexOf("adb('shell', 'pm', 'clear', packageName)")).toBeLessThan(script.indexOf("adb('shell', 'am', 'start'"));
    expect(script.indexOf("await page.route('**/*', router.handle)")).toBeLessThan(script.indexOf("await page.reload({ waitUntil: 'load' })"));
    expect(script).toContain("localStorage.setItem('zira.dev.apiUrl', origin)");
    expect(script).toContain('{ allowMissingPostData: true }');
    expect(script).toContain('preRouteApiEntries');
    expect(script).toContain("router.hits.includes('POST /api/v1/auth/login')");
    expect(script).toContain('webview_devtools_remote_${pid}');
    expect(script).toContain("'forward', 'tcp:0'");
    expect(script).toContain("'Browser.setDownloadBehavior'");
    expect(script).toContain('startLegacyWebViewCdpProxy');
    expect(script).toContain('createDiagnosticsPhysicalInput');
    expect(script).toContain("adb('shell', 'wm', 'size')");
    expect(script).toContain("adb('shell', 'input', 'tap'");
    expect(script).toContain('mapDomBoxToPhysicalTap');
    expect(script).toContain('PASS SUNMI physical hit-test');
    expect(script).not.toContain('element.click()');
    expect(script).not.toContain('native Back/PIN acceptance captured');
    expect(script).not.toContain("locator.fill(");
    expect(script).toContain("page.getByTestId('settings-kiosk-exit-pin-input')");
    expect(script).toContain("adb('shell', 'input', 'keyevent', '4')");
    expect(script).toContain("page.getByTestId('android-checkin-staff-exit')");
    expect(script).toContain("router.hits.includes('POST /api/v1/checkin/kiosk-search')");
    expect(script).toContain("router.hits.includes('POST /api/v1/checkin/arrive')");
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
