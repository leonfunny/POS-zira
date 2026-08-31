/**
 * auth:expired wiring — main → renderer signal path.
 *
 * PRD-driven from PLAN-refresh-token-rotation.md C3:
 *
 *   When refreshAccessToken returns refresh-rejected, the renderer
 *   must drop to AuthScreen immediately — not on the next AUTH_GET_USER
 *   poll, which only runs at app start.
 *
 *   Wire:
 *     auth-refresh.authEvents.emit(AUTH_EXPIRED)
 *       └─ auth.module.ts subscribes
 *            └─ mainWindow.webContents.send('auth:expired')
 *                 └─ preload.ts exposes auth.onExpired(cb)
 *                      └─ useAuth subscribes
 *                           └─ setIsAuthenticated(false) + setUser(null)
 *
 * Each link is a tiny piece of glue. Source-string regression covers
 * the wiring; behavioural verification of the helper itself is in
 * auth-refresh.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../src/main/config/store', () => ({
  setSecureAuthToken: vi.fn(),
  setSecureRefreshToken: vi.fn(),
  getSecureRefreshToken: vi.fn(() => null),
  clearSecureAuthTokens: vi.fn(),
  getConfigValue: vi.fn(),
}));

import { forwardAuthExpiredToRenderer } from '../src/main/network/auth-refresh';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('auth:expired wiring — end-to-end glue', () => {
  it('auth.module.ts subscribes to authEvents AUTH_EXPIRED on init', () => {
    const source = read('src/main/modules/auth.module.ts');
    expect(source).toMatch(/import\s*\{[^}]*authEvents[^}]*\}\s*from\s*['"]\.\.\/network\/auth-refresh['"]/);
    // Subscriber pattern: authEvents.on(AUTH_EXPIRED, ...) somewhere
    // inside the init/registerIpcHandlers block.
    expect(source).toMatch(/authEvents\.on\(\s*AUTH_EXPIRED/);
  });

  it('auth.module.ts wires forwardAuthExpiredToRenderer (behaviour spec covers the rest)', () => {
    // This is intentionally just a wiring guard — the helper's actual
    // forwarding behaviour (channel-name spelling, destroyed-window
    // guard) is pinned by behaviour tests below, not by source grep.
    const source = read('src/main/modules/auth.module.ts');
    expect(source).toMatch(/forwardAuthExpiredToRenderer\s*\(/);
  });
});

describe('forwardAuthExpiredToRenderer — behaviour', () => {
  function makeFakeWindow(opts: { destroyed?: boolean } = {}) {
    const send = vi.fn();
    return {
      win: {
        isDestroyed: vi.fn(() => Boolean(opts.destroyed)),
        webContents: { send },
      } as unknown as Electron.BrowserWindow,
      send,
    };
  }

  it('sends "auth:expired" on the main window when invoked', () => {
    const { win, send } = makeFakeWindow();
    const forward = forwardAuthExpiredToRenderer(() => win);
    forward();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('auth:expired');
  });

  it('does NOT send when the window is destroyed (race after logout / app close)', () => {
    const { win, send } = makeFakeWindow({ destroyed: true });
    const forward = forwardAuthExpiredToRenderer(() => win);
    forward();
    expect(send).not.toHaveBeenCalled();
  });

  it('does NOT send when getter returns undefined (window not created yet)', () => {
    // Edge case: AUTH_EXPIRED can fire before the main window is
    // wired into the container (e.g. early init refresh attempt).
    const send = vi.fn();
    const forward = forwardAuthExpiredToRenderer(() => undefined);
    forward();
    expect(send).not.toHaveBeenCalled();
  });

  it('does NOT send when getter returns null', () => {
    const forward = forwardAuthExpiredToRenderer(() => null);
    expect(() => forward()).not.toThrow();
  });

  it('re-evaluates the window on each call (lazy getter — survives reload)', () => {
    // Main window can be recreated after a hot-reload; the forwarder
    // must read the LATEST window from the container, not capture a
    // stale reference at subscription time.
    const w1 = makeFakeWindow();
    const w2 = makeFakeWindow();
    let current: typeof w1 | typeof w2 = w1;
    const forward = forwardAuthExpiredToRenderer(() => current.win);

    forward();
    expect(w1.send).toHaveBeenCalledTimes(1);
    expect(w2.send).not.toHaveBeenCalled();

    current = w2;
    forward();
    expect(w1.send).toHaveBeenCalledTimes(1); // unchanged — old window untouched
    expect(w2.send).toHaveBeenCalledTimes(1); // new window receives event
  });

  it('preload.ts exposes auth.onExpired wrapping ipcRenderer.on("auth:expired")', () => {
    const source = read('src/preload/preload.ts');
    const idx = source.indexOf('onExpired:');
    expect(idx, 'auth.onExpired not exposed in preload').toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 400);
    expect(block).toMatch(/ipcRenderer\.on\(\s*['"]auth:expired['"]/);
    // Must return an unsubscribe function — useEffect cleanup needs it.
    expect(block).toMatch(/removeListener\(\s*['"]auth:expired['"]/);
  });

  it('electron.d.ts declares auth.onExpired so renderer code typechecks', () => {
    const source = read('src/shared/electron.d.ts');
    // Locate the auth: { ... } block under ElectronAPI and confirm
    // onExpired is declared as a subscribe-returning-unsubscribe.
    expect(source).toMatch(/onExpired:\s*\(callback:\s*\(\)\s*=>\s*void\)\s*=>\s*\(\)\s*=>\s*void/);
  });

  it('useAuth.ts subscribes to onExpired and clears auth state', () => {
    const source = read('src/renderer/hooks/useAuth.ts');
    expect(source).toMatch(/electronAPI\.auth\.onExpired/);
    // The handler must clear BOTH flags so App.tsx falls through to
    // AuthScreen on the next render. They are cleared in one setState call,
    // so assert on the resulting state rather than on two separate setters.
    const idx = source.indexOf('onExpired');
    const block = source.slice(idx, idx + 500);
    expect(block).toMatch(/setState\(\{[^}]*isAuthenticated:\s*false/);
    expect(block).toMatch(/setState\(\{[^}]*user:\s*null/);
  });

  it('useAuth.ts subscribes once per renderer and keeps the unsub handle — no listener leak', () => {
    const source = read('src/renderer/hooks/useAuth.ts');

    // The listener lives in the module-level store, not in a component
    // effect: a session can expire while no particular component is mounted,
    // so tearing it down on unmount would drop the event. The no-leak
    // guarantee therefore comes from subscribing exactly once, not from
    // unsubscribing on unmount.
    expect(source).toMatch(/expiredUnsub\s*=\s*window\.electronAPI\.auth\.onExpired/);

    // `started` is the once-guard that keeps remounts from stacking listeners.
    const startIdx = source.indexOf('function ensureStarted');
    expect(startIdx, 'ensureStarted() not found').toBeGreaterThan(-1);
    expect(source.slice(startIdx, startIdx + 200)).toMatch(/if\s*\(started\)\s*return;\s*started\s*=\s*true;/);

    // And the handle is retained so the store can release it on reset.
    expect(source).toMatch(/expiredUnsub\?\.\(\)/);
  });
});
