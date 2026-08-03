/**
 * Task 4 of docs/superpowers/plans/2026-07-25-android-pos-device-readiness-fixes.md.
 *
 * Storage for the crash-survivable cart. The cart lives in ShimPosStore memory,
 * which is fine on Windows — Electron has no back button and the OS does not
 * reclaim the process mid-sale — and is not fine on a tablet, where both happen
 * routinely. Task 5 does the persisting; this is the table it writes to.
 */
import { describe, expect, test } from 'vitest';

import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import {
  POS_SNAPSHOT_CART_KEY,
  createPosSnapshotRepo,
} from '../src/renderer/android-pos/shim/db/pos-snapshot-repo';

/** Node-friendly sql.js load — mirrors tests/android-shim-db.test.ts. */
const NODE_LOCATE_FILE = null;

async function freshDb() {
  return initAndroidDb({ locateFile: NODE_LOCATE_FILE });
}

describe('pos snapshot repo', () => {
  test('returns null before anything is saved', async () => {
    const repo = createPosSnapshotRepo(await freshDb());
    expect(repo.load(POS_SNAPSHOT_CART_KEY)).toBeNull();
  });

  test('round-trips a snapshot', async () => {
    const repo = createPosSnapshotRepo(await freshDb());
    repo.save(POS_SNAPSHOT_CART_KEY, '{"items":[{"id":"a"}]}');
    expect(repo.load(POS_SNAPSHOT_CART_KEY)).toBe('{"items":[{"id":"a"}]}');
  });

  test('overwrites rather than accumulating rows', async () => {
    const db = await freshDb();
    const repo = createPosSnapshotRepo(db);
    repo.save(POS_SNAPSHOT_CART_KEY, '{"v":1}');
    repo.save(POS_SNAPSHOT_CART_KEY, '{"v":2}');
    expect(repo.load(POS_SNAPSHOT_CART_KEY)).toBe('{"v":2}');
    const rows = db.all<{ n: number }>('SELECT COUNT(*) AS n FROM pos_snapshot');
    expect(rows[0].n).toBe(1);
  });

  test('clear removes the row', async () => {
    const repo = createPosSnapshotRepo(await freshDb());
    repo.save(POS_SNAPSHOT_CART_KEY, '{"v":1}');
    repo.clear(POS_SNAPSHOT_CART_KEY);
    expect(repo.load(POS_SNAPSHOT_CART_KEY)).toBeNull();
  });

  test('clearSalonData wipes the snapshot — a cart must never cross tenants', async () => {
    const db = await freshDb();
    const repo = createPosSnapshotRepo(db);
    repo.save(POS_SNAPSHOT_CART_KEY, '{"items":[{"id":"salonA-line"}]}');
    db.clearSalonData();
    expect(repo.load(POS_SNAPSHOT_CART_KEY)).toBeNull();
  });
});

// ── Task 5: hydrate the cart back ───────────────────────────────────────────

import {
  ShimPosStore,
  createInitialState,
  posReducer,
  type CartHydration,
  type PosState,
} from '../src/renderer/android-pos/shim/pos-store';

function hydration(overrides: Partial<CartHydration> = {}): CartHydration {
  return {
    cart: {
      items: [{
        id: 'line-1', variantId: 'v1', name: 'Cà phê', sku: 'CF',
        price: 2500, quantity: 2, total: 5000, vatRate: 23,
      }],
      // Deliberately wrong on purpose — the reducer must recompute these.
      subtotal: 0, discount: 0, tax: 0, total: 0,
    },
    checkoutDraft: { customerName: 'Anh Ba' },
    activeTable: 'T4',
    activeCustomer: null,
    tip: 0,
    ...overrides,
  };
}

describe('cart/hydrate', () => {
  test('restores the cart and RECOMPUTES the money', () => {
    const next = posReducer(createInitialState(), { type: 'cart/hydrate', payload: hydration() });
    expect(next.cart.items).toHaveLength(1);
    // Storage said 0; the reducer trusts the lines, not the stored totals.
    expect(next.cart.subtotal).toBe(5000);
    expect(next.cart.total).toBe(5000);
    expect(next.checkoutDraft.customerName).toBe('Anh Ba');
    expect(next.activeTable).toBe('T4');
    expect(next.display.mode).toBe('cart');
  });

  test('an empty snapshot does not force the display into cart mode', () => {
    const payload = hydration({ cart: { items: [], subtotal: 0, discount: 0, tax: 0, total: 0 } });
    const next = posReducer(createInitialState(), { type: 'cart/hydrate', payload });
    expect(next.cart.items).toHaveLength(0);
    expect(next.display.mode).toBe('idle');
  });

  test('REFUSES to overwrite an active frozen billiard checkout', () => {
    // The billiard bill is owned by the durable handoff journal and its own
    // recover() path. A snapshot must never become a second source of truth.
    const frozen: PosState = {
      ...createInitialState(),
      cart: { items: [{ id: 'b1', variantId: 'v', name: 'Stół', sku: '', price: 3000, quantity: 1, total: 3000, locked: true }], subtotal: 3000, discount: 0, tax: 0, total: 3000 },
      checkoutDraft: { billiard: { origin: { type: 'BILLIARD_SESSION', sessionId: 's', checkoutId: 'c', snapshotVersion: 1 }, orderId: 'o', clientAttemptId: 'billiard:c', handoffId: 'c', interruptedHoldId: null, tableName: null, orderCommitted: false } } as any,
    };
    expect(posReducer(frozen, { type: 'cart/hydrate', payload: hydration() })).toBe(frozen);
  });

  test('REFUSES to restore a billiard cart out of a snapshot', () => {
    const payload = hydration({ checkoutDraft: { billiard: { origin: { checkoutId: 'c' } } } as any });
    const base = createInitialState();
    expect(posReducer(base, { type: 'cart/hydrate', payload })).toBe(base);
  });
});

describe('snapshot round trip through the store', () => {
  test('a cart survives being serialized and hydrated into a fresh store', () => {
    const store = new ShimPosStore();
    store.dispatch({ type: 'cart/addItem', payload: {
      id: 'l1', variantId: 'v1', name: 'Cà phê', sku: 'CF', price: 2500, quantity: 2, total: 5000, vatRate: 23,
    } as any });
    const serialized = JSON.stringify({
      cart: store.getState().cart,
      checkoutDraft: store.getState().checkoutDraft,
      activeTable: null,
      activeCustomer: null,
      tip: 0,
    });

    // …process dies here…
    const restarted = new ShimPosStore();
    const parsed = JSON.parse(serialized);
    restarted.dispatch({ type: 'cart/hydrate', payload: parsed });

    expect(restarted.getState().cart.items).toHaveLength(1);
    expect(restarted.getState().cart.total).toBe(store.getState().cart.total);
  });
});
