/**
 * Smoke tests for IPC bridge contracts.
 *
 * Verifies that the types declared in electron.d.ts match the preload
 * bridge structure. This doesn't test actual IPC, but validates
 * that type declarations stay in sync with the API shape.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Read source files as strings to validate contract consistency
const electronDts = readFileSync(join(__dirname, '../src/shared/electron.d.ts'), 'utf-8');
const preloadMain = readFileSync(join(__dirname, '../src/preload/preload.ts'), 'utf-8');
const preloadPos = readFileSync(join(__dirname, '../src/preload/preload-pos.ts'), 'utf-8');
const preloadDisplay = readFileSync(join(__dirname, '../src/preload/preload-display.ts'), 'utf-8');

describe('IPC channel contracts - main preload', () => {
  // Every top-level API group in preload.ts should have a corresponding
  // declaration in electron.d.ts
  const topLevelGroups = [
    'getConfig', 'setConfig', 'connect', 'disconnect', 'getStatus',
    'listPorts', 'listWindowsPrinters', 'testPrint',
    'remote', 'telegram', 'ai', 'booksy', 'auth',
    'window', 'selectFolder', 'shell', 'invoice', 'entitlements',
    'sshTunnel', 'display',
  ];

  for (const group of topLevelGroups) {
    it(`electron.d.ts declares "${group}"`, () => {
      expect(electronDts).toContain(group);
    });
    it(`preload.ts exposes "${group}"`, () => {
      expect(preloadMain).toContain(group);
    });
  }
});

describe('IPC channel contracts - POS preload', () => {
  const posGroups = [
    'pos.getState', 'pos.dispatch', 'pos.onStateChanged',
    'products', 'categories', 'orders', 'tables', 'customers', 'staff',
    'hold', 'quickKeys', 'shift', 'payment',
    'setConfig', 'saveConfig',
  ];

  for (const group of posGroups) {
    it(`preload-pos.ts exposes "${group}"`, () => {
      expect(preloadPos).toContain(group.split('.').pop()!);
    });
  }
});

describe('IPC channel contracts - display preload', () => {
  it('exposes pos.getState', () => {
    expect(preloadDisplay).toContain('getState');
  });

  it('exposes pos.onStateChanged', () => {
    expect(preloadDisplay).toContain('onStateChanged');
  });

  it('exposes getConfig (for language)', () => {
    expect(preloadDisplay).toContain('getConfig');
  });

  it('exposes display.touch', () => {
    expect(preloadDisplay).toContain('touch');
  });
});

describe('Type consistency', () => {
  it('electron.d.ts declares display.list method', () => {
    expect(electronDts).toContain('display');
    expect(electronDts).toContain('list');
    expect(electronDts).toContain('isPrimary');
  });

  it('electron.d.ts declares PosState-related types', () => {
    expect(electronDts).toContain('PosProduct');
    expect(electronDts).toContain('PosCategory');
    expect(electronDts).toContain('PosDailyStats');
    expect(electronDts).toContain('PosTable');
    expect(electronDts).toContain('PosCustomer');
    expect(electronDts).toContain('PosStaff');
  });

  it('preload-pos exposes customer display status listener', () => {
    expect(preloadPos).toContain('customer-display:status');
  });
});
