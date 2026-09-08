import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlDatabase } from 'sql.js';
vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../src/main/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/main/config/store', () => ({ getConfigValue: vi.fn() }));
vi.mock('../src/main/pos/promo-loader', () => ({ PromoLoader: class { async getImages() { return []; } } }));
import { PosStore } from '../src/main/pos/pos-store';
import { RestaurantCheckController } from '../src/main/pos/restaurant-check-controller';
import { RestaurantCheckStore, type RestaurantCheckDatabase } from '../src/shared/restaurant-check-store';
import { RESTAURANT_CHECK_SCHEMA } from '../src/shared/restaurant-check';

let sql: SqlDatabase; let pos: PosStore; let db: RestaurantCheckDatabase;
let store: RestaurantCheckStore; let controller: RestaurantCheckController;
let epoch: number; let counter: number;
const scope = { salonId: 'salon', userId: 'staff', registerId: 'windows' };
const paid = new Set<string>();
function makeController() {
  return new RestaurantCheckController({ store,
    captureAccess: () => { const current = epoch; return { scope, isCurrent: () => epoch === current }; },
    getState: () => pos.getState(), dispatch: action => pos.dispatch(action),
    getCovers: () => 2, newId: () => `check-${++counter}`, isOrderCommitted: id => paid.has(id),
  });
}
function sale(tableId = 'A') {
  pos.dispatch({ type: 'table/setActive', payload: { tableId, orderType: 'dine_in' } });
  pos.dispatch({ type: 'cart/addItem', payload: { id: 'line', variantId: 'tea', name: 'Tea', sku: '', quantity: 1, price: 1000, total: 1000, notes: 'No sugar', course: 2 } });
}
beforeEach(async () => {
  sql = new (await initSqlJs()).Database(); sql.run(RESTAURANT_CHECK_SCHEMA);
  function rows<T>(query: string, params: any[] = []): T[] {
    const stmt = sql.prepare(query); const result: T[] = [];
    try { stmt.bind(params); while (stmt.step()) result.push(stmt.getAsObject() as T); } finally { stmt.free(); }
    return result;
  }
  db = { run: (query, params) => { sql.run(query, params); }, get: <T>(query: string, params?: any[]) => rows<T>(query, params)[0] ?? null, all: rows,
    transaction: <T>(fn: () => T) => { sql.run('BEGIN'); try { const result = fn(); sql.run('COMMIT'); return result; } catch (e) { sql.run('ROLLBACK'); throw e; } },
    flush: vi.fn(async () => ({ success: true })),
  };
  store = new RestaurantCheckStore(db); pos = new PosStore(); epoch = 0; counter = 0; paid.clear();
  pos.dispatch({ type: 'session/open', payload: { shiftId: 'shift', staffId: 'staff', staffName: 'Staff' } });
  controller = makeController();
});
afterEach(() => { pos.destroy(); sql.close(); });

describe('restaurant checks connected to the real POS reducer and SQLite', () => {
  it('saves A, sells B, then restores A with its notes and course', async () => {
    sale(); const a = await controller.saveCurrent();
    expect(pos.getState().cart.items).toEqual([]); expect(pos.getState().activeTable).toBeNull();
    sale('B'); await controller.saveCurrent();
    await controller.open(a.id);
    expect(pos.getState().activeTable).toBe('A');
    expect(pos.getState().cart.items[0]).toMatchObject({ notes: 'No sugar', course: 2 });
    expect((await controller.list()).checks).toHaveLength(2);
  });
  it('does not clear the live cart before the disk acknowledgment', async () => {
    sale(); let finish!: () => void;
    vi.mocked(db.flush).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ success: true }); }));
    const saving = controller.saveCurrent(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(pos.getState().cart.items).toHaveLength(1); expect(controller.busy).toBe(true);
    await expect(controller.saveCurrent()).rejects.toThrow('Wait');
    finish(); await saving; expect(pos.getState().cart.items).toHaveLength(0);
  });
  it('keeps the live cart and blocks retries when disk persistence fails', async () => {
    sale(); vi.mocked(db.flush).mockResolvedValueOnce({ success: false, error: 'Disk full' });
    await expect(controller.saveCurrent()).rejects.toThrow('RESTART_REQUIRED');
    expect(pos.getState().cart.items).toHaveLength(1); expect(controller.blocked).toBe(true);
    await expect(controller.saveCurrent()).rejects.toThrow('restart');
  });
  it('does not clear or restore another user cart after logout during save', async () => {
    sale(); let finish!: () => void;
    vi.mocked(db.flush).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ success: true }); }));
    const saving = controller.saveCurrent(); await new Promise(resolve => setTimeout(resolve, 0));
    epoch++; controller.resetForAuthBoundary(); pos.resetForAuthBoundary(); sale('B');
    finish(); await expect(saving).rejects.toThrow('user changed');
    expect(pos.getState().activeTable).toBe('B'); expect(pos.getState().cart.items).toHaveLength(1);
    expect((await store.get(scope, 'check-1'))?.tableId).toBe('A');
  });
  it('auto-saves edits, preserves current shift on recall, and rolls back an invalid empty cart', async () => {
    sale(); const a = await controller.saveCurrent();
    pos.dispatch({ type: 'session/open', payload: { shiftId: 'next-shift', staffId: 'staff', staffName: 'Staff' } });
    await controller.open(a.id);
    expect(pos.getState().session.shiftId).toBe('next-shift');
    await controller.mutate({ type: 'cart/setItemNotes', payload: { id: 'line', notes: 'Extra hot' } });
    expect((await store.get(scope, a.id))?.snapshot.state.cart.items[0].notes).toBe('Extra hot');
    await expect(controller.mutate({ type: 'cart/removeItem', payload: { id: 'line' } })).rejects.toThrow('UNSAFE_SNAPSHOT');
    expect(pos.getState().cart.items[0].notes).toBe('Extra hot');
    await expect(controller.mutate({ type: 'cart/clear' })).rejects.toThrow('authorized cancellation');
  });
  it('saves guest count to the check and keeps it when parked and reopened', async () => {
    sale(); const a = await controller.saveCurrent(); await controller.open(a.id);
    await controller.setCovers('A', 4); await controller.saveCurrent();
    const opened = await controller.open(a.id); expect(opened.covers).toBe(4);
    await expect(controller.setCovers('B', 7)).rejects.toThrow('active');
  });
  it('requires a durable payment boundary and actual ledger proof before freeing a check', async () => {
    sale(); const a = await controller.saveCurrent(); await controller.open(a.id);
    expect(() => controller.assertPaymentOrder('order')).toThrow('boundary');
    await controller.beginPayment('order');
    expect(controller.assertPaymentOrder('order')).toBe(a.id);
    await expect(controller.mutate({ type: 'cart/setItemNotes', payload: { id: 'line', notes: 'changed' } })).rejects.toThrow('not editable');
    await expect(controller.confirmPaid(a.id, 'order')).rejects.toThrow('ledger');
    expect(pos.getState().cart.items).toHaveLength(1);
    paid.add('order'); await controller.confirmPaid(a.id, 'order');
    expect(pos.getState().cart.items).toHaveLength(0); expect(controller.hasActive).toBe(false);
    expect((await store.get(scope, a.id))?.status).toBe('PAID');
  });
  it('recovers an interrupted paid commit without reopening a paid sale', async () => {
    sale(); const a = await controller.saveCurrent(); await controller.open(a.id); await controller.beginPayment('order');
    controller = makeController(); pos.resetForAuthBoundary(); paid.add('order');
    await controller.recoverPaid();
    expect((await controller.list()).checks).toHaveLength(0);
    await expect(controller.open(a.id)).rejects.toThrow('LOCKED');
  });
  it('does not resolve a pending payment without a matching paid order', async () => {
    sale(); const a = await controller.saveCurrent(); await controller.open(a.id); await controller.beginPayment('order');
    controller = makeController(); pos.resetForAuthBoundary();
    await controller.recoverPaid(); expect((await controller.list()).checks[0].status).toBe('PAYMENT_PENDING');
    await expect(controller.open(a.id)).rejects.toThrow('LOCKED');
  });
  it('rejects changed order content at the frozen payment boundary', async () => {
    sale(); const a = await controller.saveCurrent(); await controller.open(a.id); await controller.beginPayment('order');
    const check = (await store.get(scope, a.id))!;
    const state = check.snapshot.state;
    const order = { total: state.cart.total, table_id: check.tableId, covers: check.covers, tip: state.tip,
      order_type: state.checkoutDraft?.restaurant?.orderType ?? 'dine_in' };
    const items = state.cart.items.map((item: any) => ({ variant_id: item.variantId, sale_quantity: item.quantity,
      price: item.price, total: item.total, notes: item.notes, course: item.course, allocated_discount: item.lineDiscount ?? 0 }));
    expect(controller.assertPaymentOrder('order', order, items)).toBe(a.id);
    expect(() => controller.assertPaymentOrder('order', { total: 1 }, [])).toThrow('does not match');
  });
});
