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

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

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

  it('auth.module.ts forwards AUTH_EXPIRED to the main window via webContents.send', () => {
    const source = read('src/main/modules/auth.module.ts');
    // The handler must call mainWindow.webContents.send with the
    // 'auth:expired' channel name. Catches a typo regression that
    // would silently break the renderer drop.
    const subscriptionIdx = source.indexOf('authEvents.on(');
    expect(subscriptionIdx).toBeGreaterThan(-1);
    const block = source.slice(subscriptionIdx, subscriptionIdx + 800);
    expect(block).toMatch(/webContents\.send\(\s*['"]auth:expired['"]/);
    // Defensive: must guard against destroyed window.
    expect(block).toMatch(/isDestroyed/);
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
    // The subscription effect must clear BOTH flags so App.tsx falls
    // through to AuthScreen on next render.
    const idx = source.indexOf('onExpired');
    const block = source.slice(idx, idx + 500);
    expect(block).toMatch(/setIsAuthenticated\(\s*false\s*\)/);
    expect(block).toMatch(/setUser\(\s*null\s*\)/);
  });

  it('useAuth.ts cleanup unsubscribes (returned unsub function) — no listener leak across remounts', () => {
    const source = read('src/renderer/hooks/useAuth.ts');
    const idx = source.indexOf('onExpired');
    const block = source.slice(idx, idx + 500);
    // Return value of useEffect must be the unsub returned by onExpired.
    expect(block).toMatch(/return\s+unsub/);
  });
});
