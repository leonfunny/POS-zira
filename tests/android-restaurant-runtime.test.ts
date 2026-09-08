import { afterEach, describe, expect, it, vi } from 'vitest';
import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { installShim, __resetShimForTest, ShimConfigStore } from '../src/renderer/android-pos/shim';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

const databases: AndroidDatabase[] = [];
const storage = () => { const data = new Map<string, string>(); return {
  getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); },
}; };
async function boot(persistence = new MemoryAndroidPersistence(), salonId = 'salon', userId = 'staff', fetchLayout?: () => Promise<unknown>) {
  const db = await initAndroidDb({ locateFile: null, persistence }); databases.push(db);
  const configStore = new ShimConfigStore({ storage: storage(), seed: { posMode: 'restaurant', salonId,
    authUser: { id: userId, salonId, role: 'STAFF', email: 'test@example.invalid', firstName: 'Test', lastName: 'Staff' } as any } });
  const repo = createOrderRepo(db);
  if (!repo.getActiveShift()) repo.openShift('shift', userId, 'Test Staff', 0);
  await db.flush();
  const create = vi.fn(async (order: any, items: any[]) => { const id = repo.create(order, items); await db.flush(); return { success: true, id }; });
  const login = vi.fn(async () => ({ success: true }));
  const installed = installShim({ reinstall: true, configStore, transport: {
    getRestaurantDatabase: async () => db, createOrder: create,
    getRestaurantLayout: fetchLayout,
    loginWithEmail: login, logout: vi.fn(async () => ({ success: true })),
  } });
  expect((await installed.api.pos.dispatch({ type: 'session/open', payload: { shiftId: 'shift', staffId: userId, staffName: 'Test Staff' } })).success).toBe(true);
  return { ...installed, db, repo, persistence, create, login };
}
type Register = Awaited<ReturnType<typeof boot>>;
async function sale(r: Register, tableId: string | null = null) {
  if (tableId) r.db.run('INSERT OR IGNORE INTO pos_tables(salon_id,id,name) VALUES (?,?,?)', [r.configStore.getRawConfig().salonId, tableId, tableId]);
  expect(await r.api.pos.dispatch({ type: 'table/setActive', payload: { tableId, orderType: tableId ? 'dine_in' : 'takeout' } })).toMatchObject({ success: true });
  expect(await r.api.pos.dispatch({ type: 'cart/addItem', payload: {
    id: 'tea-line', variantId: 'tea', name: 'Tea', sku: '', price: 1000, quantity: 1, total: 1000, vatRate: 23, notes: 'No sugar', course: 2,
  } })).toMatchObject({ success: true });
}
async function save(r: Register) {
  const result = await r.api.pos.restaurantChecks.saveCurrent(); expect(result.success, result.error).toBe(true); return result.id as string;
}
async function open(r: Register, id: string) { expect(await r.api.pos.restaurantChecks.open(id)).toMatchObject({ success: true }); }
async function begin(r: Register, id = 'order') {
  const proof = await r.api.pos.payment.preflight(id); expect(proof.success, proof.error).toBe(true);
  expect(await r.api.pos.restaurantChecks.beginPayment(id, proof.token)).toMatchObject({ success: true });
}
function orderPayload(r: Register, id = 'order') {
  const s = r.posStore.getState();
  const order = { id, subtotal: s.cart.subtotal, total: s.cart.total, discount: s.cart.discount, tax: s.cart.tax,
    table_id: s.activeTable, covers: s.activeTable ? r.db.get<{ covers: number }>('SELECT covers FROM pos_tables WHERE id = ?', [s.activeTable])?.covers ?? 0 : 0,
    order_type: s.checkoutDraft.restaurant?.orderType, tip: s.tip, mode: 'restaurant', payment_method: 'CASH',
    payment_amount: s.cart.total, change_amount: 0, shift_id: 'shift', staff_id: 'staff', staff_name: 'Test Staff', source: 'POS' };
  const items = s.cart.items.map(i => ({ id: i.id, order_id: id, variant_id: i.variantId, name: i.name, sku: i.sku, price: i.price,
    quantity: i.quantity, sale_quantity: i.quantity, total: i.total, notes: i.notes, course: i.course, vat_rate: i.vatRate, allocated_discount: i.lineDiscount ?? 0 }));
  return [order, items] as const;
}
afterEach(async () => {
  __resetShimForTest();
  // Stop debounce timers even in tests that deliberately poison persistence.
  for (const db of databases.splice(0)) { try { await db.flush(); } catch {} }
  vi.restoreAllMocks();
});

describe('Android independent restaurant register using the Windows lifecycle', () => {
  const serverTable = { id: 'A', salonId: 'salon', tableNumber: 'Table A', capacity: 4, isActive: true, zone: null,
    status: 'OCCUPIED', currentOrderId: 'another-register-order' };
  it('syncs real layout and retains removed tables only while their local check is unfinished', async () => {
    const fetchLayout = vi.fn().mockResolvedValue([serverTable]);
    const r = await boot(undefined, 'salon', 'staff', fetchLayout);
    expect((await r.api.pos.tables.getActive())[0]).toMatchObject({ id: 'A', status: 'free', current_order_id: null });
    expect(await r.api.pos.tables.getSyncStatus()).toMatchObject({ source: 'server' });
    await sale(r, 'A'); const id = await save(r);
    fetchLayout.mockResolvedValue([]);
    expect((await r.api.pos.tables.getActive())[0]).toMatchObject({ id: 'A', is_active: 0, status: 'occupied', current_order_id: id });
    await open(r, id); await begin(r);
    expect(await r.api.pos.orders.create(...orderPayload(r))).toMatchObject({ success: true });
    expect(await r.api.pos.tables.getActive()).toEqual([]);
    expect(r.db.get('SELECT id FROM pos_tables WHERE id = ?', ['A'])).toBeTruthy();
  });
  it('keeps a removed table visible while an unsaved local cart references it', async () => {
    const fetchLayout = vi.fn().mockResolvedValue([serverTable]);
    const r = await boot(undefined, 'salon', 'staff', fetchLayout);
    await r.api.pos.tables.getActive(); await sale(r, 'A');
    fetchLayout.mockResolvedValue([]);
    expect((await r.api.pos.tables.getActive())[0].id).toBe('A');
    expect((await r.api.pos.restaurantChecks.saveCurrent()).success).toBe(true);
  });
  it('uses durable cache after restart on network errors, including a genuinely empty layout', async () => {
    for (const rows of [[serverTable], []]) {
      const r = await boot(undefined, 'salon', 'staff', async () => rows);
      await r.api.pos.tables.getActive();
      const restarted = await boot(r.persistence, 'salon', 'staff', async () => { throw new TypeError('Failed to fetch'); });
      expect(await restarted.api.pos.tables.getActive()).toHaveLength(rows.length);
      expect(await restarted.api.pos.tables.getSyncStatus()).toMatchObject({ source: 'cache', syncedAt: expect.any(String) });
    }
  });
  it('never treats an initial network failure, denied access or invalid layout as an empty restaurant', async () => {
    const fetchLayout = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const r = await boot(undefined, 'salon', 'staff', fetchLayout);
    await expect(r.api.pos.tables.getActive()).rejects.toThrow('Failed to fetch');
    fetchLayout.mockResolvedValue([serverTable]); await r.api.pos.tables.getActive();
    for (const status of [401, 403, 404]) {
      fetchLayout.mockRejectedValue(Object.assign(new Error('Denied'), { status }));
      await expect(r.api.pos.tables.getActive()).rejects.toThrow('Denied');
    }
    fetchLayout.mockResolvedValue([{ ...serverTable, salonId: 'other' }]);
    await expect(r.api.pos.tables.getActive()).rejects.toThrow('salon mismatch');
    expect(r.db.get<{ is_active: number }>('SELECT is_active FROM pos_tables WHERE id = ?', ['A'])?.is_active).toBe(1);
  });
  it('discards a late response after account change before any table write', async () => {
    let finish!: (data: unknown) => void;
    const r = await boot(undefined, 'salon', 'staff', () => new Promise(resolve => { finish = resolve; }));
    const pending = r.api.pos.tables.getActive();
    const assertion = expect(pending).rejects.toThrow('account changed');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    r.configStore.setConfig({ salonId: 'other', authUser: { id: 'other-staff', salonId: 'other', role: 'STAFF' } as any });
    finish([serverTable]); await assertion;
    expect(r.db.all('SELECT * FROM pos_tables')).toEqual([]);
    expect(r.db.all('SELECT * FROM pos_table_layout_sync')).toEqual([]);
  });
  it('does not report a successful layout when its durable save failed', async () => {
    const r = await boot(undefined, 'salon', 'staff', async () => [serverTable]);
    r.persistence.failSave = true;
    await expect(r.api.pos.tables.getActive()).rejects.toThrow('STORAGE_RESTART_REQUIRED');
    expect(await r.api.pos.dispatch({ type: 'cart/clear' })).toMatchObject({ success: false });
    r.persistence.failSave = false;
  });
  it('loads checks and tables concurrently, without sample tables or counter-only capability', async () => {
    const r = await boot();
    const [checks, tables, hydration] = await Promise.all([r.api.pos.restaurantChecks.list(), r.api.pos.tables.getActive(),
      r.api.pos.dispatch({ type: 'session/open', payload: { shiftId: 'shift', staffId: 'staff', staffName: 'Staff' } })]);
    expect(checks).toMatchObject({ success: true, checks: [] }); expect(tables).toEqual([]);
    expect(hydration.success).toBe(true); expect(r.api.pos.restaurantService).toBeUndefined();
  });
  it('parks two tables independently, restores all checkout fields and keeps the current shift', async () => {
    const r = await boot(); await sale(r, 'A');
    await r.api.pos.tables.setCovers('A', 3);
    await r.api.pos.dispatch({ type: 'tip/set', payload: { amount: 200 } });
    await r.api.pos.dispatch({ type: 'checkoutDraft/update', payload: { customerNip: 'test-nip', requiresInvoice: true } });
    await r.api.pos.dispatch({ type: 'customer/select', payload: { id: 'customer', name: 'Test Customer', nip: 'test-nip' } });
    const a = await save(r); await sale(r, 'B'); await save(r);
    r.repo.openShift('new-shift', 'staff', 'New Cashier', 0);
    r.posStore.dispatch({ type: 'session/open', payload: { shiftId: 'new-shift', staffId: 'staff', staffName: 'New Cashier' } });
    await open(r, a);
    expect(r.posStore.getState()).toMatchObject({ activeTable: 'A', tip: 200, activeCustomer: { id: 'customer' },
      session: { shiftId: 'new-shift' }, checkoutDraft: { customerNip: 'test-nip', requiresInvoice: true, restaurant: { orderType: 'dine_in' } } });
    expect(r.posStore.getState().cart.items[0]).toMatchObject({ notes: 'No sugar', course: 2 });
    expect((await r.api.pos.tables.getActive()).map((t: any) => [t.id, t.status])).toEqual([['A', 'occupied'], ['B', 'occupied']]);
    expect(await r.api.pos.dispatch({ type: 'table/setActive', payload: { tableId: 'B' } })).toMatchObject({ success: false });
  });
  it('durably autosaves recalled edits, discounts, and covers; recovers after a new WebView boot', async () => {
    const r = await boot(); await sale(r, 'A'); const id = await save(r); await open(r, id);
    await r.api.pos.dispatch({ type: 'cart/setItemNotes', payload: { id: 'tea-line', notes: 'Extra hot' } });
    await r.api.pos.dispatch({ type: 'cart/applyItemDiscount', payload: { id: 'tea-line', amount: 10, discountType: 'percentage' } });
    await r.api.pos.tables.setCovers('A', 4);
    const next = await boot(r.persistence); await open(next, id);
    expect(next.posStore.getState().cart.items[0]).toMatchObject({ notes: 'Extra hot', lineDiscount: 100 });
    expect((await next.api.pos.tables.getActive())[0].covers).toBe(4);
    expect(await next.api.pos.dispatch({ type: 'cart/removeItem', payload: { id: 'tea-line' } })).toMatchObject({ success: false });
    expect(next.posStore.getState().cart.items).toHaveLength(1);
  });
  it('does not prune unpaid checks after 20 saves', async () => {
    const r = await boot();
    for (let i = 0; i < 25; i++) { await sale(r); await save(r); }
    expect((await r.api.pos.restaurantChecks.list()).checks).toHaveLength(25);
  });
  it('isolates device, tenant and user checks without hiding occupied tables from other staff', async () => {
    const a = await boot(); await sale(a, 'A'); const id = await save(a);
    const device2 = await boot(); expect((await device2.api.pos.restaurantChecks.list()).checks).toEqual([]);
    const staff2 = await boot(a.persistence, 'salon', 'other-staff');
    expect((await staff2.api.pos.restaurantChecks.list()).checks).toEqual([]);
    expect(await staff2.api.pos.restaurantChecks.open(id)).toMatchObject({ success: false });
    expect((await staff2.api.pos.tables.getActive())[0].status).toBe('occupied');
    const otherSalon = await boot(a.persistence, 'another-salon');
    expect(await otherSalon.api.pos.tables.getActive()).toEqual([]);
    expect(await otherSalon.api.pos.restaurantChecks.open(id)).toMatchObject({ success: false });
  });
  it('rejects renderer snapshot injection, mode change and logout with a recalled check', async () => {
    const r = await boot(); await sale(r); await open(r, await save(r));
    expect(await r.api.pos.dispatch({ type: 'state/replaceCheckoutSnapshot', payload: { snapshot: {} } })).toMatchObject({ success: false });
    await expect(r.api.setConfig({ posMode: 'retail' })).rejects.toThrow('Save');
    expect(await r.api.auth.logout()).toMatchObject({ success: false });
    expect(await r.api.auth.loginWithEmail('other', 'test')).toMatchObject({ success: false }); expect(r.login).not.toHaveBeenCalled();
  });
  it('retains the cart and freezes retry on a failed save', async () => {
    const r = await boot(); await sale(r); r.persistence.failSave = true;
    expect(await r.api.pos.restaurantChecks.saveCurrent()).toMatchObject({ success: false });
    expect(r.posStore.getState().cart.items).toHaveLength(1);
    expect(await r.api.pos.dispatch({ type: 'cart/clear' })).toMatchObject({ success: false });
    r.persistence.failSave = false;
  });
  it('blocks double clicks and auth while the save barrier is pending', async () => {
    const r = await boot(); await sale(r);
    let finish!: () => void;
    vi.spyOn(r.persistence, 'saveImage').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = r.api.pos.restaurantChecks.saveCurrent(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(await r.api.pos.restaurantChecks.saveCurrent()).toMatchObject({ success: false });
    expect(await r.api.auth.logout()).toMatchObject({ success: false });
    expect(r.posStore.getState().cart.items).toHaveLength(1);
    finish(); expect(await saving).toMatchObject({ success: true });
  });
  it('rejects stale preflight and mismatched order payload before any ledger write', async () => {
    const r = await boot(); await sale(r); const id = await save(r); await open(r, id);
    expect(await r.api.pos.restaurantChecks.beginPayment('order', 'android:order')).toMatchObject({ success: false });
    await begin(r);
    const [order, items] = orderPayload(r);
    expect(await r.api.pos.orders.create({ ...order, total: 1 }, items)).toMatchObject({ success: false });
    expect(r.create).not.toHaveBeenCalled();
  });
  it('frees a table only after a durable paid order and preserves restaurant fields in the ledger', async () => {
    const r = await boot(); await sale(r, 'A'); await r.api.pos.tables.setCovers('A', 2);
    const id = await save(r); await open(r, id); await begin(r);
    expect(await r.api.pos.orders.create(...orderPayload(r))).toMatchObject({ success: true, id: 'order' });
    expect(r.posStore.getState().cart.items).toEqual([]);
    expect((await r.api.pos.tables.getActive())[0]).toMatchObject({ status: 'free', covers: 0 });
    expect(r.repo.getById('order')).toMatchObject({ table_id: 'A', covers: 2, mode: 'restaurant', order_type: 'dine_in' });
    expect((await r.api.pos.restaurantChecks.list()).checks).toEqual([]);
    const next = await boot(r.persistence); expect((await next.api.pos.restaurantChecks.list()).checks).toEqual([]);
  });
  it('keeps a pending payment locked after restart when no durable order proves payment', async () => {
    const r = await boot(); await sale(r); const id = await save(r); await open(r, id); await begin(r);
    const next = await boot(r.persistence);
    expect((await next.api.pos.restaurantChecks.list()).checks[0].status).toBe('PAYMENT_PENDING');
    expect(await next.api.pos.restaurantChecks.open(id)).toMatchObject({ success: false });
    expect(await next.api.pos.dispatch({ type: 'cart/addItem', payload: {} })).toMatchObject({ success: false });
  });
  it('recovers paid ledger proof after a crash between order commit and check completion', async () => {
    const r = await boot(); await sale(r); await open(r, await save(r)); await begin(r);
    r.repo.create(...orderPayload(r)); await r.db.flush();
    const next = await boot(r.persistence);
    expect((await next.api.pos.restaurantChecks.list()).checks).toEqual([]);
  });
  it('reports uncertainty and disallows retry when order persistence fails after creation', async () => {
    const r = await boot(); await sale(r); await open(r, await save(r)); await begin(r);
    r.persistence.failSave = true;
    expect(await r.api.pos.orders.create(...orderPayload(r))).toMatchObject({ success: false, outcomeUncertain: true, paymentCommitted: true });
    expect(await r.api.pos.dispatch({ type: 'cart/clear' })).toMatchObject({ success: false });
    r.persistence.failSave = false;
  });
  it('a negative transport reply cannot release an already-frozen payment attempt', async () => {
    const r = await boot(); await sale(r); await open(r, await save(r)); await begin(r);
    r.create.mockResolvedValueOnce({ success: false, error: 'Lost acknowledgment' } as any);
    expect(await r.api.pos.orders.create(...orderPayload(r))).toMatchObject({ success: false, outcomeUncertain: true, paymentCommitted: true });
    expect(await r.api.pos.restaurantChecks.saveCurrent()).toMatchObject({ success: false });
  });
  it('expires payment preflight tokens and cannot reuse them for another order', async () => {
    const r = await boot(); await sale(r); await open(r, await save(r));
    const proof = await r.api.pos.payment.preflight('order');
    expect(await r.api.pos.restaurantChecks.beginPayment('other-order', proof.token)).toMatchObject({ success: false });
    vi.spyOn(Date, 'now').mockReturnValue(proof.expiresAt + 1);
    expect(await r.api.pos.restaurantChecks.beginPayment('order', proof.token)).toMatchObject({ success: false });
    expect(r.create).not.toHaveBeenCalled();
  });
});
