import { describe, expect, it, vi } from 'vitest';

const { constructorOptions, storeData, storeMock } = vi.hoisted(() => {
  const data = new Map<string, unknown>([
    ['posMode', 'garment'],
    ['name', 'Factory label station'],
    ['printers', { FABRIC_TAG: { enabled: true, protocol: 'TSPL', windowsPrinter: 'TSC MB241' } }],
  ]);
  const set = (key: string | object, value?: unknown) => {
    if (typeof key === 'string') data.set(key, value);
    else for (const [entryKey, entryValue] of Object.entries(key)) data.set(entryKey, entryValue);
  };
  return {
    constructorOptions: [] as any[],
    storeData: data,
    storeMock: {
      set,
      get: (key: string) => data.get(key),
      has: (key: string) => data.has(key),
      clear: () => data.clear(),
      get store() {
        return Object.fromEntries(data);
      },
    },
  };
});

vi.mock('electron-store', () => ({
  default: class Store {
    constructor(options: unknown) {
      constructorOptions.push(options);
    }
    set = storeMock.set;
    get = storeMock.get;
    has = storeMock.has;
    clear = storeMock.clear;
    get store() {
      return storeMock.store;
    }
  },
}));

vi.mock('electron', () => ({ safeStorage: null }));

import { POS_MODES } from '../src/shared/types';
import { getConfig, setConfig, setConfigValue } from '../src/main/config/store';

describe('legacy garment POS mode migration', () => {
  it('accepts the legacy file long enough to normalize only posMode for rollback', () => {
    const schemaModes = constructorOptions[0]?.schema?.posMode?.enum;

    expect(schemaModes).toContain('garment');
    expect(POS_MODES).not.toContain('garment');
    expect(getConfig().posMode).toBe('retail');
    expect(storeData.get('posMode')).toBe('retail');
    expect(storeData.get('name')).toBe('Factory label station');
    expect(storeData.get('printers')).toEqual({
      FABRIC_TAG: { enabled: true, protocol: 'TSPL', windowsPrinter: 'TSC MB241' },
    });
  });

  it('normalizes stale runtime writes instead of persisting garment again', () => {
    setConfig({ posMode: 'garment' } as any);
    expect(storeData.get('posMode')).toBe('retail');

    setConfigValue('posMode', 'garment' as any);
    expect(storeData.get('posMode')).toBe('retail');
  });
});
