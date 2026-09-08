import { describe, expect, it, vi } from 'vitest';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { createAndroidRefundCoordinator } from '../src/renderer/android-pos/shim/refund-coordinator';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore } from '../src/renderer/android-pos/shim/token-store';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const backendId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const shiftBackendId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const requestA = '11111111-1111-4111-8111-111111111111';
const requestB = '22222222-2222-4222-8222-222222222222';
const serverUrl = 'https://refund.test';
const storage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
};
function rawOrder(): any {
  return { id: backendId, salonId: 'salon-a', status: 'COMPLETED', total: 20, refundAmount: 0, paymentMethod: 'CASH',
    posMode: 'restaurant', discountAmount: 0, taxAmount: 3.74, paidAmount: 20, createdAt: '2026-09-08T10:00:00Z',
    items: ['b', 'a'].map(id => ({ id: `item-${id}`, orderId: backendId, productId: 'same-product', productName: 'Tea',
      sellBy: 'PIECE', saleUnit: 'szt', totalUnits: 1, grossUnitPrice: 10, grossTotalPrice: 10, taxRate: 23 })) };
}
const dto = (requestId = requestA, item = 'item-a') => ({ type: 'PARTIAL', refundRequestId: requestId, amount: 1000, reason: 'Return',
  lines: [{ orderItemId: item, variantId: 'same-product', quantity: 1, unit: 'szt', unitPrice: 1000, refundAmount: 1000, restock: false }] });
async function setup() {
  const persistence = new MemoryAndroidPersistence();
  const database = await initAndroidDb({ locateFile: null, persistence });
  database.run("INSERT INTO shifts (id,backend_id,staff_id,opened_at) VALUES ('local-shift',?,'owner-a','2026-09-08T09:00:00Z')", [shiftBackendId]);
  database.run("INSERT INTO orders (id,backend_id,shift_id,source,status,synced,total,refund_amount,payment_method,mode) VALUES ('local-order',?,'local-shift','POS','COMPLETED',1,2000,0,'CASH','restaurant')", [backendId]);
  database.run("INSERT INTO product_variants (id,name,in_stock,available_qty) VALUES ('same-product','Tea',3,3)");
  await database.flush();
  const configStore = new ShimConfigStore({ storage: storage(), seed: { salonId: 'salon-a', authUser: { id: 'owner-a', role: 'OWNER', salonId: 'salon-a' } } as any });
  const tokenStore = new TokenStore({ storage: storage(), allowInsecureFallback: true });
  await tokenStore.setTokens('owner-token', 'refresh-token');
  let server = rawOrder();
  const replies = new Map<string, any>();
  let commits = 0;
  let transitioning = false;
  let currentUrl = serverUrl;
  const applyServer = (serialized: string) => {
    const request = JSON.parse(serialized);
    if (replies.has(request.refundRequestId)) return structuredClone(replies.get(request.refundRequestId));
    commits++;
    const lines = request.items.map((item: any) => ({ ...item, variantId: 'same-product', unit: 'szt', unitPrice: 10,
      refundAmount: 10 * item.quantity, refundRequestId: request.refundRequestId, name: 'Tea' }));
    server.refundAmount += request.amount;
    server.status = server.refundAmount === server.total ? 'REFUNDED' : 'PARTIAL_REFUND';
    server.refundedLines = [...(server.refundedLines ?? []), ...lines];
    const response = { success: true, orderId: backendId, status: server.status, refundAmount: request.amount,
      totalRefundedAmount: server.refundAmount, refundedLines: lines, stockMovementIds: [] };
    replies.set(request.refundRequestId, structuredClone(response));
    return response;
  };
  const client = { getPosCapabilities: vi.fn(async () => ({})),
    getServerOrderDetail: vi.fn(async () => structuredClone(server)),
    refundOrder: vi.fn(async (_id: string, body: any, guard?: () => Promise<void>) => { await guard?.(); return applyServer(body); }) };
  const refreshStock = vi.fn(async () => {});
  const make = (db = database) => createAndroidRefundCoordinator({ client, configStore, tokenStore,
    db: async () => db, serverUrl, currentServerUrl: () => currentUrl,
    isTransitioning: () => transitioning, refreshStock });
  return { database, persistence, configStore, tokenStore, client, refreshStock, make, coordinator: make(), applyServer,
    get commits() { return commits; }, setServer: (value: any) => { server = value; },
    setTransition: (value: boolean) => { transitioning = value; }, setUrl: (value: string) => { currentUrl = value; } };
}
const order = (db: Awaited<ReturnType<typeof initAndroidDb>>) => db.get<any>("SELECT * FROM orders WHERE id='local-order'");

describe('Android durable refund coordinator', () => {
  it('freezes canonical PLN request, applies cumulative audit once and never increments requested stock', async () => {
    const h = await setup();
    expect(await h.coordinator.refundOrder('local-order', dto())).toMatchObject({ success: true, refundAmount: 10, receiptPrinted: false });
    expect(JSON.parse(h.client.refundOrder.mock.calls[0][1])).toMatchObject({ amount: 10, shiftId: shiftBackendId,
      items: [{ orderItemId: 'item-a', quantity: 1 }], tenderAllocations: [{ method: 'CASH', amount: 10 }] });
    expect(order(h.database)).toMatchObject({ refund_amount: 1000, status: 'PARTIAL_REFUND' });
    expect(JSON.parse(order(h.database).refund_lines)).toMatchObject([{ orderItemId: 'item-a', refundAmount: 1000, refundRequestId: requestA }]);
    expect(h.database.get('SELECT in_stock FROM product_variants')).toEqual({ in_stock: 3 });
    expect(await h.coordinator.refundOrder('local-order', dto())).toMatchObject({ success: false, reconciled: true });
    expect(await h.coordinator.reconcileRefund('local-order', requestA)).toMatchObject({ success: true, reconciled: true, receiptPrinted: false });
    expect(h.client.refundOrder).toHaveBeenCalledTimes(1); expect(h.commits).toBe(1);
  });

  it('keeps two partial refund audit events for separate identical-product lines', async () => {
    const h = await setup();
    expect((await h.coordinator.refundOrder('local-order', dto())).success).toBe(true);
    expect((await h.coordinator.refundOrder('local-order', dto(requestB, 'item-b'))).success).toBe(true);
    expect(order(h.database)).toMatchObject({ refund_amount: 2000, status: 'REFUNDED' });
    expect(JSON.parse(order(h.database).refund_lines).map((line: any) => line.orderItemId)).toEqual(['item-a', 'item-b']);
    expect(h.commits).toBe(2);
  });

  it('recovers timeout-after-commit across restart with original bytes/expectation and only one server mutation', async () => {
    const h = await setup();
    h.client.refundOrder.mockImplementationOnce(async (_id, body) => { h.applyServer(body); throw new Error('Connection lost after commit'); });
    const result = await h.coordinator.refundOrder('local-order', dto());
    expect(result).toMatchObject({ success: false, requiresReconciliation: true, refundRequestId: requestA });
    expect(order(h.database).refund_amount).toBe(0);
    const frozen = h.database.get<any>('SELECT * FROM pos_refund_attempts');
    expect(frozen.status).toBe('UNKNOWN');
    const restartedDb = await initAndroidDb({ locateFile: null, persistence: h.persistence });
    const recovered = h.make(restartedDb);
    expect(await recovered.getRefundDetail('local-order')).toMatchObject({ success: false, reconciliation: { requestId: requestA, status: 'UNKNOWN' } });
    expect(h.client.refundOrder).toHaveBeenCalledTimes(1);
    expect(await recovered.reconcileRefund('local-order', requestA)).toMatchObject({ success: true, reconciled: true });
    expect(h.client.refundOrder.mock.calls[1][1]).toBe(frozen.payload_json);
    expect(order(restartedDb).refund_amount).toBe(1000); expect(h.commits).toBe(1);
    expect(h.client.getServerOrderDetail).toHaveBeenCalledTimes(1);
  });

  it('does not allow a new ID or changed payload to bypass an UNKNOWN attempt', async () => {
    const h = await setup(); h.client.refundOrder.mockRejectedValueOnce(new Error('Timeout'));
    await h.coordinator.refundOrder('local-order', dto());
    expect(await h.coordinator.refundOrder('local-order', dto(requestB, 'item-b'))).toMatchObject({ success: false, requiresReconciliation: true, refundRequestId: requestA });
    expect(await h.coordinator.refundOrder('local-order', { ...dto(), reason: 'Changed' })).toMatchObject({ success: false, requiresReconciliation: true, refundRequestId: requestA });
    expect(h.client.refundOrder).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])('never dispatches when pre-POST flush %s fails; runtime requires restart', async barrier => {
    const h = await setup(); const realFlush = h.database.flush.bind(h.database); let count = 0;
    vi.spyOn(h.database, 'flush').mockImplementation(async () => { if (++count === barrier) throw new Error('Disk failure'); await realFlush(); });
    expect(await h.coordinator.refundOrder('local-order', dto())).toMatchObject({ success: false });
    expect(h.coordinator.storageFailed).toBe(true); expect(h.client.refundOrder).not.toHaveBeenCalled();
    expect(await h.coordinator.reconcileRefund('local-order', requestA)).toMatchObject({ success: false });
    expect(h.client.refundOrder).not.toHaveBeenCalled();
  });

  it('does not unlock on an in-memory CONFIRMED result after failed final flush; restart replays durable UNKNOWN', async () => {
    const h = await setup(); const realFlush = h.database.flush.bind(h.database); let count = 0;
    vi.spyOn(h.database, 'flush').mockImplementation(async () => { if (++count === 3) throw new Error('Disk failure'); await realFlush(); });
    expect(await h.coordinator.refundOrder('local-order', dto())).toMatchObject({ success: false, requiresReconciliation: true });
    expect(h.database.get<any>('SELECT status FROM pos_refund_attempts').status).toBe('CONFIRMED');
    expect(h.coordinator.storageFailed).toBe(true);
    expect((await h.coordinator.refundOrder('local-order', dto(requestB, 'item-b'))).success).toBe(false);
    const restored = await initAndroidDb({ locateFile: null, persistence: h.persistence });
    expect(restored.get<any>('SELECT status FROM pos_refund_attempts').status).toBe('UNKNOWN');
    expect(order(restored).refund_amount).toBe(0);
    expect(await h.make(restored).reconcileRefund('local-order', requestA)).toMatchObject({ success: true, reconciled: true });
    expect(h.commits).toBe(1); expect(order(restored).refund_amount).toBe(1000);
  });

  it.each(['false-success', 'wrong-order', 'missing-lines', 'wrong-item', 'over-refund'])('keeps %s response UNKNOWN without local projection', async kind => {
    const h = await setup();
    h.client.refundOrder.mockImplementation(async (_id, body) => {
      const response = h.applyServer(body);
      if (kind === 'false-success') response.success = false;
      if (kind === 'wrong-order') response.orderId = 'another-order';
      if (kind === 'missing-lines') response.refundedLines = [];
      if (kind === 'wrong-item') response.refundedLines[0].orderItemId = 'another-item';
      if (kind === 'over-refund') response.totalRefundedAmount = 900;
      return response;
    });
    expect(await h.coordinator.refundOrder('local-order', dto())).toMatchObject({ success: false, requiresReconciliation: true });
    expect(order(h.database).refund_amount).toBe(0);
    expect(h.database.get<any>('SELECT status FROM pos_refund_attempts').status).toBe('UNKNOWN');
  });

  it.each(['role', 'server', 'old-shift', 'no-link', 'server-mirror', 'unsynced'])('refuses unsupported %s before POST', async kind => {
    const h = await setup();
    if (kind === 'role') h.configStore.setConfig({ authUser: { id: 'owner-a', salonId: 'salon-a', role: 'STAFF' } } as any);
    if (kind === 'server') h.setUrl('https://other.test');
    if (kind === 'old-shift') h.database.run("UPDATE shifts SET closed_at='closed'");
    if (kind === 'no-link') h.database.run('UPDATE shifts SET backend_id=NULL');
    if (kind === 'server-mirror') h.database.run("UPDATE orders SET source='SERVER'");
    if (kind === 'unsynced') h.database.run('UPDATE orders SET synced=0');
    expect((await h.coordinator.refundOrder('local-order', dto())).success).toBe(false);
    expect(h.client.refundOrder).not.toHaveBeenCalled();
  });

  it('rejects identity switching away and back while preparing detail', async () => {
    const h = await setup(); const original = h.configStore.getRawConfig();
    h.client.getServerOrderDetail.mockImplementationOnce(async () => {
      h.configStore.setConfig({ salonId: 'different' }); h.configStore.setConfig(original); return rawOrder();
    });
    expect((await h.coordinator.refundOrder('local-order', dto())).success).toBe(false);
    expect(h.client.refundOrder).not.toHaveBeenCalled();
    expect(h.database.all('SELECT * FROM pos_refund_attempts')).toHaveLength(0);
  });

  it('retains UNKNOWN if context changes after server commit, recoverable only under original user', async () => {
    const h = await setup(); const original = h.configStore.getRawConfig();
    h.client.refundOrder.mockImplementationOnce(async (_id, body) => {
      const result = h.applyServer(body); h.configStore.setConfig({ authUser: { id: 'other-owner', role: 'OWNER', salonId: 'salon-a' } } as any); return result;
    });
    expect((await h.coordinator.refundOrder('local-order', dto())).success).toBe(false);
    const foreign = await h.coordinator.reconcileRefund('local-order', requestA);
    expect(foreign.success).toBe(false); expect(foreign).not.toHaveProperty('refundRequestId');
    expect(order(h.database).refund_amount).toBe(0);
    h.configStore.setConfig(original);
    expect(await h.coordinator.reconcileRefund('local-order', requestA)).toMatchObject({ success: true, reconciled: true });
    expect(h.commits).toBe(1);
  });

  it('reserves a single operation before its first await and blocks transition overlaps', async () => {
    const h = await setup(); let release!: () => void;
    h.client.refundOrder.mockImplementationOnce(async (_id, body) => { await new Promise<void>(resolve => { release = resolve; }); return h.applyServer(body); });
    const first = h.coordinator.refundOrder('local-order', dto());
    await vi.waitFor(() => expect(h.client.refundOrder).toHaveBeenCalledTimes(1));
    expect(h.coordinator.busy).toBe(true);
    expect((await h.coordinator.refundOrder('local-order', dto(requestB))).success).toBe(false);
    release(); expect((await first).success).toBe(true); expect(h.coordinator.busy).toBe(false);
    h.setTransition(true);
    expect((await h.coordinator.refundOrder('local-order', dto(requestB, 'item-b'))).success).toBe(false);
  });

  it('exposes pending ID read-only after shift closes, but refuses resubmission', async () => {
    const h = await setup(); h.client.refundOrder.mockRejectedValueOnce(new Error('Timeout'));
    await h.coordinator.refundOrder('local-order', dto()); h.database.run("UPDATE shifts SET closed_at='closed'");
    expect(await h.coordinator.getRefundDetail('local-order')).toMatchObject({ success: false, reconciliation: { requestId: requestA } });
    expect((await h.coordinator.reconcileRefund('local-order', requestA)).success).toBe(false);
    expect(h.client.refundOrder).toHaveBeenCalledTimes(1);
  });

  it('reconciles CONFIRMED read-only after shift closes but rejects a remapped local order', async () => {
    const h = await setup(); await h.coordinator.refundOrder('local-order', dto()); h.database.run("UPDATE shifts SET closed_at='closed'");
    expect(await h.coordinator.reconcileRefund('local-order', requestA)).toMatchObject({ success: true, reconciled: true });
    h.database.run("UPDATE orders SET backend_id='different'");
    expect((await h.coordinator.reconcileRefund('local-order', requestA)).success).toBe(false);
    expect(h.client.refundOrder).toHaveBeenCalledTimes(1);
  });

  it('does not turn a stock refresh failure into a second refund attempt', async () => {
    const h = await setup(); h.refreshStock.mockRejectedValueOnce(new Error('Catalog offline'));
    const request = dto(); request.lines[0].restock = true;
    expect(await h.coordinator.refundOrder('local-order', request)).toMatchObject({ success: true, stockRefreshRequired: true });
    expect((await h.coordinator.refundOrder('local-order', request)).success).toBe(false);
    expect(h.refreshStock).toHaveBeenCalledTimes(1); expect(h.commits).toBe(1);
    expect(h.database.get('SELECT in_stock FROM product_variants')).toEqual({ in_stock: 3 });
  });

  it.each(['mismatched-method', 'split'])('rejects %s tender accounting before POST', async kind => {
    const h = await setup();
    if (kind === 'mismatched-method') h.database.run("UPDATE orders SET payment_method='CARD'");
    else {
      const raw = rawOrder(); raw.paymentMethod = 'SPLIT'; raw.tenders = [{ method: 'CASH', amount: 10 }, { method: 'CARD', amount: 10 }]; h.setServer(raw);
      h.database.run("UPDATE orders SET payment_method='SPLIT', payment_tenders=?", [JSON.stringify([{ method: 'CASH', amount: 1000 }, { method: 'CARD', amount: 1000 }])]);
    }
    expect((await h.coordinator.refundOrder('local-order', dto())).success).toBe(false);
    expect(h.client.refundOrder).not.toHaveBeenCalled();
    expect(h.database.all('SELECT * FROM pos_refund_attempts')).toHaveLength(0);
  });

  it('does not attach late refund detail to a remapped local order', async () => {
    const h = await setup();
    h.client.getServerOrderDetail.mockImplementationOnce(async () => {
      h.database.run("UPDATE orders SET backend_id='another-order'"); return rawOrder();
    });
    expect((await h.coordinator.getRefundDetail('local-order')).success).toBe(false);
    expect(h.client.refundOrder).not.toHaveBeenCalled();
  });

  it('upgrades a v9 shift without inventing a backend identity or losing pending refund evidence', async () => {
    const h = await setup(); h.client.refundOrder.mockRejectedValueOnce(new Error('Timeout'));
    await h.coordinator.refundOrder('local-order', dto());
    h.database.run('ALTER TABLE shifts DROP COLUMN backend_id');
    h.database.run('PRAGMA user_version=9');
    await h.database.flush();
    const migrated = await initAndroidDb({ locateFile: null, persistence: h.persistence });
    expect(migrated.get('SELECT backend_id FROM shifts')).toEqual({ backend_id: null });
    expect(migrated.getRawHandle().exec('PRAGMA user_version')[0].values).toEqual([[13]]);
    expect(migrated.get<any>('SELECT status FROM pos_refund_attempts').status).toBe('UNKNOWN');
    expect(order(migrated).refund_amount).toBe(0);
    expect(await h.make(migrated).getRefundDetail('local-order')).toMatchObject({ reconciliation: { requestId: requestA } });
  });
});
