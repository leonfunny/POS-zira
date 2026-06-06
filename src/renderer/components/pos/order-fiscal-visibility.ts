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
