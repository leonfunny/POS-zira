import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * There are two preloads. The POS window loads `preload-pos.ts`; the main
 * window loads `preload.ts`. The label module runs in the main window, so a
 * bridge added to only one of them is present in the code, compiled into the
 * bundle, and still missing at runtime — the panel quietly falls back to
 * browser storage and nothing reaches the server.
 *
 * That is exactly what happened when the print-order bridge shipped: the shop
 * machine ran a build that had the feature in it and stored nothing.
 */
const read = (file: string) =>
  readFileSync(resolve(__dirname, '..', 'src', 'preload', file), 'utf8');

describe('the two preloads expose the same shared bridges', () => {
  const pos = read('preload-pos.ts');
  const main = read('preload.ts');

  /**
   * Bridges the label module needs. It is mounted from the main window, and
   * every one of these is reached through `window.electronAPI.pos`.
   */
  const labelModuleBridges = ['fabricTagTemplates', 'labelPrintOrders'] as const;

  it.each(labelModuleBridges)('%s is wired in the POS preload', (name) => {
    expect(pos).toContain(`${name}:`);
  });

  it.each(labelModuleBridges)('%s is wired in the main-window preload', (name) => {
    expect(main).toContain(`${name}:`);
  });
});
