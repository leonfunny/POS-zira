import { afterEach, describe, expect, it, vi } from 'vitest';
import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { createRefundAttemptRepo } from '../src/renderer/android-pos/shim/db/refund-attempt-repo';
import { createAndroidRefundCoordinator } from '../src/renderer/android-pos/shim/refund-coordinator';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore } from '../src/renderer/android-pos/shim/token-store';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const backendId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const backendShiftId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const requestId = '11111111-1111-4111-8111-111111111111';
const machineId = '22222222-2222-4222-8222-222222222222';
const serverUrl = 'https://event-gates.invalid';
const databases: AndroidDatabase[] = [];
const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
};
const rawOrder = () => ({ id: backendId, salonId: 'salon', status: 'COMPLETED', total: 10, refundAmount: 0,
  paymentMethod: 'CASH', posMode: 'restaurant', discountAmount: 0, taxAmount: 0, paidAmount: 10,
  createdAt: '2026-09-08T10:00:00Z', items: [{ id: 'server-item', orderId: backendId, productId: 'tea',
    productName: 'Tea', sellBy: 'PIECE', saleUnit: 'szt', totalUnits: 1, grossUnitPrice: 10, grossTotalPrice: 10, taxRate: 0 }] });
const dto = () => ({ type: 'FULL', refundRequestId: requestId, amount: 1000, reason: 'Return',
  lines: [{ orderItemId: 'server-item', variantId: 'tea', quantity: 1, unit: 'szt', unitPrice: 1000, refundAmount: 1000, restock: true }] });
const confirmed = () => ({ success: true, orderId: backendId, refundRequestId: requestId, status: 'REFUNDED',
  refundAmount: 10, totalRefundedAmount: 10, refundedLines: [{ orderItemId: 'server-item', variantId: 'tea',
    quantity: 1, unit: 'szt', unitPrice: 10, refundAmount: 10, refundRequestId: requestId, restock: true }] });
async function setup() {
  const persistence = new MemoryAndroidPersistence();
  const database = await initAndroidDb({ locateFile: null, persistence }); databases.push(database);
  database.run("INSERT INTO shifts (id,backend_id,staff_id,opened_at) VALUES ('local-shift',?,'owner','2026-09-08T09:00:00Z')", [backendShiftId]);
  database.run(`INSERT INTO orders (id,backend_id,shift_id,source,status,synced,total,refund_amount,payment_method,mode)
    VALUES ('local-order',?,'local-shift','POS','COMPLETED',1,1000,0,'CASH','restaurant')`, [backendId]);
  database.run("INSERT INTO product_variants (id,name,in_stock,available_qty) VALUES ('tea','Tea',3,3)");
  await database.flush();
  const configStore = new ShimConfigStore({ storage: storage(), seed: { salonId: 'salon',
    authUser: { id: 'owner', salonId: 'salon', role: 'OWNER' } } as any });
  const tokenStore = new TokenStore({ storage: storage(), allowInsecureFallback: true });
  await tokenStore.setTokens('owner-token', 'refresh-token');
  const client = { getServerOrderDetail: vi.fn(async () => rawOrder()), refundOrder: vi.fn(async () => confirmed()) };
  const refreshStock = vi.fn(async () => {});
  const coordinator = createAndroidRefundCoordinator({ client, configStore, tokenStore, db: async () => database,
    serverUrl, currentServerUrl: () => serverUrl, isTransitioning: () => false, refreshStock });
  return { database, persistence, client, refreshStock, coordinator, orders: createOrderRepo(database) };
}
type Harness = Awaited<ReturnType<typeof setup>>;
const mark = (h: Harness, value = '{}') => h.database.run("UPDATE orders SET refund_event_context_json = ? WHERE id = 'local-order'", [value]);
function seedEvent(h: Harness, localOrderId = 'local-order', localShiftId = 'local-shift') {
  h.database.run(`INSERT INTO pos_refund_events (request_id,server_url,salon_id,local_order_id,backend_order_id,
    local_shift_id,backend_shift_id,machine_id,operator_id,occurred_at,delta_amount_minor,event_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [requestId, serverUrl, 'salon', localOrderId, backendId, localShiftId, backendShiftId, machineId, 'owner', '2026-09-08T10:00:00Z', 100, '{}']);
}
const state = (h: Harness) => ({ order: h.database.get("SELECT * FROM orders WHERE id='local-order'"),
  shift: h.database.get("SELECT * FROM shifts WHERE id='local-shift'"),
  stock: h.database.all('SELECT * FROM product_variants'), attempts: h.database.all('SELECT * FROM pos_refund_attempts'),
  events: h.database.all('SELECT * FROM pos_refund_events') });
function noExternal(h: Harness) {
  expect(h.client.getServerOrderDetail).not.toHaveBeenCalled();
  expect(h.client.refundOrder).not.toHaveBeenCalled();
  expect(h.refreshStock).not.toHaveBeenCalled();
}
async function blockedCoordinator(h: Harness) {
  for (const operation of [() => h.coordinator.getRefundDetail('local-order'),
    () => h.coordinator.refundOrder('local-order', dto()), () => h.coordinator.reconcileRefund('local-order', requestId)]) {
    expect(await operation()).toMatchObject({ success: false, error: expect.stringContaining('Canonical refund event') });
  }
}
afterEach(async () => {
  for (const database of databases.splice(0)) { try { await database.flush(); } catch {} }
  vi.restoreAllMocks();
});

describe('Android canonical event isolation from legacy refund accounting', () => {
  it.each(['', 'not-json', 'null', '{}', '{"schemaVersion":1}'])('treats any non-NULL context %j as a gate, not a parsable legacy fallback', async marker => {
    const h = await setup(); mark(h, marker); await h.database.flush();
    const before = state(h);
    expect(() => h.orders.markRefunded('local-order', 1000, 'legacy overwrite', 'FULL')).toThrow('ANDROID_REFUND_EVENT_LEGACY_WRITE_BLOCKED');
    expect(() => h.orders.closeShift('local-shift', 1000)).toThrow('ANDROID_REFUND_EVENT_REPORT_INVALID');
    await blockedCoordinator(h); noExternal(h);
    expect(state(h)).toEqual(before);
  });
  it('blocks orphaned event rows even when the local order has no context marker', async () => {
    const h = await setup(); seedEvent(h); const before = state(h);
    expect(() => h.orders.markRefunded('local-order', 1000, 'legacy overwrite', 'FULL')).toThrow('ANDROID_REFUND_EVENT_LEGACY_WRITE_BLOCKED');
    expect(() => h.orders.closeShift('local-shift', 1000)).toThrow('ANDROID_REFUND_EVENT_REPORT_INVALID');
    await blockedCoordinator(h); noExternal(h); expect(state(h)).toEqual(before);
  });
  it('blocks new shift accounting from an event referencing that shift even when its order is absent', async () => {
    const h = await setup(); seedEvent(h, 'missing-local-order'); const before = state(h);
    expect(() => h.orders.closeShift('local-shift', 1000)).toThrow('ANDROID_REFUND_EVENT_REPORT_INVALID');
    expect(state(h)).toEqual(before); noExternal(h);
  });
  it('keeps an already frozen close report readable without recalculating marked orders or events', async () => {
    const h = await setup(); const saved = h.orders.closeShift('local-shift', 1000);
    mark(h); seedEvent(h); const before = state(h);
    expect(h.orders.closeShift('local-shift', 999999)).toEqual(saved);
    expect(h.orders.getClosedShiftReport('local-shift')).toEqual(saved);
    expect(state(h)).toEqual(before); noExternal(h);
  });
  it.each([1, 0, null, '1'])('never replays version-tagged UNKNOWN protocol %j through legacy HTTP and preserves original bytes', async protocolVersion => {
    const h = await setup(); const repo = createRefundAttemptRepo(h.database);
    const payload = '{ "refundRequestId": "' + requestId + '", "refundEventVersion": 1, "amount": 10 }';
    const expected = '{ "protocolVersion": ' + JSON.stringify(protocolVersion) + ', "authority": {} }';
    repo.prepare({ request_id: requestId, scope_key: JSON.stringify([serverUrl, 'salon', 'owner']),
      local_order_id: 'local-order', backend_order_id: backendId, shift_id: 'local-shift', payload_json: payload, expected_json: expected });
    repo.markUnknown(requestId); await h.database.flush(); const before = state(h);
    expect(await h.coordinator.reconcileRefund('local-order', requestId))
      .toMatchObject({ success: false, error: expect.stringContaining('Canonical refund event reconciliation') });
    expect(await h.coordinator.refundOrder('local-order', dto()))
      .toMatchObject({ success: false, error: expect.stringContaining('Canonical refund event reconciliation') });
    noExternal(h); expect(state(h)).toEqual(before);
    const restored = await initAndroidDb({ locateFile: null, persistence: h.persistence }); databases.push(restored);
    expect(restored.get<any>('SELECT payload_json, expected_json, status FROM pos_refund_attempts WHERE request_id = ?', [requestId]))
      .toEqual({ payload_json: payload, expected_json: expected, status: 'UNKNOWN' });
  });
  it.each(['marker', 'event'] as const)('does not bypass %s protection through legacy CONFIRMED reconciliation after shift closure', async kind => {
    const h = await setup();
    expect(await h.coordinator.refundOrder('local-order', dto())).toMatchObject({ success: true });
    h.orders.closeShift('local-shift', 0);
    if (kind === 'marker') mark(h); else seedEvent(h);
    h.client.getServerOrderDetail.mockClear(); h.client.refundOrder.mockClear(); h.refreshStock.mockClear();
    const before = state(h);
    await blockedCoordinator(h); noExternal(h); expect(state(h)).toEqual(before);
  });
  it.each(['marker', 'event'] as const)('rechecks %s evidence added while fetching canonical detail before preparing or dispatching legacy refund', async kind => {
    const h = await setup();
    h.client.getServerOrderDetail.mockImplementationOnce(async () => {
      if (kind === 'marker') mark(h); else seedEvent(h);
      return rawOrder();
    });
    expect(await h.coordinator.refundOrder('local-order', dto()))
      .toMatchObject({ success: false, error: expect.stringContaining('Canonical refund event') });
    expect(h.client.refundOrder).not.toHaveBeenCalled(); expect(h.refreshStock).not.toHaveBeenCalled();
    expect(h.database.all('SELECT * FROM pos_refund_attempts')).toHaveLength(0);
    expect(h.database.get("SELECT status,refund_amount FROM orders WHERE id='local-order'"))
      .toEqual({ status: 'COMPLETED', refund_amount: 0 });
  });
  it('does not expose refundable detail if an event appears during the detail read', async () => {
    const h = await setup();
    h.client.getServerOrderDetail.mockImplementationOnce(async () => { seedEvent(h); return rawOrder(); });
    expect(await h.coordinator.getRefundDetail('local-order'))
      .toMatchObject({ success: false, error: expect.stringContaining('Canonical refund event') });
    expect(h.client.refundOrder).not.toHaveBeenCalled(); expect(h.refreshStock).not.toHaveBeenCalled();
    expect(h.database.all('SELECT * FROM pos_refund_attempts')).toHaveLength(0);
  });
  it('retains UNKNOWN without a legacy projection if event evidence appears during a submitted refund', async () => {
    const h = await setup();
    h.client.refundOrder.mockImplementationOnce(async () => { mark(h); return confirmed(); });
    expect(await h.coordinator.refundOrder('local-order', dto()))
      .toMatchObject({ success: false, requiresReconciliation: true, error: expect.stringContaining('Canonical refund event') });
    expect(h.client.refundOrder).toHaveBeenCalledTimes(1); expect(h.refreshStock).not.toHaveBeenCalled();
    expect(h.database.get('SELECT status FROM pos_refund_attempts')).toEqual({ status: 'UNKNOWN' });
    expect(h.database.get("SELECT status,refund_amount,refund_lines FROM orders WHERE id='local-order'"))
      .toEqual({ status: 'COMPLETED', refund_amount: 0, refund_lines: null });
    expect(h.database.get('SELECT in_stock,available_qty FROM product_variants')).toEqual({ in_stock: 3, available_qty: 3 });
  });
  it('keeps unmarked ordinary legacy writes and close accounting available', async () => {
    const h = await setup();
    h.orders.markRefunded('local-order', 200, 'Legacy return', 'PARTIAL');
    expect(h.orders.closeShift('local-shift', 800)).toMatchObject({ totalRefunds: 200, totalSales: 800, cashTotal: 800 });
    noExternal(h);
  });
});
