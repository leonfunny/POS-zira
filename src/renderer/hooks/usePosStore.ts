import { useState, useEffect, useCallback } from 'react';
import type { CustomerDisplayCatalogSection, CustomerDisplayProfile } from '../../shared/types';
import type { SellBy } from '../../shared/pos-sale';

interface SelectedService {
  id: string;
  name: string;
  price?: number;
  duration?: number;
}

interface CartItem {
  id: string;
  variantId: string;
  name: string;
  sku: string;
  price: number;
  quantity: number;
  saleUnit?: string | null;
  sellBy?: SellBy | string | null;
  total: number;
  imageUrl?: string;
  // Mode-specific
  staffId?: string;
  staffName?: string;
  duration?: number;
  notes?: string;
  course?: number;
  vatRate?: number;
  // Translation map carried alongside canonical `name`.
  // Cart row renders this via `resolveName` so language toggles refresh the
  // cart without re-fetching products. Orders/fiscal lines still use `name`;
  // paper receipts localize separately at print time.
  name_translations?: string | null;
}

interface CartState {
  items: CartItem[];
  subtotal: number;
  discount: number;
  discountType?: 'fixed' | 'percentage';
  discountPercent?: number;
  tax: number;
  total: number;
}

export interface CheckoutDraftState {
  customerNip?: string;
  customerName?: string;
  requiresInvoice?: boolean;
  kitchenSelfOrder?: {
    orderNumber: string;
    orderId?: string;
    sourceLabel?: string | null;
    fulfillmentType?: 'DINE_IN' | 'TAKEAWAY' | string | null;
    kitchenAlreadyReleased?: boolean;
    /** Backend pickup_orders.id — settle on payment / release on abandon. */
    pickupOrderId?: string | null;
  };
}

interface PosSessionState {
  shiftId: string | null;
  staffId: string | null;
  staffName: string | null;
  isOpen: boolean;
  openedAt: string | null;
}

interface DisplayState {
  mode: 'cart' | 'idle' | 'thankyou' | 'promo' | 'interactive' | 'checkin';
  profile?: CustomerDisplayProfile;
  promoImageUrl?: string;
  promoImages?: string[];
  promoIntervalMs?: number;
  lastOrderTotal?: number;
  // Salon-specific
  salonName?: string;
  bookingUrl?: string;
  upsellItems?: Array<{ id: string; name: string; price: number; imageUrl?: string; description?: string }>;
  serviceCategories?: Array<{
    id: string;
    name: string;
    name_translations?: string | null;
    section?: CustomerDisplayCatalogSection;
    services: Array<{ id: string; name: string; name_translations?: string | null; price: number; duration: number; imageUrl?: string; saleUnit?: string | null; sellBy?: SellBy | string | null }>;
  }>;
  customerRequests?: Array<{ id: string; serviceName: string; timestamp: number }>;
  lastCheckIn?: {
    customerName: string;
    serviceName?: string;
    services?: SelectedService[];
    staffName?: string;
    bookingTime?: string;
    isWalkIn: boolean;
  };
  // When browsing services, optionally pre-select a specific category (jump into category view).
  browseInitialCategoryId?: string;
  // Payment status for customer display (forwarded from Elavon)
  paymentStatus?: string;
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

type PosAction =
  | { type: 'cart/addItem'; payload: CartItem }
  | { type: 'cart/removeItem'; payload: { id: string } }
  | { type: 'cart/updateQuantity'; payload: { id: string; quantity: number } }
  | { type: 'cart/clear' }
  | { type: 'cart/applyDiscount'; payload: { amount: number; discountType?: 'fixed' | 'percentage' } }
  | { type: 'cart/clearDiscount' }
  | { type: 'cart/setItemNotes'; payload: { id: string; notes: string } }
  | { type: 'cart/setItemPrice'; payload: { id: string; price: number } }
  | { type: 'cart/setItemStaff'; payload: { id: string; staffId: string; staffName: string } }
  | { type: 'cart/setItemCourse'; payload: { id: string; course: number } }
  | { type: 'checkoutDraft/update'; payload: Partial<CheckoutDraftState> }
  | { type: 'checkoutDraft/clear' }
  | { type: 'session/open'; payload: { shiftId: string; staffId: string; staffName: string } }
  | { type: 'session/close' }
  | { type: 'display/setMode'; payload: DisplayState }
  | { type: 'table/setActive'; payload: { tableId: string | null } }
  | { type: 'customer/select'; payload: { id: string; name: string; nip?: string } }
  | { type: 'customer/clear' }
  | { type: 'tip/set'; payload: { amount: number } }
  | { type: 'tip/clear' };

export function usePosStore() {
  const [state, setState] = useState<PosState | null>(null);

  useEffect(() => {
    window.electronAPI.pos.getState().then(setState);
    const unsub = window.electronAPI.pos.onStateChanged(setState);
    return unsub;
  }, []);

  const dispatch = useCallback((action: PosAction) => {
    window.electronAPI.pos.dispatch(action);
  }, []);

  return { state, dispatch };
}

export type { CartItem, CartState, PosAction, DisplayState };
