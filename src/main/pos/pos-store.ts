import { BrowserWindow } from 'electron';
import logger from '../logger';
import { PromoLoader } from './promo-loader';
import { getConfigValue } from '../config/store';
import { productRepo } from '../database/repos/product-repo';
import type {
  AgentConfig,
  CustomerDisplayCatalogSection,
  LiveCustomerDisplayProfile,
  SelectedService,
} from '../../shared/types';
import { resolveCustomerDisplayProfile } from '../../shared/customer-display-profile';

// === State interfaces ===

export interface CartItem {
  id: string;
  variantId: string;
  name: string;
  sku: string;
  price: number;       // grosze
  quantity: number;
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

// === Actions ===

export type PosAction =
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
  | { type: 'session/open'; payload: { shiftId: string; staffId: string | null; staffName: string | null; openedAt?: string } }
  | { type: 'session/close' }
  | { type: 'display/setMode'; payload: DisplayState }
  | { type: 'table/setActive'; payload: { tableId: string | null } }
  | { type: 'customer/select'; payload: { id: string; name: string; nip?: string } }
  | { type: 'customer/clear' }
  | { type: 'tip/set'; payload: { amount: number } }
  | { type: 'tip/clear' };

// === Initial state ===

function createInitialState(): PosState {
  return {
    cart: {
      items: [],
      subtotal: 0,
      discount: 0,
      tax: 0,
      total: 0,
    },
    session: {
      shiftId: null,
      staffId: null,
      staffName: null,
      isOpen: false,
      openedAt: null,
    },
    display: {
      mode: 'idle',
    },
    activeTable: null,
    activeCustomer: null,
    tip: 0,
  };
}

export interface CustomerDisplayCatalogConfig {
  retailEnabled: boolean;
  foodEnabled: boolean;
}

const FOOD_MENU_KEYWORDS = [
  'bar',
  'beer',
  'beverage',
  'breakfast',
  'burger',
  'cafe',
  'coffee',
  'com',
  'dania',
  'danie',
  'deser',
  'desery',
  'dessert',
  'dinner',
  'dish',
  'drink',
  'fnb',
  'food',
  'herbata',
  'jedzenie',
  'juice',
  'kawa',
  'kebab',
  'kolacja',
  'lunch',
  'meal',
  'menu',
  'napoj',
  'napoje',
  'obiad',
  'pho',
  'piwo',
  'pizza',
  'przekaski',
  'restaurant',
  'snack',
  'sniadanie',
  'sok',
  'tea',
  'tra',
  'water',
  'wino',
  'woda',
  'do an',
  'do uong',
];

const RETAIL_CATALOG_KEYWORDS = [
  'grocery',
  'goods',
  'hang hoa',
  'product',
  'products',
  'retail',
  'shop',
  'sklep',
  'spozywcze',
  'tap hoa',
  'towar',
  'towary',
];

function normalizeCatalogText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase()
    : '';
}

function matchesAnyKeyword(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

export function resolveCustomerDisplayCatalogSection(category: unknown): CustomerDisplayCatalogSection {
  const raw = category as Record<string, unknown> | null | undefined;
  const explicit = normalizeCatalogText(
    raw?.customer_display_section
      ?? raw?.display_section
      ?? raw?.displaySection
      ?? raw?.section
      ?? raw?.kind
      ?? raw?.type,
  );
  if (matchesAnyKeyword(explicit, FOOD_MENU_KEYWORDS)) return 'food';
  if (matchesAnyKeyword(explicit, RETAIL_CATALOG_KEYWORDS)) return 'retail';

  const name = normalizeCatalogText(raw?.name);
  if (matchesAnyKeyword(name, FOOD_MENU_KEYWORDS)) return 'food';
  return 'retail';
}

export function isCustomerDisplayCatalogSectionEnabled(
  section: CustomerDisplayCatalogSection,
  config: CustomerDisplayCatalogConfig,
): boolean {
  return section === 'food' ? config.foodEnabled : config.retailEnabled;
}

// === Reducer ===

function recalcCart(cart: CartState): CartState {
  const subtotal = cart.items.reduce((sum, item) => sum + item.total, 0);
  // Recalculate percentage discounts when cart changes; clamp to subtotal
  const discount = cart.discountType === 'percentage' && cart.discountPercent != null
    ? Math.min(Math.round(subtotal * cart.discountPercent / 100), subtotal)
    : Math.min(cart.discount, subtotal);
  // Polish tax compliance: round VAT per line item in grosze, then sum.
  // item.total is gross (incl. VAT). VAT = gross - gross / (1 + rate/100)
  const tax = cart.items.reduce((sum, item) => {
    const rate = item.vatRate ?? 0;
    if (rate <= 0) return sum;
    // Round each item's VAT independently to avoid floating-point accumulation
    const itemVat = Math.round(item.total - item.total * 100 / (100 + rate));
    return sum + itemVat;
  }, 0);
  const total = Math.max(0, subtotal - discount);
  return { ...cart, subtotal, discount, tax, total };
}

interface PosReducerOptions {
  customerDisplayProfile?: LiveCustomerDisplayProfile;
}

function posReducer(
  state: PosState,
  action: PosAction,
  options: PosReducerOptions = {},
): PosState {
  switch (action.type) {
    case 'cart/addItem': {
      // Merge only if same variant AND same staff AND same course
      // (salon mode: different staff = separate entry; restaurant: different course = separate entry)
      const p = action.payload;
      const existing = state.cart.items.find(
        (i) => i.variantId === p.variantId
          && (i.staffId ?? null) === (p.staffId ?? null)
          && (i.course ?? null) === (p.course ?? null),
      );
      let items: CartItem[];
      if (existing) {
        items = state.cart.items.map((i) =>
          i.id === existing.id
            ? { ...i, quantity: i.quantity + p.quantity, total: (i.quantity + p.quantity) * i.price }
            : i,
        );
      } else {
        items = [...state.cart.items, p];
      }
      // Don't yank a salon customer display out of an active self-service flow.
      // Retail-assisted displays should always show the cart once the cashier
      // adds an item, even if stale state was left behind by another mode.
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
      return { ...state, cart: recalcCart({ ...state.cart, items }), display };
    }

    case 'cart/updateQuantity': {
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id
          ? { ...i, quantity: action.payload.quantity, total: action.payload.quantity * i.price }
          : i,
      ).filter((i) => i.quantity > 0);
      const display = items.length === 0 ? { ...state.display, mode: 'idle' as const } : state.display;
      return { ...state, cart: recalcCart({ ...state.cart, items }), display };
    }

    case 'cart/clear': {
      const display = state.display?.mode === 'cart' ? { ...state.display, mode: 'idle' as const } : state.display;
      return { ...state, cart: createInitialState().cart, tip: 0, display };
    }

    case 'cart/applyDiscount': {
      const { amount, discountType } = action.payload;
      const discount = discountType === 'percentage'
        ? Math.min(Math.round(state.cart.subtotal * amount / 100), state.cart.subtotal)
        : Math.min(amount, state.cart.subtotal);
      return { ...state, cart: recalcCart({
        ...state.cart,
        discount,
        discountType: discountType ?? 'fixed',
        discountPercent: discountType === 'percentage' ? amount : undefined,
      }) };
    }

    case 'cart/clearDiscount': {
      return { ...state, cart: recalcCart({
        ...state.cart,
        discount: 0,
        discountType: undefined,
        discountPercent: undefined,
      }) };
    }

    case 'cart/setItemNotes': {
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id ? { ...i, notes: action.payload.notes } : i,
      );
      return { ...state, cart: { ...state.cart, items } };
    }

    case 'cart/setItemPrice': {
      const newPrice = Math.max(0, action.payload.price);
      const items = state.cart.items.map((i) =>
        i.id === action.payload.id
          ? { ...i, price: newPrice, total: newPrice * i.quantity }
          : i,
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
      return { ...state, activeCustomer: action.payload };

    case 'customer/clear':
      return { ...state, activeCustomer: null };

    case 'tip/set':
      return { ...state, tip: action.payload.amount };

    case 'tip/clear':
      return { ...state, tip: 0 };

    default:
      return state;
  }
}

// === Store class ===

export class PosStore {
  private state: PosState;
  private windows: BrowserWindow[] = [];
  private displayTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private interactionTimer: ReturnType<typeof setTimeout> | null = null;
  private promoLoader: PromoLoader;
  private transitionVersion = 0; // Guards against stale async transitions

  constructor() {
    this.state = createInitialState();
    this.promoLoader = new PromoLoader();
    logger.info('[PosStore] Initialized');
    this.resetIdleTimer();
  }

  getState(): PosState {
    return this.state;
  }

  private getCustomerDisplayProfile(): LiveCustomerDisplayProfile {
    return resolveCustomerDisplayProfile({
      customerDisplayProfile: getConfigValue('customerDisplayProfile') as AgentConfig['customerDisplayProfile'],
      posMode: getConfigValue('posMode') as AgentConfig['posMode'],
    });
  }

  private getCustomerDisplayCatalogConfig(): CustomerDisplayCatalogConfig {
    return {
      retailEnabled: (getConfigValue('customerDisplayRetailCatalogEnabled') as boolean | undefined) !== false,
      foodEnabled: (getConfigValue('customerDisplayFoodMenuEnabled') as boolean | undefined) === true,
    };
  }

  dispatch(action: PosAction): void {
    logger.info(`[PosStore] Dispatch: ${action.type}`);
    // Invalidate any in-flight async transitions (e.g. transitionToPromoOrIdle)
    // so they don't clobber the state we're about to set. Without this, an idle
    // timer that fires mid-dispatch can overwrite a freshly-added cart with idle.
    this.transitionVersion++;
    this.state = posReducer(this.state, action, {
      customerDisplayProfile: this.getCustomerDisplayProfile(),
    });
    this.broadcast();

    this.handleDisplayTransitions();
    this.resetIdleTimer();

    // If mode was set to promo without images (e.g. from POS "Ads" button),
    // trigger the loader to fetch images and re-broadcast with them.
    // Falls back to idle if no images are found.
    if (this.state.display.mode === 'promo' && !this.state.display.promoImages?.length) {
      this.transitionToPromoOrIdle();
    }
  }

  private handleDisplayTransitions(): void {
    // Auto-transition: thankyou -> promo (if images) or idle after 8 seconds
    if (this.displayTimer) {
      clearTimeout(this.displayTimer);
      this.displayTimer = null;
    }
    if (this.state.display.mode === 'thankyou') {
      this.displayTimer = setTimeout(() => {
        this.transitionToPromoOrIdle();
        this.displayTimer = null;
      }, 8000);
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const mode = this.state.display.mode;
    // Only start idle timer when in idle or cart-with-empty-cart
    if (mode === 'idle' || (mode === 'cart' && this.state.cart.items.length === 0)) {
      const timeoutMs = (getConfigValue('customerDisplayIdleTimeout') as number | undefined) ?? 120000;
      this.idleTimer = setTimeout(() => {
        this.transitionToPromoOrIdle();
        this.idleTimer = null;
      }, timeoutMs);
    }
  }

  /** Called from IPC when customer display receives a touch/click */
  handleTouch(): void {
    const mode = this.state.display.mode;
    // Only transition from idle or promo to interactive/checkin
    if (mode !== 'idle' && mode !== 'promo') return;

    const profile = this.getCustomerDisplayProfile();
    if (profile !== 'salon_checkin') {
      const catalogConfig = this.getCustomerDisplayCatalogConfig();
      const canBrowseCatalog = profile === 'retail_assisted'
        && (catalogConfig.retailEnabled || catalogConfig.foodEnabled);
      if (canBrowseCatalog) {
        this.loadServiceCategories();
        const categoryCount = this.state.display.serviceCategories?.length ?? 0;
        if (categoryCount > 0) {
          logger.info(`[PosStore] Customer touch detected -> retail catalog (${categoryCount} categories)`);
          this.state = {
            ...this.state,
            display: { ...this.state.display, mode: 'interactive', browseInitialCategoryId: undefined },
          };
          this.broadcast();
          this.resetInteractionTimer();
          return;
        }
      }

      // Retail / promo-only profiles have no interactive next-step, but
      // the operator still expects tapping the screen to skip an empty
      // promo carousel back to the idle copy ("Your items will appear
      // here"). Without this branch the customer display can get stuck
      // on a blank promo slot when promo images fail to load.
      if (mode === 'promo') {
        logger.info(`[PosStore] Customer tapped promo on profile=${profile}, returning to idle`);
        this.state = {
          ...this.state,
          display: { ...this.state.display, mode: 'idle' },
        };
        this.broadcast();
      }
      return;
    }

    // Load service categories for display
    this.loadServiceCategories();

    // If salon mode (has salon name or service categories), go to checkin first
    const salonName = this.state.display.salonName;
    const categoryCount = this.state.display.serviceCategories?.length ?? 0;
    const hasSalonData = !!(salonName || categoryCount > 0);
    const targetMode = hasSalonData ? 'checkin' : 'interactive';

    logger.info(`[PosStore] Customer touch detected → ${targetMode} (salonName=${salonName ?? '∅'}, serviceCategories=${categoryCount}). If both are empty, salon-mode sync may be missing.`);
    this.state = {
      ...this.state,
      display: { ...this.state.display, mode: targetMode },
    };
    this.broadcast();
    this.resetInteractionTimer();
  }

  /** Called when customer checks in from the display */
  handleCheckIn(data: { bookingId?: number; customerName: string; customerPhone?: string; customerEmail?: string; serviceName?: string; services?: SelectedService[]; staffName?: string; bookingTime?: string; isWalkIn: boolean; upsellsAdded?: string[] }): void {
    const services = normalizeSelectedServices(data.services);
    const serviceName = data.serviceName?.trim() || deriveLegacyServiceName(services);
    logger.info(`[PosStore] Customer check-in: ${data.customerName} (walk-in: ${data.isWalkIn})`);
    this.state = {
      ...this.state,
      display: {
        ...this.state.display,
        lastCheckIn: {
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          customerEmail: data.customerEmail,
          serviceName,
          services,
          staffName: data.staffName,
          bookingTime: data.bookingTime,
          isWalkIn: data.isWalkIn,
          upsellsAdded: data.upsellsAdded,
        },
      },
    };
    this.broadcast();
  }

  /** Reset interaction timer from customer display (keeps checkin/interactive alive) */
  handleInteractionPing(): void {
    this.resetInteractionTimer();
  }

  /** Return display to idle/promo */
  handleBackToIdle(): void {
    logger.info('[PosStore] Customer returning to idle/promo');
    this.transitionToPromoOrIdle();
  }

  /** Return interactive browse flow back to the check-in hub */
  handleBackToCheckin(): void {
    logger.info('[PosStore] Customer returning from browse services to check-in');
    this.loadServiceCategories();
    this.state = {
      ...this.state,
      display: { ...this.state.display, mode: 'checkin', browseInitialCategoryId: undefined },
    };
    this.broadcast();
    this.resetInteractionTimer();
  }

  /** Switch display from checkin to interactive (browse services).
   * If categoryId is provided, SalonInteractiveView will open directly in that category. */
  handleBrowseFromCheckin(categoryId?: string): void {
    logger.info(`[PosStore] Customer switching to browse services from checkin${categoryId ? ` (category: ${categoryId})` : ''}`);
    this.loadServiceCategories();
    this.state = {
      ...this.state,
      display: { ...this.state.display, mode: 'interactive', browseInitialCategoryId: categoryId },
    };
    this.broadcast();
    this.resetInteractionTimer();
  }

  /** Called when customer requests a service from the display */
  handleServiceRequest(serviceId: string): void {
    this.resetInteractionTimer();
    // Find the service name from categories
    let serviceName = serviceId;
    for (const cat of this.state.display.serviceCategories || []) {
      const svc = cat.services.find((s) => s.id === serviceId);
      if (svc) { serviceName = svc.name; break; }
    }
    const request = { id: `req-${Date.now()}`, serviceName, timestamp: Date.now() };
    const existing = this.state.display.customerRequests || [];
    // Keep last 50 requests to prevent unbounded growth
    const capped = existing.length >= 50 ? existing.slice(-49) : existing;
    this.state = {
      ...this.state,
      display: {
        ...this.state.display,
        customerRequests: [...capped, request],
      },
    };
    this.broadcast();
    logger.info(`[PosStore] Customer requested service: ${serviceName}`);
  }

  /** Load service categories from local DB for customer display */
  private loadServiceCategories(): void {
    try {
      const catalogConfig = this.getCustomerDisplayCatalogConfig();
      const categories = productRepo.getCategories();
      const allProducts = productRepo.getAll();
      const serviceCategories: ServiceCategory[] = categories
        .filter((cat: any) => cat.customer_display_enabled !== 0)
        .sort((a: any, b: any) => {
          const aSort = a.customer_display_sort_order ?? a.sort_order ?? 0;
          const bSort = b.customer_display_sort_order ?? b.sort_order ?? 0;
          return aSort - bSort || String(a.name || '').localeCompare(String(b.name || ''));
        })
        .map((cat: any): ServiceCategory | null => {
          const section = resolveCustomerDisplayCatalogSection(cat);
          if (!isCustomerDisplayCatalogSectionEnabled(section, catalogConfig)) return null;

          return {
            id: cat.id,
            name: cat.name,
            name_translations: cat.name_translations ?? null,
            section,
            services: allProducts
              .filter((p: any) => p.category_id === cat.id && p.customer_display_enabled !== 0)
              .sort((a: any, b: any) => {
                const aSort = a.customer_display_sort_order ?? 0;
                const bSort = b.customer_display_sort_order ?? 0;
                return aSort - bSort || String(a.name || '').localeCompare(String(b.name || ''));
              })
              .map((p: any) => ({
                id: p.id,
                name: p.name,
                name_translations: p.name_translations ?? null,
                price: p.retail_price,
                duration: p.duration ?? 0,
                imageUrl: p.thumbnail_url || p.image_url || undefined,
                saleUnit: p.sale_unit ?? null,
              })),
          };
        })
        .filter((cat): cat is ServiceCategory => !!cat && cat.services.length > 0);

      this.state = {
        ...this.state,
        display: { ...this.state.display, serviceCategories },
      };
      this.broadcast();
    } catch (e) {
      logger.error('[PosStore] Failed to load service categories:', e);
    }
  }

  /** Update salon display metadata */
  setSalonDisplayInfo(info: { salonName?: string; bookingUrl?: string; upsellItems?: UpsellDisplayItem[] }): void {
    this.state = {
      ...this.state,
      display: { ...this.state.display, ...info },
    };
    this.broadcast();
  }

  private resetInteractionTimer(): void {
    if (this.interactionTimer) {
      clearTimeout(this.interactionTimer);
      this.interactionTimer = null;
    }
    if (this.state.display.mode === 'interactive' || this.state.display.mode === 'checkin') {
      // Return to promo/idle after 90 seconds of inactivity.
      // Must stay in sync with INTERACTION_TIMEOUT_MS in CheckInView.tsx —
      // 30s was too short for customers browsing/reading service lists.
      const timeoutMs = 90000;
      this.interactionTimer = setTimeout(() => {
        logger.info('[PosStore] Interaction timeout, returning to promo/idle');
        this.transitionToPromoOrIdle();
        this.interactionTimer = null;
      }, timeoutMs);
    }
  }

  private async loadPromoAndBroadcast(): Promise<void> {
    const token = ++this.transitionVersion;
    const images = await this.promoLoader.getImages();
    if (token !== this.transitionVersion) return; // Stale request
    const intervalMs = (getConfigValue('customerDisplayPromoInterval') as number | undefined) ?? 5000;
    if (images.length > 0) {
      this.state = {
        ...this.state,
        display: { mode: 'promo', promoImages: images, promoIntervalMs: intervalMs },
      };
      this.broadcast();
    } else {
      logger.warn('[PosStore] No promo images available, staying in promo mode with empty list');
    }
  }

  private async transitionToPromoOrIdle(): Promise<void> {
    const token = ++this.transitionVersion;
    const images = await this.promoLoader.getImages();
    if (token !== this.transitionVersion) return; // Stale request
    const intervalMs = (getConfigValue('customerDisplayPromoInterval') as number | undefined) ?? 5000;
    if (images.length > 0) {
      this.state = {
        ...this.state,
        display: { mode: 'promo', promoImages: images, promoIntervalMs: intervalMs },
      };
    } else {
      this.state = {
        ...this.state,
        display: { mode: 'idle' },
      };
    }
    this.broadcast();
  }

  registerWindow(win: BrowserWindow): void {
    if (!this.windows.includes(win)) {
      this.windows.push(win);
      let title = '(unknown)';
      try { title = win.getTitle(); } catch {}
      logger.info(`[PosStore] Window registered: title="${title}" (total: ${this.windows.length})`);
    }
    this.resetIdleTimer();
  }

  unregisterWindow(win: BrowserWindow): void {
    this.windows = this.windows.filter((w) => w !== win);
    logger.info(`[PosStore] Window unregistered (total: ${this.windows.length})`);
  }

  destroy(): void {
    if (this.displayTimer) {
      clearTimeout(this.displayTimer);
      this.displayTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.interactionTimer) {
      clearTimeout(this.interactionTimer);
      this.interactionTimer = null;
    }
    this.transitionVersion++;
    this.windows = [];
    logger.info('[PosStore] Destroyed');
  }

  private broadcast(): void {
    logger.info(`[PosStore] broadcast() → ${this.windows.length} windows, mode=${this.state.display.mode}, cartItems=${this.state.cart.items.length}`);
    for (const win of this.windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('pos:state-changed', this.state);
      }
    }
  }
}

function normalizeSelectedServices(services?: SelectedService[]): SelectedService[] | undefined {
  const normalized = (services || [])
    .map((service) => ({
      id: service.id,
      name: service.name,
      price: service.price,
      duration: service.duration,
    }))
    .filter((service) => service.id && service.name);

  return normalized.length > 0 ? normalized : undefined;
}

function deriveLegacyServiceName(services?: SelectedService[]): string | undefined {
  const names = (services || [])
    .map((service) => service.name?.trim())
    .filter((name): name is string => !!name);

  return names.length > 0 ? names.join(', ') : undefined;
}
