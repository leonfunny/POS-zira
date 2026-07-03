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
import { ShiftController } from '../src/main/pos/shift-controller';

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

describe('ShiftController transfer totals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(database.all).mockReturnValue([]);
    vi.mocked(database.get).mockReturnValue({
      id: 'shift-1',
      staff_id: 'staff-1',
      staff_name: 'Cashier',
      opened_at: '2026-04-27T08:00:00.000Z',
      opening_cash: 10000,
      backend_id: null,
    } as any);
    vi.mocked(orderRepo.getUnsyncedCountByShift).mockReturnValue(0);
    vi.mocked(getConfigValue).mockReturnValue(undefined);
    vi.mocked(getSecureAuthToken).mockReturnValue(null);
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

  it('subtracts BANK_TRANSFER refunds from transfer totals', () => {
    vi.mocked(orderRepo.getByShift).mockReturnValue([
      order({
        total: 10000,
        payment_method: 'BANK_TRANSFER',
        refund_amount: 2500,
      }),
      order({
        total: 10000,
        payment_method: 'SPLIT',
        payment_tenders: JSON.stringify([
          { method: 'BANK_TRANSFER', amount: 6000 },
          { method: 'CARD', amount: 4000 },
        ]),
        refund_amount: 5000,
      }),
    ]);

    const report = new ShiftController(() => null, () => false).closeShift('shift-1', 10000);

    expect(report.transferTotal).toBe(10500);
    expect(report.cardTotal).toBe(2000);
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
    expect(vi.mocked(database.run).mock.calls[0][1]).toEqual([15000, 10000, 1, 'shift-1']);
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
      staffId: 'staff-2',
      openingCash: 25000,
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
});
