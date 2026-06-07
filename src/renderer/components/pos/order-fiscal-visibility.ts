// Fiscal-visibility filter for Order History. Local rows carry the
// SQL-computed `has_fiscal` (EXISTS over fiscal_attempts SUCCESS_CONFIRMED);
// server-sourced rows don't — for those the caller looks the ids up in the
// local fiscal journal and passes the confirmed set here. Unknown rows that
// are NOT in the confirmed set are hidden: the toggle's contract is "history
// shows only fiscally-confirmed sales", so an unverifiable row must not leak
// through (the old `o.has_fiscal !== 0` let every server row pass because
// undefined !== 0).
export interface FiscalVisibilityOrder {
  id: string;
  has_fiscal?: number;
}

export interface HistoryDisplayOrder {
  id: string;
  order_number: string | null;
}

export function applyFiscalVisibility<T extends FiscalVisibilityOrder>(
  orders: T[],
  hideNonFiscal: boolean,
  confirmedFiscalIds: ReadonlySet<string>,
): T[] {
  if (!hideNonFiscal) return orders;
  return orders.filter((order) => {
    if (typeof order.has_fiscal === 'number') return order.has_fiscal !== 0;
    return confirmedFiscalIds.has(order.id);
  });
}

export function getRealHistoryOrderNumber(order: HistoryDisplayOrder): string {
  return order.order_number || order.id.substring(0, 8);
}

export function getHistoryDisplayNumber(
  order: HistoryDisplayOrder,
  sortedIndex: number,
  fiscalOnly: boolean,
  totalVisibleOrders?: number,
): string {
  if (!fiscalOnly) return getRealHistoryOrderNumber(order);
  const safeIndex = Math.max(0, Math.floor(sortedIndex));
  const safeTotal = typeof totalVisibleOrders === 'number' && isFinite(totalVisibleOrders)
    ? Math.max(0, Math.floor(totalVisibleOrders))
    : 0;
  const ordinal = safeTotal > 0
    ? Math.max(1, safeTotal - safeIndex)
    : safeIndex + 1;
  const sequence = String(ordinal).padStart(3, '0');
  return `FISCAL #${sequence}`;
}
