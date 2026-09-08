import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore } from '../src/renderer/android-pos/shim/token-store';
import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { createRefundAttemptRepo } from '../src/renderer/android-pos/shim/db/refund-attempt-repo';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const apiUrl = 'https://shift-report.invalid';
const shiftId = '11111111-1111-4111-8111-111111111111';
const backendShiftId = '22222222-2222-4222-8222-222222222222';
const orderId = '33333333-3333-4333-8333-333333333333';
const backendOrderId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const databases: AndroidDatabase[] = [];
const fetchMock = vi.fn();
const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
};
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ success: true }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  for (const db of databases.splice(0)) { try { await db.flush(); } catch {} }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function setup(persistence = new MemoryAndroidPersistence(), seed = true) {
  const configStore = new ShimConfigStore({ storage: storage(), seed: {
    apiUrl, salonId: 'salon', authUser: { id: 'owner', salonId: 'salon', role: 'OWNER' } as any,
  } });
  const tokenStore = new TokenStore({ storage: storage(), allowInsecureFallback: true });
  await tokenStore.setTokens('test-token', 'test-refresh');
  const transport = createRealTransport({ configStore, tokenStore, dbInit: { locateFile: null, persistence }, agentConnection: {
    connect: async () => ({ connected: false, reason: 'no-key' as const }), disconnect: async () => {},
    isConnected: () => false, getPushedJobStatus: () => null, onJobStatus: () => () => {},
  } });
  const db = await transport.getRestaurantDatabase!(); databases.push(db);
  if (seed) {
    db.run('INSERT INTO shifts (id, staff_id, staff_name, opening_cash, opened_at, backend_id) VALUES (?, ?, ?, ?, ?, ?)',
      [shiftId, 'owner', 'Owner', 200, '2026-09-08T09:00:00Z', backendShiftId]);
    db.run(`INSERT INTO orders (id, order_number, status, subtotal, discount, tax, total, payment_method,
      payment_amount, change_amount, shift_id, source, synced, backend_id, mode)
      VALUES (?, 'SALE-1', 'COMPLETED', 1000, 0, 0, 1000, 'CASH', 1000, 0, ?, 'POS', 1, ?, 'restaurant')`,
      [orderId, shiftId, backendOrderId]);
    await db.flush();
  }
  return { transport, db, persistence };
}
async function closeOnce(transport: Awaited<ReturnType<typeof setup>>['transport']) {
  const result = await transport.closeShift!({ shiftId, closingCash: 1200 });
  expect(result.success, result.error).toBe(true);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  return result;
}

describe('Android immutable close report transport', () => {
  it('persists the close report before backend HTTP or successful completion', async () => {
    const { transport, db, persistence } = await setup();
    const previous = persistence.image!.slice();
    const original = persistence.saveImage.bind(persistence);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const save = vi.spyOn(persistence, 'saveImage').mockImplementationOnce(async image => { await barrier; await original(image); });
    let settled = false;
    const closing = transport.closeShift!({ shiftId, closingCash: 1200 }).then(result => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(db.get<any>('SELECT close_report_json FROM shifts WHERE id = ?', [shiftId])?.close_report_json).toBeTypeOf('string');
      expect(settled).toBe(false); expect(fetchMock).not.toHaveBeenCalled();
      expect(persistence.image).toEqual(previous);
    } finally { release(); }
    const result = await closing;
    expect(result.success).toBe(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const restored = await setup(persistence, false);
    expect(JSON.parse(restored.db.get<any>('SELECT close_report_json FROM shifts WHERE id = ?', [shiftId])!.close_report_json))
      .toEqual(result.report);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/pos/shifts/${backendShiftId}/close`);
  });
  it('returns the same durable report on repeat and restart without another backend close', async () => {
    const { transport, db, persistence } = await setup();
    const first = await closeOnce(transport);
    const stored = db.get<any>('SELECT close_report_json FROM shifts WHERE id = ?', [shiftId])!.close_report_json;
    db.run('UPDATE orders SET total = 9000, refund_amount = 700 WHERE id = ?', [orderId]);
    await db.flush();
    fetchMock.mockClear();
    expect(await transport.closeShift!({ shiftId, closingCash: 999999 })).toEqual(first);
    const restarted = await setup(persistence, false);
    expect(await restarted.transport.closeShift!({ shiftId, closingCash: 1 })).toEqual(first);
    expect(restarted.db.get<any>('SELECT close_report_json, closing_cash FROM shifts WHERE id = ?', [shiftId]))
      .toMatchObject({ close_report_json: stored, closing_cash: 1200 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not treat a known legacy closed shift without a report as an absent ghost', async () => {
    const { transport, db } = await setup();
    db.run("UPDATE shifts SET closed_at = '2026-09-08T10:00:00Z', closing_cash = 1200 WHERE id = ?", [shiftId]);
    await db.flush();
    expect(await transport.closeShift!({ shiftId, closingCash: 5000 })).toEqual({ success: true, report: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.get<any>('SELECT close_report_json, closing_cash FROM shifts WHERE id = ?', [shiftId]))
      .toMatchObject({ close_report_json: null, closing_cash: 1200 });
  });
  it.each(['not-json', '{}'])('rejects corrupt saved report %j without recomputing or sending HTTP', async corrupt => {
    const { transport, db } = await setup();
    await closeOnce(transport);
    expect(db.get<any>('SELECT close_report_json FROM shifts WHERE id = ?', [shiftId])?.close_report_json).toBeTypeOf('string');
    db.run('UPDATE shifts SET close_report_json = ? WHERE id = ?', [corrupt, shiftId]); await db.flush();
    fetchMock.mockClear();
    expect(await transport.closeShift!({ shiftId, closingCash: 9999 })).toMatchObject({ success: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.get<any>('SELECT close_report_json, closing_cash FROM shifts WHERE id = ?', [shiftId]))
      .toMatchObject({ close_report_json: corrupt, closing_cash: 1200 });
  });
  it('does not return even a cached report when its required durability barrier fails', async () => {
    const { transport, db, persistence } = await setup();
    await closeOnce(transport);
    const previous = persistence.image!.slice();
    db.run('UPDATE orders SET total = 9000 WHERE id = ?', [orderId]);
    persistence.failSave = true; fetchMock.mockClear();
    expect(await transport.closeShift!({ shiftId, closingCash: 1200 }))
      .toMatchObject({ success: false, error: expect.stringContaining('Shift storage failed') });
    expect(await transport.closeShift!({ shiftId, closingCash: 1200 }))
      .toMatchObject({ success: false, error: expect.stringContaining('Shift storage failed') });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistence.image).toEqual(previous);
  });
  it.each(['PREPARED', 'UNKNOWN'] as const)('keeps the pending %s refund lock ahead of report reuse', async state => {
    const { transport, db } = await setup();
    await closeOnce(transport);
    const repo = createRefundAttemptRepo(db);
    repo.prepare({ request_id: requestId, scope_key: JSON.stringify([apiUrl, 'salon', 'owner']), local_order_id: orderId,
      backend_order_id: backendOrderId, shift_id: shiftId, payload_json: '{}', expected_json: '{}' });
    if (state === 'UNKNOWN') repo.markUnknown(requestId);
    await db.flush(); fetchMock.mockClear();
    expect(await transport.closeShift!({ shiftId, closingCash: 1200 }))
      .toMatchObject({ success: false, error: expect.stringContaining('pending refund') });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('freezes close inputs before the pending order drain and sends only the original cash value', async () => {
    const { transport, db } = await setup();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const drain = vi.spyOn(transport, 'syncOrders').mockImplementationOnce(async () => { await barrier; return { success: true, synced: 0 }; });
    const input = { shiftId, closingCash: 1200 };
    const closing = transport.closeShift!(input);
    try {
      await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
      input.shiftId = 'wrong-shift'; input.closingCash = 999999;
    } finally { release(); }
    expect(await closing).toMatchObject({ success: true, report: { shiftId, closingCash: 1200 } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/pos/shifts/${backendShiftId}/close`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ closingCash: 1200 });
    expect(db.get<any>('SELECT closing_cash FROM shifts WHERE id = ?', [shiftId])?.closing_cash).toBe(1200);
  });
  it('captures caller-owned inputs before the outer pending-refund check yields', async () => {
    const { transport, db } = await setup();
    const input = { shiftId, closingCash: 1200 };
    const closing = transport.closeShift!(input);
    input.shiftId = 'mutated-before-pending-check'; input.closingCash = 7777;
    expect(await closing).toMatchObject({ success: true, report: { shiftId, closingCash: 1200 } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/pos/shifts/${backendShiftId}/close`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ closingCash: 1200 });
    expect(db.get<any>('SELECT closing_cash FROM shifts WHERE id = ?', [shiftId])?.closing_cash).toBe(1200);
  });
});
