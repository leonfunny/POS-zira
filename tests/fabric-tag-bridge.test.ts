import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

async function loadPreload(preload: 'main' | 'pos'): Promise<any> {
  if (preload === 'main') {
    await import('../src/preload/preload');
  } else {
    await import('../src/preload/preload-pos');
  }

  const exposure = electron.exposures.find(({ name }) => name === 'electronAPI');
  expect(exposure, `${preload} preload did not expose electronAPI`).toBeDefined();
  return exposure!.api;
}

beforeEach(() => {
  vi.resetModules();
  electron.exposures.length = 0;
  electron.exposeInMainWorld.mockClear();
  electron.invoke.mockReset();
  electron.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => ({ channel, args }));
  electron.send.mockClear();
  electron.on.mockClear();
  electron.removeListener.mockClear();
});

describe('the fabric tag bridge reaches every window that needs it', () => {
  it.each([
    ['main', 'the main window, which renders the Label tab'],
    ['pos', 'the POS window'],
  ] as const)('exposes the exact runtime bridge through the %s preload (%s)', async (preload) => {
    const api = await loadPreload(preload);
    const bridge = api.pos.fabricTagTemplates;
    const template = {
      templateId: 'style-1',
      brandName: 'Zira',
      logoDataUrl: null,
      composition: '100% cotton',
      careSymbols: ['WASH_30'],
      careText: null,
      fabric: null,
      layout: 'default',
    };

    expect(Object.keys(bridge)).toEqual(['list', 'listIds', 'get', 'save', 'remove']);

    await bridge.list();
    expect(electron.invoke).toHaveBeenLastCalledWith('pos:fabric-tag-templates:list');

    await bridge.listIds();
    expect(electron.invoke).toHaveBeenLastCalledWith('pos:fabric-tag-templates:listIds');

    await bridge.get('style-1');
    expect(electron.invoke).toHaveBeenLastCalledWith('pos:fabric-tag-templates:get', 'style-1');

    await bridge.save(template);
    expect(electron.invoke).toHaveBeenLastCalledWith('pos:fabric-tag-templates:save', template);

    await bridge.remove('style-1');
    expect(electron.invoke).toHaveBeenLastCalledWith('pos:fabric-tag-templates:remove', 'style-1');
  });

  it('degrades to no fabric panel when the bridge is missing', () => {
    // Belt and braces for a preload that predates the binding: the module must
    // check before reaching through, or an old bundle takes the window down.
    const label = read('src/renderer/components/label/LabelModule.tsx');
    expect(label).toMatch(/window\.electronAPI\?\.pos\?\.fabricTagTemplates/);
  });
});
