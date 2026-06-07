import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyFiscalVisibility,
  getHistoryDisplayNumber,
  getRealHistoryOrderNumber,
} from '../src/renderer/components/pos/order-fiscal-visibility';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('order history fiscal visibility', () => {
  const local = (id: string, hasFiscal: 0 | 1) => ({ id, has_fiscal: hasFiscal });
  const server = (id: string) => ({ id });

  it('passes everything through when the toggle is off', () => {
    const orders = [local('a', 0), local('b', 1), server('c')];
    expect(applyFiscalVisibility(orders, false, new Set())).toEqual(orders);
  });

  it('hides local rows without a confirmed fiscal receipt', () => {
    const orders = [local('a', 0), local('b', 1)];
    expect(applyFiscalVisibility(orders, true, new Set())).toEqual([local('b', 1)]);
  });

  it('does NOT let server rows leak through just because has_fiscal is missing', () => {
    // The original bug: `o.has_fiscal !== 0` is true for undefined, so every
    // server-sourced row (orders from other terminals) ignored the filter.
    const orders = [server('kiosk-1'), server('kiosk-2'), local('pos-1', 0)];
    expect(applyFiscalVisibility(orders, true, new Set())).toEqual([]);
  });

  it('keeps server rows whose ids are confirmed in the local fiscal journal', () => {
    const orders = [server('kiosk-1'), server('kiosk-2')];
    expect(applyFiscalVisibility(orders, true, new Set(['kiosk-2']))).toEqual([server('kiosk-2')]);
  });

  it('uses display-only contiguous fiscal numbers without mutating real order numbers', () => {
    const order = { id: 'local-order-id', order_number: 'POS260607-0042' };

    expect(getHistoryDisplayNumber(order, 0, false)).toBe('POS260607-0042');
    expect(getHistoryDisplayNumber(order, 0, true)).toBe('FISCAL #001');
    expect(getHistoryDisplayNumber(order, 19, true)).toBe('FISCAL #020');
    expect(getRealHistoryOrderNumber(order)).toBe('POS260607-0042');
    expect(order.order_number).toBe('POS260607-0042');
  });

  it('wires the modal to request fiscal-filtered local history before pagination', () => {
    const modalSource = readSource('src/renderer/components/pos/OrderHistoryModal.tsx');
    const posModuleSource = readSource('src/main/modules/pos.module.ts');
    const repoSource = readSource('src/main/database/repos/fiscal-attempt-repo.ts');

    expect(modalSource).toContain('fiscalOnly: hideNonFiscalOrders');
    expect(modalSource).toContain('window.electronAPI.pos.orders.getHistory(localHistoryFilters)');
    expect(modalSource).toContain("source: 'unconfigured' as const");
    expect(modalSource).toContain('hideNonFiscalOrders ? `${realOrderNumber} - ${formatDate(order.created_at)}` : formatDate(order.created_at)');
    expect(modalSource).not.toContain('applyFiscalVisibility(merged, true');
    expect(modalSource).not.toContain('getConfirmedFiscalIds?.(unknownIds)');
    expect(modalSource).not.toContain('merged.filter((o) => o.has_fiscal !== 0)');
    expect(posModuleSource).toContain("ipcMain.handle('pos:orders:getConfirmedFiscalIds'");
    expect(posModuleSource).toContain('fiscalOnly?: boolean');
    expect(posModuleSource).toContain('paymentMethod: filters.paymentMethod');
    expect(posModuleSource).toContain('staffName: filters.staffName');
    expect(repoSource).toContain('getConfirmedOrderIds(orderIds: string[])');
  });
});

describe('config-updated cross-window propagation', () => {
  it('broadcasts a ping after set-config and useConfig refreshes on it', () => {
    // Settings lives in the main window; the POS window caches config at
    // mount. Without the broadcast, toggles like showNonFiscalOrders did
    // nothing until an app restart.
    const authSource = readSource('src/main/modules/auth.module.ts');
    const useConfigSource = readSource('src/renderer/hooks/useConfig.ts');
    const preloadMain = readSource('src/preload/preload.ts');
    const preloadPos = readSource('src/preload/preload-pos.ts');

    expect(authSource).toContain("win.webContents.send('config-updated')");
    expect(useConfigSource).toContain('onConfigUpdated?.(');
    expect(preloadMain).toContain("ipcRenderer.on('config-updated', listener)");
    expect(preloadPos).toContain("ipcRenderer.on('config-updated', listener)");
  });
});

describe('remote fiscal success is mirrored into the local journal', () => {
  it('records SUCCESS_CONFIRMED locally when the shared fiscal job prints', () => {
    // A POS that prints its paragons on ANOTHER machine's fiscal printer
    // (kiosk -> POS1) otherwise has has_fiscal=0 for every sale, so the
    // hide-non-fiscal toggle would wrongly hide ALL of its orders.
    const controllerSource = readSource('src/main/pos/payment-controller.ts');
    const repoSource = readSource('src/main/database/repos/fiscal-attempt-repo.ts');

    expect(controllerSource).toContain('recordRemoteFiscalSuccess(orderId, shared.jobId, shared.printerId)');
    expect(repoSource).toContain('recordRemoteFiscalSuccess(orderId: string');
    // Idempotent: never duplicate a confirmed row for the same order.
    expect(repoSource).toContain("WHERE order_id = ? AND status = 'SUCCESS_CONFIRMED' LIMIT 1");
  });
});
