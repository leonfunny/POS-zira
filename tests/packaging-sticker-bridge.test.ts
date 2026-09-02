import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Label tab renders in the main window (preload.ts) while the POS window
 * uses preload-pos.ts. A channel declared in only one of them reads as
 * `undefined` in the other and the first access takes the whole renderer down —
 * that is exactly how the fabric tag panel whited out the app on 2026-09-01.
 */
const electron = vi.hoisted(() => {
  const exposures: Array<{ name: string; api: any }> = [];
  return {
    exposures,
    exposeInMainWorld: vi.fn((name: string, api: any) => exposures.push({ name, api })),
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    send: electron.send,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

async function loadPreload(preload: 'main' | 'pos'): Promise<any> {
  if (preload === 'main') await import('../src/preload/preload');
  else await import('../src/preload/preload-pos');
  const exposure = electron.exposures.find(({ name }) => name === 'electronAPI');
  expect(exposure, `${preload} preload did not expose electronAPI`).toBeDefined();
  return exposure!.api;
}

beforeEach(() => {
  vi.resetModules();
  electron.exposures.length = 0;
  electron.exposeInMainWorld.mockClear();
  electron.invoke.mockReset();
  electron.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => ({
    channel,
    args,
  }));
});

describe('the packaging sticker bridge reaches every window', () => {
  it.each([
    ['main', 'the main window, which renders the Label tab'],
    ['pos', 'the POS window'],
  ] as const)('binds printPackagingSticker in the %s preload (%s)', async (preload, _why) => {
    const api = await loadPreload(preload);

    expect(
      typeof api.printPackagingSticker,
      `printPackagingSticker missing from the ${preload} preload`,
    ).toBe('function');

    const request = {
      customerName: 'MoonCollection',
      styleName: 'KURTKA',
      styleCode: '114',
      colorName: 'CAPPUCCINO',
      code: 'SP006290',
      quantity: 4,
    };
    const result = await api.printPackagingSticker(request);

    // Quote the channel name in full: 'print-packaging-sticker' must not be
    // satisfied by a prefix of some other channel.
    expect(result.channel).toBe('print-packaging-sticker');
    expect(result.args).toEqual([request]);
  });

  it.each(['main', 'pos'] as const)(
    'still binds printLabel in the %s preload, so the EAN lane is untouched',
    async (preload) => {
      const api = await loadPreload(preload);
      expect(typeof api.printLabel).toBe('function');
    },
  );
});
