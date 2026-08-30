import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    all: vi.fn(),
    get: vi.fn(),
    run: vi.fn(),
    save: vi.fn(),
    markDirty: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/order-repo', () => ({
  orderRepo: {
    getByShift: vi.fn(),
    getUnsyncedCountByShift: vi.fn(),
    getRefundCashflowBetween: vi.fn(),
  },
}));

vi.mock('../src/main/network/api-client', () => ({
  apiClient: {
    closePosShift: vi.fn(),
    getActiveShift: vi.fn(),
    openPosShift: vi.fn(),
  },
}));

vi.mock('../src/main/config/store', () => ({
  getConfigValue: vi.fn(),
  getSecureAuthToken: vi.fn(() => null),
}));

vi.mock('../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { database } from '../src/main/database/database';
import { orderRepo } from '../src/main/database/repos/order-repo';
import { apiClient } from '../src/main/network/api-client';
import { getConfigValue, getSecureAuthToken } from '../src/main/config/store';
import {
  canReconcileActiveShift,
  isSafeZReportPrintFailure,
  ShiftController,
  type ShiftReport,
} from '../src/main/pos/shift-controller';

function order(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    total: 0,
    discount: 0,
    payment_method: null,
    payment_tenders: null,
    refund_amount: null,
    ...overrides,
  } as any;
}

function findRunCall(matcher: RegExp) {
  return vi
    .mocked(database.run)
    .mock.calls.find((c) => typeof c[0] === 'string' && matcher.test(c[0] as string));
}

describe('ShiftController transfer totals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(database.all).mockReturnValue([]);
    vi.mocked(database.get).mockImplementation((sql: string) => {
      if (/SELECT changes\(\)/i.test(sql)) return { count: 1 } as any;
      return {
        id: 'shift-1',
        staff_id: 'staff-1',
        staff_name: 'Cashier',
        opened_at: '2026-04-27T08:00:00.000Z',
        opening_cash: 10000,
        backend_id: null,
      } as any;
    });
    vi.mocked(orderRepo.getUnsyncedCountByShift).mockReturnValue(0);
    vi.mocked(orderRepo.getRefundCashflowBetween).mockReturnValue({
      refund_count: 0,
      refund_total: 0,
      cash_refund_total: 0,
      card_refund_total: 0,
      blik_refund_total: 0,
      transfer_refund_total: 0,
    });
    vi.mocked(getConfigValue).mockReturnValue(undefined);
    vi.mocked(getSecureAuthToken).mockReturnValue(null);
  });

  it('does not reconcile by staff when the active-shift lookup is not machine-scoped', () => {
    expect(canReconcileActiveShift(
      'local-shift-1',
      'staff-1',
      { id: 'server-shift-other-pos', staffId: 'staff-1' },
      undefined,
    )).toBe(false);
    expect(canReconcileActiveShift(
      'local-shift-1',
      'staff-1',
      { id: 'server-shift-this-pos', staffId: 'staff-1' },
      'POS-2',
    )).toBe(true);
    expect(canReconcileActiveShift(
      'local-shift-1',
      'staff-2',
      { id: 'local-shift-1', staffId: 'different-staff' },
      undefined,
    )).toBe(true);
  });

  it('counts BANK_TRANSFER as transfer for single payment orders', () => {
    vi.mocked(orderRepo.getByShift).mockReturnValue([
      order({ total: 10000, payment_method: 'BANK_TRANSFER' }),
    ]);

    const report = new ShiftController(() => null, () => false).closeShift('shift-1', 10000);

    expect(report.transferTotal).toBe(10000);
  });

  it('counts BANK_TRANSFER as transfer in split tenders', () => {
    vi.mocked(orderRepo.getByShift).mockReturnValue([
      order({
        total: 7000,
        payment_method: 'SPLIT',
        payment_tenders: JSON.stringify([
          { method: 'BANK_TRANSFER', amount: 3000 },
          { method: 'CASH', amount: 4000 },
        ]),
      }),
    ]);

    const report = new ShiftController(() => null, () => false).closeShift('shift-1', 14000);

    expect(report.transferTotal).toBe(3000);
    expect(report.cashTotal).toBe(4000);
  });

  it('does not subtract discounts from an already-discounted order total', () => {
    vi.mocked(orderRepo.getByShift).mockReturnValue([
      order({
        total: 9000,
        discount: 1000,
        payment_method: 'CARD',
        payment_amount: 9000,
      }),
    ]);

    const report = new ShiftController(() => null, () => false).closeShift('shift-1', 10000);

    expect(report.totalSales).toBe(9000);
    expect(report.totalDiscounts).toBe(1000);
  });

  it('includes single-payment tips in the tender bucket but not sales revenue', () => {
    vi.mocked(orderRepo.getByShift).mockReturnValue([
      order({
        total: 9000,
        tip: 500,
        payment_method: 'CASH',
        payment_amount: 10000,
        change_amount: 500,
      }),
    ]);

    const report = new ShiftController(() => null, () => false).closeShift('shift-1', 19500);

    expect(report.totalSales).toBe(9000);
    expect(report.totalTips).toBe(500);
    expect(report.cashTotal).toBe(9500);
    expect(report.difference).toBe(0);
  });

  it('refuses to close the same local shift twice', () => {
    let open = true;
    vi.mocked(database.get).mockImplementation((sql: string) => {
      if (/SELECT changes\(\)/i.test(sql)) return { count: 1 } as any;
      if (/closed_at IS NULL/i.test(sql)) {
        return open ? {
          id: 'shift-1',
          staff_id: 'staff-1',
          staff_name: 'Cashier',
          opened_at: '2026-04-27T08:00:00.000Z',
          opening_cash: 10000,
        } as any : null;
      }
      return { id: 'shift-1' } as any;
    });
    vi.mocked(database.run).mockImplementation((sql: string) => {
      if (/UPDATE shifts SET[\s\S]*closed_at/i.test(sql)) open = false;
    });
    vi.mocked(orderRepo.getByShift).mockReturnValue([]);

    const controller = new ShiftController(() => null, () => false);
    controller.closeShift('shift-1', 10000);

    expect(() => controller.closeShift('shift-1', 10000)).toThrow(/already closed/i);
  });

  it('defers backend close until the caller confirms the local close is durable', () => {
    vi.mocked(orderRepo.getByShift).mockReturnValue([]);
    const controller = new ShiftController(() => null, () => false);
    const syncShiftClose = vi
      .spyOn(controller as any, 'syncShiftClose')
      .mockResolvedValue(undefined);

    controller.closeShift('shift-1', 10000, false, {
      deferSyncUntilDurable: true,
    });
    expect(syncShiftClose).not.toHaveBeenCalled();

    controller.syncDurableShiftClose('shift-1', 10000);
    expect(syncShiftClose).toHaveBeenCalledWith('shift-1', 10000);
  });

  it('defers backend open until the caller confirms the local open is durable', () => {
    const controller = new ShiftController(() => null, () => false);
    const syncShiftOpen = vi
      .spyOn(controller as any, 'syncShiftOpen')
      .mockResolvedValue(undefined);

    const shiftId = (controller as any).openShift(
      'staff-1',
      'Cashier',
      10000,
      { deferSyncUntilDurable: true },
    );
    expect(syncShiftOpen).not.toHaveBeenCalled();

    (controller as any).syncDurableShiftOpen(shiftId, 'staff-1', 10000);
    expect(syncShiftOpen).toHaveBeenCalledWith(shiftId, 'staff-1', 10000);
  });

  it('keeps reconnect retry workers away from deferred shift mutations', async () => {
    vi.mocked(getSecureAuthToken).mockReturnValue('token-1');
    vi.mocked(orderRepo.getByShift).mockReturnValue([]);
    const controller = new ShiftController(() => null, () => true);
    const shiftId = controller.openShift('staff-1', 'Cashier', 10000, {
      deferSyncUntilDurable: true,
    });
    controller.closeShift(shiftId, 10000, false, {
      deferSyncUntilDurable: true,
    });
    vi.mocked(database.all)
      .mockReturnValueOnce([
        { id: shiftId, staff_id: 'staff-1', opening_cash: 10000, sync_attempts: 0 },
      ] as any)
      .mockReturnValueOnce([
        { id: shiftId, backend_id: 'server-shift', closing_cash: 10000, close_sync_attempts: 0 },
      ] as any);

    await controller.retryUnsyncedShifts();

    expect(apiClient.openPosShift).not.toHaveBeenCalled();
    expect(apiClient.closePosShift).not.toHaveBeenCalled();
  });

  it('rejects when a connected printer fails to print the Z-report', async () => {
    const printError = new Error('paper jam');
    const printer = {
      isConnected: vi.fn(() => true),
      printZReport: vi.fn().mockRejectedValue(printError),
    };
    const controller = new ShiftController(() => printer, () => false);

    await expect(controller.printZReport({
      shiftId: 'shift-1',
      staffName: 'Cashier',
      openedAt: '2026-08-30T08:00:00.000Z',
      closedAt: '2026-08-30T16:00:00.000Z',
      openingCash: 10000,
      closingCash: 12000,
      totalSales: 2000,
      totalOrders: 1,
      cashTotal: 2000,
      cardTotal: 0,
      blikTotal: 0,
      transferTotal: 0,
      totalRefunds: 0,
      totalDiscounts: 0,
      totalTips: 0,
      difference: 0,
      unsyncedOrders: 0,
    })).rejects.toBe(printError);
  });

  it('treats a missing printer as a safe retry instead of silently losing the Z-report', async () => {
    const controller = new ShiftController(() => null, () => false);

    let failure: unknown;
    try {
      await controller.printZReport({
        shiftId: 'shift-no-printer',
        staffName: 'Cashier',
        openedAt: '2026-08-30T08:00:00.000Z',
        closedAt: '2026-08-30T16:00:00.000Z',
        openingCash: 10000,
        closingCash: 10000,
        totalSales: 0,
        totalOrders: 0,
        cashTotal: 0,
        cardTotal: 0,
        blikTotal: 0,
        transferTotal: 0,
        totalRefunds: 0,
        totalDiscounts: 0,
        totalTips: 0,
        difference: 0,
        unsyncedOrders: 0,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(isSafeZReportPrintFailure(failure)).toBe(true);
  });

  it('recovers a complete pending Z-report snapshot from the durable shift row', () => {
    const report: ShiftReport = {
      shiftId: 'shift-restart',
      staffName: 'Cashier',
      openedAt: '2026-08-30T08:00:00.000Z',
      closedAt: '2026-08-30T16:00:00.000Z',
      openingCash: 10000,
      closingCash: 12000,
      totalSales: 2000,
      totalOrders: 1,
      cashTotal: 2000,
      cardTotal: 0,
      blikTotal: 0,
      transferTotal: 0,
      totalRefunds: 0,
      totalDiscounts: 0,
      totalTips: 0,
      difference: 0,
      unsyncedOrders: 0,
    };
    vi.mocked(database.get).mockReturnValueOnce({
      id: report.shiftId,
      z_report_payload: JSON.stringify(report),
      z_report_status: 'PENDING',
      z_report_attempts: 0,
      z_report_error: null,
    } as any);

    const recovered = new ShiftController(() => null, () => false)
      .getUnresolvedZReport();

    expect(recovered).toEqual({
      shiftId: report.shiftId,
      report,
      status: 'PENDING',
      attempts: 0,
      lastError: null,
    });
  });

  it('requires an explicit operator decision before reprinting an uncertain report', () => {
    const report = {
      shiftId: 'shift-uncertain',
      staffName: 'Cashier',
    } as ShiftReport;
    vi.mocked(database.get).mockReturnValue({
      id: report.shiftId,
      z_report_payload: JSON.stringify(report),
      z_report_status: 'DISPATCHING',
      z_report_attempts: 1,
      z_report_error: null,
    } as any);
    const controller = new ShiftController(() => null, () => false);

    expect(() => controller.beginZReportPrint(report.shiftId)).toThrow(/uncertain/i);
    expect(findRunCall(/z_report_status = 'DISPATCHING'/i)).toBeUndefined();

    expect(controller.beginZReportPrint(report.shiftId, true)).toEqual(report);
    expect(findRunCall(/z_report_status = 'DISPATCHING'/i)?.[1]).toEqual([
      report.shiftId,
    ]);
  });

  it('subtracts refunds issued during this shift even when the sale belongs to an older shift', () => {
    vi.mocked(orderRepo.getByShift).mockReturnValue([
      order({
        total: 10000,
        payment_method: 'SPLIT',
        payment_tenders: JSON.stringify([
          { method: 'BANK_TRANSFER', amount: 6000 },
          { method: 'CARD', amount: 4000 },
        ]),
      }),
    ]);
    vi.mocked(orderRepo.getRefundCashflowBetween).mockReturnValue({
      refund_count: 1,
      refund_total: 5000,
      cash_refund_total: 0,
      card_refund_total: 2000,
      blik_refund_total: 0,
      transfer_refund_total: 3000,
    });

    const report = new ShiftController(() => null, () => false).closeShift('shift-1', 10000);

    expect(report.totalRefunds).toBe(5000);
    expect(report.totalSales).toBe(5000);
    expect(report.transferTotal).toBe(3000);
    expect(report.cardTotal).toBe(2000);
    expect(orderRepo.getRefundCashflowBetween).toHaveBeenCalledWith(
      '2026-04-27T08:00:00.000Z',
      expect.any(String),
      false,
      'shift-1',
    );
  });

  it('can report a negative cash flow when an old order is refunded on a quiet shift', () => {
    vi.mocked(orderRepo.getByShift).mockReturnValue([]);
    vi.mocked(orderRepo.getRefundCashflowBetween).mockReturnValue({
      refund_count: 1,
      refund_total: 1461,
      cash_refund_total: 1461,
      card_refund_total: 0,
      blik_refund_total: 0,
      transfer_refund_total: 0,
    });

    const report = new ShiftController(() => null, () => false).closeShift('shift-1', 8539);

    expect(report.totalSales).toBe(-1461);
    expect(report.cashTotal).toBe(-1461);
    expect(report.difference).toBe(0);
  });

  it('can limit sales and payment totals to fiscal orders', () => {
    vi.mocked(orderRepo.getByShift).mockReturnValue([
      order({
        total: 10000,
        payment_method: 'CARD',
        has_fiscal: 1,
      }),
      order({
        total: 5000,
        payment_method: 'CASH',
        has_fiscal: 0,
      }),
    ]);

    const report = new ShiftController(() => null, () => false).closeShift('shift-1', 15000, true);

    expect(report.totalOrders).toBe(1);
    expect(report.totalSales).toBe(10000);
    expect(report.cashTotal).toBe(0);
    expect(report.cardTotal).toBe(10000);
    expect(report.difference).toBe(5000);
    expect(report.fiscalOnlySales).toBe(true);
    const closeParams = vi.mocked(database.run).mock.calls[0][1] as unknown[];
    expect(closeParams[1]).toBe(15000);
    expect(closeParams[2]).toBe(10000);
    expect(closeParams[3]).toBe(1);
    expect(JSON.parse(String(closeParams[4]))).toMatchObject({
      shiftId: 'shift-1',
      fiscalOnlySales: true,
      totalSales: 10000,
    });
    expect(closeParams[5]).toBe('shift-1');
  });

  it('sends machineId when retrying unsynced shift opens', async () => {
    vi.mocked(getSecureAuthToken).mockReturnValue('token-1');
    vi.mocked(getConfigValue).mockImplementation((key: string) => key === 'machineId' ? 'POS-2' : undefined);
    vi.mocked(database.all)
      .mockReturnValueOnce([
        { id: 'shift-2', staff_id: 'staff-2', opening_cash: 25000, sync_attempts: 0 },
      ] as any)
      .mockReturnValueOnce([]);
    vi.mocked(apiClient.openPosShift).mockResolvedValueOnce({ shiftId: 'server-shift-2' });

    await new ShiftController(() => null, () => true).retryUnsyncedShifts();

    expect(apiClient.openPosShift).toHaveBeenCalledWith('token-1', {
      shiftId: 'shift-2',
      staffId: 'staff-2',
      openingCash: 25000,
      machineId: 'POS-2',
    });
  });

  it('sends the local shift UUID when initially syncing a new shift open', async () => {
    vi.mocked(getSecureAuthToken).mockReturnValue('token-1');
    vi.mocked(getConfigValue).mockImplementation((key: string) => key === 'machineId' ? 'POS-2' : undefined);
    vi.mocked(apiClient.openPosShift).mockResolvedValueOnce({ shiftId: 'shift-local-1' });

    await (new ShiftController(() => null, () => true) as any).syncShiftOpen(
      'shift-local-1',
      'staff-1',
      10000,
    );

    expect(apiClient.openPosShift).toHaveBeenCalledWith('token-1', {
      shiftId: 'shift-local-1',
      staffId: 'staff-1',
      openingCash: 10000,
      machineId: 'POS-2',
    });
  });

  it('scopes active-shift close fallback by machineId', async () => {
    vi.mocked(getSecureAuthToken).mockReturnValue('token-1');
    vi.mocked(getConfigValue).mockImplementation((key: string) => key === 'machineId' ? 'POS-2' : undefined);
    vi.mocked(database.get).mockReturnValueOnce({
      backend_id: null,
      staff_id: 'staff-2',
      staff_name: 'Cashier',
    } as any);
    vi.mocked(apiClient.getActiveShift).mockResolvedValueOnce(null);

    await (new ShiftController(() => null, () => true) as any).syncShiftClose('shift-2', 12000);

    expect(apiClient.getActiveShift).toHaveBeenCalledWith('token-1', 'POS-2');
  });

  it('marks a retried shift close as synced after backend success', async () => {
    vi.mocked(getSecureAuthToken).mockReturnValue('token-1');
    vi.mocked(database.all)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        { id: 'shift-close-1', backend_id: 'server-shift-1', closing_cash: 12000, close_sync_attempts: 0 },
      ] as any);
    vi.mocked(apiClient.closePosShift).mockResolvedValueOnce({} as any);

    await new ShiftController(() => null, () => true).retryUnsyncedShifts();

    expect(apiClient.closePosShift).toHaveBeenCalledWith('token-1', 'server-shift-1', { closingCash: 12000 });
    expect(findRunCall(/close_sync_attempts = COALESCE\(close_sync_attempts, 0\) \+ 1/i)).toBeDefined();
    const successUpdate = findRunCall(/UPDATE shifts SET close_synced = 1/i);
    expect(successUpdate).toBeDefined();
    expect(successUpdate![1]).toEqual(['shift-close-1']);
  });

  it('records transient shift close retry failures without shelving before the cap', async () => {
    vi.mocked(getSecureAuthToken).mockReturnValue('token-1');
    vi.mocked(database.all)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        { id: 'shift-close-2', backend_id: 'server-shift-2', closing_cash: 13000, close_sync_attempts: 1 },
      ] as any);
    vi.mocked(apiClient.closePosShift).mockRejectedValueOnce(new Error('ECONNRESET'));

    await new ShiftController(() => null, () => true).retryUnsyncedShifts();

    expect(apiClient.closePosShift).toHaveBeenCalledTimes(1);
    expect(findRunCall(/UPDATE shifts SET close_synced = -1/i)).toBeUndefined();
    const errorUpdate = findRunCall(/UPDATE shifts SET close_sync_error = \?/i);
    expect(errorUpdate).toBeDefined();
    expect(errorUpdate![1]).toEqual(['ECONNRESET', 'shift-close-2']);
  });

  it('shelves terminal 404 shift close retry failures', async () => {
    vi.mocked(getSecureAuthToken).mockReturnValue('token-1');
    vi.mocked(database.all)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        { id: 'shift-close-3', backend_id: 'server-shift-3', closing_cash: 14000, close_sync_attempts: 2 },
      ] as any);
    vi.mocked(apiClient.closePosShift).mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));

    await new ShiftController(() => null, () => true).retryUnsyncedShifts();

    const terminalUpdate = findRunCall(/UPDATE shifts SET close_synced = -1/i);
    expect(terminalUpdate).toBeDefined();
    expect((terminalUpdate![1] as unknown[])[0]).toContain('Not Found');
    expect((terminalUpdate![1] as unknown[])[1]).toBe('shift-close-3');
  });

  it('does not retry shift close after the retry cap is exhausted', async () => {
    vi.mocked(getSecureAuthToken).mockReturnValue('token-1');
    vi.mocked(database.all)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        { id: 'shift-close-4', backend_id: 'server-shift-4', closing_cash: 15000, close_sync_attempts: 5 },
      ] as any);

    await new ShiftController(() => null, () => true).retryUnsyncedShifts();

    expect(apiClient.closePosShift).not.toHaveBeenCalled();
    const exhaustedUpdate = findRunCall(/UPDATE shifts SET close_synced = -1/i);
    expect(exhaustedUpdate).toBeDefined();
    expect(exhaustedUpdate![1]).toEqual(['shift-close-4']);
  });
});
