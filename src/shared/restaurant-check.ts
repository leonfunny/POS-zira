import type { PosCheckoutSnapshot } from './billiard-pos-handoff';
import { isValidSaleQuantity, normalizeSellBy } from './pos-sale';

export type RestaurantCheckScope = PosCheckoutSnapshot['scope'];
export type RestaurantCheckStatus = 'SAVED' | 'OPEN' | 'PAYMENT_PENDING' | 'PAYMENT_UNCERTAIN' | 'PAID' | 'CANCELLED';
export interface RestaurantCheck {
  id: string;
  scope: RestaurantCheckScope;
  revision: number;
  status: RestaurantCheckStatus;
  tableId: string | null;
  covers: number;
  snapshot: PosCheckoutSnapshot;
  orderId: string | null;
  paymentAttemptId: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

// Shared SQL for the Windows migration and a future Android adapter. No device
// imports here. Operational table status is local, not a backend table mutation.
export const RESTAURANT_CHECK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pos_restaurant_checks (
    id TEXT PRIMARY KEY,
    salon_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    register_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN ('SAVED','OPEN','PAYMENT_PENDING','PAYMENT_UNCERTAIN','PAID','CANCELLED')),
    table_id TEXT,
    covers INTEGER NOT NULL CHECK (covers >= 0),
    snapshot_json TEXT NOT NULL,
    order_id TEXT,
    payment_attempt_id TEXT,
    cancellation_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_restaurant_checks_scope
    ON pos_restaurant_checks(salon_id, user_id, register_id, status, updated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_checks_open_table
    ON pos_restaurant_checks(salon_id, register_id, table_id)
    WHERE table_id IS NOT NULL AND status NOT IN ('PAID','CANCELLED');
  CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_checks_active_register
    ON pos_restaurant_checks(salon_id, register_id)
    WHERE status IN ('OPEN','PAYMENT_PENDING','PAYMENT_UNCERTAIN');
  CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_checks_payment_attempt
    ON pos_restaurant_checks(salon_id, register_id, payment_attempt_id)
    WHERE payment_attempt_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_checks_order
    ON pos_restaurant_checks(salon_id, register_id, order_id)
    WHERE order_id IS NOT NULL;
`;

export function validateRestaurantCheckScope(scope: RestaurantCheckScope): void {
  if (!scope || ![scope.salonId, scope.userId, scope.registerId].every(value => typeof value === 'string' && value.trim().length > 0)) {
    throw new Error('RESTAURANT_SCOPE_REQUIRED');
  }
}

export function validateRestaurantCheckSnapshot(snapshot: PosCheckoutSnapshot, scope: RestaurantCheckScope, covers: number): void {
  validateRestaurantCheckScope(scope);
  if (snapshot?.schemaVersion !== 1 || snapshot.posMode !== 'restaurant'
    || snapshot.scope?.salonId !== scope.salonId || snapshot.scope?.userId !== scope.userId || snapshot.scope?.registerId !== scope.registerId) {
    throw new Error('RESTAURANT_SNAPSHOT_SCOPE_MISMATCH');
  }
  const state = snapshot.state;
  if (!Number.isSafeInteger(covers) || covers < 0) throw new Error('RESTAURANT_INVALID_COVERS');
  const orderType = state?.checkoutDraft?.restaurant?.orderType ?? 'dine_in';
  const table = state?.activeTable ?? null;
  if (!['dine_in', 'takeout', 'delivery'].includes(orderType)
    || (table !== null && (typeof table !== 'string' || !table.trim() || orderType !== 'dine_in'))) {
    throw new Error('RESTAURANT_INVALID_CONTEXT');
  }
  if (!Array.isArray(state?.cart?.items) || state.cart.items.length === 0
    || state.checkoutDraft?.billiard || state.checkoutDraft?.restoredInterruption
    || state.checkoutDraft?.holdRecallPending || state.checkoutDraft?.kitchenSelfOrder
    || state.cart.items.some((item: any) => !item || item.locked || item.billiard)) {
    throw new Error('RESTAURANT_UNSAFE_SNAPSHOT');
  }
  const money = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  const ids = new Set<string>();
  if (!money(state.cart.total) || !money(state.cart.subtotal)
    || state.cart.items.some((item: any) => {
      if (typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) return true;
      ids.add(item.id);
      return typeof item.variantId !== 'string' || !item.variantId.trim()
        || !money(item.price) || !money(item.total) || item.quantity <= 0
        || !isValidSaleQuantity(item.quantity, normalizeSellBy(item.sellBy));
    })) throw new Error('RESTAURANT_INVALID_CART');
}
