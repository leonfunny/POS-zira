import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlDatabase, type SqlJsStatic } from 'sql.js';
import { RestaurantCheckStore, type RestaurantCheckDatabase } from '../src/shared/restaurant-check-store';
import { RESTAURANT_CHECK_SCHEMA, type RestaurantCheckScope } from '../src/shared/restaurant-check';
import { migrations } from '../src/main/database/migrations';
import type { PosCheckoutSnapshot } from '../src/shared/billiard-pos-handoff';

const scope: RestaurantCheckScope = { salonId: 'salon-a', userId: 'staff-a', registerId: 'windows-1' };
let SQL: SqlJsStatic;
let sql: SqlDatabase;
let durableBytes: Uint8Array;
let db: RestaurantCheckDatabase;
let store: RestaurantCheckStore;

function snapshot(tableId: string | null = null, owner = scope): PosCheckoutSnapshot {
  return { schemaVersion: 1, posMode: 'restaurant', scope: { ...owner }, capturedAt: '2026-09-08T00:00:00.000Z', state: {
    activeTable: tableId, tip: 50,
    checkoutDraft: { restaurant: { orderType: 'dine_in' }, customerName: 'Guest' },
    session: { isOpen: true, shiftId: 'shift-1', staffId: owner.userId, staffName: 'Staff' },
    cart: { items: [{ id: 'line-1', variantId: 'tea', quantity: 2, price: 1000, total: 2000, notes: 'No sugar', course: 2 }], subtotal: 2000, total: 2050 },
  } };
}

function rows<T>(query: string, params: any[] = []): T[] {
  const stmt = sql.prepare(query);
  const result: T[] = [];
  try { stmt.bind(params); while (stmt.step()) result.push(stmt.getAsObject() as T); }
  finally { stmt.free(); }
  return result;
}

function reopen() {
  sql.close(); sql = new SQL.Database(durableBytes);
  store = new RestaurantCheckStore(db);
}

beforeEach(async () => {
  SQL = await initSqlJs(); sql = new SQL.Database(); sql.run(RESTAURANT_CHECK_SCHEMA);
  durableBytes = sql.export();
  db = {
    run: (query, params) => { sql.run(query, params); },
    get: <T>(query: string, params?: any[]) => rows<T>(query, params)[0] ?? null,
    all: rows,
    transaction: <T>(fn: () => T): T => {
      sql.run('BEGIN');
      try { const result = fn(); sql.run('COMMIT'); return result; }
      catch (error) { sql.run('ROLLBACK'); throw error; }
    },
    flush: vi.fn(async () => { durableBytes = sql.export(); return { success: true }; }),
  };
  store = new RestaurantCheckStore(db);
});
afterEach(() => sql.close());

describe('independent local restaurant checks (real SQLite)', () => {
  it('adds migration 67 without modifying orders or Hold data, and can be applied idempotently', () => {
    sql.run('CREATE TABLE orders(id TEXT); INSERT INTO orders VALUES (\'paid-old\'); CREATE TABLE pos_hold_orders(id TEXT); INSERT INTO pos_hold_orders VALUES (\'protected-old\');');
    const migration = migrations.find(item => item.version === 67)!;
    sql.run(migration.up); sql.run(migration.up);
    expect(rows('SELECT * FROM orders')).toEqual([{ id: 'paid-old' }]);
    expect(rows('SELECT * FROM pos_hold_orders')).toEqual([{ id: 'protected-old' }]);
    expect(new Set(migrations.map(item => item.version)).size).toBe(migrations.length);
  });

  it('opens without deleting the durable copy and restores fields after reopening SQLite', async () => {
    const saved = await store.create(scope, 'check-a', snapshot('A'), 3);
    const open = await store.open(scope, saved.id, saved.revision);
    reopen();
    const restored = await store.get(scope, 'check-a');
    expect(restored).toMatchObject({ status: 'OPEN', tableId: 'A', covers: 3, revision: open.revision });
    expect(restored?.snapshot.state.cart.items[0]).toMatchObject({ notes: 'No sugar', course: 2, quantity: 2 });
    expect(restored?.snapshot.state).toMatchObject({ tip: 50, session: { shiftId: 'shift-1' } });
  });

  it('parks A, works on B, then opens the latest saved A with the same ID', async () => {
    let a = await store.create(scope, 'a', snapshot('A'), 2);
    a = await store.open(scope, a.id, a.revision);
    const changed = snapshot('A'); changed.state.cart.items[0].notes = 'Extra hot';
    a = await store.save(scope, a.id, a.revision, changed, 4, true);
    let b = await store.create(scope, 'b', snapshot('B'), 1);
    b = await store.open(scope, b.id, b.revision);
    await store.save(scope, b.id, b.revision, b.snapshot, 1, true);
    reopen(); a = await store.open(scope, a.id, a.revision);
    expect(a).toMatchObject({ id: 'a', covers: 4, status: 'OPEN' });
    expect(a.snapshot.state.cart.items[0].notes).toBe('Extra hot');
    expect(await store.listUnfinished(scope)).toHaveLength(2);
  });

  it.each([21, 50, 100])('retains all %i unpaid checks after reopening, with no pruning', async count => {
    for (let i = 0; i < count; i++) await store.create(scope, `check-${i}`, snapshot(`table-${i}`), 2);
    reopen();
    expect(await store.listUnfinished(scope)).toHaveLength(count);
  });

  it.each(['salonId', 'userId', 'registerId'] as const)('isolates reads and writes by %s', async field => {
    await store.create(scope, 'a', snapshot('A'), 1);
    const other = { ...scope, [field]: 'other' };
    expect(await store.get(other, 'a')).toBeNull();
    expect(await store.listUnfinished(other)).toEqual([]);
    await expect(store.open(other, 'a', 1)).rejects.toThrow('NOT_FOUND');
    await expect(store.create(other, 'b', snapshot('B'), 1)).rejects.toThrow('SCOPE_MISMATCH');
  });

  it('lets two independent devices sell at the same table label without sharing checks', async () => {
    const android = { ...scope, registerId: 'android-1' };
    await store.create(scope, 'windows-a', snapshot('A'), 1);
    await store.create(android, 'android-a', snapshot('A', android), 2);
    await store.open(scope, 'windows-a', 1); await store.open(android, 'android-a', 1);
    expect(await store.listUnfinished(scope)).toHaveLength(1);
    expect(await store.listUnfinished(android)).toHaveLength(1);
  });

  it('prevents duplicate unpaid table checks on one machine, including another staff member', async () => {
    await store.create(scope, 'a', snapshot('A'), 1);
    const other = { ...scope, userId: 'staff-b' };
    await expect(store.create(other, 'duplicate', snapshot('A', other), 2)).rejects.toThrow();
    expect(await store.get(other, 'duplicate')).toBeNull();
    expect(await store.get(scope, 'a')).not.toBeNull();
  });

  it('does not replace an active check with another open check', async () => {
    await store.create(scope, 'a', snapshot('A'), 1); await store.create(scope, 'b', snapshot('B'), 2);
    await store.open(scope, 'a', 1);
    await expect(store.open(scope, 'b', 1)).rejects.toThrow();
    expect((await store.get(scope, 'b'))?.status).toBe('SAVED');
  });

  it('rejects stale edits and concurrent double commands instead of losing changes', async () => {
    await store.create(scope, 'a', snapshot(), 0); const open = await store.open(scope, 'a', 1);
    const results = await Promise.allSettled([
      store.save(scope, 'a', open.revision, snapshot(), 2), store.save(scope, 'a', open.revision, snapshot(), 9),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((await store.get(scope, 'a'))?.covers).toBe(2);
  });

  it('does not allow save to silently move items to another table', async () => {
    await store.create(scope, 'a', snapshot('A'), 1); await store.open(scope, 'a', 1);
    await expect(store.save(scope, 'a', 2, snapshot('B'), 1)).rejects.toThrow('REQUIRES_TRANSFER');
    expect((await store.get(scope, 'a'))?.tableId).toBe('A');
  });

  it('requires payment identity, freezes pending/uncertain orders, and only settles the matching order', async () => {
    await store.create(scope, 'a', snapshot('A'), 1); let check = await store.open(scope, 'a', 1);
    await expect(store.beginPayment(scope, 'a', check.revision, '', '')).rejects.toThrow('ID_REQUIRED');
    check = await store.beginPayment(scope, 'a', check.revision, 'order-a', 'attempt-a');
    for (const status of ['PAYMENT_PENDING', 'PAYMENT_UNCERTAIN']) {
      expect(check.status).toBe(status);
      await expect(store.save(scope, 'a', check.revision, snapshot('A'), 1)).rejects.toThrow('LOCKED');
      await expect(store.cancel(scope, 'a', check.revision, 'Cancel')).rejects.toThrow('LOCKED');
      await expect(store.beginPayment(scope, 'a', check.revision, 'new-order', 'new-attempt')).rejects.toThrow('LOCKED');
      if (status === 'PAYMENT_PENDING') check = await store.markPaymentUncertain(scope, 'a', check.revision);
    }
    reopen();
    await expect(store.confirmPaid(scope, 'a', check.revision, 'wrong-order')).rejects.toThrow('MISMATCH');
    check = await store.confirmPaid(scope, 'a', check.revision, 'order-a');
    expect(check.status).toBe('PAID');
    expect(await store.listUnfinished(scope)).toEqual([]);
    await expect(store.open(scope, 'a', check.revision)).rejects.toThrow('LOCKED');
    await store.create(scope, 'next-a', snapshot('A'), 1);
    expect(await store.get(scope, 'a')).not.toBeNull();
  });

  it('retains cancellation reason/snapshot but frees the table for a new sale', async () => {
    await store.create(scope, 'a', snapshot('A'), 1);
    await expect(store.cancel(scope, 'a', 1, '  ')).rejects.toThrow('REASON_REQUIRED');
    const cancelled = await store.cancel(scope, 'a', 1, 'Guest left');
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Guest left' });
    await store.create(scope, 'next', snapshot('A'), 1);
    expect(await store.listUnfinished(scope)).toHaveLength(1);
  });

  it('waits for durable acknowledgment before returning and hides in-flight state from readers', async () => {
    let finish!: () => void;
    vi.mocked(db.flush).mockImplementationOnce(() => new Promise(resolve => { finish = () => { durableBytes = sql.export(); resolve({ success: true }); }; }));
    let completed = false; let observed = false;
    const write = store.create(scope, 'a', snapshot(), 0).then(() => { completed = true; });
    const read = store.get(scope, 'a').then(result => { observed = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(completed).toBe(false); expect(observed).toBe(false);
    finish(); await write;
    expect(await read).not.toBeNull();
  });

  it.each(['returned', 'thrown'])('fails closed on %s flush failure; reopening recovers the last confirmed snapshot', async kind => {
    await store.create(scope, 'a', snapshot('A'), 1); await store.open(scope, 'a', 1);
    if (kind === 'returned') vi.mocked(db.flush).mockResolvedValueOnce({ success: false, error: 'Disk full' });
    else vi.mocked(db.flush).mockRejectedValueOnce(new Error('Disk full'));
    await expect(store.save(scope, 'a', 2, snapshot('A'), 8, true)).rejects.toThrow('RESTART_REQUIRED');
    await expect(store.get(scope, 'a')).rejects.toThrow('RESTART_REQUIRED');
    await expect(store.listUnfinished(scope)).rejects.toThrow('RESTART_REQUIRED');
    reopen();
    expect(await store.get(scope, 'a')).toMatchObject({ status: 'OPEN', covers: 1, revision: 2 });
  });

  it('captures inputs before queuing and does not allow returned snapshots to mutate storage', async () => {
    const original = snapshot(); const owner = { ...scope };
    const create = store.create(owner, 'a', original, 1);
    owner.salonId = 'other'; original.state.cart.items[0].notes = 'mutated';
    const saved = await create;
    expect(saved.snapshot.state.cart.items[0].notes).toBe('No sugar');
    saved.snapshot.state.cart.items[0].notes = 'mutated again';
    expect((await store.get(scope, 'a'))?.snapshot.state.cart.items[0].notes).toBe('No sugar');
  });

  it('rejects invalid context, negative covers and protected cart snapshots', async () => {
    await expect(store.create(scope, 'a', snapshot(), -1)).rejects.toThrow('INVALID_COVERS');
    const delivery = snapshot('A'); delivery.state.checkoutDraft.restaurant.orderType = 'delivery';
    await expect(store.create(scope, 'a', delivery, 1)).rejects.toThrow('INVALID_CONTEXT');
    const protectedCart = snapshot(); protectedCart.state.checkoutDraft.billiard = {};
    await expect(store.create(scope, 'a', protectedCart, 1)).rejects.toThrow('UNSAFE_SNAPSHOT');
    const empty = snapshot(); empty.state.cart.items = [];
    await expect(store.create(scope, 'a', empty, 1)).rejects.toThrow('UNSAFE_SNAPSHOT');
    expect(await store.listUnfinished(scope)).toEqual([]);
  });
  it.each([NaN, Infinity, -1, 0, 1.5])('rejects invalid piece quantity %s without creating a record', async quantity => {
    const invalid = snapshot(); invalid.state.cart.items[0].quantity = quantity;
    await expect(store.create(scope, 'bad', invalid, 1)).rejects.toThrow('INVALID_CART');
    expect(await store.get(scope, 'bad')).toBeNull();
  });
  it('retains gram quantities but refuses duplicate line IDs', async () => {
    const weighted = snapshot(); weighted.state.cart.items[0] = { ...weighted.state.cart.items[0], sellBy: 'WEIGHT', saleUnit: 'kg', quantity: 0.35, total: 350 };
    await store.create(scope, 'good', weighted, 0);
    expect((await store.get(scope, 'good'))?.snapshot.state.cart.items[0].quantity).toBe(0.35);
    weighted.state.cart.items.push({ ...weighted.state.cart.items[0] });
    await expect(store.create(scope, 'duplicate', weighted, 0)).rejects.toThrow('INVALID_CART');
  });
  it('does not reuse an old payment attempt or order identity for a different check', async () => {
    await store.create(scope, 'a', snapshot(), 1); let a = await store.open(scope, 'a', 1);
    a = await store.beginPayment(scope, 'a', a.revision, 'order-a', 'attempt-a');
    await store.confirmPaid(scope, 'a', a.revision, 'order-a');
    await store.create(scope, 'b', snapshot(), 1); const b = await store.open(scope, 'b', 1);
    await expect(store.beginPayment(scope, 'b', b.revision, 'order-b', 'attempt-a')).rejects.toThrow();
    await expect(store.beginPayment(scope, 'b', b.revision, 'order-a', 'attempt-b')).rejects.toThrow();
    expect((await store.get(scope, 'b'))?.status).toBe('OPEN');
  });
});
