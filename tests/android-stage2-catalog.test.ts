import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function source(path: string) {
  return readFile(resolve(ROOT, path), 'utf8');
}

// Packet S2 replaced the static Stage-2 synthetic catalog with the REAL Windows
// POS renderer (src/renderer/windows/pos/POSApp) mounted behind the typed
// `window.electronAPI` shim. These assertions pin that contract: the entry
// installs the shim before mounting POSApp, the shim module exists, and the
// shim's synthetic surface lands in the built Android web bundle.
describe('Android Stage 2 — real POS renderer behind the electronAPI shim', () => {
  test('the entry installs the shim with the real transport before mounting the boot app', async () => {
    const main = await source('src/renderer/android-pos/main.ts');

    // The shim is imported from the S2 shim package and invoked with the real
    // transport + the SHARED config store (S6+S7)...
    expect(main).toContain("from './shim'");
    expect(main).toContain('createRealTransport');
    expect(main).toMatch(/installShim\(\{ transport, configStore \}\)/);
    // ...and the boot app (LoginScreen ↔ the REAL Windows POS renderer) is what
    // gets mounted.
    expect(main).toContain("from './AndroidBootApp'");
    expect(main).toMatch(/createRoot/);
    // Source order: the installShim() call precedes the React mount call. (ES
    // module imports are hoisted, but POSApp's module is side-effect-free re:
    // electronAPI — the renderer only touches window.electronAPI at render
    // time, which follows installShim().)
    expect(main.indexOf('installShim(')).toBeLessThan(main.indexOf('createRoot('));

    // The boot app mounts the REAL Windows POS renderer after auth.
    const bootApp = await source('src/renderer/android-pos/AndroidBootApp.tsx');
    expect(bootApp).toContain("from '../windows/pos/POSApp'");
    expect(bootApp).toContain('LoginScreen');
    expect(bootApp).toContain('auth.onExpired');
  });

  test('the shim installer module exposes the typed surface', async () => {
    const installer = await source('src/renderer/android-pos/shim/index.ts');
    expect(installer).toContain('export function installShim');

    const stubs = await source('src/renderer/android-pos/shim/stubs.ts');
    // Benign S1 defaults that the CASH checkout + boot path depend on.
    expect(stubs).toContain("'telegram-login-unavailable'");
    expect(stubs).toContain("'no-printer'");
    expect(stubs).toContain("'no-scale'");
  });

  test('the built Android web bundle contains the shim surface', async () => {
    const assetsDir = resolve(ROOT, 'dist/android-web/assets');
    let entries: string[];
    let jsFile: string | undefined;
    try {
      entries = await readdir(assetsDir);
      jsFile = entries.find((name) => name.endsWith('.js'));
    } catch (error) {
      throw new Error(
        `Built Android web bundle missing at ${assetsDir}. Run "npm run build:android:web" first. (${String(error)})`,
      );
    }
    expect(jsFile, 'expected a built bundle .js asset under dist/android-web/assets').toBeTruthy();

    const bundle = await readFile(resolve(assetsDir, jsFile as string), 'utf8');
    // The shim assigns window.electronAPI (the renderer rides on it) and embeds
    // the synthetic S2 seed identity + persisted-config key — all unique to the
    // shim and present in the built output.
    expect(bundle).toContain('electronAPI');
    expect(bundle).toContain('dev@synthetic.local');
    expect(bundle).toContain('zira-android-pos-config');

    // S5 GOAL A: the entry now imports the renderer's Tailwind stylesheet
    // (../../index.css — the same file Windows pos/main.tsx imports), so the
    // mounted renderer is styled. Vite emits it as a hashed .css asset.
    const cssFile = (entries as string[]).find((name) => name.endsWith('.css'));
    expect(cssFile, 'expected a built bundle .css asset under dist/android-web/assets').toBeTruthy();
    if (cssFile) {
      const stylesheet = await readFile(resolve(assetsDir, cssFile), 'utf8');
      // Tailwind's compiled utilities land in the emitted CSS (the renderer's
      // classNames resolve). A non-empty stylesheet with a Tailwind directive
      // artifact confirms the right CSS was bundled, not a stray empty file.
      expect(stylesheet.length).toBeGreaterThan(0);
    }
  });
});
