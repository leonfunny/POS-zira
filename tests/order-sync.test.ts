import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('../src/main/network/api-client', () => ({
  apiClient: {
    createPosOrder: vi.fn(),
    finishOrder: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/order-repo', () => ({
  orderRepo: {
    getUnsynced: vi.fn(),
    getItemsByOrderId: vi.fn(),
    getById: vi.fn(),
    markSyncing: vi.fn(),
    markSynced: vi.fn(),
    markSyncFailed: vi.fn(),
  },
}));

vi.mock('../src/main/database/database', () => ({
  database: {
    run: vi.fn(),
    save: vi.fn(),
    all: vi.fn(),
  },
}));

vi.mock('../src/main/config/store', () => ({
  getSecureAuthToken: vi.fn(),
}));

vi.mock('../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { apiClient } from '../src/main/network/api-client';
import { orderRepo } from '../src/main/database/repos/order-repo';
import { database } from '../src/main/database/database';
import { getSecureAuthToken } from '../src/main/config/store';
import { OrderSync } from '../src/main/sync/order-sync';

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    order_number: 'POS-20260421-0002',
    status: 'PAID',
    subtotal: 4400,
    discount: 0,
    tax: 326,
    total: 4400,
    payment_method: 'BLIK',
    payment_amount: 4400,
    change_amount: 0,
    staff_id: null,
    staff_name: null,
    customer_id: null,
    customer_name: null,
    customer_nip: null,
    shift_id: null,
    source: 'POS',
    synced: 0,
    backend_id: null,
    created_at: '2026-04-21T10:00:00.000Z',
    synced_at: null,
    table_id: null,
    covers: null,
    order_type: 'standard',
    tip: 0,
    mode: 'retail',
    payment_tenders: null,
    sync_attempts: 0,
    sync_error: null,
    refund_amount: null,
    refund_reason: null,
    refunded_at: null,
    ...overrides,
  };
}

describe('OrderSync DTO mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSecureAuthToken).mockReturnValue('secure-token');
    vi.mocked(apiClient.createPosOrder).mockResolvedValue({ id: 'backend-order-1' });
    vi.mocked(apiClient.finishOrder).mockResolvedValue({});
  });

  it('preserves zero and non-zero local item prices and converts split tenders to PLN', async () => {
    vi.mocked(orderRepo.getUnsynced).mockReturnValue([
      makeOrder({
        payment_tenders: JSON.stringify([
          { method: 'CASH', amount: 2000 },
          { method: 'BLIK', amount: 2400 },
        ]),
      }) as any,
    ]);
    vi.mocked(orderRepo.getItemsByOrderId).mockReturnValue([
      {
        id: 'item-1',
        order_id: 'order-1',
        variant_id: '62f4d726-16cf-488f-b2ca-b716f5b7cbed',
        name: 'Bulka kajzerka',
        sku: 'BULKA-KAJ-001',
        price: 0,
        quantity: 2,
        total: 0,
        vat_rate: 5,
        staff_id: null,
        staff_name: null,
        notes: null,
        course: null,
      },
      {
        id: 'item-2',
        order_id: 'order-1',
        variant_id: 'b1426b1f-70c5-4026-af23-da1c8be724c0',
        name: 'Banh Trang Re 200g',
        sku: 'CHE-BANHTRANG-13',
        price: 1100,
        quantity: 4,
        total: 4400,
        vat_rate: 8,
        staff_id: null,
        staff_name: null,
        notes: null,
        course: null,
      },
    ] as any);

    await new OrderSync().syncPendingOrders();

    expect(apiClient.createPosOrder).toHaveBeenCalledWith(
      'secure-token',
      expect.objectContaining({
        items: [
          expect.objectContaining({
            variantSku: 'BULKA-KAJ-001',
            packQuantity: 2,
            customPrice: 0,
          }),
          expect.objectContaining({
            variantSku: 'CHE-BANHTRANG-13',
            packQuantity: 4,
            customPrice: 11,
          }),
        ],
        tenders: [
          { method: 'CASH', amount: 20 },
          { method: 'BLIK', amount: 24 },
        ],
      }),
    );
  });

  it('persists backend canonical orderNumber when createPosOrder returns it', async () => {
    vi.mocked(apiClient.createPosOrder).mockResolvedValue({
      id: 'backend-order-1',
      orderNumber: 'POS260506-0005',
    });
    vi.mocked(orderRepo.getUnsynced).mockReturnValue([
      makeOrder({ order_number: 'POS-20260506-0001' }) as any,
    ]);
    vi.mocked(orderRepo.getItemsByOrderId).mockReturnValue([
      {
        id: 'item-1',
        order_id: 'order-1',
        variant_id: 'variant-1',
        name: 'Refunded item',
        sku: 'SKU-1',
        price: 1799,
        quantity: 1,
        total: 1799,
        vat_rate: 23,
        staff_id: null,
        staff_name: null,
        notes: null,
        course: null,
      },
    ] as any);

    const summary = await new OrderSync().syncPendingOrders();

    expect(orderRepo.markSynced).toHaveBeenCalledWith(
      'order-1',
      'backend-order-1',
      'POS260506-0005',
    );
    expect(summary.results[0]).toMatchObject({
      orderId: 'order-1',
      backendId: 'backend-order-1',
      orderNumber: 'POS260506-0005',
    });
  });
});

describe('OrderSync.resetForRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resets a shelved order for manual retry', () => {
    vi.mocked(orderRepo.getById).mockReturnValue(makeOrder({ synced: -1 }) as any);

    const result = new OrderSync().resetForRetry('order-1');

    expect(result).toBe(true);
    expect(database.run).toHaveBeenCalledWith(
      'UPDATE orders SET synced = 0, sync_attempts = 0, sync_error = NULL WHERE id = ?',
      ['order-1'],
    );
    expect(database.save).toHaveBeenCalled();
  });

  it('does not reset an order unless it is shelved', () => {
    vi.mocked(orderRepo.getById).mockReturnValue(makeOrder({ synced: 0 }) as any);

    const result = new OrderSync().resetForRetry('order-1');

    expect(result).toBe(false);
    expect(database.run).not.toHaveBeenCalled();
    expect(database.save).not.toHaveBeenCalled();
  });
});
