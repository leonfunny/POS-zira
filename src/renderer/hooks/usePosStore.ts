import { useState, useEffect, useCallback } from 'react';

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
  total: number;
  imageUrl?: string;
  // Mode-specific
  staffId?: string;
  staffName?: string;
  duration?: number;
  notes?: string;
  course?: number;
  vatRate?: number;
}

interface CartState {
  items: CartItem[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
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
    services: Array<{ id: string; name: string; price: number; duration: number; imageUrl?: string }>;
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
  | { type: 'cart/applyDiscount'; payload: { amount: number } }
  | { type: 'cart/setItemNotes'; payload: { id: string; notes: string } }
  | { type: 'cart/setItemPrice'; payload: { id: string; price: number } }
  | { type: 'cart/setItemStaff'; payload: { id: string; staffId: string; staffName: string } }
  | { type: 'cart/setItemCourse'; payload: { id: string; course: number } }
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
