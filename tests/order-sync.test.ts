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
    shelve: vi.fn(),
  },
}));

vi.mock('../src/main/database/repos/local-variant-imports-repo', () => ({
  localVariantImportsRepo: {
    isUnresolvedVariant: vi.fn(() => false),
    getByVariantId: vi.fn(),
    getServerVariantId: vi.fn(() => null),
  },
}));

vi.mock('../src/main/database/repos/billiard-pos-handoff-repo', () => ({
  billiardPosHandoffRepo: {
    getByOrderId: vi.fn(),
    markState: vi.fn(() => true),
  },
}));

vi.mock('../src/main/database/database', () => ({
  database: {
    get: vi.fn(),
    run: vi.fn(),
    save: vi.fn(),
    saveCoalesced: vi.fn(),
    markDirty: vi.fn(),
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
import { localVariantImportsRepo } from '../src/main/database/repos/local-variant-imports-repo';
import { database } from '../src/main/database/database';
import { billiardPosHandoffRepo } from '../src/main/database/repos/billiard-pos-handoff-repo';
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

function mockNoStrandedSyncingOrders() {
  vi.mocked(database.get).mockReturnValue({ cnt: 0 } as any);
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    order_id: 'order-1',
    variant_id: '3f2b9c14-8a0d-4e6f-9c21-5b7d8e0a1f34',
    name: 'Banh Trang Re 200g',
    sku: 'CHE-BANHTRANG-13',
    price: 1100,
    quantity: 1,
    total: 1100,
    vat_rate: 8,
    staff_id: null,
    staff_name: null,
    notes: null,
    course: null,
    ...overrides,
  };
}

describe('OrderSync DTO mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNoStrandedSyncingOrders();
    vi.mocked(getSecureAuthToken).mockReturnValue('secure-token');
    vi.mocked(apiClient.createPosOrder).mockResolvedValue({ id: 'backend-order-1' });
    vi.mocked(apiClient.finishOrder).mockResolvedValue({});
    vi.mocked(database.saveCoalesced).mockResolvedValue({ success: true } as any);
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
    expect(apiClient.finishOrder).not.toHaveBeenCalled();
  });

  it('shelves an itemless local order instead of claiming it synced', async () => {
    vi.mocked(orderRepo.getUnsynced).mockReturnValue([makeOrder() as any]);
    vi.mocked(orderRepo.getItemsByOrderId).mockReturnValue([]);

    const summary = await new OrderSync().syncPendingOrders();

    expect(orderRepo.shelve).toHaveBeenCalledWith('order-1', 'INVALID_LOCAL_ORDER_NO_ITEMS');
    expect(orderRepo.markSynced).not.toHaveBeenCalled();
    expect(orderRepo.markSyncing).not.toHaveBeenCalled();
    expect(apiClient.createPosOrder).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ attempted: 1, synced: 0, failed: 1 });
    expect(summary.results[0]).toMatchObject({ status: 'shelved', error: 'INVALID_LOCAL_ORDER_NO_ITEMS' });
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
        variant_id: '3f2b9c14-8a0d-4e6f-9c21-5b7d8e0a1f34',
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

  it('marks a paid Billiard handoff SETTLED after create succeeds and never calls legacy finish', async () => {
    vi.mocked(orderRepo.getUnsynced).mockReturnValue([
      makeOrder({
        billiard_origin_json: JSON.stringify({
          type: 'BILLIARD_SESSION',
          sessionId: 'session-1',
          checkoutId: 'checkout-1',
          snapshotVersion: 1,
        }),
        client_attempt_id: 'billiard:checkout-1',
      }) as any,
    ]);
    vi.mocked(orderRepo.getItemsByOrderId).mockReturnValue([
      makeItem({
        billiard_json: JSON.stringify({
          lineKey: 'fnb-1',
          kind: 'FNB',
          sessionItemId: 'session-item-1',
          displayName: 'Cola',
        }),
      }) as any,
    ]);
    vi.mocked(billiardPosHandoffRepo.getByOrderId).mockReturnValue({
      checkoutId: 'checkout-1',
      state: 'POS_PAID_SYNC_PENDING',
    } as any);

    const summary = await new OrderSync().syncPendingOrders();

    expect(apiClient.finishOrder).not.toHaveBeenCalled();
    expect(billiardPosHandoffRepo.markState).toHaveBeenCalledWith('checkout-1', 'SETTLED');
    expect(database.saveCoalesced).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ synced: 1, failed: 0 });
  });
});

describe('OrderSync rejects payloads the backend can never accept', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNoStrandedSyncingOrders();
    vi.mocked(getSecureAuthToken).mockReturnValue('secure-token');
    vi.mocked(apiClient.createPosOrder).mockResolvedValue({ id: 'backend-order-1' });
    vi.mocked(localVariantImportsRepo.isUnresolvedVariant).mockReturnValue(false);
    vi.mocked(localVariantImportsRepo.getServerVariantId).mockReturnValue(null);
  });

  it('shelves an order whose line id is not a variant UUID instead of posting it', async () => {
    vi.mocked(orderRepo.getUnsynced).mockReturnValue([makeOrder() as any]);
    vi.mocked(orderRepo.getItemsByOrderId).mockReturnValue([
      makeItem({ variant_id: 'bh-suon-1755f58e52d0', name: 'Sườn' }) as any,
    ]);

    const summary = await new OrderSync().syncPendingOrders();

    expect(apiClient.createPosOrder).not.toHaveBeenCalled();
    expect(orderRepo.markSyncing).not.toHaveBeenCalled();
    const [, shelvedError] = vi.mocked(orderRepo.shelve).mock.calls[0];
    // The offending value only ever exists on the till — record it verbatim.
    expect(shelvedError).toContain('INVALID_LOCAL_ORDER_ITEM_ID');
    expect(shelvedError).toContain('bh-suon-1755f58e52d0');
    expect(shelvedError).toContain('Sườn');
    expect(summary.results[0]).toMatchObject({ status: 'shelved', code: 'INVALID_PAYLOAD' });
  });

  it('falls back to the order-item row id and still refuses it when the line has no variant', async () => {
    vi.mocked(orderRepo.getUnsynced).mockReturnValue([makeOrder() as any]);
    vi.mocked(orderRepo.getItemsByOrderId).mockReturnValue([
      makeItem({ variant_id: null, id: 'line-42' }) as any,
    ]);

    await new OrderSync().syncPendingOrders();

    expect(apiClient.createPosOrder).not.toHaveBeenCalled();
    expect(vi.mocked(orderRepo.shelve).mock.calls[0][1]).toContain('line-42');
  });

  it('posts the order once the local-import reconciler maps the local id to a server variant', async () => {
    vi.mocked(orderRepo.getUnsynced).mockReturnValue([makeOrder() as any]);
    vi.mocked(orderRepo.getItemsByOrderId).mockReturnValue([
      makeItem({ variant_id: 'draft-local-1' }) as any,
    ]);
    vi.mocked(localVariantImportsRepo.getServerVariantId).mockReturnValue(
      '9ca579ca-028b-49b0-947c-63d16c2d3e2a',
    );

    await new OrderSync().syncPendingOrders();

    expect(orderRepo.shelve).not.toHaveBeenCalled();
    const [, dto] = vi.mocked(apiClient.createPosOrder).mock.calls[0] as [string, any];
    expect(dto.items[0]).toMatchObject({
      productId: '9ca579ca-028b-49b0-947c-63d16c2d3e2a',
      variantId: '9ca579ca-028b-49b0-947c-63d16c2d3e2a',
    });
  });

  it('shelves a 400 from the backend on the first failure instead of retrying it', async () => {
    vi.mocked(orderRepo.getUnsynced).mockReturnValue([makeOrder() as any]);
    vi.mocked(orderRepo.getItemsByOrderId).mockReturnValue([makeItem() as any]);
    const rejection = Object.assign(new Error('customPrice must be a positive number'), { status: 400 });
    vi.mocked(apiClient.createPosOrder).mockRejectedValue(rejection);

    const summary = await new OrderSync().syncPendingOrders();

    const shelveCall = vi.mocked(database.run).mock.calls.find(
      ([sql]) => sql === 'UPDATE orders SET synced = -1, sync_error = ? WHERE id = ?',
    );
    expect(shelveCall?.[1]?.[0]).toBe('[PERMANENT] customPrice must be a positive number');
    expect(orderRepo.markSyncFailed).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({ status: 'shelved', code: 'INVALID_PAYLOAD' });
  });

  it('still retries a genuine network failure', async () => {
    vi.mocked(orderRepo.getUnsynced).mockReturnValue([makeOrder() as any]);
    vi.mocked(orderRepo.getItemsByOrderId).mockReturnValue([makeItem() as any]);
    vi.mocked(apiClient.createPosOrder).mockRejectedValue(new Error('fetch failed'));

    const summary = await new OrderSync().syncPendingOrders();

    expect(orderRepo.markSyncFailed).toHaveBeenCalledWith('order-1');
    expect(summary.results[0]).toMatchObject({ status: 'failed' });
  });
});

describe('OrderSync.requeueShelvedTransient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNoStrandedSyncingOrders();
  });

  it('leaves permanently rejected orders shelved and re-queues only transient ones', () => {
    vi.mocked(database.all).mockReturnValue([
      { id: 'order-network', sync_error: 'fetch failed' },
      { id: 'order-uuid', sync_error: '[PERMANENT] INVALID_LOCAL_ORDER_ITEM_ID: Sườn → bh-suon' },
      { id: 'order-legacy', sync_error: 'productId must be a UUID,variantId must be a UUID' },
    ] as any);

    const requeued = new OrderSync().requeueShelvedTransient();

    expect(requeued).toBe(1);
    const update = vi.mocked(database.run).mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.startsWith('UPDATE orders SET synced = 0, sync_attempts = 0 WHERE id IN'),
    );
    expect(update?.[1]).toEqual(['order-network']);
  });
});

describe('OrderSync.resetForRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNoStrandedSyncingOrders();
  });

  it('resets a shelved order for manual retry', () => {
    vi.mocked(orderRepo.getById).mockReturnValue(makeOrder({ synced: -1 }) as any);

    const result = new OrderSync().resetForRetry('order-1');

    expect(result).toBe(true);
    expect(database.run).toHaveBeenCalledWith(
      'UPDATE orders SET synced = 0, sync_attempts = 0, sync_error = NULL WHERE id = ?',
      ['order-1'],
    );
    expect(database.markDirty).toHaveBeenCalled();
  });

  it('does not reset an order unless it is shelved', () => {
    vi.mocked(orderRepo.getById).mockReturnValue(makeOrder({ synced: 0 }) as any);

    const result = new OrderSync().resetForRetry('order-1');

    expect(result).toBe(false);
    expect(database.run).not.toHaveBeenCalled();
    expect(database.markDirty).not.toHaveBeenCalled();
  });
});

describe('OrderSync concurrency and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNoStrandedSyncingOrders();
    vi.mocked(getSecureAuthToken).mockReturnValue('secure-token');
    vi.mocked(apiClient.finishOrder).mockResolvedValue({});
  });

  it('reuses an in-flight sync so concurrent triggers do not create duplicate backend orders', async () => {
    vi.mocked(orderRepo.getUnsynced).mockReturnValue([makeOrder() as any]);
    vi.mocked(orderRepo.getItemsByOrderId).mockReturnValue([makeItem() as any]);

    let resolveCreate: (value: any) => void = () => {};
    vi.mocked(apiClient.createPosOrder).mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }) as any,
    );

    const sync = new OrderSync();
    const first = sync.syncPendingOrders();
    const second = sync.syncPendingOrders();

    expect(orderRepo.getUnsynced).toHaveBeenCalledTimes(1);
    expect(orderRepo.markSyncing).toHaveBeenCalledTimes(1);
    expect(apiClient.createPosOrder).toHaveBeenCalledTimes(1);

    resolveCreate({ id: 'backend-order-1', orderNumber: 'POS260609-0013' });
    const [firstSummary, secondSummary] = await Promise.all([first, second]);

    expect(firstSummary).toBe(secondSummary);
    expect(apiClient.createPosOrder).toHaveBeenCalledTimes(1);
    expect(orderRepo.markSynced).toHaveBeenCalledTimes(1);
  });

  it('recovers stranded syncing orders only when the sync service starts', async () => {
    vi.mocked(database.get).mockReturnValue({ cnt: 2 } as any);

    const sync = new OrderSync();

    expect(database.run).toHaveBeenCalledWith('UPDATE orders SET synced = 0 WHERE synced = 2');
    expect(database.markDirty).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    vi.mocked(getSecureAuthToken).mockReturnValue(null as any);

    await sync.syncPendingOrders();

    expect(database.run).not.toHaveBeenCalledWith('UPDATE orders SET synced = 0 WHERE synced = 2');
  });
});
