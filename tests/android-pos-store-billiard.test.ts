/**
 * L4 of the billiard POS-handoff port — the Android reducer's protected-cart
 * guards (docs/android-pos/2026-08-02-billiard-pos-handoff-port-plan.md).
 *
 * A frozen billiard checkout is the SERVER's bill sitting in the cashier's
 * cart: the lines, the discount allocation and the VAT split are already
 * final and fiscal. The Windows reducer refuses every edit that would make the
 * local cart disagree with it; the Android reducer previously could not even
 * represent one (its local CheckoutDraftState had no `billiard` field), so
 * none of those refusals existed. These tests pin each one.
 *
 * Reference for every case: src/main/pos/pos-store.ts.
 */
import { describe, expect, test } from 'vitest';

import {
  createInitialState,
  posReducer,
  ShimPosStore,
  type CartItem,
  type PosState,
} from '../src/renderer/android-pos/shim/pos-store';

const CHECKOUT_ID = 'co-1';
const ORDER_ID = 'ord-1';

function line(overrides: Partial<CartItem> = {}): CartItem {
  return {
    id: 'l1',
    variantId: 'v1',
    name: 'Stół #1 — 1h',
    sku: '',
    price: 3000,
    quantity: 1,
    total: 3000,
    vatRate: 23,
    ...overrides,
  };
}

/** A state holding a frozen billiard checkout, as `prepare` would leave it. */
function frozenState(overrides: { orderCommitted?: boolean } = {}): PosState {
  const base = createInitialState();
  return {
    ...base,
    cart: { items: [line({ locked: true })], subtotal: 3000, discount: 0, tax: 561, total: 3000 },
    checkoutDraft: {
      billiard: {
        origin: { type: 'BILLIARD_SESSION', sessionId: 'sess-1', checkoutId: CHECKOUT_ID, snapshotVersion: 1 },
        orderId: ORDER_ID,
        clientAttemptId: `billiard:${CHECKOUT_ID}`,
        handoffId: CHECKOUT_ID,
        interruptedHoldId: null,
        tableName: 'Stół #1',
        orderCommitted: overrides.orderCommitted ?? false,
      },
    } as any,
  };
}

describe('frozen billiard cart is not editable', () => {
  test('addItem is ignored — the cashier cannot append to a server bill', () => {
    const state = frozenState();
    const next = posReducer(state, { type: 'cart/addItem', payload: line({ id: 'l2', variantId: 'v2' }) });
    expect(next).toBe(state);
  });

  test('locked lines refuse remove / quantity / price / notes / staff / course', () => {
    const state = frozenState();
    const edits = [
      { type: 'cart/removeItem', payload: { id: 'l1' } },
      { type: 'cart/updateQuantity', payload: { id: 'l1', quantity: 5 } },
      { type: 'cart/setItemPrice', payload: { id: 'l1', price: 1 } },
      { type: 'cart/setItemNotes', payload: { id: 'l1', notes: 'x' } },
      { type: 'cart/setItemStaff', payload: { id: 'l1', staffId: 's', staffName: 'S' } },
      { type: 'cart/setItemCourse', payload: { id: 'l1', course: 2 } },
    ] as const;
    for (const action of edits) {
      expect(posReducer(state, action as any), `${action.type} mutated a locked line`).toBe(state);
    }
  });

  test('discounts are refused — the frozen allocation is the fiscal truth', () => {
    const state = frozenState();
    expect(posReducer(state, { type: 'cart/applyDiscount', payload: { amount: 500 } })).toBe(state);
    expect(posReducer(state, { type: 'cart/clearDiscount' })).toBe(state);
  });

  test('checkoutDraft/update only lets the invoice fields through', () => {
    const state = frozenState();
    const next = posReducer(state, {
      type: 'checkoutDraft/update',
      payload: { customerNip: '1234567890', billiard: undefined } as any,
    });
    expect(next.checkoutDraft.customerNip).toBe('1234567890');
    // The handoff context survives — the renderer must not be able to drop it.
    expect(next.checkoutDraft.billiard?.origin.checkoutId).toBe(CHECKOUT_ID);
  });

  test('checkoutDraft/clear and customer/clear keep the frozen context', () => {
    const state = frozenState();
    expect(posReducer(state, { type: 'checkoutDraft/clear' })).toBe(state);
    const cleared = posReducer(state, { type: 'customer/clear' });
    expect(cleared.activeCustomer).toBeNull();
    expect(cleared.checkoutDraft.billiard?.origin.checkoutId).toBe(CHECKOUT_ID);
  });

  test('cart/clear cannot discard the bill, and session/close cannot strand it', () => {
    const state = frozenState();
    expect(posReducer(state, { type: 'cart/clear' })).toBe(state);
    expect(posReducer(state, { type: 'session/close' })).toBe(state);
  });
});

describe('cart/completeCheckout — the post-payment clear', () => {
  test('an ordinary paid cart clears (before L4 this action did not exist at all)', () => {
    const base = createInitialState();
    const state: PosState = {
      ...base,
      cart: { items: [line()], subtotal: 3000, discount: 0, tax: 561, total: 3000 },
      display: { mode: 'cart' },
      tip: 500,
    };
    const next = posReducer(state, { type: 'cart/completeCheckout' });
    expect(next.cart.items).toHaveLength(0);
    expect(next.tip).toBe(0);
    expect(next.display.mode).toBe('idle');
  });

  test('a billiard cart refuses to clear until its local order is durably committed', () => {
    const uncommitted = frozenState({ orderCommitted: false });
    // Money already taken but the order not yet on disk — clearing here loses
    // the bill.
    expect(posReducer(uncommitted, { type: 'cart/completeCheckout' })).toBe(uncommitted);

    const committed = frozenState({ orderCommitted: true });
    expect(posReducer(committed, { type: 'cart/completeCheckout' }).cart.items).toHaveLength(0);
  });
});

describe('state/replaceCheckoutSnapshot', () => {
  const snapshotOf = (state: PosState) => ({
    payload: { snapshot: { schemaVersion: 1, state, posMode: 'retail', scope: { salonId: 's', userId: 'u', registerId: 'r' }, capturedAt: 'now' } },
  }) as any;

  test('activates a frozen checkout without recomputing the server totals', () => {
    const incoming = frozenState();
    // Server says 3000 with 561 VAT; a local recalc of a discounted allocation
    // would drift, so an authoritative billiard cart is copied verbatim.
    incoming.cart = { ...incoming.cart, total: 2500, discount: 500 };
    const next = posReducer(createInitialState(), { type: 'state/replaceCheckoutSnapshot', ...snapshotOf(incoming) });
    expect(next.cart.total).toBe(2500);
    expect(next.cart.discount).toBe(500);
    expect(next.checkoutDraft.billiard?.origin.checkoutId).toBe(CHECKOUT_ID);
    expect(next.display.mode).toBe('cart');
  });

  test('an ordinary recalled cart IS recalculated', () => {
    const base = createInitialState();
    const incoming: PosState = {
      ...base,
      // Deliberately stale totals — a plain hold must be re-derived on restore.
      cart: { items: [line()], subtotal: 0, discount: 0, tax: 0, total: 0 },
    };
    const next = posReducer(base, { type: 'state/replaceCheckoutSnapshot', ...snapshotOf(incoming) });
    expect(next.cart.subtotal).toBe(3000);
    expect(next.cart.total).toBe(3000);
  });

  test('refuses to overwrite a DIFFERENT active frozen checkout', () => {
    const active = frozenState();
    const other = frozenState();
    (other.checkoutDraft.billiard as any).origin.checkoutId = 'co-2';
    expect(posReducer(active, { type: 'state/replaceCheckoutSnapshot', ...snapshotOf(other) })).toBe(active);
  });

  test('rejects a malformed snapshot instead of blanking the cart', () => {
    const active = frozenState();
    expect(posReducer(active, { type: 'state/replaceCheckoutSnapshot', payload: { snapshot: { state: {} } } } as any)).toBe(active);
  });
});

describe('markBilliardOrderCommitted', () => {
  test('only the exact checkout+order identity may unlock the cart', () => {
    const store = new ShimPosStore();
    store.dispatch({ type: 'state/replaceCheckoutSnapshot', ...( {
      payload: { snapshot: { schemaVersion: 1, state: frozenState(), posMode: 'retail', scope: { salonId: 's', userId: 'u', registerId: 'r' }, capturedAt: 'now' } },
    } as any) });

    expect(store.markBilliardOrderCommitted('wrong-checkout', ORDER_ID)).toBe(false);
    expect(store.markBilliardOrderCommitted(CHECKOUT_ID, 'wrong-order')).toBe(false);
    expect(store.getState().checkoutDraft.billiard?.orderCommitted).toBe(false);

    expect(store.markBilliardOrderCommitted(CHECKOUT_ID, ORDER_ID)).toBe(true);
    expect(store.getState().checkoutDraft.billiard?.orderCommitted).toBe(true);
    // Now — and only now — the paid cart may be cleared.
    store.dispatch({ type: 'cart/completeCheckout' });
    expect(store.getState().cart.items).toHaveLength(0);
  });

  test('is a no-op when no billiard checkout is active', () => {
    const store = new ShimPosStore();
    expect(store.markBilliardOrderCommitted(CHECKOUT_ID, ORDER_ID)).toBe(false);
  });
});
