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

// Source files in this repo are checked in with CRLF on Windows. String
// assertions in this file embed multi-line snippets using `\n`, so we
// normalize line endings on read to keep the tests cross-platform.
function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}
import { toCashDrawerIpcResult } from '../src/main/pos/cash-drawer-ipc-result';
import {
  buildRefundMutationError,
  getRefundBackendResponseSummary,
  mergeRefundLines,
  toRefundBackendPayload,
  validateRefundBackendResponse,
} from '../src/main/pos/refund-backend-payload';
import { buildRefundRequest } from '../src/renderer/components/pos/refund-request';
import {
  getRemainingRefundableItems,
  getSafeRemainingTotal,
  hasRefundOverage,
} from '../src/renderer/components/pos/refund-quantities';
import {
  compareOrdersByDisplayTimeDesc,
  parseOrderTimestampMs,
} from '../src/renderer/components/pos/order-history-time';

// Read source files as strings to validate contract consistency
const electronDts = readSource('../src/shared/electron.d.ts');
const preloadMain = readSource('../src/preload/preload.ts');
const preloadPos = readSource('../src/preload/preload-pos.ts');
const preloadDisplay = readSource('../src/preload/preload-display.ts');
const posModuleSrc = readSource('../src/main/modules/pos.module.ts');
const preloadSelfCheckout = readSource('../src/preload/preload-self-checkout.ts');
const windowManagerSource = readSource('../src/main/windows/window-manager.ts');
const sharedTypes = readSource('../src/shared/types.ts');
const settingsSrc = readSource('../src/renderer/components/Settings.tsx');

describe('IPC channel contracts - main preload', () => {
  const topLevelGroups = [
    'getConfig', 'setConfig', 'connect', 'disconnect', 'getStatus',
    'listPorts', 'listWindowsPrinters', 'testPrint',
    'remote', 'telegram', 'ai', 'booksy', 'auth',
    'window', 'selectFolder', 'shell', 'invoice', 'entitlements',
    'sshTunnel', 'display', 'backup',
  ];

  for (const group of topLevelGroups) {
    it(`electron.d.ts declares "${group}"`, () => {
      expect(electronDts).toContain(group);
    });
    it(`preload.ts exposes "${group}"`, () => {
      expect(preloadMain).toContain(group);
    });
  }

  const backupMethods = [
    { method: 'list', ipc: 'backup:list', constant: 'BACKUP_LIST' },
    { method: 'prepareRestore', ipc: 'backup:prepare-restore', constant: 'BACKUP_PREPARE_RESTORE' },
    { method: 'openDataFolder', ipc: 'backup:open-data-folder', constant: 'BACKUP_OPEN_DATA_FOLDER' },
  ];

  for (const { method, ipc, constant } of backupMethods) {
    it(`backup bridge exposes ${method}`, () => {
      expect(preloadMain).toContain(method);
      expect(preloadMain).toContain(constant);
      expect(sharedTypes).toContain(ipc);
      expect(electronDts).toContain(method);
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
    { scope: 'products', method: 'getById', ipc: 'pos:products:getById' },
    { scope: 'products', method: 'searchByCode', ipc: 'pos:products:searchByCode' },
    { scope: 'draftProducts', method: 'getByBarcode', ipc: 'pos:draft-products:getByBarcode' },
    { scope: 'masterCatalog', method: 'scanCreate', ipc: 'pos:master-catalog:scan-create' },
    { scope: 'masterCatalog', method: 'lookupExternalByEan', ipc: 'pos:master-catalog:lookup-external-by-ean' },
    { scope: 'masterCatalog', method: 'importExternal', ipc: 'pos:master-catalog:import-external' },
    { scope: 'quickAdd', method: 'prepare', ipc: 'pos:quick-add:prepare' },
    { scope: 'quickAdd', method: 'finalize', ipc: 'pos:quick-add:finalize' },
    { scope: 'voice', method: 'transcribe', ipc: 'pos:voice:transcribe' },
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

  it('guards customer-display IPC handlers to the customer window and live profile', () => {
    expect(posModuleSrc).toContain('private allowCustomerDisplayIpc');
    expect(posModuleSrc).toContain('BrowserWindow.fromWebContents(event.sender)');
    expect(posModuleSrc).toContain("this.allowCustomerDisplayIpc(e, 'display:check-in', 'salon_checkin')");
    expect(posModuleSrc).toContain("this.allowCustomerDisplayIpc(e, 'display:request-service', 'salon_checkin')");
    expect(posModuleSrc).toContain("this.allowCustomerDisplayIpc(e, 'display:search-by-phone', 'salon_checkin')");
    expect(windowManagerSource).toContain("logger.warn('[WindowManager] Rejected display:close from non-customer window')");
    expect(windowManagerSource).toContain("return { success: false, error: 'invalid_display_sender' }");
  });

  it('only confirms customer check-in after local persistence succeeds', () => {
    const handlerStart = posModuleSrc.indexOf("ipcMain.handle('display:check-in'");
    const handlerEnd = posModuleSrc.indexOf('// Customer display: switch to browse services from checkin', handlerStart);
    const handler = posModuleSrc.slice(handlerStart, handlerEnd);

    expect(handler).toContain("return { success: false, error: 'customer_name_required' }");
    expect(handler).toContain("return { success: false, error: 'failed_to_save_check_in' }");
    expect(handler).toContain('services_json: services ? JSON.stringify(services) : undefined');
    expect(handler.indexOf('database.save()')).toBeLessThan(handler.indexOf('this.posStore?.handleCheckIn(normalizedData)'));
    expect(handler).toContain('return { success: true, bookingNumber, checkinId }');
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
  const orderHistoryModal = readSource('../src/renderer/components/pos/OrderHistoryModal.tsx');
  const posModule = readSource('../src/main/modules/pos.module.ts');
  const apiClientSrc = readSource('../src/main/network/api-client.ts');

  it('renderer sends lines (not items) in refund payload', () => {
    expect(orderHistoryModal).toContain('buildRefundRequest');
    expect(orderHistoryModal).toContain('computedRefundTotal');
    expect(orderHistoryModal).toContain('lines: refundItems');
    expect(orderHistoryModal).not.toMatch(/items:\s*refundItems/);
  });

  it('electron.d.ts allows amount on the renderer refund IPC payload', () => {
    expect(electronDts).toContain('amount?: number;');
    expect(electronDts).toContain('refundRequestId?: string;');
  });

  it('renderer sends amount for partial refund in grosze', () => {
    expect(buildRefundRequest({
      type: 'PARTIAL',
      refundRequestId: 'refund-request-1',
      reason: 'Damaged item',
      computedRefundTotal: 1234,
      lines: [
        { name: 'Bulka', quantity: 2, unitPrice: 200, refundAmount: 400, restock: true },
        { name: 'Mleko', quantity: 1, unitPrice: 834, refundAmount: 834, restock: true },
      ],
    })).toEqual({
      type: 'PARTIAL',
      refundRequestId: 'refund-request-1',
      reason: 'Damaged item',
      amount: 1234,
      lines: [
        { name: 'Bulka', quantity: 2, unitPrice: 200, refundAmount: 400, restock: true },
        { name: 'Mleko', quantity: 1, unitPrice: 834, refundAmount: 834, restock: true },
      ],
    });
  });

  it('renderer sends remaining amount for full refund too', () => {
    expect(buildRefundRequest({
      type: 'FULL',
      refundRequestId: 'refund-request-full-1',
      reason: 'Customer request',
      computedRefundTotal: 1234,
      lines: [
        { name: 'Bulka', quantity: 2, unitPrice: 200, refundAmount: 400, restock: true },
      ],
    })).toEqual({
      type: 'FULL',
      refundRequestId: 'refund-request-full-1',
      reason: 'Customer request',
      amount: 1234,
      lines: [
        { name: 'Bulka', quantity: 2, unitPrice: 200, refundAmount: 400, restock: true },
      ],
    });
  });

  it('renderer generates refundRequestId only inside the actual refund attempt', () => {
    expect(orderHistoryModal).toContain('const refundRequestIdRef = useRef<string | null>(null)');
    expect(orderHistoryModal).toContain('refundRequestIdRef.current ?? createRefundRequestId()');
    expect(orderHistoryModal).toContain('refundRequestIdRef.current = refundRequestId');
    expect(orderHistoryModal).toContain('const resetRefundRequestId = () =>');
    expect(orderHistoryModal).toContain('resetRefundRequestId();');
  });

  it('keeps refundRequestId stable across transport errors for the same visible attempt', () => {
    expect(orderHistoryModal).toContain('} catch (e: any) {');
    expect(orderHistoryModal).toContain("setError(e.message || 'Refund failed')");
    expect(orderHistoryModal).not.toContain('finally {\n      refundRequestIdRef.current = null;');
    expect(orderHistoryModal).toContain('if (result.success) {\n        resetRefundRequestId();');
    expect(orderHistoryModal).toContain('} else if ((result as any).mutationDetected || (result as any).requiresRefresh) {\n        resetRefundRequestId();');
  });

  it('renderer does NOT send local item.id as orderItemId', () => {
    expect(orderHistoryModal).not.toContain('orderItemId: item.id');
  });

  it('main IPC handler forwards lines to apiClient', () => {
    expect(posModule).toContain('toRefundBackendPayload(data)');
  });

  it('main IPC handler maps lines explicitly without orderItemId', () => {
    expect(posModule).toContain('variantId: l.variantId');
    expect(posModule).toContain('sku: l.sku');
    expect(posModule).toContain('restock: l.restock');
    expect(posModule).not.toMatch(/orderItemId.*l\./);
  });

  it('main IPC handler logs backend refund response summary before local persistence', () => {
    expect(posModule).toContain('Refund backend response');
    expect(posModule).toContain('refundAmount=${summary.refundAmount');
    expect(posModule).toContain('refundedLines.length=${summary.refundedLinesLength}');
    expect(posModule).toContain('stockMovementIds.length=${summary.stockMovementIdsLength}');
    expect(posModule).toContain('validateRefundBackendResponse(result');
    expect(posModule.indexOf('validateRefundBackendResponse(result')).toBeLessThan(
      posModule.indexOf('orderRepo.markRefunded'),
    );
  });

  it('main IPC handler stores cumulative refund_lines but prints the delta refund receipt', () => {
    expect(posModule).toContain('mergeRefundLines(order.refund_lines, deltaRefundLines)');
    expect(posModule).toContain('orderRepo.markRefunded(orderId, refundedAmount, refundReason, status, cumulativeRefundLines.length > 0 ? cumulativeRefundLines : undefined)');
    expect(posModule).toContain('getRefundExpectedDeltaCandidates(data, requestedAmountGrosze, order)');
    expect(posModule).toContain('expectedDeltaGroszeCandidates');
    expect(posModule).toContain('printRefundReceipt(orderId, {');
    expect(posModule).toContain('amount: validation.refundAmountGrosze ?? refundedAmount');
    expect(posModule).toContain('lines: deltaRefundLines');
  });

  it('renderer sends vatRate for refund lines and surfaces refund receipt print failures', () => {
    expect(orderHistoryModal).toContain('vatRate: item.vat_rate');
    expect(orderHistoryModal).toContain('deriveReceiptOutcome(result, t)');
    expect(orderHistoryModal).toContain('printWarning: outcome.warning');
    expect(electronDts).toContain('receiptPrinted?: boolean');
  });

  it('startup does not retroactively finish every synced order', () => {
    expect(posModule).not.toContain('Retroactively finished order');
    expect(posModule).not.toContain('SELECT backend_id, order_number FROM orders WHERE synced = 1');
  });

  it('apiClient refundOrder accepts Record<string, any> (not legacy amount-only type)', () => {
    expect(apiClientSrc).toContain('data: Record<string, any>');
    expect(apiClientSrc).toContain('body: JSON.stringify(data)');
  });

  it('main IPC handler converts line unitPrice/refundAmount from grosze to PLN', () => {
    expect(toRefundBackendPayload({
      type: 'PARTIAL',
      refundRequestId: 'refund-request-2',
      amount: 400,
      lines: [
        { variantId: 'v1', sku: 'BULKA-1', name: 'Bulka', quantity: 2, unitPrice: 200, refundAmount: 400, restock: true },
      ],
    })).toEqual({
      type: 'PARTIAL',
      refundRequestId: 'refund-request-2',
      reason: undefined,
      amount: 4,
      lines: [
        { variantId: 'v1', sku: 'BULKA-1', name: 'Bulka', quantity: 2, unitPrice: 2, refundAmount: 4, restock: true },
      ],
    });
  });

  it('main payload includes refundRequestId in POST body', () => {
    expect(toRefundBackendPayload({
      type: 'PARTIAL',
      refundRequestId: 'refund-request-3',
      amount: 1234,
      lines: [
        { name: 'Bulka', quantity: 2, unitPrice: 200, refundAmount: 400, restock: true },
      ],
    })).toMatchObject({
      type: 'PARTIAL',
      refundRequestId: 'refund-request-3',
      amount: 12.34,
    });
  });

  it('main payload includes explicit partial amount converted from grosze to PLN', () => {
    expect(toRefundBackendPayload({
      type: 'PARTIAL',
      reason: 'Damaged item',
      amount: 1234,
      lines: [
        { name: 'Bulka', quantity: 2, unitPrice: 200, refundAmount: 400, restock: true },
      ],
    })).toMatchObject({
      type: 'PARTIAL',
      reason: 'Damaged item',
      amount: 12.34,
    });
  });

  it('main payload sends full refund amount converted from grosze to PLN', () => {
    expect(toRefundBackendPayload({
      type: 'FULL',
      refundRequestId: 'refund-request-full-2',
      reason: 'Customer request',
      amount: 1400,
      lines: [
        { name: 'Remaining item', quantity: 1, unitPrice: 1400, refundAmount: 1400, restock: true },
      ],
    })).toMatchObject({
      type: 'FULL',
      refundRequestId: 'refund-request-full-2',
      reason: 'Customer request',
      amount: 14,
    });
  });

  it('main payload derives partial amount from lines when renderer omits it', () => {
    expect(toRefundBackendPayload({
      type: 'PARTIAL',
      reason: 'Damaged item',
      lines: [
        { name: 'Bulka', quantity: 2, unitPrice: 200, refundAmount: 400, restock: true },
        { name: 'Mleko', quantity: 1, unitPrice: 350, refundAmount: 350, restock: true },
      ],
    })).toMatchObject({
      type: 'PARTIAL',
      reason: 'Damaged item',
      amount: 7.5,
    });
  });

  it('main payload sends a 2 x 17.99 partial restock as POS lines with amount 35.98', () => {
    expect(toRefundBackendPayload({
      type: 'PARTIAL',
      reason: 'Damaged item',
      amount: 3598,
      lines: [
        { variantId: 'variant-17-99', sku: 'SKU-1799', name: 'Refunded item', quantity: 2, unitPrice: 1799, refundAmount: 3598, restock: true },
      ],
    })).toEqual({
      type: 'PARTIAL',
      reason: 'Damaged item',
      amount: 35.98,
      lines: [
        { variantId: 'variant-17-99', sku: 'SKU-1799', name: 'Refunded item', quantity: 2, unitPrice: 17.99, refundAmount: 35.98, restock: true },
      ],
    });
  });

  it('accepts only a backend response that confirms refund amount, refund lines, and restock movement', () => {
    const result = {
      success: true,
      status: 'PARTIAL_REFUND',
      refundAmount: 35.98,
      totalRefundedAmount: 35.98,
      refundedLines: [
        { variantId: 'variant-17-99', sku: 'SKU-1799', name: 'Refunded item', quantity: 2, unitPrice: 17.99, refundAmount: 35.98, taxRate: 23 },
      ],
      stockMovementIds: ['stock-move-1'],
    };

    const summary = getRefundBackendResponseSummary(result);
    expect(summary).toEqual({
      status: 'PARTIAL_REFUND',
      refundAmount: 35.98,
      totalRefundedAmount: 35.98,
      refundedLinesLength: 1,
      stockMovementIdsLength: 1,
    });

    const validation = validateRefundBackendResponse(result, {
      type: 'PARTIAL',
      requestedAmountGrosze: 3598,
      orderTotalGrosze: 10000,
      alreadyRefundedGrosze: 0,
      requireRefundedLines: true,
      requireStockMovement: true,
    });
    expect(validation.ok).toBe(true);
    expect(validation.classification).toBe('confirmedComplete');
    expect(validation.mutationDetected).toBe(true);
    expect(validation.requiresRefresh).toBe(false);
    expect(validation.refundedAmountGrosze).toBe(3598);
    expect(validation.refundAmountGrosze).toBe(3598);
  });

  it('accepts backend gross refund amounts when the client refund line was net plus VAT', () => {
    const validation = validateRefundBackendResponse({
      success: true,
      status: 'PARTIAL_REFUND',
      refundAmount: 7,
      totalRefundedAmount: 7,
      refundedLines: [
        { variantId: 'variant-8vat', sku: 'VAT8', name: 'Grossed item', quantity: 1, unitPrice: 7, refundAmount: 7, taxRate: 8 },
      ],
      stockMovementIds: ['stock-move-8vat'],
    }, {
      type: 'PARTIAL',
      requestedAmountGrosze: 648,
      orderTotalGrosze: 2100,
      alreadyRefundedGrosze: 0,
      requireRefundedLines: true,
      requireStockMovement: true,
      expectedDeltaGroszeCandidates: [700],
    });

    expect(validation.ok).toBe(true);
    expect(validation.classification).toBe('confirmedComplete');
    expect(validation.refundAmountGrosze).toBe(700);
    expect(validation.refundedAmountGrosze).toBe(700);
  });

  it('does not treat refundAmount alone as the cumulative refunded total', () => {
    const validation = validateRefundBackendResponse({
      success: true,
      status: 'PARTIAL_REFUND',
      refundAmount: 35.98,
      refundedLines: [
        { variantId: 'variant-17-99', sku: 'SKU-1799', quantity: 2, unitPrice: 17.99, refundAmount: 35.98 },
      ],
      stockMovementIds: ['stock-move-1'],
    }, {
      type: 'PARTIAL',
      requestedAmountGrosze: 3598,
      orderTotalGrosze: 10000,
      alreadyRefundedGrosze: 0,
      requireRefundedLines: true,
      requireStockMovement: true,
    });

    expect(validation.ok).toBe(false);
    expect(validation.classification).toBe('mutatedButIncomplete');
    expect(validation.missingTotalRefundedAmount).toBe(true);
    expect(validation.refundedAmountGrosze).toBeNull();
  });

  it('classifies the known broken backend response as mutated but incomplete', () => {
    const validation = validateRefundBackendResponse({
      success: true,
      status: 'PARTIAL_REFUND',
      refundAmount: 0,
      refundedLines: [],
      stockMovementIds: [],
    }, {
      type: 'PARTIAL',
      requestedAmountGrosze: 3598,
      orderTotalGrosze: 10000,
      alreadyRefundedGrosze: 0,
      requireRefundedLines: true,
      requireStockMovement: true,
    });

    expect(validation.ok).toBe(false);
    expect(validation.classification).toBe('mutatedButIncomplete');
    expect(validation.mutationDetected).toBe(true);
    expect(validation.requiresRefresh).toBe(true);
    expect(validation.amountMismatch).toBe(true);
    expect(buildRefundMutationError(validation)).toContain('do not retry');
  });

  it('rejects a positive refund response if backend did not persist refund lines', () => {
    const validation = validateRefundBackendResponse({
      success: true,
      status: 'PARTIAL_REFUND',
      refundAmount: 35.98,
      totalRefundedAmount: 35.98,
      refundedLines: [],
      stockMovementIds: ['stock-move-1'],
    }, {
      type: 'PARTIAL',
      requestedAmountGrosze: 3598,
      orderTotalGrosze: 10000,
      alreadyRefundedGrosze: 0,
      requireRefundedLines: true,
      requireStockMovement: true,
    });

    expect(validation.ok).toBe(false);
    expect(validation.classification).toBe('mutatedButIncomplete');
    expect(validation.missingLines).toBe(true);
    expect(validation.mutationDetected).toBe(true);
    expect(validation.requiresRefresh).toBe(true);
  });

  it('rejects a restock refund response if backend did not return stock movement ids', () => {
    const validation = validateRefundBackendResponse({
      success: true,
      status: 'PARTIAL_REFUND',
      refundAmount: 35.98,
      totalRefundedAmount: 35.98,
      refundedLines: [
        { variantId: 'variant-17-99', sku: 'SKU-1799', quantity: 2, unitPrice: 17.99, refundAmount: 35.98 },
      ],
      stockMovementIds: [],
    }, {
      type: 'PARTIAL',
      requestedAmountGrosze: 3598,
      orderTotalGrosze: 10000,
      alreadyRefundedGrosze: 0,
      requireRefundedLines: true,
      requireStockMovement: true,
    });

    expect(validation.ok).toBe(false);
    expect(validation.classification).toBe('mutatedButIncomplete');
    expect(validation.missingStockMovement).toBe(true);
    expect(validation.mutationDetected).toBe(true);
    expect(validation.requiresRefresh).toBe(true);
  });

  it('flags the POS-20260506-0001 over-refund response and forces refresh/no retry', () => {
    const validation = validateRefundBackendResponse({
      success: true,
      status: 'REFUNDED',
      refundAmount: 23.66,
      totalRefundedAmount: 51.66,
      refundedLines: [],
      stockMovementIds: [],
    }, {
      type: 'FULL',
      requestedAmountGrosze: 1400,
      orderTotalGrosze: 4200,
      alreadyRefundedGrosze: 2800,
      requireRefundedLines: true,
      requireStockMovement: true,
    });

    expect(validation.ok).toBe(false);
    expect(validation.classification).toBe('mutatedButIncomplete');
    expect(validation.overRefund).toBe(true);
    expect(validation.mutationDetected).toBe(true);
    expect(validation.requiresRefresh).toBe(true);
    expect(buildRefundMutationError(validation)).toContain('do not retry');
  });

  it('treats partial refund amounts as cumulative backend totals', () => {
    const validation = validateRefundBackendResponse({
      success: true,
      status: 'PARTIAL_REFUND',
      refundAmount: 35.98,
      totalRefundedAmount: 42,
      refundedLines: [
        { variantId: 'variant-17-99', quantity: 2, unitPrice: 17.99, refundAmount: 35.98 },
      ],
      stockMovementIds: ['stock-move-2'],
    }, {
      type: 'PARTIAL',
      requestedAmountGrosze: 3598,
      orderTotalGrosze: 10000,
      alreadyRefundedGrosze: 602,
      requireRefundedLines: true,
      requireStockMovement: true,
    });

    expect(validation.ok).toBe(true);
    expect(validation.refundedAmountGrosze).toBe(4200);
  });

  it('requires full refunds to end at the order total, not already + requested drift', () => {
    const validation = validateRefundBackendResponse({
      success: true,
      status: 'REFUNDED',
      refundAmount: 14,
      totalRefundedAmount: 42,
      refundedLines: [
        { variantId: 'variant-1', quantity: 1, unitPrice: 14, refundAmount: 14 },
      ],
      stockMovementIds: ['stock-move-3'],
    }, {
      type: 'FULL',
      requestedAmountGrosze: 1400,
      orderTotalGrosze: 4200,
      alreadyRefundedGrosze: 2800,
      requireRefundedLines: true,
      requireStockMovement: true,
    });

    expect(validation.ok).toBe(true);
    expect(validation.refundedAmountGrosze).toBe(4200);
  });

  it('blocks further refund quantities when local refund amount exists without backend refund lines', () => {
    const result = getRemainingRefundableItems({
      total: 4200,
      refund_amount: 2800,
      refund_lines: null,
    }, [
      { id: 'item-1', variant_id: 'variant-1', sku: 'SKU-1', name: 'Service', price: 1400, quantity: 3, total: 4200, order_id: 'order-1', vat_rate: 23 },
    ]);

    expect(result.unsafeMissingRefundLines).toBe(true);
    expect(result.items).toEqual([]);
  });

  it('subtracts already refunded quantities from future full/partial refund choices', () => {
    const result = getRemainingRefundableItems({
      total: 5397,
      refund_amount: 3598,
      refund_lines: JSON.stringify([
        { variantId: 'variant-17-99', sku: 'SKU-1799', quantity: 2, refundAmount: 3598 },
      ]),
    }, [
      { id: 'item-1', variant_id: 'variant-17-99', sku: 'SKU-1799', name: 'Refunded item', price: 1799, quantity: 3, total: 5397, order_id: 'order-1', vat_rate: 23 },
    ]);

    expect(result.unsafeMissingRefundLines).toBe(false);
    expect(result.items[0].maxQty).toBe(1);
  });

  it('clamps remaining refund total and detects backend over-refund rows', () => {
    const order = { total: 4200, refund_amount: 5166 };
    expect(getSafeRemainingTotal(order)).toBe(0);
    expect(hasRefundOverage(order)).toBe(true);
  });

  it('merges backend delta refundedLines into cumulative local refund_lines', () => {
    const existing = JSON.stringify([
      { variantId: 'variant-1', sku: 'SKU-1', name: 'First item', quantity: 1, unitPrice: 1000, refundAmount: 1000, vatRate: 23 },
    ]);
    const merged = mergeRefundLines(existing, [
      { variantId: 'variant-2', sku: 'SKU-2', name: 'Second item', quantity: 2, unitPrice: 500, refundAmount: 1000, vatRate: 8 },
    ]);

    expect(merged).toEqual([
      { variantId: 'variant-1', sku: 'SKU-1', name: 'First item', quantity: 1, unitPrice: 1000, refundAmount: 1000, vatRate: 23 },
      { variantId: 'variant-2', sku: 'SKU-2', name: 'Second item', quantity: 2, unitPrice: 500, refundAmount: 1000, vatRate: 8 },
    ]);
    expect(merged.reduce((sum, line) => sum + line.refundAmount, 0)).toBe(2000);
  });

  it('renderer closes/refreshes mutated refund responses and uses remaining totals', () => {
    expect(orderHistoryModal).toContain('getSafeRemainingTotal(order)');
    expect(orderHistoryModal).toContain('unsafeMissingRefundLines');
    expect(orderHistoryModal).toContain("refundStatus !== 'full'");
    expect(orderHistoryModal).toContain('detailRefundableResult.items.some');
    expect(orderHistoryModal).toContain('!refundBlockedByMissingLines');
    expect(orderHistoryModal).toContain('(result as any).mutationDetected || (result as any).requiresRefresh');
    expect(orderHistoryModal).toContain('Review refund (${formatMoney(computedRefundTotal, currency)})');
    expect(orderHistoryModal).toContain('Confirm refund (${formatMoney(computedRefundTotal, currency)})');
    expect(electronDts).toContain('mutationDetected?: boolean');
    expect(electronDts).toContain('requiresRefresh?: boolean');
  });

  it('renderer shows refund breakdown and keeps the success summary actionable', () => {
    expect(orderHistoryModal).toContain('getItemRefundBreakdowns(order, items)');
    expect(orderHistoryModal).toContain('getRefundBreakdownLines(order)');
    expect(orderHistoryModal).toContain('Refund breakdown');
    expect(orderHistoryModal).toContain('refunded -');
    expect(orderHistoryModal).toContain('setSuccessSummary({');
    expect(orderHistoryModal).toContain('Print refund receipt');
    expect(orderHistoryModal).toContain('onComplete({ keepRefundOpen: true })');
    expect(orderHistoryModal).toContain('const refreshLocalOrderDetail = async (orderId: string)');
    expect(orderHistoryModal).toContain('refreshLocalOrderDetail(order.id).finally');
    expect(orderHistoryModal).not.toContain('setTimeout(onComplete, 1500)');
  });
});

describe('Printer settings contract', () => {
  it('shows paper controls for receipt-like WINDOWS printer slots', () => {
    expect(settingsSrc).toContain("PAPER_CONTROL_PRINTER_TYPES = ['RECEIPT', 'TICKET', 'KITCHEN']");
    expect(settingsSrc).toContain("printerConfig.protocol === 'WINDOWS' && renderPaperControls(printerType, printerConfig)");
  });

  it('keeps paper controls scoped away from label and A4 slots', () => {
    expect(settingsSrc).toContain('isPaperControlPrinterType(printerType)');
    expect(settingsSrc).toContain('{isLabel && (');
  });
});

describe('Order history sorting contract', () => {
  const orderHistoryModal = readSource('../src/renderer/components/pos/OrderHistoryModal.tsx');

  it('sorts local SQLite timestamps with the same UTC parser used for display', () => {
    const localCreatedAt = '2026-05-06 11:53:31';
    const serverCreatedAt = '2026-05-06T10:17:41.574Z';

    expect(parseOrderTimestampMs(localCreatedAt)).toBeGreaterThan(
      parseOrderTimestampMs(serverCreatedAt),
    );

    const sorted = [
      { id: 'server-1217', created_at: serverCreatedAt },
      { id: 'local-1353', created_at: localCreatedAt },
    ].sort(compareOrdersByDisplayTimeDesc);

    expect(sorted.map((o) => o.id)).toEqual(['local-1353', 'server-1217']);
  });

  it('uses deterministic timestamp tie-breakers without sorting by order number', () => {
    const sorted = [
      { id: 'a-id', created_at: '2026-05-06T10:17:41.574Z' },
      { id: 'b-id', created_at: '2026-05-06T10:17:41.574Z' },
    ].sort(compareOrdersByDisplayTimeDesc);

    expect(sorted.map((o) => o.id)).toEqual(['b-id', 'a-id']);
    expect(orderHistoryModal).toContain('merged.sort(compareOrdersByDisplayTimeDesc)');
    expect(orderHistoryModal).not.toContain('new Date(b.created_at).getTime()');
  });
});

describe('Cash drawer IPC contract', () => {
  it('maps an opened drawer to a successful IPC result', () => {
    expect(toCashDrawerIpcResult(true)).toEqual({
      success: true,
      drawerOpened: true,
    });
  });

  it('maps a false drawer result to a truthful IPC failure', () => {
    expect(toCashDrawerIpcResult(false)).toEqual({
      success: false,
      drawerOpened: false,
      error: 'Cash drawer did not open',
    });
  });

  it('maps an undefined drawer result to a truthful IPC failure', () => {
    expect(toCashDrawerIpcResult(undefined)).toEqual({
      success: false,
      drawerOpened: false,
      error: 'Cash drawer did not open',
    });
  });

  it('preserves a readable error message for the IPC catch path', () => {
    expect(toCashDrawerIpcResult(false, new Error('printer offline'))).toEqual({
      success: false,
      drawerOpened: false,
      error: 'printer offline',
    });
  });

  it('POS preload declaration exposes drawerOpened and error for manual drawer opens', () => {
    expect(electronDts).toContain('openCashDrawer: () => Promise<{ success: boolean; drawerOpened: boolean; error?: string }>');
  });

  it('POS preload declaration exposes combined receipt and drawer print result', () => {
    expect(electronDts).toContain('printReceiptAndOpenDrawer: (orderId: string) => Promise<{ success: boolean; receiptPrinted: boolean; drawerOpened: boolean; error?: string }>');
  });
});

describe('IPC channel contracts - self-checkout preload', () => {
  const requiredSelfCheckoutMethods = [
    { method: 'getAll', ipc: 'pos:products:getAll' },
    { method: 'getByBarcode', ipc: 'pos:products:getByBarcode' },
    { method: 'getByCategory', ipc: 'pos:products:getByCategory' },
    { method: 'search', ipc: 'pos:products:search' },
    { method: 'searchByCode', ipc: 'pos:products:searchByCode' },
    { method: 'getAll', ipc: 'pos:categories:getAll' },
    { method: 'create', ipc: 'pos:orders:create' },
    { method: 'printReceipt', ipc: 'pos:print-receipt' },
    { method: 'cardPayment', ipc: 'pos:payment:card' },
    { method: 'onElavonStatus', ipc: 'pos:elavon-status' },
    { method: 'orders', ipc: 'pos:sync:orders' },
    { method: 'onProductsSynced', ipc: 'pos:products-synced' },
    { method: 'onBarcodeScanned', ipc: 'barcode-scanned' },
    { method: 'getConfig', ipc: 'get-config' },
    { method: 'helpRequest', ipc: 'self-checkout:help-request' },
    { method: 'checkStatus', ipc: 'self-checkout:help-status' },
    { method: 'finalizePrint', ipc: 'self-checkout:finalize-print' },
    { method: 'close', ipc: 'self-checkout:close' },
  ];

  it('self-checkout window uses its own narrow preload', () => {
    expect(windowManagerSource).toContain("preload: 'preload-self-checkout.js'");
  });

  for (const { method, ipc } of requiredSelfCheckoutMethods) {
    it(`preload-self-checkout.ts exposes ${method} via ${ipc}`, () => {
      expect(preloadSelfCheckout).toContain(method);
      expect(preloadSelfCheckout).toContain(ipc);
    });
  }

  it('electron.d.ts declares self-checkout final print routing', () => {
    expect(electronDts).toContain('finalizePrint: (payload: { orderId: string; method:');
    expect(electronDts).toContain("method: 'CASH' | 'CARD' | 'BLIK'");
  });

  for (const forbidden of [
    'saveConfig',
    'set-config',
    'display:check-in',
    'display:search-by-phone',
    'display:request-service',
    'display:close',
  ]) {
    it(`preload-self-checkout.ts does not expose ${forbidden}`, () => {
      expect(preloadSelfCheckout).not.toContain(forbidden);
    });
  }
});
