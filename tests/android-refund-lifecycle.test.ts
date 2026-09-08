import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealTransport } from '../src/renderer/android-pos/shim/real-transport';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { TokenStore } from '../src/renderer/android-pos/shim/token-store';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { createRefundAttemptRepo } from '../src/renderer/android-pos/shim/db/refund-attempt-repo';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const apiUrl = 'https://refund-lifecycle.invalid';
const userId = 'owner-a'; const salonId = 'salon-a';
const localShift = '11111111-1111-4111-8111-111111111111';
const backendShift = '22222222-2222-4222-8222-222222222222';
const backendOrder = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const localOrder = '55555555-5555-4555-8555-555555555555';
const serverItem = '66666666-6666-4666-8666-666666666666';
const storage = () => { const values = new Map<string, string>(); return {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); },
}; };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const loginBody = (user = userId, salon = salonId) => ({ access_token: `token-${user}`, refresh_token: 'refresh',
  user: { id: user, email: `${user}@example.invalid`, role: 'OWNER', salonId: salon, salon: { id: salon, name: 'Test', slug: salon } } });
const detail = () => ({ id: backendOrder, salonId, status: 'COMPLETED', posMode: 'restaurant',
  createdAt: '2026-09-08T10:00:00Z', subtotal: '10.00', taxAmount: '0', discountAmount: '0', total: '10.00',
  paidAmount: '10.00', paymentMethod: 'CASH', refundAmount: '0', items: [{ id: serverItem, orderId: backendOrder,
    productId: 'tea', productName: 'Tea', sellBy: 'PIECE', saleUnit: 'szt', totalUnits: 1,
    unitPrice: '10.00', totalPrice: '10.00', grossUnitPrice: '10.00', grossTotalPrice: '10.00', taxRate: 0 }] });
const refundDto = () => ({ type: 'FULL' as const, refundRequestId: requestId, amount: 1000,
  lines: [{ orderItemId: serverItem, quantity: 1, unitPrice: 1000, refundAmount: 1000, restock: false, unit: 'szt' }] });
const confirmed = () => ({ success: true, orderId: backendOrder, refundRequestId: requestId,
  status: 'REFUNDED', refundAmount: 10, totalRefundedAmount: 10, refundedLines: [{ orderItemId: serverItem,
    refundRequestId: requestId, quantity: 1, unit: 'szt', saleUnit: 'szt', unitPrice: 10, refundAmount: 10, restock: false }] });
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(seedSale = false) {
  const persistence = new MemoryAndroidPersistence();
  const configStore = new ShimConfigStore({ storage: storage(), seed: { apiUrl, salonId,
    authUser: { id: userId, salonId, role: 'OWNER', email: 'owner@example.invalid' } } as any });
  const tokenStore = new TokenStore({ storage: storage(), allowInsecureFallback: true });
  await tokenStore.setTokens('original-token', 'original-refresh');
  const transport = createRealTransport({ configStore, tokenStore, dbInit: { locateFile: null, persistence }, agentConnection: {
    connect: async () => ({ connected: false, reason: 'no-key' as const }), disconnect: async () => {},
    isConnected: () => false, getPushedJobStatus: () => null, onJobStatus: () => () => {},
  } });
  const db = await transport.getRestaurantDatabase!();
  if (seedSale) {
    db.run('INSERT INTO shifts (id, staff_id, staff_name, opening_cash, opened_at, backend_id) VALUES (?, ?, ?, 0, ?, ?)',
      [localShift, userId, 'Owner', '2026-09-08T09:00:00Z', backendShift]);
    db.run(`INSERT INTO orders (id, order_number, status, subtotal, discount, tax, total, payment_method, payment_amount,
      change_amount, shift_id, source, synced, backend_id, mode) VALUES (?, 'LOCAL-1', 'COMPLETED', 1000, 0, 0, 1000, 'CASH', 1000, 0, ?, 'POS', 1, ?, 'restaurant')`,
      [localOrder, localShift, backendOrder]);
    db.run("INSERT INTO order_items (id, order_id, variant_id, name, price, quantity, total, vat_rate) VALUES ('local-item', ?, 'tea', 'Tea', 1000, 1, 1000, 0)", [localOrder]);
    await db.flush();
  }
  return { transport, db, persistence, configStore, tokenStore };
}
function seedPending(db: Awaited<ReturnType<typeof setup>>['db'], status: 'PREPARED' | 'UNKNOWN' = 'UNKNOWN') {
  const repo = createRefundAttemptRepo(db);
  repo.prepare({ request_id: requestId, scope_key: JSON.stringify([apiUrl, salonId, userId]), local_order_id: localOrder,
    backend_order_id: backendOrder, shift_id: localShift, payload_json: '{}', expected_json: '{}' });
  if (status === 'UNKNOWN') repo.markUnknown(requestId);
}

describe('Android real transport refund lifecycle boundaries', () => {
  it.each(['id', 'shiftId'])('durably stores backend shift mapping from %s and restores it after reopen', async field => {
    const { transport, db, persistence } = await setup();
    fetchMock.mockResolvedValue(response({ [field]: backendShift }));
    const opened = await transport.openShift!({ staffId: userId, staffName: 'Owner', openingCash: 0 });
    expect(opened.success).toBe(true);
    await vi.waitFor(() => expect(db.get<any>('SELECT backend_id FROM shifts WHERE id = ?', [opened.shiftId])?.backend_id).toBe(backendShift));
    await db.flush();
    const restored = await initAndroidDb({ locateFile: null, persistence });
    expect(restored.get<any>('SELECT backend_id FROM shifts WHERE id = ?', [opened.shiftId])?.backend_id).toBe(backendShift);
  });
  it.each([{}, { id: 'bad-id' }, { shiftId: null }, { id: backendShift, shiftId: backendOrder }, { id: backendShift, salonId: 'wrong-salon' }])('keeps malformed backend mapping null: %j', async body => {
    const { transport, db } = await setup(); fetchMock.mockResolvedValue(response(body));
    const opened = await transport.openShift!({ staffId: userId, staffName: 'Owner', openingCash: 0 });
    await new Promise(resolve => setTimeout(resolve, 15)); await db.flush();
    expect(db.get<any>('SELECT backend_id FROM shifts WHERE id = ?', [opened.shiftId])?.backend_id).toBeNull();
  });
  it.each(['token', 'config'])('does not bind a late open-shift mapping after %s changes', async change => {
    const { transport, db, tokenStore, configStore } = await setup();
    let finish!: (value: Response) => void; fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const opened = await transport.openShift!({ staffId: userId, staffName: 'Owner', openingCash: 0 });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (change === 'token') await tokenStore.setTokens('different-token', 'refresh');
    else configStore.setConfig({ salonName: 'Changed context' });
    finish(response({ id: backendShift })); await new Promise(resolve => setTimeout(resolve, 15));
    expect(db.get<any>('SELECT backend_id FROM shifts WHERE id = ?', [opened.shiftId])?.backend_id).toBeNull();
  });
  it.each(['PREPARED', 'UNKNOWN'] as const)('blocks close and ghost-close before HTTP with a %s refund', async status => {
    const { transport, db } = await setup(true); seedPending(db, status); await db.flush();
    for (const shiftId of [localShift, 'ghost-shift']) {
      expect(await transport.closeShift!({ shiftId, closingCash: 0 })).toMatchObject({ success: false, error: expect.stringContaining('pending refund') });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.get<any>('SELECT closed_at FROM shifts WHERE id = ?', [localShift])?.closed_at).toBeNull();
  });
  it.each([['other-owner', salonId], [userId, 'other-salon']])('refuses different pending-account login %s/%s without replacing tokens or data', async (user, salon) => {
    const { transport, db, configStore, tokenStore } = await setup(true); seedPending(db); await db.flush();
    const before = configStore.getRawConfig(); fetchMock.mockResolvedValue(response(loginBody(user, salon)));
    expect(await transport.loginWithEmail!('user@example.invalid', 'test')).toMatchObject({ success: false, error: expect.stringContaining('original refund account') });
    expect(configStore.getRawConfig()).toBe(before); expect(await tokenStore.getAccessToken()).toBe('original-token');
    expect(db.get<any>('SELECT id FROM orders WHERE id = ?', [localOrder])?.id).toBe(localOrder);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('allows original-account reauthentication after logout while preserving its pending attempt', async () => {
    const { transport, db, tokenStore } = await setup(true); seedPending(db); await db.flush();
    expect(await transport.logout!()).toMatchObject({ success: true });
    fetchMock.mockImplementation((url: string) => Promise.resolve(response(String(url).endsWith('/auth/login')
      ? loginBody() : { salonId, features: {} })));
    expect(await transport.loginWithEmail!('owner@example.invalid', 'test')).toMatchObject({ success: true });
    expect(await tokenStore.getAccessToken()).toBe(`token-${userId}`);
    expect(db.get<any>('SELECT status FROM pos_refund_attempts WHERE request_id = ?', [requestId])?.status).toBe('UNKNOWN');
  });
  it('reserves session, shift and sale transitions during refund HTTP, then releases after confirmation', async () => {
    const { transport, db } = await setup(true);
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation((url: string) => String(url).endsWith('/refund')
      ? new Promise<Response>(resolve => { finish = resolve; })
      : Promise.resolve(response(detail())));
    const pending = transport.refundOrder!(localOrder, refundDto());
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    try {
      const callsBefore = fetchMock.mock.calls.length;
      const operations = [
        () => transport.loginWithEmail!('owner@example.invalid', 'test'), () => transport.logout!(),
        () => transport.openShift!({ staffId: userId, staffName: 'Owner', openingCash: 0 }),
        () => transport.closeShift!({ shiftId: localShift, closingCash: 0 }),
        () => transport.createOrder!({} as any),
      ];
      for (const operation of operations) expect(await operation()).toMatchObject({ success: false, error: expect.stringContaining('financial operation') });
      expect(fetchMock).toHaveBeenCalledTimes(callsBefore);
    } finally { finish(response(confirmed())); }
    expect(await pending).toMatchObject({ success: true });
    expect(db.get<any>('SELECT status FROM pos_refund_attempts WHERE request_id = ?', [requestId])?.status).toBe('CONFIRMED');
    fetchMock.mockResolvedValue(response({ success: true }));
    expect(await transport.closeShift!({ shiftId: localShift, closingCash: 0 })).toMatchObject({ success: true });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith(`/pos/shifts/${backendShift}/close`))).toBe(true));
    expect(await transport.logout!()).toMatchObject({ success: true });
  });
  it('does not open another local or server shift when one is already active', async () => {
    const { transport, db } = await setup(true);
    expect(await transport.openShift!({ staffId: userId, staffName: 'Owner', openingCash: 0 })).toMatchObject({ success: false, error: expect.stringContaining('already open') });
    expect(db.all('SELECT * FROM shifts')).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['open', 'close'] as const)('latches a failed %s save before HTTP and preserves the last durable shift after restart', async action => {
    const { transport, db, persistence, configStore, tokenStore } = await setup(action === 'close');
    db.markDirty(); // Persist the empty fresh schema as the pre-open restart image.
    await db.flush();
    const durableBefore = persistence.image!.slice();
    const configBefore = configStore.getRawConfig();
    persistence.failSave = true;
    const result = action === 'open'
      ? await transport.openShift!({ staffId: userId, staffName: 'Owner', openingCash: 0 })
      : await transport.closeShift!({ shiftId: localShift, closingCash: 1000 });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Shift storage failed') });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistence.image).toEqual(durableBefore);

    // Even if storage becomes writable again, the in-memory transition is not
    // trustworthy until restart. In particular, a retry must not ghost-close.
    persistence.failSave = false;
    const operations = [
      () => transport.closeShift!({ shiftId: localShift, closingCash: 0 }),
      () => transport.closeShift!({ shiftId: 'ghost-shift', closingCash: 0 }),
      () => transport.openShift!({ staffId: userId, staffName: 'Owner', openingCash: 0 }),
      () => transport.createOrder!({} as any),
      () => transport.loginWithEmail!('owner@example.invalid', 'test'),
      () => transport.logout!(),
    ];
    for (const operation of operations) {
      expect(await operation()).toMatchObject({ success: false, error: expect.stringContaining('Shift storage failed') });
    }
    expect(await transport.refundOrder!(localOrder, refundDto())).toMatchObject({ success: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(configStore.getRawConfig()).toBe(configBefore);
    expect(await tokenStore.getAccessToken()).toBe('original-token');
    expect(db.all('SELECT * FROM pos_refund_attempts')).toHaveLength(0);
    expect(persistence.image).toEqual(durableBefore);

    const restored = await initAndroidDb({ locateFile: null, persistence });
    if (action === 'open') {
      expect(restored.all('SELECT * FROM shifts')).toHaveLength(0);
    } else {
      expect(restored.all('SELECT * FROM shifts')).toHaveLength(1);
      expect(restored.get<any>('SELECT closed_at, backend_id FROM shifts WHERE id = ?', [localShift]))
        .toMatchObject({ closed_at: null, backend_id: backendShift });
      expect(restored.get<any>('SELECT status, total FROM orders WHERE id = ?', [localOrder]))
        .toMatchObject({ status: 'COMPLETED', total: 1000 });
    }
  });
  it('waits for durable close storage before dispatching backend close or reporting success', async () => {
    const { transport, db, persistence } = await setup(true);
    const durableBefore = persistence.image!.slice();
    const saveImage = persistence.saveImage.bind(persistence);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const save = vi.spyOn(persistence, 'saveImage').mockImplementationOnce(async image => {
      await barrier;
      await saveImage(image);
    });
    fetchMock.mockResolvedValue(response({ success: true }));
    let settled = false;
    const closing = transport.closeShift!({ shiftId: localShift, closingCash: 1000 })
      .then(result => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(db.get<any>('SELECT closed_at FROM shifts WHERE id = ?', [localShift])?.closed_at).not.toBeNull();
      expect(settled).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(persistence.image).toEqual(durableBefore);
    } finally { release(); }
    expect(await closing).toMatchObject({ success: true });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith(`/pos/shifts/${backendShift}/close`))).toBe(true));
    const restored = await initAndroidDb({ locateFile: null, persistence });
    expect(restored.get<any>('SELECT closed_at FROM shifts WHERE id = ?', [localShift])?.closed_at).not.toBeNull();
  });
  it('latches a failed late backend mapping save without pretending the already dispatched open was undone', async () => {
    const { transport, db, persistence } = await setup();
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const opened = await transport.openShift!({ staffId: userId, staffName: 'Owner', openingCash: 0 });
    expect(opened.success).toBe(true);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const durableBefore = persistence.image!.slice();
    persistence.failSave = true;
    const save = vi.spyOn(persistence, 'saveImage');
    finish(response({ id: backendShift }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await expect(save.mock.results[0].value).rejects.toThrow('Test storage write failed');
    expect(db.get<any>('SELECT backend_id FROM shifts WHERE id = ?', [opened.shiftId])?.backend_id).toBe(backendShift);
    expect(await transport.closeShift!({ shiftId: opened.shiftId!, closingCash: 0 }))
      .toMatchObject({ success: false, error: expect.stringContaining('Shift storage failed') });
    expect(await transport.createOrder!({} as any))
      .toMatchObject({ success: false, error: expect.stringContaining('Shift storage failed') });
    expect(fetchMock).toHaveBeenCalledTimes(1); // Only the original server open, never a compensating close.
    expect(persistence.image).toEqual(durableBefore);
    persistence.failSave = false;
    const restored = await initAndroidDb({ locateFile: null, persistence });
    expect(restored.get<any>('SELECT closed_at, backend_id FROM shifts WHERE id = ?', [opened.shiftId]))
      .toMatchObject({ closed_at: null, backend_id: null });
  });
});
