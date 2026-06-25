/**
 * Pure reducer for the cashier pickup-order waiting list. Kept side-effect-free
 * so the merge rules (which socket events add/update/remove a row, ordering)
 * are unit-testable without React or IPC.
 */

export type PickupOrderStatus = 'PENDING' | 'CLAIMED' | 'SETTLED' | 'CANCELLED';
export type PickupOrderKitchenPrintStatus = 'PENDING' | 'PRINTED' | 'UNCERTAIN' | 'FAILED';

export interface PickupOrderRow {
  id: string;
  sourceOrderId?: string | null;
  orderNumber: string;
  sequence?: number;
  totalGrosze?: number;
  status: PickupOrderStatus;
  kitchenPrintStatus?: PickupOrderKitchenPrintStatus | null;
  kitchenPrintError?: string | null;
  kitchenPrintUpdatedAt?: string | null;
  claimedByMachineId?: string | null;
  payload?: any;
}

function isOpen(status: unknown): boolean {
  return status === 'PENDING' || status === 'CLAIMED';
}

function bySequence(a: PickupOrderRow, b: PickupOrderRow): number {
  return (a.sequence ?? 0) - (b.sequence ?? 0);
}

/** Seed the list from `GET /open`, keeping only non-terminal rows, ordered. */
export function seedPickupOrders(rows: PickupOrderRow[] | null | undefined): PickupOrderRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r && r.id && isOpen(r.status)).sort(bySequence);
}

/**
 * Apply one `pickup-order:*` socket event to the list.
 * - settled / cancelled → remove the row (terminal),
 * - new / claimed / released → upsert (merge fields), drop if it became terminal.
 * A row claimed by another station stays visible (status CLAIMED + its
 * claimedByMachineId) so the UI can show it as busy; the claiming station
 * removes it locally after a successful claim.
 */
export function mergePickupEvent(
  prev: PickupOrderRow[],
  msg: { event: string; data: any },
): PickupOrderRow[] {
  const data = msg?.data;
  if (!data?.id) return prev;
  const without = prev.filter((r) => r.id !== data.id);

  if (msg.event === 'settled' || msg.event === 'cancelled') return without;

  const existing = prev.find((r) => r.id === data.id);
  const merged: PickupOrderRow = { ...existing, ...data };
  if (!isOpen(merged.status)) return without;
  return [...without, merged].sort(bySequence);
}

/** Remove a row locally (e.g. after this station claims/loads it). */
export function removePickupOrder(prev: PickupOrderRow[], id: string): PickupOrderRow[] {
  return prev.filter((r) => r.id !== id);
}
