/**
 * Shim POS store — the Android stand-in for the Windows main-process
 * `PosStore` (src/main/pos/pos-store.ts) that backs the authoritative cart /
 * session / display state (S1 §2.C, §0.3).
 *
 * Packet S2 of the Android parity port. The Windows store is the single source
 * of truth the renderer reads via `pos.getState` / `pos.onStateChanged` /
 * `pos.dispatch`. This shim reproduces the SAME reducer semantics by COPYING the
 * pure reducer logic (createInitialState / recalcCart / normalizedCartItem /
 * posReducer) — it does NOT import `src/main/**`. The only shared helpers used
 * (`normalizeSellBy`, `roundSaleQuantity`, `normalizeSaleUnit`,
 * `calculateLineTotalGrosze`, `isValidSaleQuantity`) come from the pure
 * `src/shared/pos-sale.ts` module the Windows reducer already depends on, so
 * pricing/rounding parity is automatic.
 *
 * Divergences from Windows (all S2-scoped, called out for S5/S8):
 *  - No customer-display transition timers, promo loader, or window registry —
 *    the Android renderer is single-window and the retail cashier flow never
 *    drives a customer display through the store. `dispatch` runs the reducer
 *    and broadcasts, nothing more.
 *  - `validateCartItemCatalogPrice` is a permissive no-op: there is no local
 *    SQL.js catalog yet (S5) to compare against, so every catalog price is
 *    accepted. S5 must restore the price-anomaly guard against the real repo.
 *  - Display "profile" options collapse to the default (retail) branch.
 *
 * Windows behavior stays the reference (PARITY_PORT_PLAN §2): the reducer cases
 * below are byte-for-byte the Windows logic; a divergence here is a silent
 * data-correctness bug, not a crash.
 */

import {
  calculateLineTotalGrosze,
  isValidSaleQuantity,
  normalizeSaleUnit,
  normalizeSellBy,
  roundSaleQuantity,
  type SellBy,
} from '../../../shared/pos-sale';

// ── State interfaces ────────────────────────────────────────────────────────
//
// These used to be RE-DECLARED here as a reduced copy of the Windows shapes,
// and that copy is what let the platforms drift: the local CartItem had no
// `locked`/`billiard`, and the local CheckoutDraftState had no `billiard`, so
// the Android reducer could not even represent a frozen billiard checkout.
// They now come from the one shared definition (src/shared/pos/pos-state.ts),
// re-exported so every existing importer of this module is untouched.

export type {
  CartItem,
  CartState,
  CheckoutDraftState,
  PosSessionState,
  DisplayState,
  PosState,
} from '../../../shared/pos/pos-state';

import type {
  CartItem,
  CartState,
  CheckoutDraftState,
  DisplayState,
  PosState,
} from '../../../shared/pos/pos-state';
import type { PosCheckoutSnapshot } from '../../../shared/billiard-pos-handoff';

// ── Actions (mirror src/main/pos/pos-store.ts) ──────────────────────────────

export type PosAction =
  | { type: 'cart/addItem'; payload: CartItem }
  | { type: 'cart/removeItem'; payload: { id: string } }
  | { type: 'cart/updateQuantity'; payload: { id: string; quantity: number } }
  | { type: 'cart/clear' }
  // Post-payment clear. The SHARED PaymentModal dispatches this
  // (PaymentModal.tsx:832); before this action existed the Android reducer fell
  // through to `default: return state` and the cart stayed on screen after a
  // completed sale.
  | { type: 'cart/completeCheckout' }
  | { type: 'cart/applyDiscount'; payload: { amount: number; discountType?: 'fixed' | 'percentage' } }
  | { type: 'cart/clearDiscount' }
  | { type: 'cart/setItemNotes'; payload: { id: string; notes: string } }
  | { type: 'cart/setItemPrice'; payload: { id: string; price: number } }
  | { type: 'cart/setItemStaff'; payload: { id: string; staffId: string; staffName: string } }
  | { type: 'cart/setItemCourse'; payload: { id: string; course: number } }
  | { type: 'checkoutDraft/update'; payload: Partial<CheckoutDraftState> }
  | { type: 'checkoutDraft/clear' }
  | { type: 'session/open'; payload: { shiftId: string; staffId: string | null; staffName: string | null; openedAt?: string } }
  | { type: 'session/close' }
  | { type: 'display/setMode'; payload: DisplayState }
  | { type: 'table/setActive'; payload: { tableId: string | null } }
  | { type: 'customer/select'; payload: { id: string; name: string; nip?: string } }
  | { type: 'customer/clear' }
  | { type: 'tip/set'; payload: { amount: number } }
  | { type: 'tip/clear' }
  // Atomic whole-cart replacement, used by the billiard handoff to activate a
  // frozen checkout and by crash recovery to restore a parked cart. Renderer
  // dispatches are refused at the shim boundary (main-process-only action).
  | { type: 'state/replaceCheckoutSnapshot'; payload: { snapshot: PosCheckoutSnapshot } };

// ── Initial state (copied) ──────────────────────────────────────────────────

export function createInitialState(): PosState {
  return {
    cart: { items: [], subtotal: 0, discount: 0, tax: 0, total: 0 },
    checkoutDraft: {},
    session: { shiftId: null, staffId: null, staffName: null, isOpen: false, openedAt: null },
    display: { mode: 'idle' },
    activeTable: null,
    activeCustomer: null,
    tip: 0,
  };
}

// ── Reducer helpers (copied from src/main/pos/pos-store.ts:214-244) ─────────

export function recalcCart(cart: CartState): CartState {
  const subtotal = cart.items.reduce((sum, item) => sum + item.total, 0);
  const discount = cart.discountType === 'percentage' && cart.discountPercent != null
    ? Math.min(Math.round(subtotal * cart.discountPercent / 100), subtotal)
    : Math.min(cart.discount, subtotal);
  // Polish tax compliance: round VAT per line item in grosze, then sum.
  const tax = cart.items.reduce((sum, item) => {
    const rate = item.vatRate ?? 0;
    if (rate <= 0) return sum;
    const itemVat = Math.round(item.total - (item.total * 100) / (100 + rate));
    return sum + itemVat;
  }, 0);
  const total = Math.max(0, subtotal - discount);
  return { ...cart, subtotal, discount, tax, total };
}

export function normalizedCartItem(item: CartItem): CartItem {
  const sellBy = normalizeSellBy(item.sellBy);
  const quantity = roundSaleQuantity(Number(item.quantity) || 0, sellBy);
  const saleUnit = normalizeSaleUnit({ saleUnit: item.saleUnit, sellBy });
  return {
    ...item,
    quantity,
    saleUnit,
    sellBy,
    total: calculateLineTotalGrosze(item.price, quantity, sellBy),
  };
}

// No SQL.js catalog yet (S5) — accept every catalog price. Windows gates this
// via productRepo + pos-price-guard; S5 must restore that guard.
function validateCartItemCatalogPrice(_item: CartItem): boolean {
  return true;
}

interface PosReducerOptions {
  customerDisplayProfile?: string;
}

// ── Reducer (copied from src/main/pos/pos-store.ts:261-453) ─────────────────

export function posReducer(
  state: PosState,
  action: PosAction,
  options: PosReducerOptions = {},
): PosState {
  switch (action.type) {
    case 'cart/addItem': {
      // A frozen billiard checkout is the server's bill — the cashier may not
      // append to it (Windows pos-store.ts:296-299).
      if (state.checkoutDraft.billiard) return state;
      const incomingSellBy = normalizeSellBy(action.payload.sellBy);
      if (!isValidSaleQuantity(action.payload.quantity, incomingSellBy)) {
        return state;
      }
      const p = normalizedCartItem(action.payload);
      if (!validateCartItemCatalogPrice(p)) return state;
      const existing = state.cart.items.find(
        (i) => i.variantId === p.variantId
          && (i.staffId ?? null) === (p.staffId ?? null)
          && (i.course ?? null) === (p.course ?? null),
      );
      let items: CartItem[];
      if (existing) {
        items = state.cart.items.map((i) =>
          i.id === existing.id
            ? normalizedCartItem({ ...i, quantity: i.quantity + p.quantity })
            : i,
        );
      } else {
        items = [...state.cart.items, p];
      }
      const currentMode = state.display.mode;
      const preserveSelfService =
        options.customerDisplayProfile === 'salon_checkin'
          && (currentMode === 'checkin' || currentMode === 'interactive');
      const nextMode = options.customerDisplayProfile === 'promo_only'
        ? (currentMode === 'promo' ? 'promo' : 'idle')
        : preserveSelfService
          ? currentMode
          : 'cart';
      return { ...state, cart: recalcCart({ ...state.cart, items }), display: { ...state.display, mode: nextMode } };
    }

    case 'cart/removeItem': {
      // Frozen server-origin lines are not editable (Windows pos-store.ts:238).
      if (state.cart.items.some((item) => item.id === action.payload.id && item.locked)) return state;
      const items = state.cart.items.filter((i) => i.id !== action.payload.id);
      const display = items.length === 0 ? { ...state.display, mode: 'idle' as const } : state.display;
      const checkoutDraft = items.length === 0 ? createInitialState().checkoutDraft : state.checkoutDraft;
      return { ...state, cart: recalcCart({ ...state.cart, items }), checkoutDraft, display };
    }

    case 'cart/updateQuantity': {
      const existing = state.cart.items.find((item) => item.id === action.payload.id);
      if (!existing) return state;
      if (existing.locked) return state; // Windows pos-store.ts:248
      const sellBy = normalizeSellBy(existing.sellBy);
      if (!isValidSaleQuantity(action.payload.quantity, sellBy)) return state;
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id
          ? normalizedCartItem({ ...i, quantity: action.payload.quantity })
          : i,
      ).filter((i) => i.quantity > 0);
      const display = items.length === 0 ? { ...state.display, mode: 'idle' as const } : state.display;
      const checkoutDraft = items.length === 0 ? createInitialState().checkoutDraft : state.checkoutDraft;
      return { ...state, cart: recalcCart({ ...state.cart, items }), checkoutDraft, display };
    }

    case 'cart/clear': {
      // Never discard a frozen billiard bill by clearing the cart.
      if (state.checkoutDraft.billiard) return state;
      const display = state.display?.mode === 'cart' ? { ...state.display, mode: 'idle' as const } : state.display;
      return { ...state, cart: createInitialState().cart, checkoutDraft: createInitialState().checkoutDraft, tip: 0, display };
    }

    case 'cart/completeCheckout': {
      // The paid-and-done clear. A billiard cart may only be cleared AFTER its
      // local order is durably committed, otherwise a crash here would lose the
      // bill with the money already taken (Windows pos-store.ts:375-378).
      if (state.checkoutDraft.billiard && state.checkoutDraft.billiard.orderCommitted !== true) return state;
      const display = state.display?.mode === 'cart' ? { ...state.display, mode: 'idle' as const } : state.display;
      return { ...state, cart: createInitialState().cart, checkoutDraft: createInitialState().checkoutDraft, tip: 0, display };
    }

    case 'checkoutDraft/update': {
      // While a billiard checkout is frozen only the invoice fields may move —
      // the renderer must not overwrite the handoff context (Windows
      // pos-store.ts:283-290).
      const payload = state.checkoutDraft.billiard
        ? {
            customerNip: action.payload.customerNip,
            customerName: action.payload.customerName,
            requiresInvoice: action.payload.requiresInvoice,
          }
        : action.payload;
      return { ...state, checkoutDraft: { ...state.checkoutDraft, ...payload } };
    }

    case 'checkoutDraft/clear':
      if (state.checkoutDraft.billiard) return state;
      return {
        ...state,
        checkoutDraft: state.checkoutDraft.restoredInterruption
          ? { restoredInterruption: state.checkoutDraft.restoredInterruption }
          : createInitialState().checkoutDraft,
      };

    case 'cart/applyDiscount': {
      // The frozen line allocation is the fiscal source of truth.
      if (state.checkoutDraft.billiard) return state;
      const { amount, discountType } = action.payload;
      const discount = discountType === 'percentage'
        ? Math.min(Math.round((state.cart.subtotal * amount) / 100), state.cart.subtotal)
        : Math.min(amount, state.cart.subtotal);
      return {
        ...state,
        cart: recalcCart({
          ...state.cart,
          discount,
          discountType: discountType ?? 'fixed',
          discountPercent: discountType === 'percentage' ? amount : undefined,
        }),
      };
    }

    case 'cart/clearDiscount': {
      if (state.checkoutDraft.billiard) return state;
      return {
        ...state,
        cart: recalcCart({
          ...state.cart,
          discount: 0,
          discountType: undefined,
          discountPercent: undefined,
        }),
      };
    }

    case 'cart/setItemNotes': {
      if (state.cart.items.some((item) => item.id === action.payload.id && item.locked)) return state;
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id ? { ...i, notes: action.payload.notes } : i,
      );
      return { ...state, cart: { ...state.cart, items } };
    }

    case 'cart/setItemPrice': {
      const newPrice = Math.max(0, action.payload.price);
      const existingItem = state.cart.items.find((i) => i.id === action.payload.id);
      if (existingItem?.locked) return state; // Windows pos-store.ts:337
      if (existingItem && !validateCartItemCatalogPrice({ ...existingItem, price: newPrice })) return state;
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id ? normalizedCartItem({ ...i, price: newPrice }) : i,
      );
      return { ...state, cart: recalcCart({ ...state.cart, items }) };
    }

    case 'cart/setItemStaff': {
      if (state.cart.items.some((item) => item.id === action.payload.id && item.locked)) return state;
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id
          ? { ...i, staffId: action.payload.staffId, staffName: action.payload.staffName }
          : i,
      );
      return { ...state, cart: { ...state.cart, items } };
    }

    case 'cart/setItemCourse': {
      if (state.cart.items.some((item) => item.id === action.payload.id && item.locked)) return state;
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id ? { ...i, course: action.payload.course } : i,
      );
      return { ...state, cart: { ...state.cart, items } };
    }

    case 'session/open':
      return {
        ...state,
        session: {
          shiftId: action.payload.shiftId,
          staffId: action.payload.staffId,
          staffName: action.payload.staffName,
          isOpen: true,
          openedAt: action.payload.openedAt ?? new Date().toISOString(),
        },
      };

    case 'session/close':
      // Pay, hold or discard a protected cart before closing the shift —
      // closing here would silently drop an unresolved bill.
      if (state.checkoutDraft.billiard || state.checkoutDraft.restoredInterruption) return state;
      return {
        ...state,
        session: createInitialState().session,
        cart: createInitialState().cart,
        checkoutDraft: createInitialState().checkoutDraft,
        display: { ...state.display, mode: 'idle' },
        activeTable: null,
        activeCustomer: null,
        tip: 0,
      };

    case 'display/setMode':
      return { ...state, display: { ...state.display, ...action.payload } };

    case 'table/setActive':
      return { ...state, activeTable: action.payload.tableId };

    case 'customer/select':
      return {
        ...state,
        activeCustomer: action.payload,
        checkoutDraft: {
          ...state.checkoutDraft,
          customerNip: action.payload.nip ?? '',
          customerName: action.payload.name,
        },
      };

    case 'customer/clear':
      if (state.checkoutDraft.billiard) {
        return { ...state, activeCustomer: null };
      }
      return {
        ...state,
        activeCustomer: null,
        checkoutDraft: state.checkoutDraft.restoredInterruption
          ? { restoredInterruption: state.checkoutDraft.restoredInterruption }
          : createInitialState().checkoutDraft,
      };

    case 'tip/set':
      return { ...state, tip: action.payload.amount };

    case 'tip/clear':
      return { ...state, tip: 0 };

    case 'state/replaceCheckoutSnapshot': {
      const saved = action.payload.snapshot?.state as Partial<PosState> | undefined;
      if (!saved?.cart || !Array.isArray(saved.cart.items)) return state;
      // Never let one frozen checkout overwrite a DIFFERENT active one.
      const activeCheckoutId = state.checkoutDraft.billiard?.origin.checkoutId;
      const incomingCheckoutId = saved.checkoutDraft?.billiard?.origin.checkoutId;
      if (activeCheckoutId && activeCheckoutId !== incomingCheckoutId) return state;
      const cart = restoreCheckoutSnapshotCart(
        saved.cart as CartState,
        Boolean(saved.checkoutDraft?.billiard),
      );
      return {
        ...state,
        cart,
        checkoutDraft: saved.checkoutDraft ? { ...saved.checkoutDraft } : {},
        activeTable: saved.activeTable ?? null,
        activeCustomer: saved.activeCustomer ? { ...saved.activeCustomer } : null,
        tip: Number(saved.tip) || 0,
        // Shift and display configuration are live process state, not recalled
        // historical state. Only switch the customer display atomically.
        display: { ...state.display, mode: cart.items.length > 0 ? 'cart' : 'idle' },
      };
    }

    default:
      return state;
  }
}

/**
 * Restore a cart from a checkout snapshot. A billiard cart is AUTHORITATIVE —
 * its totals come from the server's frozen allocation and must not be
 * recomputed locally; an ordinary recalled cart is recalculated
 * (Windows pos-store.ts restoreCheckoutSnapshotCart).
 */
export function restoreCheckoutSnapshotCart(
  saved: CartState,
  authoritativeBilliard: boolean,
): CartState {
  const cloned = { ...saved, items: saved.items.map((item) => ({ ...item })) };
  return authoritativeBilliard ? cloned : recalcCart(cloned);
}

// ── Store — backs pos.getState / dispatch / onStateChanged (S1 §2.C) ─────────

type StateListener = (state: PosState) => void;

export class ShimPosStore {
  private state: PosState = createInitialState();
  private readonly listeners = new Set<StateListener>();

  getState(): PosState {
    return this.state;
  }

  dispatch(action: PosAction): void {
    this.state = posReducer(this.state, action);
    this.broadcast();
  }

  /**
   * Flip the frozen billiard cart to "its local order is durably committed",
   * which is what unlocks `cart/completeCheckout` (Windows pos-store.ts:600).
   * Identity must match exactly so a stale caller cannot unlock a different
   * checkout. Not reachable from the renderer — the handoff orchestration owns it.
   */
  markBilliardOrderCommitted(checkoutId: string, orderId: string): boolean {
    const billiard = this.state.checkoutDraft.billiard;
    if (!billiard || billiard.origin.checkoutId !== checkoutId || billiard.orderId !== orderId) return false;
    this.state = {
      ...this.state,
      checkoutDraft: {
        ...this.state.checkoutDraft,
        billiard: { ...billiard, orderCommitted: true },
      },
    };
    this.broadcast();
    return true;
  }

  onStateChanged(callback: StateListener): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  private broadcast(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state);
      } catch {
        // A subscriber throwing must not break the broadcast to others.
      }
    }
  }
}
