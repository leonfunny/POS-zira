/**
 * Billiard salons: mirror finished POS-tab retail orders into the billiard
 * ledger (server quick-sale), so counter retail shows up in the billiard
 * history/report exactly like web-made retail. Pure builder — the caller
 * gates on the billiard entitlement and ships the payload through the
 * queue-safe mutation path (server is idempotent on paymentAttemptId).
 *
 * Deliberately mirrored is NOTHING that came from a billiard table handoff:
 * that money already lives in the billiard ledger as the session itself.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface RetailMirrorOrder {
  id: string;
  status?: string | null;
  payment_method?: string | null;
  customer_name?: string | null;
  client_attempt_id?: string | null;
  billiard_origin_json?: string | null;
}

export interface RetailMirrorOrderItem {
  name: string;
  quantity: number;
  /** grosze */
  price: number;
  billiard_json?: string | null;
}

export interface RetailMirrorPayload {
  items: Array<{ name: string; quantity: number; unitPrice: number }>;
  paymentMethod: 'CASH' | 'CARD' | 'BLIK' | 'TRANSFER';
  paymentAttemptId: string;
  customerName?: string;
  sourceRef: string;
}

function mapPaymentMethod(raw: string | null | undefined): RetailMirrorPayload['paymentMethod'] | null {
  const method = String(raw ?? '').toUpperCase();
  if (method === 'CASH') return 'CASH';
  if (method === 'CARD') return 'CARD';
  if (method === 'BLIK') return 'BLIK';
  if (method === 'TRANSFER' || method === 'BANK_TRANSFER' || method === 'INVOICE') return 'TRANSFER';
  return null;
}

/** Returns null when the order must not be mirrored. */
export function buildRetailMirrorPayload(
  order: RetailMirrorOrder,
  items: RetailMirrorOrderItem[],
): RetailMirrorPayload | null {
  // Table-handoff orders are the billiard session's own money.
  if (order.billiard_origin_json) return null;

  const paymentMethod = mapPaymentMethod(order.payment_method);
  if (!paymentMethod) return null;

  const attemptCandidate = [order.client_attempt_id, order.id]
    .find((value) => typeof value === 'string' && UUID_RE.test(value));
  if (!attemptCandidate) return null;

  const mirrorItems = (items ?? [])
    .filter((item) => !item.billiard_json)
    .filter((item) => Number(item.quantity) > 0 && String(item.name ?? '').trim() !== '')
    .map((item) => ({
      name: String(item.name),
      quantity: Number(item.quantity),
      // Local order lines are stored in grosze; the server DTO takes złoty.
      unitPrice: Math.round(Number(item.price)) / 100,
    }))
    .filter((item) => item.unitPrice >= 0);
  if (mirrorItems.length === 0) return null;

  return {
    items: mirrorItems,
    paymentMethod,
    paymentAttemptId: attemptCandidate,
    customerName: order.customer_name?.trim() || undefined,
    sourceRef: order.id,
  };
}
