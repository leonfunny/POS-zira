import type { AgentConfig } from './types';

export type PosMode = NonNullable<AgentConfig['posMode']>;
export type RestaurantOrderType = 'dine_in' | 'takeout' | 'delivery';
export interface RestaurantSaleContext { tableId: string | null; orderType: RestaurantOrderType }

export function restaurantSaleContext(state: CheckoutContext): RestaurantSaleContext {
  return { tableId: state.activeTable ?? null, orderType: state.checkoutDraft.restaurant?.orderType ?? 'dine_in' };
}

export function matchesRestaurantSaleContext(state: CheckoutContext, expected: RestaurantSaleContext): boolean {
  const current = restaurantSaleContext(state);
  return current.tableId === expected.tableId && current.orderType === expected.orderType;
}

export function canAddRestaurantItem(state: CheckoutContext, tables: readonly { id: string }[]): boolean {
  const { tableId, orderType } = restaurantSaleContext(state);
  if (orderType !== 'dine_in') return tableId === null;
  return tableId ? tables.some(table => table.id === tableId) : tables.length === 0;
}

export function isPosMode(value: unknown): value is PosMode {
  return typeof value === 'string' && ['retail', 'salon', 'b2b', 'restaurant'].includes(value);
}

/** Preserve legacy settings only for their original tenant, never for a new one. */
export function resolveSalonPosMode(
  previous: Pick<AgentConfig, 'salonId' | 'posMode' | 'posModeSalonId' | 'posModesBySalon'>,
  salonId: string,
  suggested: unknown,
): Pick<AgentConfig, 'posMode' | 'posModeSalonId' | 'posModesBySalon'> {
  const saved = { ...previous.posModesBySalon };
  if (!previous.posModeSalonId && previous.salonId && isPosMode(previous.posMode)
    && !Object.prototype.hasOwnProperty.call(saved, previous.salonId)) {
    saved[previous.salonId] = previous.posMode;
  }
  const remembered = Object.prototype.hasOwnProperty.call(saved, salonId) ? saved[salonId] : undefined;
  const posMode = isPosMode(remembered) ? remembered : isPosMode(suggested) ? suggested : 'retail';
  // Do not remember a network-error fallback as the salon's chosen mode.
  if (isPosMode(remembered) || isPosMode(suggested)) saved[salonId] = posMode;
  return { posMode, posModeSalonId: salonId, posModesBySalon: saved };
}

interface CheckoutContext {
  cart: { items: unknown[] };
  checkoutDraft: {
    billiard?: unknown;
    restoredInterruption?: unknown;
    holdRecallPending?: unknown;
    kitchenSelfOrder?: unknown;
    restaurant?: { orderType: RestaurantOrderType };
  };
  activeTable?: string | null;
}

export function hasActivePosCheckout(state: CheckoutContext): boolean {
  return state.cart.items.length > 0 || Boolean(state.checkoutDraft.billiard
    || state.checkoutDraft.restoredInterruption || state.checkoutDraft.holdRecallPending
    || state.checkoutDraft.kitchenSelfOrder);
}

export function canChangeRestaurantContext(
  state: CheckoutContext,
  tableId: string | null,
  orderType?: RestaurantOrderType,
): boolean {
  const sameTable = (state.activeTable ?? null) === tableId;
  const sameOrderType = !orderType || (state.checkoutDraft.restaurant?.orderType ?? 'dine_in') === orderType;
  return (sameTable && sameOrderType) || !hasActivePosCheckout(state);
}
