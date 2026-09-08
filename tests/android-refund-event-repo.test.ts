import { afterEach, describe, expect, it, vi } from 'vitest';
import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { createRefundAttemptRepo } from '../src/renderer/android-pos/shim/db/refund-attempt-repo';
import { createRefundEventRepo, type ConfirmCanonicalRefundInput } from '../src/renderer/android-pos/shim/db/refund-event-repo';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const localId = id(1); const backendId = id(2); const localShift = id(3); const backendShift = id(4); const itemId = id(5);
const scope = { serverUrl: 'https://event-repo.invalid', salonId: id(6), operatorId: id(7), machineId: id(8) };
const capacities = [{ method: 'CARD', amountMinor: 400 }, { method: 'CASH', amountMinor: 600 }];
const databases: AndroidDatabase[] = [];
afterEach(async () => { for (const db of databases.splice(0)) { try { await db.flush(); } catch {} } vi.restoreAllMocks(); });
async function setup(persistence = new MemoryAndroidPersistence(), seed = true) {
  const db = await initAndroidDb({ locateFile: null, persistence }); databases.push(db);
  if (seed) {
    db.run('INSERT INTO pos_device_identity(singleton,id) VALUES(1,?)', [scope.machineId]);
    db.run('INSERT INTO shifts(id,staff_id,staff_name,opening_cash,opened_at,backend_id,backend_binding_json) VALUES(?,?,?,0,?,?,?)',
      [localShift, scope.operatorId, 'Owner', '2026-09-08T09:00:00.000Z', backendShift,
        JSON.stringify({ serverUrl: scope.serverUrl, salonId: scope.salonId, machineId: scope.machineId, backendShiftId: backendShift })]);
    db.run(`INSERT INTO orders(id,backend_id,shift_id,total,status,source,synced,payment_method,payment_tenders,refund_amount,payment_amount,change_amount)
      VALUES(?,?,?,1000,'COMPLETED','POS',1,'SPLIT',?,0,1000,0)`,
      [localId, backendId, localShift, JSON.stringify(capacities.map(row => ({ method: row.method, amount: row.amountMinor })))]);
    db.run('INSERT INTO order_items(id,order_id,variant_id,name,quantity,price,total) VALUES(?,?,?,?,5,200,1000)', [id(9), localId, id(10), 'Tea']);
  }
  return { db, persistence, journal: createRefundAttemptRepo(db), repo: createRefundEventRepo(db) };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const order = (f: Fixture) => f.db.get<any>('SELECT * FROM orders WHERE id = ?', [localId]);
const fingerprint = (o: any) => JSON.stringify([o.id, o.backend_id, o.shift_id, o.synced, o.source, o.status,
  o.total, o.refund_amount ?? 0, o.refund_lines ?? null, o.payment_method, o.payment_tenders ?? null]);
function proof(f: Fixture, request = 20, delta = 200, allocation = [{ method: 'CASH', amountMinor: delta }]) {
  const row = order(f); const requestId = id(request); const previous = row.refund_amount;
  const authority = { backendOrderId: backendId, requestId, orderTotalGrosze: 1000, alreadyRefundedGrosze: previous,
    expectedDeltaGrosze: delta, items: [{ orderItemId: itemId, quantity: delta / 200, restock: false }] };
  const event = { schemaVersion: 1, refundRequestId: requestId, orderId: backendId, salonId: scope.salonId,
    shiftId: backendShift, machineId: scope.machineId, operatorId: scope.operatorId, occurredAt: `2026-09-08T10:00:${String(request).padStart(2, '0')}.000Z`,
    deltaAmountMinor: delta, tenderAllocations: allocation };
  const payload = { refundEventVersion: 1, machineId: scope.machineId, refundRequestId: requestId, shiftId: backendShift,
    type: previous + delta === 1000 ? 'FULL' : 'PARTIAL', amount: delta / 100,
    items: authority.items, tenderAllocations: allocation.map(row => ({ method: row.method, amount: row.amountMinor / 100 })), reason: 'Returned' };
  const response = { success: true, orderId: backendId, refundRequestId: requestId, refundAmount: delta / 100,
    totalRefundedAmount: (previous + delta) / 100, status: previous + delta === 1000 ? 'REFUNDED' : 'PARTIAL_REFUND',
    refundedLines: [{ orderItemId: itemId, refundRequestId: requestId, quantity: delta / 200, restock: false,
      unit: 'szt', saleUnit: 'szt', unitPrice: 2, refundAmount: delta / 100 }], refundEvent: event };
  const saved = { protocolVersion: 1, authority, event, originalTenderCapacities: capacities,
    localFingerprint: fingerprint(row), inputJson: JSON.stringify({ refundRequestId: requestId, type: payload.type }),
    priorRefundLines: JSON.parse(row.refund_lines ?? '[]') };
  return { requestId, payload, response, saved };
}
function prepare(f: Fixture, p = proof(f)) {
  f.journal.prepare({ request_id: p.requestId, scope_key: JSON.stringify([scope.serverUrl, scope.salonId, scope.operatorId]),
    local_order_id: localId, backend_order_id: backendId, shift_id: localShift,
    payload_json: JSON.stringify(p.payload), expected_json: JSON.stringify(p.saved) });
  f.journal.markUnknown(p.requestId);
  return p;
}
const input = (p: ReturnType<typeof proof>): ConfirmCanonicalRefundInput => ({ requestId: p.requestId, localOrderId: localId, responseJson: JSON.stringify(p.response), scope: { ...scope } });
const state = (f: Fixture) => ({ order: order(f), journal: f.db.all('SELECT * FROM pos_refund_attempts ORDER BY request_id'),
  events: f.db.all('SELECT * FROM pos_refund_events ORDER BY request_id') });

describe('Android canonical refund confirmation storage', () => {
  it('atomically saves event, immutable context, cumulative audit and journal without flushing or touching stock', async () => {
    const f = await setup(); const p = prepare(f); const flush = vi.spyOn(f.db, 'flush');
    const original = f.journal.get(p.requestId)!;
    expect(f.repo.confirmCanonicalRefund(input(p))).toEqual({ applied: true, deltaGrosze: 200, cumulativeGrosze: 200 });
    expect(flush).not.toHaveBeenCalled(); expect(f.persistence.image).toBeNull();
    expect(order(f)).toMatchObject({ status: 'PARTIAL_REFUND', refund_amount: 200, refunded_at: p.response.refundEvent.occurredAt });
    expect(JSON.parse(order(f).refund_event_context_json)).toEqual({ serverUrl: scope.serverUrl, salonId: scope.salonId,
      machineId: scope.machineId, backendOrderId: backendId, originalTenderCapacities: capacities });
    const event = f.db.get<any>('SELECT * FROM pos_refund_events');
    expect(event).toMatchObject({ request_id: p.requestId, local_order_id: localId, backend_order_id: backendId,
      local_shift_id: localShift, backend_shift_id: backendShift, delta_amount_minor: 200 });
    expect(JSON.parse(event.event_json)).toEqual(p.response.refundEvent);
    expect(f.journal.get(p.requestId)).toMatchObject({ status: 'CONFIRMED', payload_json: original.payload_json, expected_json: original.expected_json, response_json: JSON.stringify(p.response) });
    expect(f.db.get<any>('SELECT quantity FROM order_items')?.quantity).toBe(5);
  });
  it('is idempotent across restart and terminal replay after the original shift closes', async () => {
    const f = await setup(); const p = prepare(f); f.repo.confirmCanonicalRefund(input(p));
    f.db.run('UPDATE shifts SET closed_at = ?, close_report_json = ? WHERE id = ?', ['2026-09-08T11:00:00.000Z', '{}', localShift]);
    await f.db.flush(); const restarted = await setup(f.persistence, false); const before = state(restarted);
    expect(restarted.repo.confirmCanonicalRefund(input(p))).toEqual({ applied: false, deltaGrosze: 200, cumulativeGrosze: 200 });
    expect(state(restarted)).toEqual(before);
  });
  it('supports partial sequences and prior-request replay after a later full refund', async () => {
    const f = await setup(); const first = prepare(f); f.repo.confirmCanonicalRefund(input(first));
    const second = prepare(f, proof(f, 21, 400)); f.repo.confirmCanonicalRefund(input(second));
    const last = prepare(f, proof(f, 22, 400, [{ method: 'CARD', amountMinor: 400 }]));
    expect(f.repo.confirmCanonicalRefund(input(last))).toMatchObject({ applied: true, cumulativeGrosze: 1000 });
    expect(order(f).status).toBe('REFUNDED'); expect(JSON.parse(order(f).refund_lines)).toHaveLength(3);
    const before = state(f); expect(f.repo.confirmCanonicalRefund(input(first))).toMatchObject({ applied: false });
    expect(state(f)).toEqual(before);
  });
  it.each(['requestId', 'localOrderId', 'serverUrl', 'salonId', 'operatorId', 'machineId'])('rejects wrong confirmation %s without mutations', async field => {
    const f = await setup(); const p = prepare(f); const args = input(p) as any;
    if (field in args.scope) args.scope[field] = field === 'serverUrl' ? 'https://wrong.invalid' : id(99); else args[field] = id(99);
    const before = state(f); expect(() => f.repo.confirmCanonicalRefund(args)).toThrow(); expect(state(f)).toEqual(before);
  });
  it.each([
    ['version', (p: any) => { p.payload.refundEventVersion = 2; }],
    ['request', (p: any) => { p.payload.refundRequestId = id(99); }],
    ['shift', (p: any) => { p.payload.shiftId = id(99); }],
    ['machine', (p: any) => { p.payload.machineId = id(99); }],
    ['amount', (p: any) => { p.payload.amount = 2.01; }],
    ['amount junk', (p: any) => { p.payload.amount = '2junk'; }],
    ['item identity', (p: any) => { p.payload.items = [{ orderItemId: id(99), quantity: 1, restock: false }]; }],
    ['duplicate item', (p: any) => { p.payload.items.push({ ...p.payload.items[0] }); }],
    ['item quantity', (p: any) => { p.payload.items = [{ orderItemId: itemId, quantity: 2, restock: false }]; }],
    ['item restock', (p: any) => { p.payload.items = [{ orderItemId: itemId, quantity: 1, restock: true }]; }],
    ['unit', (p: any) => { p.payload.items = [{ ...p.payload.items[0], unit: 'kg' }]; }],
    ['manual adjustment', (p: any) => { p.payload.manualAdjustmentAmount = 1; }],
    ['legacy lines', (p: any) => { p.payload.lines = []; }],
    ['tenders', (p: any) => { p.payload.tenderAllocations = [{ method: 'CARD', amount: 2 }]; }],
    ['protocol', (p: any) => { p.saved.protocolVersion = 2; }],
    ['unsafe capacities', (p: any) => { p.saved.originalTenderCapacities = [{ method: 'CASH', amountMinor: Number.MAX_SAFE_INTEGER }, { method: 'CARD', amountMinor: 1 }]; }],
    ['redirected capacities', (p: any) => { p.saved.originalTenderCapacities = [{ method: 'CASH', amountMinor: 1000 }]; }],
    ['duplicate capacities', (p: any) => { p.saved.originalTenderCapacities = [{ method: 'CASH', amountMinor: 500 }, { method: 'CASH', amountMinor: 500 }]; }],
    ['OTHER', (p: any) => { p.payload.tenderAllocations = [{ method: 'OTHER', amount: 2 }]; p.saved.event.tenderAllocations = [{ method: 'OTHER', amountMinor: 200 }]; }],
    ['missing prior audit', (p: any) => { delete p.saved.priorRefundLines; }],
    ['malformed input JSON', (p: any) => { p.saved.inputJson = 'null'; }],
  ] as const)('rejects frozen %s mismatch', async (_name, mutate) => {
    const f = await setup(); const p = proof(f); mutate(p); prepare(f, p); const before = state(f);
    expect(() => f.repo.confirmCanonicalRefund(input(p))).toThrow(); expect(state(f)).toEqual(before);
  });
  it.each([
    ['delta one-cent tolerance', (p: any) => { p.response.refundAmount = 2.01; p.response.totalRefundedAmount = 2.01; p.response.refundedLines[0].refundAmount = 2.01; }],
    ['line-sum one-cent tolerance', (p: any) => { p.response.refundedLines[0].refundAmount = 1.99; }],
    ['wrong event', (p: any) => { p.response.refundEvent = { ...p.response.refundEvent, operatorId: id(99) }; }],
    ['missing event', (p: any) => { delete p.response.refundEvent; }],
    ['wrong cumulative', (p: any) => { p.response.totalRefundedAmount = 4; }],
  ] as const)('rejects response %s', async (_name, mutate) => {
    const f = await setup(); const p = prepare(f); mutate(p); const before = state(f);
    expect(() => f.repo.confirmCanonicalRefund(input(p))).toThrow(); expect(state(f)).toEqual(before);
  });
  it.each([
    "UPDATE shifts SET closed_at='2026-09-08T11:00:00Z'",
    "UPDATE shifts SET close_report_json='{}'",
    "UPDATE shifts SET backend_binding_json=NULL",
    "UPDATE shifts SET backend_binding_json='{}'",
    "UPDATE shifts SET backend_id='wrong'",
    "UPDATE orders SET shift_id='other'",
    "UPDATE orders SET source='SERVER'",
    "UPDATE orders SET total=999",
    "UPDATE orders SET payment_tenders='[]'",
    "UPDATE orders SET payment_method='CARD'",
    "UPDATE orders SET payment_amount=500",
    "UPDATE orders SET change_amount=100",
    "UPDATE orders SET payment_amount=-1",
    "UPDATE orders SET discount=1",
    "UPDATE orders SET tip=1",
    "UPDATE orders SET refund_event_context_json='{}'",
    "UPDATE pos_device_identity SET id='wrong'",
  ])('rejects altered local state %s', async sql => {
    const f = await setup(); const p = prepare(f); f.db.run(sql); const before = state(f);
    expect(() => f.repo.confirmCanonicalRefund(input(p))).toThrow(); expect(state(f)).toEqual(before);
  });
  it('refuses nonzero first-cutover even with matching frozen local/server prior money', async () => {
    const f = await setup(); f.db.run("UPDATE orders SET refund_amount=200,status='PARTIAL_REFUND'");
    const p = prepare(f); expect(() => f.repo.confirmCanonicalRefund(input(p))).toThrow();
    expect(f.db.all('SELECT * FROM pos_refund_events')).toHaveLength(0);
  });
  it('rejects underpaid single-tender fallback even with matching frozen tender capacity and fingerprint', async () => {
    const f = await setup(); f.db.run("UPDATE orders SET payment_method='CASH',payment_tenders=NULL,payment_amount=500");
    const p = proof(f); p.saved.originalTenderCapacities = [{ method: 'CASH', amountMinor: 1000 }]; prepare(f, p);
    expect(() => f.repo.confirmCanonicalRefund(input(p))).toThrow(/unsettled/);
  });
  it('supports fully settled cash with change without inventing extra tender capacity', async () => {
    const f = await setup(); f.db.run("UPDATE orders SET payment_method='CASH',payment_tenders=NULL,payment_amount=1500,change_amount=500");
    const p = proof(f); p.saved.originalTenderCapacities = [{ method: 'CASH', amountMinor: 1000 }]; prepare(f, p);
    expect(f.repo.confirmCanonicalRefund(input(p))).toMatchObject({ applied: true });
  });
  it('rejects duplicate local rows pointing at the same backend order', async () => {
    const f = await setup(); const p = prepare(f);
    f.db.run('INSERT INTO orders(id,backend_id,total) VALUES(?,?,1000)', [id(99), backendId]);
    expect(() => f.repo.confirmCanonicalRefund(input(p))).toThrow(/Ambiguous/);
  });
  it('refuses any confirmed legacy journal instead of inventing a baseline', async () => {
    const f = await setup(); const legacy = prepare(f); f.journal.confirmAndApply(legacy.requestId, '{"legacy":true}', () => {});
    const p = prepare(f, proof(f, 21)); expect(() => f.repo.confirmCanonicalRefund(input(p))).toThrow(/legacy|ledger/i);
    expect(order(f).refund_event_context_json).toBeNull();
  });
  it('rejects over-capacity second refund even when original total still has enough money', async () => {
    const f = await setup(); const first = prepare(f, proof(f, 20, 600)); f.repo.confirmCanonicalRefund(input(first));
    const p = prepare(f, proof(f, 21, 200)); const before = state(f);
    expect(() => f.repo.confirmCanonicalRefund(input(p))).toThrow(/capacity/); expect(state(f)).toEqual(before);
  });
  it.each(['server_url','salon_id','local_order_id','backend_order_id','local_shift_id','backend_shift_id','machine_id','operator_id','occurred_at','event_json'])('rejects tampered persisted %s on replay', async field => {
    const f = await setup(); const p = prepare(f); f.repo.confirmCanonicalRefund(input(p));
    f.db.run(`UPDATE pos_refund_events SET ${field} = ?`, [field === 'event_json' ? '{}' : 'wrong']);
    const before = state(f); expect(() => f.repo.confirmCanonicalRefund(input(p))).toThrow(); expect(state(f)).toEqual(before);
  });
  it.each([
    'DELETE FROM pos_refund_events',
    'UPDATE pos_refund_events SET delta_amount_minor=201',
    "UPDATE orders SET refund_amount=201",
    "UPDATE orders SET refund_lines='[]'",
    "UPDATE orders SET refund_event_context_json=NULL",
    "UPDATE pos_refund_attempts SET response_json='{}'",
    "UPDATE pos_refund_attempts SET expected_json='{}'",
  ])('rejects incomplete/corrupted confirmed accounting: %s', async sql => {
    const f = await setup(); const p = prepare(f); f.repo.confirmCanonicalRefund(input(p)); f.db.run(sql);
    expect(() => f.repo.confirmCanonicalRefund(input(p))).toThrow();
  });
  it('rejects changed response bytes on terminal replay', async () => {
    const f = await setup(); const p = prepare(f); f.repo.confirmCanonicalRefund(input(p));
    expect(() => f.repo.confirmCanonicalRefund({ ...input(p), responseJson: ` ${JSON.stringify(p.response)}` })).toThrow(/bytes/);
  });
  it.each([
    ['event insert', 'AFTER INSERT ON pos_refund_events'],
    ['order update', 'AFTER UPDATE OF refund_amount ON orders'],
    ['journal confirmation', 'AFTER UPDATE OF status ON pos_refund_attempts'],
  ])('rolls back all event/order/journal mutations on %s failure', async (_name, clause) => {
    const f = await setup(); const p = prepare(f);
    f.db.run(`CREATE TRIGGER reject_confirmation ${clause} BEGIN SELECT RAISE(ABORT,'test rollback'); END`);
    const before = state(f); expect(() => f.repo.confirmCanonicalRefund(input(p))).toThrow('test rollback'); expect(state(f)).toEqual(before);
    f.db.run('DROP TRIGGER reject_confirmation'); expect(f.repo.confirmCanonicalRefund(input(p)).applied).toBe(true);
  });
  it('recovers UNKNOWN with no partial projection after a failed durable flush', async () => {
    const f = await setup(); const p = prepare(f); await f.db.flush(); f.persistence.failSave = true;
    f.repo.confirmCanonicalRefund(input(p)); await expect(f.db.flush()).rejects.toThrow();
    const restarted = await setup(f.persistence, false);
    expect(restarted.journal.get(p.requestId)?.status).toBe('UNKNOWN'); expect(order(restarted).refund_amount).toBe(0);
    expect(restarted.db.all('SELECT * FROM pos_refund_events')).toHaveLength(0);
    f.persistence.failSave = false; expect(restarted.repo.confirmCanonicalRefund(input(p)).applied).toBe(true); await restarted.db.flush();
  });
});
