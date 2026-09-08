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
    getPosCapabilities: vi.fn(),
    getOrderUploadServerUrl: vi.fn(() => 'https://api.enail.pro'),
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
  getConfigValue: vi.fn((key: string) => key === 'salonId' ? 'salon-1' : key === 'serverUrl' ? 'https://api.enail.pro' : undefined),
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
import { billiardPosHandoffRepo } from '../src/main/database/repos/billiard-pos-handoff-repo';
import { getSecureAuthToken, getConfigValue } from '../src/main/config/store';
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
  vi.mocked(orderRepo.getById).mockImplementation(id => {
    const results = vi.mocked(orderRepo.getUnsynced).mock.results;
    return results[results.length - 1]?.value?.find((row: any) => row.id === id) ?? null;
  });
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    order_id: 'order-1',
    variant_id: 'variant-1',
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
    expect(database.saveCoalesced).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ synced: 1, failed: 0 });
  });
});

describe('Windows immutable restaurant upload', () => {
  let order: any;
  let items: any[];
  beforeEach(() => {
    vi.resetAllMocks();
    order = makeOrder({ mode: 'restaurant', order_type: 'dine_in', table_id: 'A', covers: 2, sync_metadata_eligible: 1 });
    items = [makeItem({ notes: 'No onions', course: 2 })];
    vi.mocked(getSecureAuthToken).mockReturnValue('secure-token');
    vi.mocked(getConfigValue).mockImplementation((key: any) => (key === 'salonId' ? 'salon-1' : key === 'serverUrl' ? 'https://api.enail.pro' : undefined) as any);
    vi.mocked(apiClient.getOrderUploadServerUrl).mockReturnValue('https://api.enail.pro');
    vi.mocked(apiClient.getPosCapabilities).mockResolvedValue({ restaurantMetadataVersion: 1 });
    vi.mocked(apiClient.createPosOrder).mockResolvedValue({ id: 'backend-1' });
    vi.mocked(database.get).mockReturnValue({ cnt: 0 } as any);
    vi.mocked(database.saveCoalesced).mockResolvedValue({ success: true } as any);
    vi.mocked(orderRepo.getUnsynced).mockImplementation(() => [order]);
    vi.mocked(orderRepo.getById).mockImplementation(id => id === order.id ? order : null);
    vi.mocked(orderRepo.getItemsByOrderId).mockImplementation(() => items);
    vi.mocked(database.run).mockImplementation((sql: string, params?: any[]) => {
      if (sql.includes('SET sync_payload_json')) { order.sync_payload_json = params![0]; order.sync_attempts++; }
    });
  });

  it('persists before POST and replays exact metadata after lost reply, local mutation and counter reset', async () => {
    let sent: any;
    vi.mocked(apiClient.createPosOrder).mockImplementationOnce(async (_token, dto) => {
      sent = dto; expect(JSON.parse(order.sync_payload_json).payload).toEqual(dto);
      expect(database.saveCoalesced).toHaveBeenCalled(); throw new Error('response lost');
    });
    await new OrderSync().syncPendingOrders();
    expect(sent.restaurant).toEqual({ schemaVersion: 1, tableId: 'A', covers: 2 });
    expect(sent.items[0].restaurant).toEqual({ localLineId: 'item-1', notes: 'No onions', course: 2 });
    items = [makeItem({ price: 9999, notes: 'Changed', course: 4 })]; order.covers = 99; order.sync_attempts = 0;
    vi.mocked(apiClient.getPosCapabilities).mockRejectedValue({ status: 404 });
    await new OrderSync().syncPendingOrders();
    expect(apiClient.createPosOrder).toHaveBeenLastCalledWith('secure-token', sent);
    expect(apiClient.getPosCapabilities).toHaveBeenCalledTimes(1);
  });

  it('acquires edit/delete guard before capability I/O', async () => {
    vi.mocked(apiClient.getPosCapabilities).mockImplementation(async () => {
      expect(orderRepo.markSyncing).toHaveBeenCalledWith('order-1'); return { restaurantMetadataVersion: 1 };
    });
    await new OrderSync().syncPendingOrders();
  });

  it('rereads later batch rows after HTTP so stale headers cannot override edits or resurrect deletions', async () => {
    const edited = { ...order, id: 'edited-order', covers: 4 };
    const removed = { ...order, id: 'removed-order' };
    const rows = new Map([[order.id, order], [removed.id, removed], [edited.id, edited]]);
    vi.mocked(orderRepo.getUnsynced).mockReturnValue([...rows.values()].map(row => ({ ...row })));
    vi.mocked(orderRepo.getById).mockImplementation(id => rows.get(id) ?? null);
    vi.mocked(database.run).mockImplementation(() => {});
    const sent: any[] = [];
    vi.mocked(apiClient.createPosOrder).mockImplementation(async (_token, dto) => {
      sent.push(dto);
      if (dto.id === order.id) { rows.delete(removed.id); rows.set(edited.id, { ...edited, covers: 8 }); }
      return { id: dto.id };
    });
    await new OrderSync().syncPendingOrders();
    expect(sent.map(dto => dto.id)).toEqual(['order-1', 'edited-order']);
    expect(sent[1].restaurant.covers).toBe(8);
  });

  it('storage failure before POST poisons uploader until restart', async () => {
    vi.mocked(database.saveCoalesced).mockResolvedValue({ success: false, error: 'disk full' } as any);
    const uploader = new OrderSync(); const result = await uploader.syncPendingOrders();
    expect(result.synced).toBe(0); expect(result.failed).toBe(1);
    expect(apiClient.createPosOrder).not.toHaveBeenCalled(); expect(orderRepo.markSynced).not.toHaveBeenCalled();
    await expect(uploader.syncPendingOrders()).rejects.toThrow('STORAGE_RESTART_REQUIRED');
  });

  it('does not report success when accepted state durability rejects', async () => {
    vi.mocked(database.saveCoalesced).mockResolvedValueOnce({ success: true } as any).mockRejectedValueOnce(new Error('disk failed'));
    const result = await new OrderSync().syncPendingOrders();
    expect(apiClient.createPosOrder).toHaveBeenCalledTimes(1); expect(result.synced).toBe(0); expect(result.results[0].status).toBe('failed');
  });

  it('late reply after salon change causes no catch-path writes or success', async () => {
    let writesAtSwitch = -1;
    vi.mocked(apiClient.createPosOrder).mockImplementation(async () => {
      vi.mocked(getConfigValue).mockImplementation((key: any) => (key === 'salonId' ? 'salon-2' : 'https://api.enail.pro') as any);
      writesAtSwitch = vi.mocked(database.run).mock.calls.length; return { id: 'backend-1' };
    });
    await expect(new OrderSync().syncPendingOrders()).rejects.toThrow('CONTEXT_CHANGED');
    expect(database.run).toHaveBeenCalledTimes(writesAtSwitch);
    expect(orderRepo.markSyncFailed).not.toHaveBeenCalled(); expect(orderRepo.markSynced).not.toHaveBeenCalled();
  });

  it('refuses changed config URL when API singleton still targets old server', async () => {
    vi.mocked(getConfigValue).mockImplementation((key: any) => (key === 'salonId' ? 'salon-1' : 'https://other.test') as any);
    await expect(new OrderSync().syncPendingOrders()).rejects.toThrow('CONTEXT_CHANGED');
    expect(apiClient.createPosOrder).not.toHaveBeenCalled(); expect(database.run).not.toHaveBeenCalled();
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
    vi.mocked(getConfigValue).mockImplementation((key: any) => (key === 'salonId' ? 'salon-1' : 'https://api.enail.pro') as any);
    vi.mocked(database.saveCoalesced).mockResolvedValue({ success: true } as any);
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
    await vi.waitFor(() => expect(apiClient.createPosOrder).toHaveBeenCalledTimes(1));
    expect(database.run).toHaveBeenCalledWith(expect.stringContaining('sync_payload_json = ?'), expect.any(Array));
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
