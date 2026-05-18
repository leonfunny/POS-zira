/**
 * SyncLogService.pushToServer — order/created accept side-effects.
 *
 * Path B without this fix: when the server accepts a Path B
 * `entity_type='order' event='created'` push, only the
 * local_sync_log row gets `markAccepted(seq)`. The local `orders`
 * row keeps `synced=0`, `backend_id=null`, and any subsequent refund
 * is blocked by the `!order.backend_id` guard in pos.module — so the
 * cashier sees a sale that "did not sync" and cannot refund it even
 * though the backend has the canonical row.
 *
 * Echo sync_log can't paper this over because the same agent's
 * entries are skipped on pull. The fix has to live in the push path
 * itself: when an order/created entry comes back accepted, mirror
 * the side effects on the local `orders` row so Path A and Path B
 * leave the row in the same state.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────
vi.mock('../src/main/database/database', () => ({
  database: {
    run: vi.fn(),
    get: vi.fn(),
    save: vi.fn(),
    transaction: vi.fn((fn: () => void) => fn()),
  },
}));

vi.mock('../src/main/network/api-client', () => ({
  apiClient: {
    syncPush: vi.fn(),
    syncPull: vi.fn(),
  },
}));

vi.mock('../src/main/config/store', () => ({
  getSecureAuthToken: vi.fn(() => 'test-token'),
  getConfigValue: vi.fn(),
}));

vi.mock('../src/main/sync/sync-log-repo', () => ({
  syncLogRepo: {
    getPending: vi.fn(),
    markPushing: vi.fn(),
    markAccepted: vi.fn(),
    markRejected: vi.fn(),
    revertPushingToPending: vi.fn(() => 0),
    insertConflict: vi.fn(),
    setAgentSource: vi.fn(),
    getSyncMode: vi.fn(() => 'path_b_push'),
    setSyncMode: vi.fn(),
  },
}));

vi.mock('../src/main/sync/entity-applicators', () => ({
  applyEntry: vi.fn(),
}));

vi.mock('../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { database } from '../src/main/database/database';
import { apiClient } from '../src/main/network/api-client';
import { syncLogRepo } from '../src/main/sync/sync-log-repo';
import { SyncLogService } from '../src/main/sync/sync-log-service';

function makePendingOrderEntry(overrides: Partial<any> = {}) {
  return {
    id: 99,
    source_tx: 'tx-uuid-1',
    entity_type: 'order',
    entity_id: 'order-1',
    event: 'created',
    payload: JSON.stringify({
      id: 'order-1',
      orderNumber: 'POS-20260505-0001',
      total: 1234,
      items: [{ id: 'item-1', productName: 'Bulka', unitPrice: '1234' }],
    }),
    source: 'agent-1',
    status: 'pending',
    server_seq: null,
    rejection_code: null,
    rejection_detail: null,
    attempts: 0,
    created_at: '2026-05-05T08:00:00.000Z',
    pushed_at: null,
    resolved_at: null,
    ...overrides,
  };
}

describe('SyncLogService.pushToServer — order/created accept marks local order synced', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // First getPending returns a single pending order; subsequent calls
    // return [] so the push loop terminates after one batch.
    vi.mocked(syncLogRepo.getPending)
      .mockReturnValueOnce([makePendingOrderEntry()])
      .mockReturnValue([]);
  });

  it('updates the local orders row to synced=1, sets backend_id, synced_at, clears sync_error', async () => {
    vi.mocked(apiClient.syncPush).mockResolvedValueOnce({
      results: [{ source_tx: 'tx-uuid-1', accepted: true, seq: 7 }],
    } as any);

    const service = new SyncLogService();
    const result = await service.pushToServer();

    expect(result).toEqual({ accepted: 1, rejected: 0 });
    expect(syncLogRepo.markAccepted).toHaveBeenCalledWith(99, 7);

    // The fix must issue an UPDATE on `orders` setting all four fields.
    const calls = vi.mocked(database.run).mock.calls;
    const orderUpdate = calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE\s+orders\s+SET/i.test(c[0]) && /synced/i.test(c[0]),
    );
    expect(orderUpdate, 'expected UPDATE orders ... SET synced=1 ... call').toBeDefined();
    const sql = orderUpdate![0] as string;
    expect(sql).toMatch(/synced\s*=\s*1/i);
    expect(sql).toMatch(/backend_id\s*=/i);
    expect(sql).toMatch(/synced_at\s*=/i);
    expect(sql).toMatch(/sync_error\s*=\s*NULL/i);

    // WHERE clause keys on the local entry.entity_id (last param).
    const params = orderUpdate![1] as unknown[];
    expect(params[params.length - 1]).toBe('order-1');
  });

  it('prefers a backend-supplied id over the local entry.entity_id', async () => {
    // Server sometimes returns its canonical id under entity_id /
    // entityId / backendId / orderId. When present, the orders row
    // should track the backend id (Path A behaviour parity).
    vi.mocked(apiClient.syncPush).mockResolvedValueOnce({
      results: [
        {
          source_tx: 'tx-uuid-1',
          accepted: true,
          seq: 8,
          entityId: 'backend-canonical-id',
        },
      ],
    } as any);

    const service = new SyncLogService();
    await service.pushToServer();

    const calls = vi.mocked(database.run).mock.calls;
    const orderUpdate = calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE\s+orders\s+SET/i.test(c[0]),
    );
    const params = orderUpdate![1] as unknown[];
    // backend_id should be the server-supplied value, WHERE id stays
    // on the local entity_id.
    expect(params).toContain('backend-canonical-id');
    expect(params[params.length - 1]).toBe('order-1');
  });

  it('falls back to local entry.entity_id when no backend id is returned', async () => {
    vi.mocked(apiClient.syncPush).mockResolvedValueOnce({
      results: [{ source_tx: 'tx-uuid-1', accepted: true, seq: 9 }],
    } as any);

    const service = new SyncLogService();
    await service.pushToServer();

    const calls = vi.mocked(database.run).mock.calls;
    const orderUpdate = calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE\s+orders\s+SET/i.test(c[0]),
    );
    const params = orderUpdate![1] as unknown[];
    // When no backend id is supplied, the local id is mirrored as
    // backend_id so the refund gate (!order.backend_id) clears.
    expect(params).toContain('order-1');
  });

  it('does NOT touch the orders table for non-order entries', async () => {
    vi.mocked(syncLogRepo.getPending)
      .mockReset()
      .mockReturnValueOnce([
        makePendingOrderEntry({
          entity_type: 'product',
          entity_id: 'product-1',
        }),
      ])
      .mockReturnValue([]);
    vi.mocked(apiClient.syncPush).mockResolvedValueOnce({
      results: [{ source_tx: 'tx-uuid-1', accepted: true, seq: 10 }],
    } as any);

    const service = new SyncLogService();
    await service.pushToServer();

    const calls = vi.mocked(database.run).mock.calls;
    const orderUpdate = calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE\s+orders\s+SET/i.test(c[0]),
    );
    expect(orderUpdate, 'must not UPDATE orders for non-order entries').toBeUndefined();
  });

  it('does NOT touch the orders table when the order entry is rejected', async () => {
    vi.mocked(apiClient.syncPush).mockResolvedValueOnce({
      results: [
        {
          source_tx: 'tx-uuid-1',
          accepted: false,
          code: 'CONFLICT',
          detail: 'overlap',
        },
      ],
    } as any);

    const service = new SyncLogService();
    await service.pushToServer();

    const calls = vi.mocked(database.run).mock.calls;
    const orderUpdate = calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE\s+orders\s+SET/i.test(c[0]),
    );
    expect(orderUpdate, 'must not UPDATE orders on rejection').toBeUndefined();
  });

  // ─── DUPLICATE handling for crash-recovery resends ───────────────
  // Crash recovery (revertPushingToPending) can resend a source_tx
  // after the server already accepted it. The server rejects with
  // code='DUPLICATE'. If we treat that as a normal rejection, the
  // local orders row stays synced=0 / backend_id=NULL forever and
  // the refund gate (!order.backend_id) blocks the cashier from
  // refunding a sale the backend has. Treat DUPLICATE on
  // order/created as accepted-idempotent.

  it('treats DUPLICATE on order/created as accepted: marks accepted + mirrors orders row', async () => {
    vi.mocked(apiClient.syncPush).mockResolvedValueOnce({
      results: [
        {
          source_tx: 'tx-uuid-1',
          accepted: false,
          code: 'DUPLICATE',
          detail: 'source_tx already accepted as seq=42',
          seq: 42,
        },
      ],
    } as any);

    const service = new SyncLogService();
    const result = await service.pushToServer();

    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(0);
    expect(syncLogRepo.markAccepted).toHaveBeenCalledWith(99, 42);
    expect(syncLogRepo.markRejected).not.toHaveBeenCalled();
    expect(syncLogRepo.insertConflict).not.toHaveBeenCalled();

    const calls = vi.mocked(database.run).mock.calls;
    const orderUpdate = calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        /UPDATE\s+orders\s+SET/i.test(c[0]) &&
        /synced\s*=\s*1/i.test(c[0]),
    );
    expect(
      orderUpdate,
      'DUPLICATE on order/created must still mirror orders row',
    ).toBeDefined();
    const params = orderUpdate![1] as unknown[];
    expect(params[params.length - 1]).toBe('order-1');
  });

  it('handles DUPLICATE without a seq (server returns no original seq): markAccepted with 0', async () => {
    vi.mocked(apiClient.syncPush).mockResolvedValueOnce({
      results: [
        {
          source_tx: 'tx-uuid-1',
          accepted: false,
          code: 'DUPLICATE',
        },
      ],
    } as any);

    const service = new SyncLogService();
    const result = await service.pushToServer();

    expect(result.accepted).toBe(1);
    expect(syncLogRepo.markAccepted).toHaveBeenCalledWith(99, 0);

    const calls = vi.mocked(database.run).mock.calls;
    const orderUpdate = calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        /UPDATE\s+orders\s+SET/i.test(c[0]) &&
        /synced/i.test(c[0]),
    );
    expect(orderUpdate).toBeDefined();
  });

  it('still rejects DUPLICATE on non-order entries (e.g. product) — no idempotent free pass', async () => {
    vi.mocked(syncLogRepo.getPending)
      .mockReset()
      .mockReturnValueOnce([
        makePendingOrderEntry({
          entity_type: 'product',
          entity_id: 'product-1',
        }),
      ])
      .mockReturnValue([]);
    vi.mocked(apiClient.syncPush).mockResolvedValueOnce({
      results: [
        {
          source_tx: 'tx-uuid-1',
          accepted: false,
          code: 'DUPLICATE',
        },
      ],
    } as any);

    const service = new SyncLogService();
    const result = await service.pushToServer();

    expect(result.rejected).toBe(1);
    expect(result.accepted).toBe(0);
    expect(syncLogRepo.markRejected).toHaveBeenCalledWith(
      99,
      'DUPLICATE',
      '',
    );
  });

  it('still rejects DUPLICATE on order/updated (only created is idempotent-safe)', async () => {
    vi.mocked(syncLogRepo.getPending)
      .mockReset()
      .mockReturnValueOnce([
        makePendingOrderEntry({ event: 'updated' }),
      ])
      .mockReturnValue([]);
    vi.mocked(apiClient.syncPush).mockResolvedValueOnce({
      results: [
        { source_tx: 'tx-uuid-1', accepted: false, code: 'DUPLICATE' },
      ],
    } as any);

    const service = new SyncLogService();
    const result = await service.pushToServer();

    expect(result.rejected).toBe(1);
    expect(result.accepted).toBe(0);
  });

  it('defers order push while a local draft-import variant is still pending', async () => {
    vi.mocked(syncLogRepo.getPending)
      .mockReset()
      .mockReturnValueOnce([
        makePendingOrderEntry({
          payload: JSON.stringify({
            id: 'order-1',
            items: [{ productId: 'local-variant-1', variantId: 'local-variant-1' }],
          }),
        }),
      ])
      .mockReturnValue([]);
    vi.mocked(database.get).mockReturnValue({ c: 1 } as any);

    const service = new SyncLogService();
    const result = await service.pushToServer();

    expect(result).toEqual({ accepted: 0, rejected: 0 });
    expect(apiClient.syncPush).not.toHaveBeenCalled();
    expect(syncLogRepo.markPushing).not.toHaveBeenCalled();
  });

  it('maps synced local draft-import variant ids before pushing order payload', async () => {
    vi.mocked(syncLogRepo.getPending)
      .mockReset()
      .mockReturnValueOnce([
        makePendingOrderEntry({
          payload: JSON.stringify({
            id: 'order-1',
            items: [{ productId: 'local-variant-1', variantId: 'local-variant-1' }],
          }),
        }),
      ])
      .mockReturnValue([]);
    vi.mocked(database.get)
      .mockReturnValueOnce({ c: 0 } as any)
      .mockReturnValueOnce({ server_variant_id: 'server-variant-9' } as any);
    vi.mocked(apiClient.syncPush).mockResolvedValueOnce({
      results: [{ source_tx: 'tx-uuid-1', accepted: true, seq: 8 }],
    } as any);

    const service = new SyncLogService();
    await service.pushToServer();

    const pushed = vi.mocked(apiClient.syncPush).mock.calls[0]?.[1] as any[];
    expect(pushed[0].payload.items[0]).toMatchObject({
      productId: 'server-variant-9',
      variantId: 'server-variant-9',
    });
  });
});
