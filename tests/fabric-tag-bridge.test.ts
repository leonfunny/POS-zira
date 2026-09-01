import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A channel handled in the main process is useless until a preload exposes it,
 * and the app has more than one preload. Binding the fabric tag bridge only in
 * preload-pos left `pos.fabricTagTemplates` undefined in the main window --
 * where the Label tab actually lives -- and the first read of it white-screened
 * the whole app with "Cannot read properties of undefined".
 *
 * Nothing else notices: both files compile, and the gap only appears at runtime
 * in one window.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const FABRIC_CHANNELS = [
  'pos:fabric-tag-templates:list',
  'pos:fabric-tag-templates:listIds',
  'pos:fabric-tag-templates:get',
  'pos:fabric-tag-templates:save',
  'pos:fabric-tag-templates:remove',
];

describe('the fabric tag bridge reaches every window that needs it', () => {
  it('handles each channel in the main process', () => {
    const module = read('src/main/modules/pos.module.ts');
    for (const channel of FABRIC_CHANNELS) {
      expect(module, `${channel} has no handler`).toContain(`ipcMain.handle('${channel}'`);
    }
  });

  it.each([
    ['src/preload/preload.ts', 'the main window, which renders the Label tab'],
    ['src/preload/preload-pos.ts', 'the POS window'],
  ])('exposes each channel through %s', (path) => {
    const preload = read(path);
    for (const channel of FABRIC_CHANNELS) {
      // Quoted, because ...:list is a prefix of ...:listIds -- a bare substring
      // check passed while the `list` binding was actually missing.
      expect(preload, `${channel} is not bridged in ${path}`).toContain(`'${channel}'`);
    }
  });

  it('degrades to no fabric panel when the bridge is missing', () => {
    // Belt and braces for a preload that predates the binding: the module must
    // check before reaching through, or an old bundle takes the window down.
    const label = read('src/renderer/components/label/LabelModule.tsx');
    expect(label).toMatch(/window\.electronAPI\?\.pos\?\.fabricTagTemplates/);
  });
});
