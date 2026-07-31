import { isSaleBlockedByStock, isStockTracked } from './product-stock-tracking';

export interface NormalizedBilliardDashboard {
  resources: any[];
  sessions: any[];
  layouts: any[];
}

const SESSION_STATUSES = new Set(['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']);
export type BilliardMutationPolicy = 'online-only' | 'queue-safe';

interface BilliardMutationRule {
  method: string;
  path: RegExp;
  operation: string;
  policy: BilliardMutationPolicy;
}

const BILLIARD_MUTATION_RULES: BilliardMutationRule[] = [
  { method: 'POST', path: /^\/billiard\/floor-plans$/, operation: 'online_api', policy: 'online-only' },
  { method: 'PATCH', path: /^\/billiard\/floor-plans\/[^/?#]+$/, operation: 'update_floor_plan', policy: 'queue-safe' },
  { method: 'DELETE', path: /^\/billiard\/floor-plans\/[^/?#]+$/, operation: 'online_api', policy: 'online-only' },
  { method: 'PUT', path: /^\/billiard\/table-layouts\/batch$/, operation: 'batch_update_layouts', policy: 'queue-safe' },
  { method: 'PUT', path: /^\/billiard\/table-layouts\/[^/?#]+$/, operation: 'upsert_layout', policy: 'queue-safe' },
  { method: 'POST', path: /^\/billiard\/sessions$/, operation: 'start_session', policy: 'online-only' },
  { method: 'GET', path: /^\/billiard\/sessions\/[^/?#]+$/, operation: 'online_api', policy: 'online-only' },
  // Must precede the generic PATCH /billiard/sessions/:id rule below — the
  // literal "merge" segment would otherwise be captured as a session id.
  { method: 'PATCH', path: /^\/billiard\/sessions\/merge$/, operation: 'merge_sessions', policy: 'online-only' },
  { method: 'PATCH', path: /^\/billiard\/sessions\/[^/?#]+$/, operation: 'update_session', policy: 'queue-safe' },
  { method: 'PATCH', path: /^\/billiard\/sessions\/[^/?#]+\/pause$/, operation: 'pause_session', policy: 'online-only' },
  { method: 'PATCH', path: /^\/billiard\/sessions\/[^/?#]+\/resume$/, operation: 'resume_session', policy: 'online-only' },
  { method: 'PATCH', path: /^\/billiard\/sessions\/[^/?#]+\/end$/, operation: 'end_session', policy: 'online-only' },
  { method: 'PATCH', path: /^\/billiard\/sessions\/[^/?#]+\/transfer$/, operation: 'transfer_table', policy: 'online-only' },
  { method: 'POST', path: /^\/billiard\/sessions\/[^/?#]+\/items$/, operation: 'add_item', policy: 'online-only' },
  { method: 'POST', path: /^\/billiard\/sessions\/[^/?#]+\/payment$/, operation: 'process_payment', policy: 'online-only' },
  { method: 'POST', path: /^\/billiard\/sessions\/void-batch$/, operation: 'void_sessions_batch', policy: 'online-only' },
  { method: 'POST', path: /^\/billiard\/sessions\/[^/?#]+\/void$/, operation: 'void_session', policy: 'online-only' },
  // Walk-in retail (fnb_only session, born settled) + counter parity ops.
  // All online-only: each needs the server's authoritative result (session id
  // for the receipt, split math, shift state) — nothing to replay offline.
  { method: 'POST', path: /^\/billiard\/retail\/quick-sale$/, operation: 'retail_quick_sale', policy: 'online-only' },
  { method: 'GET', path: /^\/billiard\/retail\/today$/, operation: 'online_api', policy: 'online-only' },
  { method: 'POST', path: /^\/billiard\/sessions\/[^/?#]+\/split$/, operation: 'split_bill', policy: 'online-only' },
  { method: 'GET', path: /^\/billiard\/shifts\/current$/, operation: 'online_api', policy: 'online-only' },
  { method: 'POST', path: /^\/billiard\/shifts\/open$/, operation: 'open_shift', policy: 'online-only' },
  // History & report reads: the server is the single source of truth shared
  // with the web dashboard (same endpoints ⇒ numbers match by construction).
  { method: 'GET', path: /^\/billiard\/sessions\/history\?[A-Za-z0-9=&%._:-]*$/, operation: 'online_api', policy: 'online-only' },
  { method: 'GET', path: /^\/billiard\/analytics\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/, operation: 'online_api', policy: 'online-only' },
  { method: 'DELETE', path: /^\/billiard\/sessions\/[^/?#]+\/items\/[^/?#]+$/, operation: 'remove_item', policy: 'online-only' },
  { method: 'PATCH', path: /^\/billiard\/sessions\/[^/?#]+\/items\/[^/?#]+$/, operation: 'update_item', policy: 'online-only' },
  { method: 'GET', path: /^\/billiard\/bookings\?date=\d{4}-\d{2}-\d{2}&limit=200$/, operation: 'online_api', policy: 'online-only' },
  { method: 'GET', path: /^\/billiard\/availability\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\?date=\d{4}-\d{2}-\d{2}$/, operation: 'online_api', policy: 'online-only' },
  { method: 'POST', path: /^\/billiard\/bookings$/, operation: 'online_api', policy: 'online-only' },
  { method: 'POST', path: /^\/billiard\/bookings\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/(?:cancel|check-in)$/, operation: 'online_api', policy: 'online-only' },
  { method: 'GET', path: /^\/resources\/types$/, operation: 'online_api', policy: 'online-only' },
  { method: 'POST', path: /^\/resources\/types$/, operation: 'online_api', policy: 'online-only' },
  { method: 'POST', path: /^\/resources$/, operation: 'online_api', policy: 'online-only' },
  { method: 'PUT', path: /^\/resources\/(?!types$)[^/?#]+$/, operation: 'update_resource', policy: 'queue-safe' },
  { method: 'DELETE', path: /^\/resources\/(?!types$)[^/?#]+$/, operation: 'online_api', policy: 'online-only' },
];

function findBilliardMutationRule(method: string, path: string): BilliardMutationRule | null {
  if (typeof path !== 'string' || path.includes('..') || path.includes('//')) return null;
  const normalizedMethod = String(method || '').toUpperCase();
  return BILLIARD_MUTATION_RULES.find(
    (rule) => rule.method === normalizedMethod && rule.path.test(path),
  ) ?? null;
}

/**
 * The backend dashboard contract is an array of table overview entries, while
 * older desktop builds also accepted split object collections. Keep the
 * boundary tolerant, but always return one canonical shape to the cache.
 */
export function normalizeBilliardDashboard(payload: any): NormalizedBilliardDashboard {
  const value = payload?.data ?? payload;

  if (Array.isArray(value)) {
    const resources: any[] = [];
    const sessions: any[] = [];
    const layouts: any[] = [];
    for (const entry of value) {
      const resource = entry?.resource ?? entry;
      if (!resource || typeof resource.id !== 'string' || resource.id.length === 0) {
        throw new Error('Invalid billiard dashboard response: resource row has no id');
      }
      resources.push(resource);
      if (entry?.session !== undefined && entry.session !== null) {
        if (typeof entry.session?.id !== 'string' || entry.session.id.length === 0) {
          throw new Error('Invalid billiard dashboard response: session row has no id');
        }
        sessions.push(entry.session);
      }
      if (entry?.layout !== undefined && entry.layout !== null) {
        if (typeof entry.layout?.id !== 'string' || entry.layout.id.length === 0) {
          throw new Error('Invalid billiard dashboard response: layout row has no id');
        }
        layouts.push(entry.layout);
      }
    }
    return {
      resources,
      sessions,
      layouts,
    };
  }

  if (!value || typeof value !== 'object') {
    throw new Error('Invalid billiard dashboard response: expected an array or object');
  }
  const resources = Array.isArray(value.resources)
    ? value.resources
    : (Array.isArray(value.tables) ? value.tables : null);
  const sessions = Array.isArray(value.sessions)
    ? value.sessions
    : (Array.isArray(value.activeSessions) ? value.activeSessions : null);
  const layouts = value.layouts === undefined
    ? []
    : (Array.isArray(value.layouts) ? value.layouts : null);
  if (!resources || !sessions || !layouts) {
    throw new Error('Invalid billiard dashboard response: incomplete collections');
  }
  for (const resource of resources) {
    if (!resource || typeof resource.id !== 'string' || resource.id.length === 0) {
      throw new Error('Invalid billiard dashboard response: resource row has no id');
    }
  }
  for (const session of sessions) {
    if (!session || typeof session.id !== 'string' || session.id.length === 0) {
      throw new Error('Invalid billiard dashboard response: session row has no id');
    }
  }
  for (const layout of layouts) {
    if (!layout || typeof layout.id !== 'string' || layout.id.length === 0) {
      throw new Error('Invalid billiard dashboard response: layout row has no id');
    }
  }
  return { resources, sessions, layouts };
}

/** Validate the complete cashier recovery snapshot before it may prune local rows. */
export function normalizeBilliardPendingPayments(payload: any): any[] {
  const value = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.data) ? payload.data : null);
  if (!value) {
    throw new Error('Invalid pending-payment response: expected an array');
  }
  for (const session of value) {
    const status = String(session?.status || '').toUpperCase();
    const paymentStatus = String(session?.paymentStatus || '').toUpperCase();
    if (
      typeof session?.id !== 'string'
      || status !== 'COMPLETED'
      || !['UNPAID', 'PARTIAL'].includes(paymentStatus)
    ) {
      throw new Error('Invalid pending-payment response: unsafe session row');
    }
  }
  return value;
}

export function canonicalBilliardSessionStatus(value: unknown): string {
  const status = String(value ?? 'ACTIVE').trim().toUpperCase();
  return SESSION_STATUSES.has(status) ? status : 'ACTIVE';
}

export function canonicalBilliardBillingMode(value: unknown): string {
  const mode = String(value ?? 'PER_MINUTE').trim().toUpperCase();
  if (mode === 'PER_HOUR_ROUNDED' || mode === 'PACKAGE_COUNTDOWN') return mode;
  return 'PER_MINUTE';
}

export function billiardTransferPayload(targetResourceId: string): { targetResourceId: string } {
  return { targetResourceId };
}

export function billiardPaymentPayload(
  paymentMethod: string,
  amount?: number,
): { paymentMethod: string; amount?: number } {
  return amount === undefined ? { paymentMethod } : { paymentMethod, amount };
}

/**
 * Errors thrown in the main process reach the renderer wrapped by Electron as
 * "Error invoking remote method 'billiard:mutate': Error: <real message>" —
 * cashiers must never see that wrapper.
 */
export function stripIpcErrorPrefix(message: string): string {
  return String(message ?? '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

/** Write-off payloads. The backend requires a non-empty reason (≤500 chars). */
export function billiardVoidPayload(reason: string): { reason: string } {
  return { reason: String(reason ?? '').trim() };
}

export function billiardVoidBatchPayload(
  ids: string[],
  reason: string,
): { ids: string[]; reason: string } {
  return { ids: [...ids], reason: String(reason ?? '').trim() };
}

/** Resolve the amount shown/settled by the POS without losing a finalized zero total. */
export function resolveBilliardSessionTotal(session: any): number {
  const rawCanonicalTotal = session?.totalCharge ?? session?.totalCharges;
  const canonicalTotal = Number(rawCanonicalTotal);
  const status = canonicalBilliardSessionStatus(session?.status);
  const isFinalized = status === 'COMPLETED' || status === 'CANCELLED';
  if (rawCanonicalTotal !== undefined && rawCanonicalTotal !== null
    && Number.isFinite(canonicalTotal) && (isFinalized || canonicalTotal > 0)) {
    return Math.max(0, canonicalTotal);
  }

  const items = Array.isArray(session?.items) ? session.items : [];
  const itemsTotal = items.reduce(
    (sum: number, item: any) => sum
      + Number(item?.unitPrice ?? item?.unit_price ?? 0)
      * Number(item?.quantity ?? 1),
    0,
  );
  if (canonicalBilliardBillingMode(session?.billingMode ?? session?.billing_mode) === 'PACKAGE_COUNTDOWN') {
    return Math.max(0, Number(session?.packagePrice ?? 0) + itemsTotal);
  }
  return Math.max(0, Number(session?.currentTimeCharge ?? session?.timeCharge ?? 0) + itemsTotal);
}

/** Amount the cashier should collect now, after any earlier partial tenders. */
export function resolveBilliardOutstandingBalance(session: any): number {
  const total = resolveBilliardSessionTotal(session);
  const paidAmount = Number(session?.paidAmount ?? session?.paid_amount ?? 0);
  return Math.max(
    0,
    Math.round((total - (Number.isFinite(paidAmount) ? paidAmount : 0)) * 100) / 100,
  );
}

/** A finalized/no-balance session must never open a zero-value POS tender. */
export function shouldSkipBilliardPosPayment(session: any): boolean {
  const status = canonicalBilliardSessionStatus(session?.status);
  const paymentStatus = String(session?.paymentStatus ?? session?.payment_status ?? '').toUpperCase();
  if (paymentStatus === 'PAID' || paymentStatus === 'VOID') return true;
  const isFinal = status === 'COMPLETED' || status === 'CANCELLED';
  return isFinal && resolveBilliardOutstandingBalance(session) <= 0;
}

/** A frozen server checkout is immutable and may no longer be written off. */
export function isBilliardPosCheckoutFrozen(session: any): boolean {
  const checkoutId = session?.posCheckoutId
    ?? session?.pos_checkout_id
    ?? session?.posCheckout?.checkoutId
    ?? session?.posCheckoutSnapshot?.checkoutId
    ?? session?.posOrderId
    ?? session?.pos_order_id;
  return typeof checkoutId === 'string' && checkoutId.trim().length > 0;
}

export interface NormalizedBilliardCatalogProduct {
  variantId: string | undefined;
  name: string;
  price: number;
  stock: number | null;
  hasStock: boolean;
}

export interface NormalizedBilliardBooking {
  id: string;
  resourceId: string;
  tableName: string;
  startsAt: string;
  endsAt: string;
  customerName: string;
  phone: string;
  guestCount: number;
  notes: string;
  status: string;
  totalPrice: number;
}

export interface NormalizedBilliardAvailability {
  slots: Array<{ hour: string; available: boolean; price: number }>;
  currency: string;
}

export function isBilliardDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year
    && parsed.getMonth() === month - 1
    && parsed.getDate() === day;
}

export function buildBilliardBookingsPath(date: string): string {
  if (!isBilliardDateKey(date)) throw new Error('Invalid reservation date');
  return `/billiard/bookings?date=${date}&limit=200`;
}

export function buildBilliardAvailabilityPath(resourceId: string, date: string): string {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(resourceId) || !isBilliardDateKey(date)) {
    throw new Error('Invalid reservation table or date');
  }
  return `/billiard/availability/${resourceId}?date=${date}`;
}

/** Keep the wall-clock hour selected at the salon and attach its local UTC offset. */
export function buildBilliardBookingStartsAt(date: string, hour: number): string {
  if (!isBilliardDateKey(date) || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error('Invalid reservation start time');
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  const local = new Date(`${date}T${pad(hour)}:00:00`);
  const offsetMinutes = -local.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${date}T${pad(hour)}:00:00${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

export function normalizeBilliardBookings(payload: any): NormalizedBilliardBooking[] {
  const value = payload?.data ?? payload;
  const items = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(items)) throw new Error('Invalid reservation response');
  return items
    .filter((booking: any) => typeof booking?.id === 'string')
    .map((booking: any) => {
      const guestsMatch = String(booking?.internalNotes ?? booking?.internal_notes ?? '')
        .match(/Guests:\s*(\d+)/i);
      const totalPrice = Number(
        booking?.totalPrice ?? booking?.total_price ?? booking?.totalPricePln ?? 0,
      );
      return {
        id: booking.id,
        resourceId: String(booking.resourceId ?? booking.resource_id ?? booking.resource?.id ?? ''),
        tableName: String(
          booking.tableName ?? booking.resourceName ?? booking.resource_name
            ?? booking.resource?.name ?? 'Table',
        ),
        startsAt: String(booking.startsAt ?? booking.starts_at ?? ''),
        endsAt: String(booking.endsAt ?? booking.ends_at ?? ''),
        customerName: String(
          booking.customerName ?? booking.customer_name
            ?? booking.owner?.fullName ?? booking.owner?.full_name ?? 'Guest',
        ),
        phone: String(booking.phone ?? booking.owner?.phone ?? ''),
        guestCount: Math.max(1, Number(booking.guestCount ?? guestsMatch?.[1] ?? 1)),
        notes: String(booking.notes ?? booking.customerNotes ?? booking.customer_notes ?? ''),
        status: String(booking.status ?? '').toUpperCase(),
        totalPrice: Number.isFinite(totalPrice) ? totalPrice : 0,
      };
    });
}

export function normalizeBilliardAvailability(payload: any): NormalizedBilliardAvailability {
  const value = payload?.data ?? payload;
  if (!value || !Array.isArray(value.slots)) {
    throw new Error('Invalid table availability response');
  }
  return {
    slots: value.slots
      .filter((slot: any) => /^\d{2}:00$/.test(String(slot?.hour ?? '')))
      .map((slot: any) => ({
        hour: String(slot.hour),
        available: slot.available === true,
        price: Number.isFinite(Number(slot.price)) ? Number(slot.price) : 0,
      })),
    currency: String(value.currency || 'PLN'),
  };
}

/** One normalization path for both catalog rendering and the billed item. */
export function normalizeBilliardCatalogProduct(
  product: any,
): NormalizedBilliardCatalogProduct {
  const variant = product?.variants?.[0] || product || {};
  const template = product?.template || {};
  const localMinorPrice = variant.retail_price
    ?? product?.retail_price
    ?? variant.price_gross
    ?? product?.price_gross;
  const majorPrice = variant.retailPrice
    ?? product?.retailPrice
    ?? variant.listPrice
    ?? product?.listPrice
    ?? variant.posPrice
    ?? product?.posPrice
    ?? product?.price
    ?? 0;
  const priceNumber = Number(localMinorPrice !== undefined ? localMinorPrice : majorPrice);
  const price = Number.isFinite(priceNumber)
    ? (localMinorPrice !== undefined ? priceNumber / 100 : priceNumber)
    : 0;

  const stockRaw = variant.available_qty
    ?? product?.available_qty
    ?? variant.stockQuantity
    ?? product?.stockQuantity
    ?? product?.totalAvailableStock
    ?? product?.stock;
  const parsedStock = stockRaw === undefined || stockRaw === null
    ? null
    : Number(stockRaw);
  const parsedStockQuantity = parsedStock !== null && Number.isFinite(parsedStock)
    ? parsedStock
    : null;
  const inStockFlag = variant.in_stock ?? product?.in_stock;
  const stockPolicy = {
    item_type: variant.item_type
      ?? variant.itemType
      ?? product?.item_type
      ?? product?.itemType
      ?? product?.product_type
      ?? product?.productType
      ?? template.item_type
      ?? template.itemType
      ?? template.product_type
      ?? template.productType,
    track_inventory: variant.track_inventory
      ?? variant.trackInventory
      ?? product?.track_inventory
      ?? product?.trackInventory
      ?? template.track_inventory
      ?? template.trackInventory,
    category_id: variant.category_id
      ?? variant.categoryId
      ?? product?.category_id
      ?? product?.categoryId,
  };
  const stockTracked = stockPolicy.category_id !== 'cat-5' && isStockTracked(stockPolicy);
  // Stock has no meaning for services/non-tracked products, so omit the badge
  // instead of rendering a misleading neutral "0".
  const stock = stockTracked ? parsedStockQuantity : null;
  const effectiveStock = parsedStockQuantity ?? inStockFlag;
  const hasStock = effectiveStock === undefined || effectiveStock === null
    ? true
    : !isSaleBlockedByStock(stockPolicy, effectiveStock);

  return {
    variantId: variant.id || product?.variantId || product?.id,
    name: product?.name || variant.name || 'Item',
    price,
    stock,
    hasStock,
  };
}

export function isBilliardNetworkError(error: any): boolean {
  // The API client wraps a network failure during token refresh so callers do
  // not mistake it for an authentication rejection. Preserve that transport
  // meaning for billiard queue/availability decisions.
  if (error?.name === 'AuthRefreshNetworkError') return true;
  if (Number.isInteger(error?.status)) return false;
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return message.includes('fetch')
    || message.includes('network')
    || message.includes('econnrefused')
    || message.includes('timeout')
    || message.includes('abort')
    || message.includes('socket');
}

export function isAllowedBilliardMutation(method: string, path: string): boolean {
  return findBilliardMutationRule(method, path) !== null;
}

/** Queue policy belongs to the HTTP route and cannot be relaxed by renderer input. */
export function getBilliardMutationPolicy(
  method: string,
  path: string,
): BilliardMutationPolicy | null {
  return findBilliardMutationRule(method, path)?.policy ?? null;
}

/** Bind the renderer-supplied operation label to its exact allowlisted route. */
export function isAllowedBilliardOperation(
  operation: string,
  method: string,
  path: string,
): boolean {
  return findBilliardMutationRule(method, path)?.operation === operation;
}
