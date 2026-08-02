/**
 * POS state shape — the ONE definition both platforms build on.
 *
 * Moved verbatim out of `src/main/pos/pos-store.ts` (which now re-exports it,
 * so its ~100 importers are unchanged). Nothing here touches Electron, Node or
 * a database: it is the contract that says what a cart, a checkout draft and a
 * shift session ARE.
 *
 * Why it left the main process: the Windows renderer is shared byte-for-byte
 * with the Android tablet, but everything below `window.electronAPI` used to
 * exist twice — Electron main for Windows, a hand-written shim for Android.
 * Anything the shim could not import from `src/main/**` (the cross-platform
 * boundary verifier forbids it) had to be re-declared by hand, and re-declared
 * state drifts. The billiard POS-handoff regression is what that drift costs.
 *
 * Rule of thumb for this folder: what is MONEY and RULES lives here and is
 * shared; what is WIRES (serial ports, fs, IndexedDB, IPC) stays per-platform.
 */

import type { CustomerDisplayCatalogSection, SelectedService } from '../types';
import type { SellBy } from '../pos-sale';
import type {
  BilliardCartLineMetadata,
  BilliardCheckoutContext,
  HoldRecallPendingContext,
  RestoredInterruptionContext,
} from '../billiard-pos-handoff';

export interface CartItem {
  id: string;
  variantId: string;
  name: string;
  sku: string;
  price: number;       // grosze
  quantity: number;
  saleUnit?: string | null;
  sellBy?: SellBy | string | null;
  total: number;        // grosze
  imageUrl?: string;
  // Mode-specific (all optional, backward-compatible)
  staffId?: string;       // Salon: assigned staff
  staffName?: string;     // Salon: staff display name
  duration?: number;      // Salon: service duration in minutes
  notes?: string;         // All modes: item-level notes
  course?: number;        // Restaurant: course number (1=starter, 2=main, 3=dessert)
  vatRate?: number;       // VAT rate (e.g. 23, 8, 5, 0) - from product
  name_translations?: string | null;
  /** Frozen server-origin line. Reducer and renderer must not mutate it. */
  locked?: boolean;
  billiard?: BilliardCartLineMetadata;
}

export interface CartState {
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
    /** Backend pickup_orders.id — used to settle the queue row on payment. */
    pickupOrderId?: string | null;
  };
  billiard?: BilliardCheckoutContext;
  restoredInterruption?: RestoredInterruptionContext;
  holdRecallPending?: HoldRecallPendingContext;
}

export interface PosSessionState {
  shiftId: string | null;
  staffId: string | null;
  staffName: string | null;
  isOpen: boolean;
  openedAt: string | null;
}

export interface UpsellDisplayItem {
  id: string;
  name: string;
  price: number;
  imageUrl?: string;
  description?: string;
}

export interface ServiceCategory {
  id: string;
  name: string;
  name_translations?: string | null;
  section: CustomerDisplayCatalogSection;
  services: Array<{
    id: string;
    name: string;
    name_translations?: string | null;
    price: number;
    duration: number;
    imageUrl?: string;
    saleUnit?: string | null;
    sellBy?: SellBy | string | null;
  }>;
}

export interface CheckInData {
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  serviceName?: string;
  services?: SelectedService[];
  staffName?: string;
  bookingTime?: string;
  isWalkIn: boolean;
  upsellsAdded?: string[];
}

export interface DisplayState {
  mode: 'cart' | 'idle' | 'thankyou' | 'promo' | 'interactive' | 'checkin';
  promoImageUrl?: string;
  promoImages?: string[];
  promoIntervalMs?: number;
  lastOrderTotal?: number;
  // Salon-specific
  salonName?: string;
  bookingUrl?: string;
  upsellItems?: UpsellDisplayItem[];
  serviceCategories?: ServiceCategory[];
  customerRequests?: Array<{ id: string; serviceName: string; timestamp: number }>;
  lastCheckIn?: CheckInData;
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
  // Mode-specific (no tables array - tables are in SQLite)
  activeTable?: string | null;          // Restaurant: selected table ID (for display sync)
  activeCustomer?: {                     // B2B: selected customer
    id: string;
    name: string;
    nip?: string;
  } | null;
  tip?: number;                          // Salon/Restaurant: tip amount in grosze
}
