import { afterEach, describe, expect, it, vi } from 'vitest';
import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { createAndroidRefundCoordinator } from '../src/renderer/android-pos/shim/refund-coordinator';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore } from '../src/renderer/android-pos/shim/token-store';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const baseIds = {
  localOrder: id(1), backendOrder: id(2), localShift: id(3), backendShift: id(4),
  salon: id(5), operator: id(6), machine: id(7), firstItem: id(8), secondItem: id(9), variant: id(10),
};
const requestA = id(20); const requestB = id(21); const serverUrl = 'https://refund-v1.invalid';
const databases: AndroidDatabase[] = [];
const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
};
const canonical = (value: any): string => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);

type Ids = typeof baseIds;
type SetupOptions = { capabilities?: unknown; ids?: Partial<Ids> };
function request(ids: Ids, requestId = requestA, itemId = ids.firstItem, type: 'FULL' | 'PARTIAL' = 'PARTIAL') {
  return { type, refundRequestId: requestId, amount: 1000, reason: 'Return', lines: [
    { orderItemId: itemId, variantId: ids.variant, quantity: 1, unit: 'szt', unitPrice: 1000,
      refundAmount: 1000, restock: false },
  ] };
}
function serverOrder(ids: Ids): any {
  return { id: ids.backendOrder, salonId: ids.salon, shiftId: ids.backendShift, status: 'COMPLETED',
    total: 20, refundAmount: 0, paymentMethod: 'CASH', tenders: [{ method: 'CASH', amount: 20 }],
    posMode: 'restaurant', discountAmount: 0, taxAmount: 0, paidAmount: 20, changeAmount: 0,
    createdAt: '2026-09-08T10:00:00.000Z', items: [ids.firstItem, ids.secondItem].map((itemId, index) => ({
      id: itemId, orderId: ids.backendOrder, productId: ids.variant, productName: `Tea ${index + 1}`,
      sellBy: 'PIECE', saleUnit: 'szt', totalUnits: 1, grossUnitPrice: 10, grossTotalPrice: 10, taxRate: 0,
    })) };
}

async function setup(options: SetupOptions = {}) {
  const ids = { ...baseIds, ...options.ids };
  let capabilities = Object.prototype.hasOwnProperty.call(options, 'capabilities')
    ? options.capabilities : { refundEventVersion: 1 };
  const persistence = new MemoryAndroidPersistence();
  const database = await initAndroidDb({ locateFile: null, persistence }); databases.push(database);
  database.run('INSERT INTO pos_device_identity(singleton,id) VALUES(1,?)', [ids.machine]);
  database.run(`INSERT INTO shifts(id,staff_id,staff_name,opening_cash,opened_at,backend_id,backend_binding_json)
    VALUES(?,?,?,0,?,?,?)`, [ids.localShift, ids.operator, 'Owner', '2026-09-08T09:00:00.000Z', ids.backendShift,
    JSON.stringify({ serverUrl, salonId: ids.salon, machineId: ids.machine, backendShiftId: ids.backendShift })]);
  database.run(`INSERT INTO orders(id,backend_id,shift_id,total,status,source,synced,payment_method,payment_tenders,
    refund_amount,payment_amount,change_amount,mode) VALUES(?,?,?,2000,'COMPLETED','POS',1,'CASH',?,0,2000,0,'restaurant')`,
  [ids.localOrder, ids.backendOrder, ids.localShift, JSON.stringify([{ method: 'CASH', amount: 2000 }])]);
  database.run('INSERT INTO product_variants(id,name,in_stock,available_qty) VALUES(?,?,3,3)', [ids.variant, 'Tea']);
  await database.flush();

  const configStore = new ShimConfigStore({ storage: storage(), seed: { salonId: ids.salon,
    authUser: { id: ids.operator, salonId: ids.salon, role: 'OWNER' } } as any });
  const tokenStore = new TokenStore({ storage: storage(), allowInsecureFallback: true });
  await tokenStore.setTokens('owner-token', 'refresh-token');
  let raw = serverOrder(ids); let commits = 0;
  const replies = new Map<string, any>();
  const commit = (serialized: string) => {
    const payload = JSON.parse(serialized);
    if (replies.has(payload.refundRequestId)) return structuredClone(replies.get(payload.refundRequestId));
    commits += 1;
    const refundedLines = payload.items.map((item: any) => ({ ...item, variantId: ids.variant,
      unit: 'szt', saleUnit: 'szt', unitPrice: 10, refundAmount: 10 * item.quantity,
      refundRequestId: payload.refundRequestId }));
    raw.refundAmount += payload.amount;
    raw.status = raw.refundAmount === raw.total ? 'REFUNDED' : 'PARTIAL_REFUND';
    raw.refundedLines = [...(raw.refundedLines ?? []), ...refundedLines];
    const response: any = { success: true, orderId: ids.backendOrder, refundRequestId: payload.refundRequestId,
      status: raw.status, refundAmount: payload.amount, totalRefundedAmount: raw.refundAmount,
      refundedLines, stockMovementIds: [] };
    if (payload.refundEventVersion === 1) response.refundEvent = {
      schemaVersion: 1, refundRequestId: payload.refundRequestId, orderId: ids.backendOrder,
      salonId: ids.salon, shiftId: payload.shiftId, machineId: payload.machineId, operatorId: ids.operator,
      occurredAt: `2026-09-08T10:30:${String(commits).padStart(2, '0')}.000Z`,
      deltaAmountMinor: Math.round(payload.amount * 100),
      tenderAllocations: payload.tenderAllocations.map((row: any) => ({ method: row.method, amountMinor: Math.round(row.amount * 100) })),
    };
    replies.set(payload.refundRequestId, structuredClone(response));
    return response;
  };
  const client = {
    getPosCapabilities: vi.fn(async () => capabilities),
    getServerOrderDetail: vi.fn(async () => structuredClone(raw)),
    refundOrder: vi.fn(async (_orderId: string, body: string, guard?: () => Promise<void>) => {
      await guard?.(); return commit(body);
    }),
  };
  const refreshStock = vi.fn(async () => {});
  const make = (db = database) => createAndroidRefundCoordinator({ client, configStore, tokenStore,
    db: async () => db, serverUrl, currentServerUrl: () => serverUrl, isTransitioning: () => false, refreshStock });
  return { ids, database, persistence, configStore, tokenStore, client, refreshStock, make,
    coordinator: make(), commit, get commits() { return commits; }, setCapabilities: (value: unknown) => { capabilities = value; },
    setServer: (value: any) => { raw = value; }, getServer: () => raw };
}
type Harness = Awaited<ReturnType<typeof setup>>;
const order = (h: Harness, database = h.database) => database.get<any>('SELECT * FROM orders WHERE id = ?', [h.ids.localOrder]);
const state = (h: Harness, database = h.database) => ({
  order: order(h, database), attempts: database.all('SELECT * FROM pos_refund_attempts ORDER BY request_id'),
  events: database.all('SELECT * FROM pos_refund_events ORDER BY request_id'),
});

afterEach(async () => {
  for (const database of databases.splice(0)) { try { await database.flush(); } catch {} }
  vi.restoreAllMocks();
});

describe('guarded Android refund-event V1 coordinator', () => {
  it('opts a new attempt into V1 only for the exact own numeric capability and freezes exact protocol evidence', async () => {
    const h = await setup(); const dto = request(h.ids); const before = order(h);
    expect(await h.coordinator.refundOrder(h.ids.localOrder, dto)).toMatchObject({ success: true, refundAmount: 10 });
    expect(h.client.getPosCapabilities).toHaveBeenCalledTimes(1);
    const transmitted = JSON.parse(h.client.refundOrder.mock.calls[0][1]);
    expect(transmitted).toEqual({ type: 'PARTIAL', reason: 'Return', refundRequestId: requestA,
      shiftId: h.ids.backendShift, items: [{ orderItemId: h.ids.firstItem, quantity: 1, restock: false, unit: 'szt' }],
      amount: 10, tenderAllocations: [{ method: 'CASH', amount: 10 }],
      refundEventVersion: 1, machineId: h.ids.machine });
    const attempt = h.database.get<any>('SELECT * FROM pos_refund_attempts WHERE request_id = ?', [requestA]);
    expect(JSON.parse(attempt.payload_json)).toEqual(transmitted);
    expect(JSON.parse(attempt.expected_json)).toEqual({ protocolVersion: 1,
      authority: { backendOrderId: h.ids.backendOrder, requestId: requestA, orderTotalGrosze: 2000,
        alreadyRefundedGrosze: 0, expectedDeltaGrosze: 1000,
        items: [{ orderItemId: h.ids.firstItem, quantity: 1, restock: false }] },
      event: { refundRequestId: requestA, orderId: h.ids.backendOrder, salonId: h.ids.salon,
        shiftId: h.ids.backendShift, machineId: h.ids.machine, operatorId: h.ids.operator,
        deltaAmountMinor: 1000, tenderAllocations: [{ method: 'CASH', amountMinor: 1000 }] },
      originalTenderCapacities: [{ method: 'CASH', amountMinor: 2000 }],
      localFingerprint: JSON.stringify([before.id, before.backend_id, before.shift_id, before.synced, before.source,
        before.status, before.total, before.refund_amount, before.refund_lines, before.payment_method, before.payment_tenders]),
      inputJson: canonical(dto), priorRefundLines: [] });
    expect(attempt.status).toBe('CONFIRMED');
    expect(state(h).events).toHaveLength(1);
    expect(JSON.parse(state(h).events[0].event_json)).toEqual(JSON.parse(attempt.response_json).refundEvent);
    expect(order(h)).toMatchObject({ status: 'PARTIAL_REFUND', refund_amount: 1000 });
  });

  it.each([
    ['absent', undefined], ['empty', {}], ['string', { refundEventVersion: '1' }],
    ['truthy', { refundEventVersion: true }], ['wrapped', { data: { refundEventVersion: 1 } }],
    ['inherited', Object.create({ refundEventVersion: 1 })],
  ])('keeps a new attempt legacy for %s capability and sends no V1-only fields', async (_name, capabilities) => {
    const h = await setup({ capabilities });
    expect((await h.coordinator.refundOrder(h.ids.localOrder, request(h.ids))).success).toBe(true);
    const payload = JSON.parse(h.client.refundOrder.mock.calls[0][1]);
    expect(payload).not.toHaveProperty('refundEventVersion'); expect(payload).not.toHaveProperty('machineId');
    expect(JSON.parse(h.database.get<any>('SELECT expected_json FROM pos_refund_attempts').expected_json))
      .not.toHaveProperty('protocolVersion');
    expect(h.database.all('SELECT * FROM pos_refund_events')).toHaveLength(0);
    expect(order(h).refund_event_context_json).toBeNull();
  });

  it('fails closed without a journal or refund POST when capability negotiation fails', async () => {
    const h = await setup(); h.client.getPosCapabilities.mockRejectedValueOnce(new Error('capability offline'));
    expect(await h.coordinator.refundOrder(h.ids.localOrder, request(h.ids)))
      .toMatchObject({ success: false, error: expect.stringContaining('capability offline') });
    expect(h.client.refundOrder).not.toHaveBeenCalled();
    expect(h.database.all('SELECT * FROM pos_refund_attempts')).toHaveLength(0);
  });

  it('treats only HTTP 404 as an absent capability for an unconverted legacy-compatible order', async () => {
    const h = await setup(); const missing = Object.assign(new Error('HTTP 404'), { status: 404 });
    h.client.getPosCapabilities.mockRejectedValueOnce(missing);
    expect((await h.coordinator.refundOrder(h.ids.localOrder, request(h.ids))).success).toBe(true);
    const payload = JSON.parse(h.client.refundOrder.mock.calls[0][1]);
    expect(payload).not.toHaveProperty('refundEventVersion'); expect(payload).not.toHaveProperty('machineId');
    expect(h.database.all('SELECT * FROM pos_refund_events')).toHaveLength(0);
  });

  it('rejects an auth-context change observed inside capability negotiation before refund preparation', async () => {
    const h = await setup(); const original = h.configStore.getRawConfig();
    h.client.getPosCapabilities.mockImplementationOnce(async (guard?: () => Promise<void>) => {
      h.configStore.setConfig({ ...original, authUser: { ...original.authUser, id: id(99) } } as any);
      await guard?.(); return { refundEventVersion: 1 };
    });
    expect((await h.coordinator.refundOrder(h.ids.localOrder, request(h.ids))).success).toBe(false);
    expect(h.client.getServerOrderDetail).not.toHaveBeenCalled(); expect(h.client.refundOrder).not.toHaveBeenCalled();
    expect(h.database.all('SELECT * FROM pos_refund_attempts')).toHaveLength(0);
  });

  it.each([
    { name: 'salon UUID', ids: { salon: 'salon' } },
    { name: 'operator UUID', ids: { operator: 'owner' } },
    { name: 'local order UUID', ids: { localOrder: 'local-order' } },
    { name: 'backend order UUID', ids: { backendOrder: 'backend-order' } },
    { name: 'local shift UUID', ids: { localShift: 'local-shift' } },
    { name: 'backend shift UUID', ids: { backendShift: 'backend-shift' } },
    { name: 'device UUID', ids: { machine: 'device' } },
    { name: 'durable device identity', mutate: (h: Harness) => h.database.run('DELETE FROM pos_device_identity') },
    { name: 'exact backend binding', mutate: (h: Harness) => h.database.run("UPDATE shifts SET backend_binding_json='{}'") },
    { name: 'binding without extra claims', mutate: (h: Harness) => h.database.run("UPDATE shifts SET backend_binding_json=json_set(backend_binding_json,'$.extra',1)") },
    { name: 'sole open shift', mutate: (h: Harness) => h.database.run(
      'INSERT INTO shifts(id,staff_id,staff_name,opening_cash,opened_at) VALUES(?,?,?,0,?)', [id(90), h.ids.operator, 'Other', '2026-09-08T09:30:00.000Z']) },
    { name: 'fully settled money', mutate: (h: Harness) => h.database.run('UPDATE orders SET payment_amount=1999') },
    { name: 'ordinary local order', mutate: (h: Harness) => h.database.run("UPDATE orders SET source='SERVER'") },
    { name: 'non-billiard order', mutate: (h: Harness) => h.database.run("UPDATE orders SET mode='billiard'") },
    { name: 'same open sale shift', mutate: (h: Harness) => {
      h.database.run("UPDATE shifts SET closed_at='2026-09-08T10:10:00.000Z' WHERE id=?", [h.ids.localShift]);
      h.database.run('INSERT INTO shifts(id,staff_id,staff_name,opening_cash,opened_at,backend_id) VALUES(?,?,?,0,?,?)',
        [id(91), h.ids.operator, 'Other', '2026-09-08T10:11:00.000Z', id(92)]);
    } },
    { name: 'single tender', mutate: (h: Harness) => {
      const raw = h.getServer(); raw.paymentMethod = 'SPLIT'; raw.tenders = [{ method: 'CASH', amount: 10 }, { method: 'CARD', amount: 10 }];
      h.database.run("UPDATE orders SET payment_method='SPLIT',payment_tenders=?", [JSON.stringify([
        { method: 'CASH', amount: 1000 }, { method: 'CARD', amount: 1000 }])]);
    } },
    { name: 'supported tender bucket', mutate: (h: Harness) => {
      const raw = h.getServer(); raw.paymentMethod = 'OTHER'; raw.tenders = [{ method: 'OTHER', amount: 20 }];
      h.database.run("UPDATE orders SET payment_method='OTHER',payment_tenders=?", [JSON.stringify([{ method: 'OTHER', amount: 2000 }])]);
    } },
  ])('blocks V1 before POST without $name', async testCase => {
    const h = await setup({ ids: testCase.ids }); testCase.mutate?.(h);
    expect((await h.coordinator.refundOrder(h.ids.localOrder, request(h.ids))).success).toBe(false);
    expect(h.client.refundOrder).not.toHaveBeenCalled();
    expect(h.database.all('SELECT * FROM pos_refund_events')).toHaveLength(0);
  });

  it('confirms one canonical event and treats confirmed replay/reconcile as read-only without re-probing', async () => {
    const h = await setup(); const dto = request(h.ids);
    expect((await h.coordinator.refundOrder(h.ids.localOrder, dto)).success).toBe(true);
    const confirmed = state(h); const probes = h.client.getPosCapabilities.mock.calls.length;
    expect(await h.coordinator.refundOrder(h.ids.localOrder, dto)).toMatchObject({ success: false, reconciled: true });
    expect(await h.coordinator.reconcileRefund(h.ids.localOrder, requestA)).toMatchObject({ success: true, reconciled: true });
    expect(h.client.getPosCapabilities).toHaveBeenCalledTimes(probes);
    expect(h.client.refundOrder).toHaveBeenCalledTimes(1); expect(h.commits).toBe(1);
    expect(state(h)).toEqual(confirmed);
  });

  it('reconciles timeout-after-commit across restart from the frozen V1 bytes without probing or double-applying', async () => {
    const h = await setup();
    h.client.refundOrder.mockImplementationOnce(async (_orderId, body) => { h.commit(body); throw new Error('timeout after commit'); });
    expect(await h.coordinator.refundOrder(h.ids.localOrder, request(h.ids)))
      .toMatchObject({ success: false, requiresReconciliation: true, refundRequestId: requestA });
    const frozen = h.database.get<any>('SELECT * FROM pos_refund_attempts');
    expect(frozen.status).toBe('UNKNOWN'); expect(JSON.parse(frozen.expected_json).protocolVersion).toBe(1);
    h.setCapabilities(undefined);
    const restartedDb = await initAndroidDb({ locateFile: null, persistence: h.persistence }); databases.push(restartedDb);
    expect(await h.make(restartedDb).reconcileRefund(h.ids.localOrder, requestA))
      .toMatchObject({ success: true, reconciled: true });
    expect(h.client.getPosCapabilities).toHaveBeenCalledTimes(1);
    expect(h.client.refundOrder.mock.calls[1][1]).toBe(frozen.payload_json);
    expect(h.commits).toBe(1); expect(state(h, restartedDb).events).toHaveLength(1);
    expect(order(h, restartedDb)).toMatchObject({ status: 'PARTIAL_REFUND', refund_amount: 1000 });
  });

  it.each([
    ['extra payload field', (payload: any) => { payload.unexpected = true; }, (_saved: any) => {}],
    ['changed payload amount', (payload: any) => { payload.amount = 9; }, (_saved: any) => {}],
    ['changed event allocation', (_payload: any) => {}, (saved: any) => { saved.event.tenderAllocations[0].amountMinor = 999; }],
    ['changed authority item', (_payload: any) => {}, (saved: any) => { saved.authority.items[0].orderItemId = id(99); }],
    ['invalid frozen event timestamp', (_payload: any) => {}, (saved: any) => { saved.event.occurredAt = '2026-99-99T00:00:00.000Z'; }],
  ] as const)('refuses %s before replaying frozen V1 bytes', async (_name, mutatePayload, mutateSaved) => {
    const h = await setup();
    h.client.refundOrder.mockRejectedValueOnce(new Error('timeout before known outcome'));
    expect(await h.coordinator.refundOrder(h.ids.localOrder, request(h.ids)))
      .toMatchObject({ success: false, requiresReconciliation: true });
    const attempt = h.database.get<any>('SELECT payload_json, expected_json FROM pos_refund_attempts');
    const payload = JSON.parse(attempt.payload_json); const saved = JSON.parse(attempt.expected_json);
    mutatePayload(payload); mutateSaved(saved);
    h.database.run('UPDATE pos_refund_attempts SET payload_json = ?, expected_json = ?', [JSON.stringify(payload), JSON.stringify(saved)]);
    h.client.refundOrder.mockClear();
    expect((await h.coordinator.reconcileRefund(h.ids.localOrder, requestA)).success).toBe(false);
    expect(h.client.refundOrder).not.toHaveBeenCalled();
    expect(h.database.get<any>('SELECT status FROM pos_refund_attempts').status).toBe('UNKNOWN');
    expect(h.database.all('SELECT * FROM pos_refund_events')).toHaveLength(0);
  });

  it.each(['context', 'device', 'binding'] as const)('blocks %s drift observed before dispatch', async kind => {
    const h = await setup(); const original = h.configStore.getRawConfig();
    h.client.getServerOrderDetail.mockImplementationOnce(async () => {
      if (kind === 'context') h.configStore.setConfig({ ...original, authUser: { ...original.authUser, id: id(99) } } as any);
      if (kind === 'device') h.database.run('UPDATE pos_device_identity SET id=? WHERE singleton=1', [id(98)]);
      if (kind === 'binding') h.database.run("UPDATE shifts SET backend_binding_json='{}' WHERE id=?", [h.ids.localShift]);
      return structuredClone(h.getServer());
    });
    expect((await h.coordinator.refundOrder(h.ids.localOrder, request(h.ids))).success).toBe(false);
    expect(h.client.refundOrder).not.toHaveBeenCalled();
    expect(h.database.all('SELECT * FROM pos_refund_attempts')).toHaveLength(0);
  });

  it('latches a failed final durable flush and leaves UNKNOWN with no event projection after restart', async () => {
    const h = await setup();
    h.client.refundOrder.mockImplementationOnce(async (_orderId, body, guard) => {
      await guard?.(); const response = h.commit(body); h.persistence.failSave = true; return response;
    });
    expect(await h.coordinator.refundOrder(h.ids.localOrder, request(h.ids)))
      .toMatchObject({ success: false, requiresReconciliation: true });
    expect(h.coordinator.storageFailed).toBe(true);
    expect(h.database.get<any>('SELECT status FROM pos_refund_attempts').status).toBe('CONFIRMED');
    expect((await h.coordinator.reconcileRefund(h.ids.localOrder, requestA)).success).toBe(false);
    h.persistence.failSave = false;
    const restartedDb = await initAndroidDb({ locateFile: null, persistence: h.persistence }); databases.push(restartedDb);
    expect(restartedDb.get<any>('SELECT status FROM pos_refund_attempts').status).toBe('UNKNOWN');
    expect(restartedDb.all('SELECT * FROM pos_refund_events')).toHaveLength(0);
    expect(order(h, restartedDb)).toMatchObject({ status: 'COMPLETED', refund_amount: 0, refund_event_context_json: null });
  });

  it('fails closed instead of downgrading an already converted order when the capability disappears', async () => {
    const h = await setup(); const first = request(h.ids);
    expect((await h.coordinator.refundOrder(h.ids.localOrder, first)).success).toBe(true);
    const converted = state(h); h.client.refundOrder.mockClear();
    h.setCapabilities(undefined);
    expect(await h.coordinator.refundOrder(h.ids.localOrder,
      request(h.ids, requestB, h.ids.secondItem, 'FULL'))).toMatchObject({
        success: false, error: expect.stringMatching(/cannot.*legacy/i),
      });
    expect(h.client.getPosCapabilities).toHaveBeenCalledTimes(2);
    expect(h.client.refundOrder).not.toHaveBeenCalled(); expect(h.commits).toBe(1);
    expect(state(h)).toEqual(converted);
  });

  it('detects canonical history by backend order ID and blocks an ambiguous remapped local row before negotiation', async () => {
    const h = await setup();
    expect((await h.coordinator.refundOrder(h.ids.localOrder, request(h.ids))).success).toBe(true);
    const duplicateLocalId = id(80);
    h.database.run(`INSERT INTO orders(id,backend_id,shift_id,total,status,source,synced,payment_method,payment_tenders,
      refund_amount,payment_amount,change_amount,mode) VALUES(?,?,?,2000,'COMPLETED','POS',1,'CASH',?,0,2000,0,'restaurant')`,
    [duplicateLocalId, h.ids.backendOrder, h.ids.localShift, JSON.stringify([{ method: 'CASH', amount: 2000 }])]);
    h.client.getPosCapabilities.mockClear(); h.client.refundOrder.mockClear();
    expect(await h.coordinator.refundOrder(duplicateLocalId, request(h.ids, requestB, h.ids.secondItem, 'FULL')))
      .toMatchObject({ success: false, error: expect.stringMatching(/Canonical refund event|unambiguous/i) });
    expect(h.client.getPosCapabilities).not.toHaveBeenCalled(); expect(h.client.refundOrder).not.toHaveBeenCalled();
    expect(h.commits).toBe(1);
  });
});
