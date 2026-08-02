import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/zira-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/main/database/repos/product-repo', () => ({
  productRepo: { getById: vi.fn(() => null) },
}));
vi.mock('../src/main/config/store', () => ({
  getConfigValue: vi.fn(),
}));
import {
  assertBilliardCorrectionHandoffPreflight,
  assertBilliardCheckoutSnapshotIntegrity,
  buildBilliardCheckoutSnapshot,
  isActiveBilliardCheckoutSnapshot,
} from '../src/shared/pos/billiard-pos-handoff';
import { restoreCheckoutSnapshotCart, type PosState } from '../src/main/pos/pos-store';
import {
  normalizeBilliardPosCheckout,
  type BilliardPosCheckoutBundle,
} from '../src/shared/billiard-pos-handoff';

function emptyPosState(): PosState {
  return {
    cart: { items: [], subtotal: 0, discount: 0, tax: 0, total: 0 },
    checkoutDraft: {},
    session: {
      shiftId: 'shift-1',
      staffId: 'staff-1',
      staffName: 'Tester',
      isOpen: true,
      openedAt: '2026-07-22T10:00:00.000Z',
    },
    display: { mode: 'idle' },
    activeTable: null,
    activeCustomer: null,
    tip: 0,
  };
}

function mixedVatBundle(): BilliardPosCheckoutBundle {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    checkoutId: 'checkout-1',
    discountGrosze: 3300,
    totalGrosze: 17000,
    lines: [
      {
        lineKey: 'time-1',
        kind: 'TIME',
        variantId: 'billiard-service',
        displayName: 'Playing time',
        quantity: 1,
        sellBy: 'PIECE',
        saleUnit: 'min',
        unitPriceGrosze: 12300,
        grossTotalGrosze: 12300,
        allocatedDiscountGrosze: 2300,
        payableGrosze: 10000,
        vatRate: 23,
        durationMinutes: 60,
        inventoryPolicy: 'NONE',
        refundPolicy: 'FORBIDDEN',
      },
      {
        lineKey: 'fnb-1',
        kind: 'FNB',
        sessionItemId: 'session-item-1',
        variantId: 'cola-variant',
        displayName: 'Cola',
        quantity: 1,
        sellBy: 'PIECE',
        saleUnit: 'szt',
        unitPriceGrosze: 8000,
        grossTotalGrosze: 8000,
        allocatedDiscountGrosze: 1000,
        payableGrosze: 7000,
        vatRate: 8,
        inventoryPolicy: 'ALREADY_CONSUMED',
        refundPolicy: 'ALLOWED_NO_RESTOCK',
      },
    ],
  };
}

describe('authoritative Billiard POS bundle', () => {
  it('accepts the exact frozen allocation and rejects policy, identity, and aggregate drift', () => {
    const valid = mixedVatBundle();
    expect(normalizeBilliardPosCheckout(valid)).toMatchObject(valid);

    const wrongPolicy = structuredClone(valid);
    wrongPolicy.lines[1].inventoryPolicy = 'NONE';
    expect(() => normalizeBilliardPosCheckout(wrongPolicy)).toThrow('policy mismatch');

    const duplicate = structuredClone(valid);
    duplicate.lines[1].lineKey = duplicate.lines[0].lineKey;
    expect(() => normalizeBilliardPosCheckout(duplicate)).toThrow('duplicate line');

    const wrongAggregate = structuredClone(valid);
    wrongAggregate.totalGrosze += 1;
    expect(() => normalizeBilliardPosCheckout(wrongAggregate)).toThrow('frozen total');
  });
});

describe('Billiard owner-correction handoff preflight', () => {
  it('allows a normal active cart because it will be protected by Hold', () => {
    const state = emptyPosState();
    state.cart.items = [{
      id: 'normal-1',
      variantId: 'variant-1',
      name: 'Normal cart item',
      sku: 'SKU-1',
      price: 1000,
      quantity: 1,
      total: 1000,
      vatRate: 23,
    }];
    expect(() => assertBilliardCorrectionHandoffPreflight({
      state,
      sessionId: 'session-1',
      unresolved: null,
    })).not.toThrow();
  });

  it('blocks another unresolved session and an active kitchen pickup before server mutation', () => {
    expect(() => assertBilliardCorrectionHandoffPreflight({
      state: emptyPosState(),
      sessionId: 'session-1',
      unresolved: { sessionId: 'session-2' },
    })).toThrow('Another Billiard checkout');

    const kitchenState = emptyPosState();
    kitchenState.checkoutDraft.kitchenSelfOrder = { pickupOrderId: 'pickup-1' } as any;
    expect(() => assertBilliardCorrectionHandoffPreflight({
      state: kitchenState,
      sessionId: 'session-1',
      unresolved: null,
    })).toThrow('kitchen pickup');
  });
});

describe('Billiard POS checkout snapshot', () => {
  it('calculates embedded VAT per frozen post-discount line for mixed VAT rates', () => {
    const bundle = mixedVatBundle();

    const snapshot = buildBilliardCheckoutSnapshot({
      currentState: emptyPosState(),
      bundle,
      scope: { salonId: 'salon-1', userId: 'user-1', registerId: 'register-1' },
      posMode: 'retail',
      orderId: 'order-1',
    });

    // 23% embedded in 100.00 PLN = 18.70; 8% in 70.00 PLN = 5.19.
    expect(snapshot.state.cart.tax).toBe(2389);
    expect(snapshot.state.cart.subtotal).toBe(20300);
    expect(snapshot.state.cart.discount).toBe(3300);
    expect(snapshot.state.cart.total).toBe(17000);
  });

  it('accepts the exact frozen snapshot and rejects any cart-line drift', () => {
    const bundle = mixedVatBundle();
    const snapshot = buildBilliardCheckoutSnapshot({
      currentState: emptyPosState(),
      bundle,
      scope: { salonId: 'salon-1', userId: 'user-1', registerId: 'register-1' },
      posMode: 'retail',
      orderId: 'order-1',
    });
    const record = {
      checkoutId: bundle.checkoutId,
      sessionId: bundle.sessionId,
      orderId: 'order-1',
      clientAttemptId: `billiard:${bundle.checkoutId}`,
      bundle,
      checkoutSnapshot: snapshot,
    };

    expect(() => assertBilliardCheckoutSnapshotIntegrity(record)).not.toThrow();
    const tampered = structuredClone(record);
    tampered.checkoutSnapshot.state.cart.items[1].billiard.payableGrosze += 1;
    expect(() => assertBilliardCheckoutSnapshotIntegrity(tampered)).toThrow('integrity validation');
  });

  it('applies a discounted mixed-VAT Billiard snapshot without generic gross-VAT drift', () => {
    const bundle = mixedVatBundle();
    const snapshot = buildBilliardCheckoutSnapshot({
      currentState: emptyPosState(),
      bundle,
      scope: { salonId: 'salon-1', userId: 'user-1', registerId: 'register-1' },
      posMode: 'retail',
      orderId: 'order-1',
    });
    const applied: PosState = {
      ...emptyPosState(),
      cart: restoreCheckoutSnapshotCart(snapshot.state.cart, true),
      checkoutDraft: snapshot.state.checkoutDraft,
    };

    expect(applied.cart.tax).toBe(2389);
    expect(applied.cart.total).toBe(17000);
    expect(isActiveBilliardCheckoutSnapshot(applied, snapshot)).toBe(true);
  });
});
