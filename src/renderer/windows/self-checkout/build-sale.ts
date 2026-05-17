// Pure helpers that turn a self-checkout cart + payment selection into the
// `pos:orders:create` IPC payload. Extracted from SelfCheckoutApp so smoke
// tests and unit tests can exercise the order-shape logic without mounting
// React.
//
// Money is stored as integer grosze everywhere — never floats. Prices are
// tax-inclusive (brutto), matching the main POS contract: subtotal = gross
// total, tax = included VAT amount.

import type { ScCartItem } from './useScCart';
import type { PaymentMethod } from './screens/PaymentScreen';

export interface SelfCheckoutOrder {
  id: string;
  order_number: string | null;
  status: 'COMPLETED';
  subtotal: number;
  discount: 0;
  tax: number;
  total: number;
  payment_method: PaymentMethod;
  payment_amount: number;
  change_amount: 0;
  staff_id: string | null;
  staff_name: string;
  customer_id: null;
  customer_name: null;
  customer_nip: string | null;
  shift_id: null;
  source: 'SELF_CHECKOUT';
  table_id: null;
  covers: null;
  order_type: 'standard';
  tip: 0;
  mode: 'retail';
  synced: 0;
  backend_id: null;
  created_at: string;
  synced_at: null;
  payment_tenders: null;
}

export interface SelfCheckoutOrderItem {
  id: string;
  order_id: string;
  variant_id: string | null;
  name: string;
  sku: string | null;
  price: number;
  quantity: number;
  total: number;
  vat_rate: number;
  staff_id: string | null;
  staff_name: string;
  notes: string | null;
  course: null;
}

export interface SelfCheckoutSale {
  order: SelfCheckoutOrder;
  items: SelfCheckoutOrderItem[];
}

const STAFF_NAME = 'Self-checkout';

export function calculateIncludedTax(items: ScCartItem[]): number {
  return items.reduce((sum, item) => {
    const rate = item.vatRate ?? 0;
    if (rate <= 0) return sum;
    const lineGross = item.price * item.quantity;
    return sum + Math.round(lineGross - lineGross * 100 / (100 + rate));
  }, 0);
}

// `randomId` is injected so tests / smoke scripts can produce deterministic
// payloads. Default to crypto.randomUUID() at runtime.
export interface BuildSaleOptions {
  items: ScCartItem[];
  orderId: string;
  method: PaymentMethod;
  kioskUserId: string | null;
  /** Polish NIP for B2B invoice (paragon → faktura). Must be set BEFORE
   *  fiscal print — server cannot retrofit NIP onto an already-printed
   *  receipt under Polish fiscal law. */
  customerNip?: string | null;
  now?: Date;
  randomId?: () => string;
}

export function buildSelfCheckoutSale({
  items,
  orderId,
  method,
  kioskUserId,
  customerNip = null,
  now = new Date(),
  randomId = () => crypto.randomUUID(),
}: BuildSaleOptions): SelfCheckoutSale {
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const order: SelfCheckoutOrder = {
    id: orderId,
    order_number: null,
    status: 'COMPLETED',
    subtotal: total,
    discount: 0,
    tax: calculateIncludedTax(items),
    total,
    payment_method: method,
    payment_amount: total,
    change_amount: 0,
    staff_id: kioskUserId,
    staff_name: STAFF_NAME,
    customer_id: null,
    customer_name: null,
    customer_nip: customerNip ?? null,
    shift_id: null,
    source: 'SELF_CHECKOUT',
    table_id: null,
    covers: null,
    order_type: 'standard',
    tip: 0,
    mode: 'retail',
    synced: 0,
    backend_id: null,
    created_at: now.toISOString(),
    synced_at: null,
    payment_tenders: null,
  };

  const orderItems: SelfCheckoutOrderItem[] = items.map((item) => ({
    id: randomId(),
    order_id: orderId,
    variant_id: item.isBagFee ? null : item.variantId,
    name: item.name,
    sku: item.sku || null,
    price: item.price,
    quantity: item.quantity,
    total: item.price * item.quantity,
    vat_rate: item.vatRate ?? 23,
    staff_id: kioskUserId,
    staff_name: STAFF_NAME,
    notes: item.isBagFee ? 'SELF_CHECKOUT_BAG_FEE' : null,
    course: null,
  }));

  return { order, items: orderItems };
}
