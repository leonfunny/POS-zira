/**
 * Verify that a COMMITTED local order really is the frozen billiard checkout.
 *
 * Lifted out of src/main/modules/pos.module.ts (which now imports it) so the
 * tablet applies byte-identical scrutiny. This runs at the moment the money is
 * already collected and the cart is about to be cleared: if the order on disk
 * disagrees with the server's frozen allocation in ANY field, clearing the cart
 * would destroy the only remaining evidence of what was owed. So it throws
 * instead, and the cashier keeps a cart to reconcile from.
 *
 * Row shapes are the snake_case SQLite rows both platforms store (the same
 * INSERT the shared PaymentModal feeds).
 */

import type {
  BilliardCartLineMetadata,
  BilliardPosCheckoutBundle,
  BilliardPosCheckoutLine,
  PosCheckoutSnapshot,
} from '../billiard-pos-handoff';

export interface BilliardOrderVerificationRecord {
  orderId: string;
  checkoutId: string;
  sessionId: string;
  clientAttemptId: string;
  bundle: BilliardPosCheckoutBundle;
  checkoutSnapshot: PosCheckoutSnapshot;
}

/** The exact line metadata the frozen cart carries (pos.module.ts:253-268). */
export function billiardLineMetadata(line: BilliardPosCheckoutLine): BilliardCartLineMetadata {
  return {
    kind: line.kind,
    sessionItemId: line.sessionItemId,
    lineKey: line.lineKey,
    durationMinutes: line.durationMinutes,
    displayName: line.displayName,
    inventoryPolicy: line.inventoryPolicy,
    refundPolicy: line.refundPolicy,
    sellBy: line.sellBy,
    saleUnit: line.saleUnit,
    grossTotalGrosze: line.grossTotalGrosze,
    allocatedDiscountGrosze: line.allocatedDiscountGrosze,
    payableGrosze: line.payableGrosze,
  };
}

/** pos.module.ts:270-278 — unreadable metadata is a hard failure, never `{}`. */
export function parseBilliardJson(value: unknown, label: string): Record<string, any> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, any>;
  } catch {
    throw new Error(`Invalid ${label} Billiard metadata.`);
  }
}

/**
 * Every money field of the committed order must equal the frozen allocation
 * (pos.module.ts assertBilliardOrderLines).
 */
export function assertBilliardOrderLines(
  record: BilliardOrderVerificationRecord,
  order: Record<string, any>,
  items: Array<Record<string, any>>,
): void {
  const savedCart = (record.checkoutSnapshot.state as any)?.cart;
  const expectedSubtotal = record.bundle.lines.reduce((sum, line) => sum + line.grossTotalGrosze, 0);
  if (
    String(order.id || '') !== record.orderId
    || String(order.client_attempt_id || '') !== record.clientAttemptId
    || Number(order.subtotal) !== expectedSubtotal
    || Number(order.discount || 0) !== record.bundle.discountGrosze
    || Number(order.tax || 0) !== Number(savedCart?.tax || 0)
    || Number(order.total) !== record.bundle.totalGrosze
    || items.length !== record.bundle.lines.length
  ) {
    throw new Error('Billiard order totals or identity do not match the frozen checkout.');
  }

  const byLineKey = new Map<string, Record<string, any>>();
  for (const item of items) {
    const metadata = parseBilliardJson(item.billiard_json, 'order-line');
    const lineKey = String(metadata.lineKey || '');
    if (!lineKey || byLineKey.has(lineKey)) {
      throw new Error('Billiard order contains a missing or duplicate line key.');
    }
    byLineKey.set(lineKey, item);
  }

  for (const line of record.bundle.lines) {
    const item = byLineKey.get(line.lineKey);
    if (!item) throw new Error(`Billiard order is missing frozen line ${line.lineKey}.`);
    const metadata = parseBilliardJson(item.billiard_json, 'order-line');
    const expectedMetadata = billiardLineMetadata(line);
    if (
      JSON.stringify(metadata) !== JSON.stringify(expectedMetadata)
      || String(item.id || '') !== `${record.orderId}:${line.lineKey}`
      || String(item.order_id || '') !== record.orderId
      || String(item.variant_id || '') !== line.variantId
      || String(item.name || '') !== line.displayName
      || String(item.sku ?? '') !== String(line.sku ?? '')
      || Number(item.price) !== line.unitPriceGrosze
      || Number(item.quantity) !== line.quantity
      || Number(item.sale_quantity ?? item.quantity) !== line.quantity
      || String(item.sell_by || '') !== line.sellBy
      || String(item.sale_unit || '') !== line.saleUnit
      || Number(item.total) !== line.grossTotalGrosze
      || Number(item.vat_rate) !== line.vatRate
      || String(item.inventory_policy || '') !== line.inventoryPolicy
      || String(item.refund_policy || '') !== line.refundPolicy
      || Number(item.allocated_discount || 0) !== line.allocatedDiscountGrosze
      || Number(item.payable_total) !== line.payableGrosze
    ) {
      throw new Error(`Billiard order line ${line.lineKey} differs from the frozen server snapshot.`);
    }
  }
}

/**
 * The committed order must also carry the billiard ORIGIN that ties it to this
 * session (pos.module.ts assertExistingBilliardOrder). Callers pass the row they
 * already read; a missing row is the caller's own failure to report.
 */
export function assertCommittedBilliardOrder(
  record: BilliardOrderVerificationRecord,
  order: Record<string, any> | null | undefined,
  items: Array<Record<string, any>>,
): void {
  if (!order) throw new Error('Committed Billiard order is missing locally.');
  let origin: Record<string, any>;
  try {
    origin = JSON.parse(String(order.billiard_origin_json || ''));
  } catch {
    throw new Error('Committed Billiard order has invalid origin metadata.');
  }
  if (
    String(order.client_attempt_id || '') !== record.clientAttemptId
    || origin.type !== 'BILLIARD_SESSION'
    || origin.checkoutId !== record.checkoutId
    || origin.sessionId !== record.sessionId
    || Number(origin.snapshotVersion) !== record.bundle.schemaVersion
  ) {
    throw new Error('Existing local order conflicts with the Billiard checkout identity.');
  }
  assertBilliardOrderLines(record, order, items);
}
