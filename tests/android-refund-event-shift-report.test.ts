import { afterEach, describe, expect, it } from 'vitest';
import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const id = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const serverUrl = 'https://shift-report.invalid';
const salonId = id(90);
const machineId = id(91);
const operatorId = id(92);
const databases: AndroidDatabase[] = [];

type Tender = { method: 'CASH' | 'CARD' | 'BLIK' | 'BANK_TRANSFER' | 'OTHER'; amountMinor: number };

afterEach(async () => {
  for (const db of databases.splice(0)) {
    try { await db.flush(); } catch {}
  }
});

async function setup() {
  const db = await initAndroidDb({ locateFile: null, persistence: new MemoryAndroidPersistence() });
  databases.push(db);
  return { db, repo: createOrderRepo(db) };
}

function addShift(db: AndroidDatabase, localId: string, backendId: string, openingCash = 1000) {
  const binding = { serverUrl, salonId, machineId, backendShiftId: backendId };
  db.run(`INSERT INTO shifts (id,backend_id,backend_binding_json,staff_id,staff_name,opening_cash,opened_at)
    VALUES (?,?,?,?,?,?,?)`, [localId, backendId, JSON.stringify(binding), operatorId, 'Owner', openingCash, '2026-09-08T08:00:00.000Z']);
}

function addOrder(db: AndroidDatabase, input: {
  localId: string;
  backendId: string;
  shiftId: string;
  total: number;
  tenders: Tender[];
  refundAmount?: number;
  converted?: boolean;
}) {
  const paymentTenders = input.tenders.map(row => ({ method: row.method, amount: row.amountMinor }));
  const context = input.converted ? {
    serverUrl,
    salonId,
    machineId,
    backendOrderId: input.backendId,
    originalTenderCapacities: [...input.tenders].sort((a, b) => a.method.localeCompare(b.method)),
  } : null;
  db.run(`INSERT INTO orders (id,backend_id,shift_id,status,total,payment_method,payment_tenders,payment_amount,
    change_amount,refund_amount,refund_event_context_json,synced,source,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [input.localId, input.backendId, input.shiftId,
    input.refundAmount ? 'PARTIAL_REFUND' : 'COMPLETED', input.total,
    input.tenders.length > 1 ? 'SPLIT' : input.tenders[0].method, JSON.stringify(paymentTenders), input.total,
    0, input.refundAmount ?? 0, context ? JSON.stringify(context) : null, 1, 'POS', '2026-09-08T08:15:00.000Z']);
}

function refundEvent(input: {
  request: number;
  localOrderId: string;
  backendOrderId: string;
  localShiftId: string;
  backendShiftId: string;
  allocations: Tender[];
  occurredAt?: string;
}) {
  const delta = input.allocations.reduce((sum, row) => sum + row.amountMinor, 0);
  const event = {
    schemaVersion: 1,
    refundRequestId: id(input.request),
    orderId: input.backendOrderId,
    salonId,
    shiftId: input.backendShiftId,
    machineId,
    operatorId,
    occurredAt: input.occurredAt ?? '2026-09-08T10:00:00.000Z',
    deltaAmountMinor: delta,
    tenderAllocations: input.allocations,
  };
  return {
    requestId: event.refundRequestId,
    localOrderId: input.localOrderId,
    localShiftId: input.localShiftId,
    event,
    values: [event.refundRequestId, serverUrl, salonId, input.localOrderId, input.backendOrderId,
      input.localShiftId, input.backendShiftId, machineId, operatorId, event.occurredAt, delta, JSON.stringify(event)],
  };
}

function insertEvent(db: AndroidDatabase, fixture: ReturnType<typeof refundEvent>) {
  const { occurredAt: _serverTimestamp, ...frozenEvent } = fixture.event;
  const order = db.get<any>('SELECT * FROM orders WHERE id = ?', [fixture.localOrderId]);
  const priorEvents = db.all<any>('SELECT delta_amount_minor FROM pos_refund_events WHERE local_order_id = ?', [fixture.localOrderId]);
  const alreadyRefunded = priorEvents.reduce((sum, row) => sum + row.delta_amount_minor, 0);
  const cumulative = alreadyRefunded + fixture.event.deltaAmountMinor;
  const orderItemId = id(900 + Number(fixture.requestId.slice(-3)));
  const authority = {
    backendOrderId: fixture.event.orderId,
    requestId: fixture.requestId,
    orderTotalGrosze: order.total,
    alreadyRefundedGrosze: alreadyRefunded,
    expectedDeltaGrosze: fixture.event.deltaAmountMinor,
    items: [{ orderItemId, quantity: 1, restock: false }],
  };
  const originalTenderCapacities = [...JSON.parse(order.refund_event_context_json).originalTenderCapacities]
    .sort((a: Tender, b: Tender) => a.method.localeCompare(b.method));
  const payload = {
    refundEventVersion: 1,
    machineId,
    refundRequestId: fixture.requestId,
    shiftId: fixture.event.shiftId,
    type: cumulative === order.total ? 'FULL' : 'PARTIAL',
    amount: fixture.event.deltaAmountMinor / 100,
    items: authority.items,
    tenderAllocations: fixture.event.tenderAllocations.map(row => ({ method: row.method, amount: row.amountMinor / 100 })),
    reason: 'Report fixture',
  };
  const canonicalLine = {
    orderItemId,
    refundRequestId: fixture.requestId,
    quantity: 1,
    unit: 'szt',
    saleUnit: 'szt',
    unitPrice: fixture.event.deltaAmountMinor,
    refundAmount: fixture.event.deltaAmountMinor,
    restock: false,
  };
  const priorLines = JSON.parse(order.refund_lines ?? '[]');
  const response = {
    success: true,
    orderId: fixture.event.orderId,
    refundRequestId: fixture.requestId,
    refundAmount: fixture.event.deltaAmountMinor / 100,
    totalRefundedAmount: cumulative / 100,
    status: cumulative === order.total ? 'REFUNDED' : 'PARTIAL_REFUND',
    refundedLines: [{ ...canonicalLine, unitPrice: fixture.event.deltaAmountMinor / 100,
      refundAmount: fixture.event.deltaAmountMinor / 100 }],
    refundEvent: fixture.event,
  };
  db.run(`INSERT INTO pos_refund_events (request_id,server_url,salon_id,local_order_id,backend_order_id,
    local_shift_id,backend_shift_id,machine_id,operator_id,occurred_at,delta_amount_minor,event_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, fixture.values);
  db.run(`INSERT INTO pos_refund_attempts (request_id,scope_key,local_order_id,backend_order_id,shift_id,payload_json,
    expected_json,status,response_json,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    fixture.requestId,
    JSON.stringify([serverUrl, salonId, operatorId]),
    fixture.localOrderId,
    fixture.event.orderId,
    fixture.localShiftId,
    JSON.stringify(payload),
    JSON.stringify({ protocolVersion: 1, authority, event: frozenEvent, originalTenderCapacities,
      localFingerprint: '[]', inputJson: '{}', priorRefundLines: priorLines }),
    'CONFIRMED',
    JSON.stringify(response),
    null,
    fixture.event.occurredAt,
    fixture.event.occurredAt,
  ]);
  db.run('UPDATE orders SET refund_lines = ? WHERE id = ?', [JSON.stringify([...priorLines, canonicalLine]), fixture.localOrderId]);
}

function expectOpenAndUnfinalized(db: AndroidDatabase, shiftId: string, before: unknown) {
  expect(db.get('SELECT * FROM shifts WHERE id = ?', [shiftId])).toEqual(before);
  expect(db.get<any>('SELECT closed_at,closing_cash,close_report_json FROM shifts WHERE id = ?', [shiftId])).toEqual({
    closed_at: null,
    closing_cash: null,
    close_report_json: null,
  });
}

describe('Android event-aware shift close reports', () => {
  it('uses only events assigned to the closing shift instead of a converted order cumulative refund projection', async () => {
    const { db, repo } = await setup();
    const shiftId = id(1); const backendShiftId = id(2); const otherShiftId = id(3); const otherBackendShiftId = id(4);
    const orderId = id(10); const backendOrderId = id(11);
    addShift(db, shiftId, backendShiftId); addShift(db, otherShiftId, otherBackendShiftId);
    addOrder(db, { localId: orderId, backendId: backendOrderId, shiftId, total: 10000,
      tenders: [{ method: 'CASH', amountMinor: 9000 }, { method: 'CARD', amountMinor: 1000 }],
      refundAmount: 3000, converted: true });
    insertEvent(db, refundEvent({ request: 20, localOrderId: orderId, backendOrderId, localShiftId: shiftId,
      backendShiftId, allocations: [{ method: 'CASH', amountMinor: 700 }, { method: 'CARD', amountMinor: 300 }] }));
    insertEvent(db, refundEvent({ request: 21, localOrderId: orderId, backendOrderId, localShiftId: otherShiftId,
      backendShiftId: otherBackendShiftId, occurredAt: '2026-09-08T11:00:00.000Z',
      allocations: [{ method: 'CASH', amountMinor: 1800 }, { method: 'CARD', amountMinor: 200 }] }));

    const report = repo.closeShift(shiftId, 9300);

    expect(report).toMatchObject({ totalSales: 9000, totalRefunds: 1000, cashTotal: 8300, cardTotal: 700, difference: 0 });
  });

  it('charges a canonical refund exactly once to its local refund shift even when the sale belongs to another shift', async () => {
    const { db, repo } = await setup();
    const saleShiftId = id(30); const saleBackendShiftId = id(31); const refundShiftId = id(32); const refundBackendShiftId = id(33);
    const oldOrderId = id(34); const oldBackendOrderId = id(35);
    addShift(db, saleShiftId, saleBackendShiftId); addShift(db, refundShiftId, refundBackendShiftId);
    addOrder(db, { localId: oldOrderId, backendId: oldBackendOrderId, shiftId: saleShiftId, total: 5000,
      tenders: [{ method: 'CARD', amountMinor: 5000 }], refundAmount: 600, converted: true });
    addOrder(db, { localId: id(36), backendId: id(37), shiftId: refundShiftId, total: 2000,
      tenders: [{ method: 'CASH', amountMinor: 2000 }] });
    insertEvent(db, refundEvent({ request: 38, localOrderId: oldOrderId, backendOrderId: oldBackendOrderId,
      localShiftId: refundShiftId, backendShiftId: refundBackendShiftId,
      allocations: [{ method: 'CARD', amountMinor: 600 }] }));

    const report = repo.closeShift(refundShiftId, 3000);

    expect(report).toMatchObject({ totalOrders: 1, totalSales: 1400, totalRefunds: 600,
      cashTotal: 2000, cardTotal: -600, difference: 0 });
  });

  it('subtracts exact CASH, CARD, BLIK and BANK_TRANSFER event allocations without reallocating them', async () => {
    const { db, repo } = await setup();
    const saleShiftId = id(40); const refundShiftId = id(41); const refundBackendShiftId = id(42);
    const oldOrderId = id(43); const oldBackendOrderId = id(44);
    addShift(db, saleShiftId, id(45)); addShift(db, refundShiftId, refundBackendShiftId);
    addOrder(db, { localId: oldOrderId, backendId: oldBackendOrderId, shiftId: saleShiftId, total: 10000,
      tenders: [{ method: 'CASH', amountMinor: 7000 }, { method: 'CARD', amountMinor: 1000 },
        { method: 'BLIK', amountMinor: 1000 }, { method: 'BANK_TRANSFER', amountMinor: 1000 }],
      refundAmount: 1000, converted: true });
    addOrder(db, { localId: id(46), backendId: id(47), shiftId: refundShiftId, total: 16000,
      tenders: [{ method: 'CASH', amountMinor: 4000 }, { method: 'CARD', amountMinor: 4000 },
        { method: 'BLIK', amountMinor: 4000 }, { method: 'BANK_TRANSFER', amountMinor: 4000 }] });
    insertEvent(db, refundEvent({ request: 48, localOrderId: oldOrderId, backendOrderId: oldBackendOrderId,
      localShiftId: refundShiftId, backendShiftId: refundBackendShiftId,
      allocations: [{ method: 'CASH', amountMinor: 100 }, { method: 'CARD', amountMinor: 200 },
        { method: 'BLIK', amountMinor: 300 }, { method: 'BANK_TRANSFER', amountMinor: 400 }] }));

    const report = repo.closeShift(refundShiftId, 4900);

    expect(report).toMatchObject({ totalSales: 15000, totalRefunds: 1000, cashTotal: 3900,
      cardTotal: 3800, blikTotal: 3700, transferTotal: 3600, difference: 0 });
  });

  it('fails closed when an earlier response and final audit are changed but the next frozen prior audit is unchanged', async () => {
    const { db, repo } = await setup();
    const shiftId = id(49); const backendShiftId = id(50); const orderId = id(51); const backendOrderId = id(52);
    addShift(db, shiftId, backendShiftId);
    addOrder(db, { localId: orderId, backendId: backendOrderId, shiftId, total: 1000,
      tenders: [{ method: 'CASH', amountMinor: 1000 }], refundAmount: 1000, converted: true });
    const first = refundEvent({ request: 53, localOrderId: orderId, backendOrderId, localShiftId: shiftId,
      backendShiftId, allocations: [{ method: 'CASH', amountMinor: 400 }] });
    const second = refundEvent({ request: 54, localOrderId: orderId, backendOrderId, localShiftId: shiftId,
      backendShiftId, occurredAt: '2026-09-08T11:00:00.000Z', allocations: [{ method: 'CASH', amountMinor: 600 }] });
    insertEvent(db, first); insertEvent(db, second);

    const firstAttempt = db.get<any>('SELECT response_json FROM pos_refund_attempts WHERE request_id = ?', [first.requestId]);
    const response = JSON.parse(firstAttempt.response_json);
    response.refundedLines[0].name = 'Tampered line';
    db.run('UPDATE pos_refund_attempts SET response_json = ? WHERE request_id = ?', [JSON.stringify(response), first.requestId]);
    const audit = JSON.parse(db.get<any>('SELECT refund_lines FROM orders WHERE id = ?', [orderId]).refund_lines);
    audit.find((line: any) => line.refundRequestId === first.requestId).name = 'Tampered line';
    db.run('UPDATE orders SET refund_lines = ? WHERE id = ?', [JSON.stringify(audit), orderId]);
    const before = db.get('SELECT * FROM shifts WHERE id = ?', [shiftId]);

    expect(() => repo.closeShift(shiftId, 1000)).toThrow('ANDROID_REFUND_EVENT_REPORT_INVALID');
    expectOpenAndUnfinalized(db, shiftId, before);
  });

  it.each([
    ['malformed JSON', (db: AndroidDatabase, requestId: string) => db.run(
      'UPDATE pos_refund_events SET event_json = ? WHERE request_id = ?', ['not-json', requestId])],
    ['tampered row amount', (db: AndroidDatabase, requestId: string) => db.run(
      'UPDATE pos_refund_events SET delta_amount_minor = delta_amount_minor + 1 WHERE request_id = ?', [requestId])],
    ['allocation sum mismatch', (db: AndroidDatabase, requestId: string) => {
      const row = db.get<any>('SELECT event_json FROM pos_refund_events WHERE request_id = ?', [requestId]);
      const event = JSON.parse(row.event_json); event.tenderAllocations[0].amountMinor -= 1;
      db.run('UPDATE pos_refund_events SET event_json = ? WHERE request_id = ?', [JSON.stringify(event), requestId]);
    }],
    ['unsupported OTHER allocation', (db: AndroidDatabase, requestId: string) => {
      const row = db.get<any>('SELECT event_json FROM pos_refund_events WHERE request_id = ?', [requestId]);
      const event = JSON.parse(row.event_json); event.tenderAllocations = [{ method: 'OTHER', amountMinor: event.deltaAmountMinor }];
      db.run('UPDATE pos_refund_events SET event_json = ? WHERE request_id = ?', [JSON.stringify(event), requestId]);
    }],
    ['coordinated event copies that disagree with frozen request authority', (db: AndroidDatabase, requestId: string) => {
      const row = db.get<any>('SELECT event_json FROM pos_refund_events WHERE request_id = ?', [requestId]);
      const event = JSON.parse(row.event_json);
      event.deltaAmountMinor = 900;
      event.tenderAllocations = [{ method: 'CARD', amountMinor: 900 }];
      const attempt = db.get<any>('SELECT expected_json,response_json,local_order_id FROM pos_refund_attempts WHERE request_id = ?', [requestId]);
      const expected = JSON.parse(attempt.expected_json); expected.event = { ...event }; delete expected.event.occurredAt;
      const response = JSON.parse(attempt.response_json); response.refundEvent = event;
      db.run('UPDATE pos_refund_events SET delta_amount_minor = ?, event_json = ? WHERE request_id = ?', [900, JSON.stringify(event), requestId]);
      db.run('UPDATE pos_refund_attempts SET expected_json = ?, response_json = ? WHERE request_id = ?',
        [JSON.stringify(expected), JSON.stringify(response), requestId]);
      db.run("UPDATE orders SET refund_amount = 900, status = 'PARTIAL_REFUND' WHERE id = ?", [attempt.local_order_id]);
    }],
  ] as const)('fails closed for %s and leaves the shift unfinalized', async (_name, corrupt) => {
    const { db, repo } = await setup();
    const saleShiftId = id(50); const refundShiftId = id(51); const refundBackendShiftId = id(52);
    const orderId = id(53); const backendOrderId = id(54);
    addShift(db, saleShiftId, id(55)); addShift(db, refundShiftId, refundBackendShiftId);
    addOrder(db, { localId: orderId, backendId: backendOrderId, shiftId: saleShiftId, total: 1000,
      tenders: [{ method: 'CASH', amountMinor: 1000 }], refundAmount: 400, converted: true });
    const fixture = refundEvent({ request: 56, localOrderId: orderId, backendOrderId, localShiftId: refundShiftId,
      backendShiftId: refundBackendShiftId, allocations: [{ method: 'CASH', amountMinor: 400 }] });
    insertEvent(db, fixture); corrupt(db, fixture.requestId);
    const before = db.get('SELECT * FROM shifts WHERE id = ?', [refundShiftId]);

    let failure: unknown;
    try { repo.closeShift(refundShiftId, 1000); } catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('ANDROID_REFUND_EVENT_REPORT_INVALID');
    expectOpenAndUnfinalized(db, refundShiftId, before);
  });

  it('preserves cumulative proportional refund accounting for an unconverted legacy order', async () => {
    const { db, repo } = await setup();
    const shiftId = id(60); addShift(db, shiftId, id(61), 100);
    addOrder(db, { localId: id(62), backendId: id(63), shiftId, total: 1000,
      tenders: [{ method: 'CASH', amountMinor: 600 }, { method: 'CARD', amountMinor: 400 }], refundAmount: 500 });

    const report = repo.closeShift(shiftId, 400);

    expect(report).toMatchObject({ totalSales: 500, totalRefunds: 500, cashTotal: 300, cardTotal: 200, difference: 0 });
  });

  it('returns the finalized snapshot byte-for-byte without recomputing changed orders or events', async () => {
    const { db, repo } = await setup();
    const saleShiftId = id(70); const refundShiftId = id(71); const refundBackendShiftId = id(72);
    const orderId = id(73); const backendOrderId = id(74); const currentOrderId = id(75);
    addShift(db, saleShiftId, id(76)); addShift(db, refundShiftId, refundBackendShiftId);
    addOrder(db, { localId: orderId, backendId: backendOrderId, shiftId: saleShiftId, total: 1000,
      tenders: [{ method: 'CARD', amountMinor: 1000 }], refundAmount: 250, converted: true });
    addOrder(db, { localId: currentOrderId, backendId: id(77), shiftId: refundShiftId, total: 2000,
      tenders: [{ method: 'CASH', amountMinor: 2000 }] });
    const fixture = refundEvent({ request: 78, localOrderId: orderId, backendOrderId, localShiftId: refundShiftId,
      backendShiftId: refundBackendShiftId, allocations: [{ method: 'CARD', amountMinor: 250 }] });
    insertEvent(db, fixture);
    const report = repo.closeShift(refundShiftId, 3000);
    const snapshot = db.get<any>('SELECT close_report_json FROM shifts WHERE id = ?', [refundShiftId]).close_report_json;
    db.run('UPDATE orders SET total = 999999, payment_method = ? WHERE id = ?', ['BLIK', currentOrderId]);
    db.run('UPDATE pos_refund_events SET event_json = ? WHERE request_id = ?', ['not-json', fixture.requestId]);

    expect(repo.closeShift(refundShiftId, -1)).toEqual(report);
    expect(repo.getClosedShiftReport(refundShiftId)).toEqual(report);
    expect(db.get<any>('SELECT close_report_json FROM shifts WHERE id = ?', [refundShiftId]).close_report_json).toBe(snapshot);
  });

  it('enforces replay uniqueness and reports the surviving canonical fact only once', async () => {
    const { db, repo } = await setup();
    const saleShiftId = id(80); const refundShiftId = id(81); const refundBackendShiftId = id(82);
    const orderId = id(83); const backendOrderId = id(84);
    addShift(db, saleShiftId, id(85)); addShift(db, refundShiftId, refundBackendShiftId);
    addOrder(db, { localId: orderId, backendId: backendOrderId, shiftId: saleShiftId, total: 1000,
      tenders: [{ method: 'BLIK', amountMinor: 1000 }], refundAmount: 300, converted: true });
    const fixture = refundEvent({ request: 86, localOrderId: orderId, backendOrderId, localShiftId: refundShiftId,
      backendShiftId: refundBackendShiftId, allocations: [{ method: 'BLIK', amountMinor: 300 }] });
    insertEvent(db, fixture);

    expect(() => insertEvent(db, fixture)).toThrow(/UNIQUE constraint failed/i);
    expect(db.all('SELECT * FROM pos_refund_events WHERE request_id = ?', [fixture.requestId])).toHaveLength(1);
    expect(repo.closeShift(refundShiftId, 1000)).toMatchObject({ totalRefunds: 300, blikTotal: -300, totalSales: -300 });
  });
});
