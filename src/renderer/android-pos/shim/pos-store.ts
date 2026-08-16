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

// ── State interfaces (mirror src/main/pos/pos-store.ts) ─────────────────────

export interface CartItem {
  id: string;
  variantId: string;
  name: string;
  sku: string;
  price: number; // grosze
  quantity: number;
  saleUnit?: string | null;
  sellBy?: SellBy | string | null;
  total: number; // grosze
  imageUrl?: string;
  staffId?: string;
  staffName?: string;
  duration?: number;
  notes?: string;
  course?: number;
  vatRate?: number;
  name_translations?: string | null;
  /** Cashier-entered per-line discount: how it was entered. */
  lineDiscountType?: 'fixed' | 'percentage';
  /** As entered: percent (0-100) or grosze, depending on lineDiscountType. */
  lineDiscountValue?: number;
  /** Effective per-line discount in grosze, recomputed by recalcCart. */
  lineDiscount?: number;
}

export interface CartState {
  items: CartItem[];
  subtotal: number;
  discount: number;
  discountType?: 'fixed' | 'percentage';
  discountPercent?: number;
  /** Sum of all effective per-line discounts in grosze. */
  lineDiscountTotal?: number;
  tax: number;
  total: number;
}

export interface CheckoutDraftState {
  customerNip?: string;
  customerName?: string;
  requiresInvoice?: boolean;
  kitchenSelfOrder?: Record<string, unknown>;
}

export interface PosSessionState {
  shiftId: string | null;
  staffId: string | null;
  staffName: string | null;
  isOpen: boolean;
  openedAt: string | null;
}

export interface DisplayState {
  mode: 'cart' | 'idle' | 'thankyou' | 'promo' | 'interactive' | 'checkin';
  [key: string]: unknown;
}

export interface PosState {
  cart: CartState;
  checkoutDraft: CheckoutDraftState;
  session: PosSessionState;
  display: DisplayState;
  activeTable?: string | null;
  activeCustomer?: { id: string; name: string; nip?: string } | null;
  tip?: number;
}

// ── Actions (mirror src/main/pos/pos-store.ts) ──────────────────────────────

export type PosAction =
  | { type: 'cart/addItem'; payload: CartItem }
  | { type: 'cart/removeItem'; payload: { id: string } }
  | { type: 'cart/updateQuantity'; payload: { id: string; quantity: number } }
  | { type: 'cart/clear' }
  | { type: 'cart/applyDiscount'; payload: { amount: number; discountType?: 'fixed' | 'percentage' } }
  | { type: 'cart/clearDiscount' }
  | { type: 'cart/applyItemDiscount'; payload: { id: string; amount: number; discountType?: 'fixed' | 'percentage' } }
  | { type: 'cart/clearItemDiscount'; payload: { id: string } }
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
  | { type: 'tip/clear' };

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

function effectiveLineDiscount(item: CartItem): number {
  if (item.lineDiscountType === 'percentage') {
    const percent = Math.max(0, Math.min(Number(item.lineDiscountValue) || 0, 100));
    return Math.min(Math.round(item.total * percent / 100), item.total);
  }
  if (item.lineDiscountType === 'fixed') {
    return Math.max(0, Math.min(Math.round(Number(item.lineDiscountValue) || 0), item.total));
  }
  return 0;
}

export function recalcCart(cart: CartState): CartState {
  // Per-line discounts track their line: percentage rescales with qty/price,
  // fixed clamps to the (possibly shrunken) line total. item.total stays gross.
  const items = cart.items.map((item) => {
    const lineDiscount = effectiveLineDiscount(item);
    if ((item.lineDiscount ?? 0) === lineDiscount) return item;
    return { ...item, lineDiscount };
  });
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  const lineDiscountTotal = items.reduce((sum, item) => sum + (item.lineDiscount ?? 0), 0);
  // The whole-receipt discount applies on the line-discounted base; clamp there.
  const receiptBase = Math.max(0, subtotal - lineDiscountTotal);
  const discount = cart.discountType === 'percentage' && cart.discountPercent != null
    ? Math.min(Math.round(receiptBase * cart.discountPercent / 100), receiptBase)
    : Math.min(cart.discount, receiptBase);
  // Polish tax compliance: round VAT per line item in grosze, then sum.
  const tax = items.reduce((sum, item) => {
    const rate = item.vatRate ?? 0;
    if (rate <= 0) return sum;
    const payable = item.total - (item.lineDiscount ?? 0);
    const itemVat = Math.round(payable - (payable * 100) / (100 + rate));
    return sum + itemVat;
  }, 0);
  const total = Math.max(0, subtotal - lineDiscountTotal - discount);
  return { ...cart, items, subtotal, discount, lineDiscountTotal, tax, total };
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
      const items = state.cart.items.filter((i) => i.id !== action.payload.id);
      const display = items.length === 0 ? { ...state.display, mode: 'idle' as const } : state.display;
      const checkoutDraft = items.length === 0 ? createInitialState().checkoutDraft : state.checkoutDraft;
      return { ...state, cart: recalcCart({ ...state.cart, items }), checkoutDraft, display };
    }

    case 'cart/updateQuantity': {
      const existing = state.cart.items.find((item) => item.id === action.payload.id);
      if (!existing) return state;
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
      const display = state.display?.mode === 'cart' ? { ...state.display, mode: 'idle' as const } : state.display;
      return { ...state, cart: createInitialState().cart, checkoutDraft: createInitialState().checkoutDraft, tip: 0, display };
    }

    case 'checkoutDraft/update':
      return { ...state, checkoutDraft: { ...state.checkoutDraft, ...action.payload } };

    case 'checkoutDraft/clear':
      return { ...state, checkoutDraft: createInitialState().checkoutDraft };

    case 'cart/applyDiscount': {
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

    case 'cart/applyItemDiscount': {
      const existing = state.cart.items.find((item) => item.id === action.payload.id);
      if (!existing) return state;
      const discountType = action.payload.discountType ?? 'fixed';
      const value = Math.max(0, Number(action.payload.amount) || 0);
      if (value <= 0) return state;
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id
          ? { ...i, lineDiscountType: discountType, lineDiscountValue: value }
          : i,
      );
      return { ...state, cart: recalcCart({ ...state.cart, items }) };
    }

    case 'cart/clearItemDiscount': {
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id
          ? { ...i, lineDiscountType: undefined, lineDiscountValue: undefined, lineDiscount: undefined }
          : i,
      );
      return { ...state, cart: recalcCart({ ...state.cart, items }) };
    }

    case 'cart/setItemNotes': {
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id ? { ...i, notes: action.payload.notes } : i,
      );
      return { ...state, cart: { ...state.cart, items } };
    }

    case 'cart/setItemPrice': {
      const newPrice = Math.max(0, action.payload.price);
      const existingItem = state.cart.items.find((i) => i.id === action.payload.id);
      if (existingItem && !validateCartItemCatalogPrice({ ...existingItem, price: newPrice })) return state;
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id ? normalizedCartItem({ ...i, price: newPrice }) : i,
      );
      return { ...state, cart: recalcCart({ ...state.cart, items }) };
    }

    case 'cart/setItemStaff': {
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id
          ? { ...i, staffId: action.payload.staffId, staffName: action.payload.staffName }
          : i,
      );
      return { ...state, cart: { ...state.cart, items } };
    }

    case 'cart/setItemCourse': {
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
      return { ...state, activeCustomer: null, checkoutDraft: createInitialState().checkoutDraft };

    case 'tip/set':
      return { ...state, tip: action.payload.amount };

    case 'tip/clear':
      return { ...state, tip: 0 };

    default:
      return state;
  }
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
