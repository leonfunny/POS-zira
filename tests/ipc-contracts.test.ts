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

describe('IPC channel contracts - POS methods must be in BOTH preloads', () => {
  const requiredPosMethods = [
    { scope: 'orders', method: 'cancel', ipc: 'pos:orders:cancel' },
    { scope: 'orders', method: 'downloadPdf', ipc: 'pos:orders:downloadPdf' },
    { scope: 'orders', method: 'generateProforma', ipc: 'pos:orders:generateProforma' },
    { scope: 'orders', method: 'addInvoice', ipc: 'pos:orders:addInvoice' },
    { scope: 'orders', method: 'getServerHistory', ipc: 'pos:orders:getServerHistory' },
    { scope: 'orders', method: 'retrySync', ipc: 'pos:orders:retrySync' },
    { scope: 'orders', method: 'repairStockFailures', ipc: 'pos:orders:repairStockFailures' },
    { scope: 'orders', method: 'getServerList', ipc: 'pos:orders:getServerList' },
    { scope: 'orders', method: 'getTodayServer', ipc: 'pos:orders:getTodayServer' },
    { scope: 'customers', method: 'lookupNip', ipc: 'pos:customers:lookupNip' },
    { scope: 'shift', method: 'getActive', ipc: 'pos:shift:getActive' },
    { scope: 'sync', method: 'onOrderSynced', ipc: 'pos:order-synced' },
    { scope: 'sync', method: 'onOrderSyncFailed', ipc: 'pos:order-sync-failed' },
  ];

  for (const { scope, method, ipc } of requiredPosMethods) {
    it(`preload-pos.ts exposes ${scope}.${method}`, () => {
      expect(preloadPos).toContain(method);
      expect(preloadPos).toContain(ipc);
    });
    it(`preload.ts (main window) also exposes ${scope}.${method}`, () => {
      expect(preloadMain).toContain(method);
      expect(preloadMain).toContain(ipc);
    });
    it(`electron.d.ts declares ${scope}.${method}`, () => {
      expect(electronDts).toContain(method);
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

  it('exposes a customer display config refresh listener', () => {
    expect(preloadDisplay).toContain('onRefreshConfig');
    expect(preloadDisplay).toContain('customer-display:refresh-config');
    expect(electronDts).toContain('onRefreshConfig');
  });

  it('exposes display.touch', () => {
    expect(preloadDisplay).toContain('touch');
  });

  it('keeps multi-service browse check-in payload in sync across preload and declarations', () => {
    expect(preloadDisplay).toContain('services');
    expect(electronDts).toContain('services');
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

describe('Refund payload passes lines[] end-to-end', () => {
  const orderHistoryModal = readFileSync(
    join(__dirname, '../src/renderer/components/pos/OrderHistoryModal.tsx'), 'utf-8',
  );
  const posModule = readFileSync(
    join(__dirname, '../src/main/modules/pos.module.ts'), 'utf-8',
  );
  const apiClientSrc = readFileSync(
    join(__dirname, '../src/main/network/api-client.ts'), 'utf-8',
  );

  it('renderer sends lines (not items) in refund payload', () => {
    expect(orderHistoryModal).toContain('lines: refundItems');
    expect(orderHistoryModal).not.toMatch(/items:\s*refundItems/);
  });

  it('renderer does NOT send local item.id as orderItemId', () => {
    expect(orderHistoryModal).not.toContain('orderItemId: item.id');
  });

  it('main IPC handler forwards lines to apiClient', () => {
    expect(posModule).toContain('backendPayload.lines = lines');
  });

  it('main IPC handler maps lines explicitly without orderItemId', () => {
    expect(posModule).toContain('variantId: l.variantId');
    expect(posModule).toContain('sku: l.sku');
    expect(posModule).toContain('restock: l.restock');
    expect(posModule).not.toMatch(/orderItemId.*l\./);
  });

  it('apiClient refundOrder accepts Record<string, any> (not legacy amount-only type)', () => {
    expect(apiClientSrc).toContain('data: Record<string, any>');
    expect(apiClientSrc).toContain('body: JSON.stringify(data)');
  });

  it('main IPC handler converts line unitPrice/refundAmount from grosze to PLN', () => {
    expect(posModule).toContain('unitPrice: l.unitPrice / 100');
    expect(posModule).toContain('refundAmount: l.refundAmount / 100');
  });
});
