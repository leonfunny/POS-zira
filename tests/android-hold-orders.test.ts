/**
 * Hold / Recall on the Android till.
 *
 * A parked basket is a sale the shop has not taken yet, and no cashier can
 * rebuild twenty scanned lines from memory. So the invariant under test is not
 * "the happy path works" — it is that the cart is never lost and never
 * duplicated, in every direction the durability barrier can fail.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { initAndroidDb, type AndroidDatabase } from '../src/renderer/android-pos/shim/db/db';
import { createHoldOrderRepo } from '../src/renderer/android-pos/shim/db/hold-repo';
import { createHoldOrders } from '../src/renderer/android-pos/shim/hold-orders';
import { ShimConfigStore } from '../src/renderer/android-pos/shim/config-store';
import { ShimPosStore } from '../src/renderer/android-pos/shim/pos-store';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
}

const IDENTITY = {
  salonId: 'salon-1',
  machineId: 'REG-1',
  posMode: 'retail',
  authUser: { id: 'user-1', salonId: 'salon-1' },
};

function line(id: string, price = 1000) {
  return {
    id, variantId: `variant-${id}`, name: `Item ${id}`, price,
    quantity: 1, total: price, sellBy: 'PIECE', vatRate: 23,
  } as any;
}

async function makeHarness(overrides: Record<string, unknown> = {}) {
  const database = await initAndroidDb({ locateFile: null });
  const configStore = new ShimConfigStore({
    storage: memoryStorage() as any,
    seed: { ...IDENTITY, ...overrides } as any,
  });
  const posStore = new ShimPosStore();
  posStore.dispatch({
    type: 'session/open',
    payload: { shiftId: 'shift-1', staffId: 'staff-1', staffName: 'Anna', openedAt: 'now' },
  });
  const holds = createHoldOrders({ configStore, posStore, db: async () => database });
  return { database, configStore, posStore, holds, repo: createHoldOrderRepo(database) };
}

/** Make the next flush fail, exactly once, the way a full disk would. */
function breakNextFlush(database: AndroidDatabase, times = 1) {
  const original = database.flush.bind(database);
  let left = times;
  vi.spyOn(database, 'flush').mockImplementation(async (...args: any[]) => {
    if (left-- > 0) throw new Error('quota exceeded');
    return original(...args);
  });
}

describe('Hold — parking the live cart', () => {
  afterEach(() => vi.restoreAllMocks());

  test('parks the cart, clears the screen, and the row survives on disk', async () => {
    const h = await makeHarness();
    h.posStore.dispatch({ type: 'cart/addItem', payload: line('a') });
    h.posStore.dispatch({ type: 'cart/addItem', payload: line('b') });

    const r = await h.holds.createCurrent('hold-1', 'Held cart · 12:00');

    expect(r.success).toBe(true);
    expect(h.posStore.getState().cart.items).toHaveLength(0);
    const stored = h.repo.get('hold-1');
    expect(stored?.payload?.snapshot?.state?.cart?.items).toHaveLength(2);
    expect(stored?.payload?.protected).toBe(false);
  });

  test('an empty cart is not a hold', async () => {
    const h = await makeHarness();
    const r = await h.holds.createCurrent('hold-1', 'x');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/empty/i);
    expect(h.repo.get('hold-1')).toBeNull();
  });

  test('A FAILED BARRIER KEEPS THE CART ON SCREEN AND REPORTS THE FAILURE', async () => {
    // The cardinal rule. Reporting "held" over a row that never reached disk
    // would clear the screen and destroy the basket.
    const h = await makeHarness();
    h.posStore.dispatch({ type: 'cart/addItem', payload: line('a') });
    breakNextFlush(h.database, 2); // the write AND the rollback flush

    const r = await h.holds.createCurrent('hold-1', 'x');

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not saved/i);
    expect(h.posStore.getState().cart.items, 'the basket was destroyed').toHaveLength(1);
    // And no row is left behind claiming to be a hold: a cashier who then sees
    // it in the list and recalls it would be opening a basket that is also
    // still on screen — the same lines twice.
    expect(h.repo.get('hold-1'), 'a phantom hold row survived a failed barrier').toBeNull();
  });

  test('a frozen billiard checkout is never parked', async () => {
    const h = await makeHarness();
    h.posStore.dispatch({ type: 'cart/addItem', payload: line('a') });
    (h.posStore.getState().checkoutDraft as any).billiard = { origin: { checkoutId: 'c1' } };
    const r = await h.holds.createCurrent('hold-1', 'x');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/billiard/i);
  });

  test('a cashier change after the save does NOT clear the new cashier’s screen', async () => {
    const h = await makeHarness();
    h.posStore.dispatch({ type: 'cart/addItem', payload: line('a') });
    // The row lands, then the user switches before the response is applied.
    const original = h.database.flush.bind(h.database);
    vi.spyOn(h.database, 'flush').mockImplementation(async (...args: any[]) => {
      const out = await original(...args);
      h.configStore.setConfig({ authUser: { id: 'user-2', salonId: 'salon-1' } } as any);
      return out;
    });

    const r = await h.holds.createCurrent('hold-1', 'x');

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/user changed/i);
    // Saved for the previous cashier to recall, and the live screen untouched.
    expect(h.repo.get('hold-1')).not.toBeNull();
    expect(h.posStore.getState().cart.items).toHaveLength(1);
  });
});

describe('Recall — putting a parked cart back', () => {
  afterEach(() => vi.restoreAllMocks());

  async function parked() {
    const h = await makeHarness();
    h.posStore.dispatch({ type: 'cart/addItem', payload: line('a', 2500) });
    await h.holds.createCurrent('hold-1', 'Held cart');
    return h;
  }

  test('restores the exact lines and removes the row', async () => {
    const h = await parked();
    const r = await h.holds.recall('hold-1');

    expect(r.success).toBe(true);
    const items = h.posStore.getState().cart.items;
    expect(items).toHaveLength(1);
    expect(items[0].price).toBe(2500);
    expect(h.repo.get('hold-1'), 'the row must be gone once the cart is back').toBeNull();
    // The in-flight marker must not survive into the live cart.
    expect((h.posStore.getState().checkoutDraft as any).holdRecallPending).toBeUndefined();
  });

  test('refuses while another cart is on screen — never merges two baskets', async () => {
    const h = await parked();
    h.posStore.dispatch({ type: 'cart/addItem', payload: line('z') });
    const r = await h.holds.recall('hold-1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/hold the current cart/i);
    expect(h.repo.get('hold-1'), 'a refused recall must not consume the row').not.toBeNull();
  });

  test('A FAILED BARRIER PUTS BOTH SIDES BACK', async () => {
    const h = await parked();
    breakNextFlush(h.database, 1);

    const r = await h.holds.recall('hold-1');

    expect(r.success).toBe(false);
    expect(h.repo.get('hold-1'), 'the parked basket was lost').not.toBeNull();
    expect(h.posStore.getState().cart.items, 'the live cart was left holding a phantom recall').toHaveLength(0);
  });

  test('another salon/user/register cannot open this basket', async () => {
    const h = await parked();
    h.configStore.setConfig({ authUser: { id: 'someone-else', salonId: 'salon-1' } } as any);
    const r = await h.holds.recall('hold-1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/does not belong/i);
    expect(h.repo.get('hold-1')).not.toBeNull();
  });

  test('a hold parked in another POS mode is refused with the mode to switch to', async () => {
    const h = await parked();
    h.configStore.setConfig({ posMode: 'salon' } as any);
    const r = await h.holds.recall('hold-1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/retail/);
  });

  test('the protected billiard interruption cart is not a cashier’s to recall or discard', async () => {
    const h = await makeHarness();
    h.repo.upsert('billiard-interruption:c1', 'Interrupted', {
      schemaVersion: 1, protected: true, holdReason: 'BILLIARD_INTERRUPTION',
      snapshot: { schemaVersion: 1, posMode: 'retail', scope: { salonId: 'salon-1', userId: 'user-1', registerId: 'REG-1' }, state: { cart: { items: [] } } },
    });

    expect((await h.holds.recall('billiard-interruption:c1')).error).toMatch(/protected/i);
    expect((await h.holds.remove('billiard-interruption:c1')).error).toMatch(/protected/i);
    expect(await h.holds.list(), 'a protected row must never appear in the cashier list').toEqual([]);
  });
});

describe('List / discard scoping', () => {
  test('lists only this cashier’s own holds', async () => {
    const h = await makeHarness();
    h.posStore.dispatch({ type: 'cart/addItem', payload: line('a') });
    await h.holds.createCurrent('mine', 'Mine');
    // A row belonging to a different register on the same device DB.
    h.repo.upsert('theirs', 'Theirs', {
      schemaVersion: 1, protected: false, holdReason: 'MANUAL',
      snapshot: { schemaVersion: 1, posMode: 'retail', scope: { salonId: 'salon-1', userId: 'user-1', registerId: 'OTHER-REG' }, state: { cart: { items: [] } } },
    });

    const rows = await h.holds.list();
    expect(rows.map((r: any) => r.id)).toEqual(['mine']);
  });

  test('discarding an unknown hold refuses instead of reporting a clean discard', async () => {
    const h = await makeHarness();
    const r = await h.holds.remove('nope');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});
