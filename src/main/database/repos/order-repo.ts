import { database } from '../database';
import logger from '../../logger';
import { buildBackendOrderItem, getLineSaleQuantity, getLineSaleUnit, getLineSellBy, getLineTotalGrosze } from '../../pos/order-line-contract';
import { adaptServerOrderItem } from '../../sync/pos-order-adapter';
import { allocateRefundTenders } from '../../pos/refund-backend-payload';
import { posEventEmitter } from '../../events/pos-event-emitter';
import { STOCK_TRACKED_GUARD_SQL } from './product-repo';
import { receiptPrintOutboxRepo } from './receipt-print-outbox-repo';

export interface OrderRow {
  id: string;
  order_number: string | null;
  status: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  payment_method: string | null;
  payment_amount: number;
  change_amount: number;
  staff_id: string | null;
  staff_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_nip: string | null;
  shift_id: string | null;
  source: string;
  synced: number;
  backend_id: string | null;
  created_at: string;
  synced_at: string | null;
  // Mode-specific fields (v2)
  table_id: string | null;
  covers: number | null;
  order_type: string | null;    // 'standard' | 'dine_in' | 'takeout' | 'delivery'
  tip: number | null;            // grosze
  mode: string | null;           // 'retail' | 'salon' | 'b2b' | 'restaurant'
  // Payment & sync
  payment_tenders: string | null; // JSON array of {method, amount}
  sync_attempts: number;
  sync_error: string | null;
  // Refund
  refund_amount: number | null;
  refund_reason: string | null;
  refunded_at: string | null;
  refund_lines: string | null;
  has_fiscal?: number;
  /** Daily kitchen pickup number ('0001'...) — set when the order has kitchen items. */
  kitchen_number?: string | null;
  /** Input-only hint for number generation (NOT a column): which daily
   *  series this order belongs to. Default FISCAL. */
  number_series?: 'FISCAL' | 'ORDER' | null;
  client_attempt_id?: string | null;
  billiard_origin_json?: string | null;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  variant_id: string | null;
  name: string;
  sku: string | null;
  price: number;
  quantity: number;
  sale_quantity?: number | null;
  sale_unit?: string | null;
  sell_by?: string | null;
  total: number;
  vat_rate: number;
  // Mode-specific fields (v2)
  staff_id: string | null;
  staff_name: string | null;
  notes: string | null;
  course: number | null;
  billiard_json?: string | null;
  inventory_policy?: string | null;
  refund_policy?: string | null;
  allocated_discount?: number | null;
  payable_total?: number | null;
}

export interface OrderMutationItemInput {
  id: string;
  variant_id?: string | null;
  name: string;
  sku?: string | null;
  price: number;
  quantity: number;
  sale_quantity?: number | null;
  sale_unit?: string | null;
  sell_by?: string | null;
  vat_rate: number;
  staff_id?: string | null;
  staff_name?: string | null;
  notes?: string | null;
  course?: number | null;
}

export interface OrderMutationInput {
  paymentMethod?: string | null;
  paymentAmount?: number;
  changeAmount?: number;
  items?: OrderMutationItemInput[];
}

export interface RefundCashflowStats {
  refund_count: number;
  refund_total: number;
  cash_refund_total: number;
  card_refund_total: number;
  blik_refund_total: number;
  transfer_refund_total: number;
}

export interface DailyStats {
  order_count: number;
  total_sales: number;
  cash_total: number;
  card_total: number;
  refund_count: number;
  refund_total: number;
}

export interface OrderHistoryOptions {
  fiscalOnly?: boolean;
  paymentMethod?: string;
  staffName?: string;
}

export interface ServerMirroredGrossItemRepairResult {
  scanned: number;
  repaired: number;
  skipped: number;
  skipped_reasons: Record<string, number>;
}

export interface ServerOrderUpsertOptions {
  /** The caller already owns the sql.js transaction containing this upsert. */
  callerOwnsTransaction?: boolean;
}

function runServerOrderMutation<T>(
  options: ServerOrderUpsertOptions | undefined,
  mutation: () => T,
): T {
  return options?.callerOwnsTransaction
    ? mutation()
    : database.transaction(mutation);
}

type ServerMirroredGrossRepairCandidate = {
  id: string;
  order_number: string | null;
  backend_id: string | null;
  source: string | null;
  total: number;
  discount: number | null;
  local_sum: number | null;
  payload: string | null;
};

type LocalItemRepairRow = {
  id: string;
  total: number;
};

const HAS_FISCAL_EXPR = `
  EXISTS (
    SELECT 1
    FROM fiscal_attempts fa
    WHERE fa.order_id = orders.id
      AND fa.status = 'SUCCESS_CONFIRMED'
  )
`;

type RefundEventCashflowRow = {
  event_id: string;
  local_order_id: string | null;
  payload_json: string;
};

type LegacyRefundCashflowRow = {
  id: string;
  refund_amount: number | null;
  payment_method: string | null;
  payment_tenders: string | null;
};

type DailyGrossCashflowRow = {
  total: number;
  payment_method: string | null;
  payment_tenders: string | null;
};

function emptyRefundCashflowStats(): RefundCashflowStats {
  return {
    refund_count: 0,
    refund_total: 0,
    cash_refund_total: 0,
    card_refund_total: 0,
    blik_refund_total: 0,
    transfer_refund_total: 0,
  };
}

function addRefundTender(stats: RefundCashflowStats, method: string, amount: number): void {
  switch (String(method || '').toUpperCase()) {
    case 'CASH':
      stats.cash_refund_total += amount;
      break;
    case 'CARD':
      stats.card_refund_total += amount;
      break;
    case 'BLIK':
      stats.blik_refund_total += amount;
      break;
    case 'TRANSFER':
    case 'BANK_TRANSFER':
    case 'INVOICE':
      stats.transfer_refund_total += amount;
      break;
  }
}

function addRefundCashflow(
  stats: RefundCashflowStats,
  amountValue: unknown,
  fallbackMethod: string | null | undefined,
  tenderAllocations?: unknown,
): number {
  const amount = Math.round(Number(amountValue));
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const rawTenders = Array.isArray(tenderAllocations)
    ? tenderAllocations.map((tender: any) => ({
        method: tender?.method,
        amount: tender?.amountMinor ?? tender?.amount,
      }))
    : [];
  const tenders = allocateRefundTenders(
    rawTenders.length > 0 ? JSON.stringify(rawTenders) : null,
    amount,
    fallbackMethod,
  );

  stats.refund_count += 1;
  stats.refund_total += amount;
  for (const tender of tenders) addRefundTender(stats, tender.method, tender.amount);
  return amount;
}

function parseRefundEventPayload(row: RefundEventCashflowRow): Record<string, any> | null {
  try {
    const payload = JSON.parse(row.payload_json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function refundEventFactKey(
  row: RefundEventCashflowRow,
  payload: Record<string, any>,
): string {
  const itemRequestId = Array.isArray(payload.items)
    ? payload.items.find((item: any) => item?.refundRequestId)?.refundRequestId
    : null;
  const refundId = payload.refundRequestId
    || itemRequestId
    || payload.refundId
    || row.event_id;
  return `${row.local_order_id || 'unknown-order'}:${String(refundId)}`;
}

function queryRefundCashflow(
  eventTimeSql: string,
  eventTimeParams: unknown[],
  orderTimeSql: string,
  orderTimeParams: unknown[],
  fiscalOnly: boolean,
): RefundCashflowStats {
  const stats = emptyRefundCashflowStats();
  const fiscalEventSql = fiscalOnly
    ? `AND EXISTS (
         SELECT 1 FROM fiscal_attempts fa
         WHERE fa.order_id = e.local_order_id
           AND fa.status = 'SUCCESS_CONFIRMED'
       )`
    : '';
  const events = database.all<RefundEventCashflowRow>(
    `SELECT e.event_id, e.local_order_id, e.payload_json
     FROM pos_event_outbox e
     WHERE e.event_type = 'RefundIssued'
       AND ${eventTimeSql}
       ${fiscalEventSql}`,
    eventTimeParams,
  ) ?? [];

  const seenFacts = new Set<string>();
  for (const event of events) {
    const payload = parseRefundEventPayload(event);
    if (!payload) continue;
    const factKey = refundEventFactKey(event, payload);
    if (seenFacts.has(factKey)) continue;
    seenFacts.add(factKey);
    addRefundCashflow(
      stats,
      payload.amountMinor,
      payload.method,
      payload.tenderAllocations,
    );
  }

  // Compatibility fallback for app versions that predate RefundIssued, or for
  // a partially journaled cumulative refund. Only the residual is synthesized,
  // so a real immutable event is never counted twice.
  const legacy = database.all<LegacyRefundCashflowRow>(
    `SELECT orders.id, orders.refund_amount, orders.payment_method, orders.payment_tenders
     FROM orders
     WHERE COALESCE(orders.refund_amount, 0) > 0
       AND ${orderTimeSql}
       ${fiscalOnly ? `AND ${HAS_FISCAL_EXPR}` : ''}`,
    orderTimeParams,
  ) ?? [];
  const legacyOrderIds = Array.from(new Set(legacy.map((refund) => refund.id)));
  const allJournalRows = legacyOrderIds.length > 0
    ? database.all<RefundEventCashflowRow>(
        `SELECT e.event_id, e.local_order_id, e.payload_json
         FROM pos_event_outbox e
         WHERE e.event_type = 'RefundIssued'
           AND e.local_order_id IN (${legacyOrderIds.map(() => '?').join(', ')})`,
        legacyOrderIds,
      ) ?? []
    : [];
  const journaledByOrder = new Map<string, number>();
  const allSeenFacts = new Set<string>();
  for (const event of allJournalRows) {
    if (!event.local_order_id) continue;
    const payload = parseRefundEventPayload(event);
    if (!payload) continue;
    const factKey = refundEventFactKey(event, payload);
    if (allSeenFacts.has(factKey)) continue;
    allSeenFacts.add(factKey);
    const amount = Math.round(Number(payload?.amountMinor));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    journaledByOrder.set(
      event.local_order_id,
      (journaledByOrder.get(event.local_order_id) ?? 0) + amount,
    );
  }

  for (const refund of legacy) {
    const cumulative = Math.max(0, Math.round(Number(refund.refund_amount) || 0));
    const residual = Math.max(0, cumulative - (journaledByOrder.get(refund.id) ?? 0));
    if (residual <= 0) continue;
    let tenderAllocations: unknown = undefined;
    try {
      tenderAllocations = refund.payment_tenders
        ? JSON.parse(refund.payment_tenders)
        : undefined;
    } catch {
      tenderAllocations = undefined;
    }
    addRefundCashflow(stats, residual, refund.payment_method, tenderAllocations);
  }

  return stats;
}

const HISTORY_SPLIT_PAYMENT_EXPR = `(
  orders.payment_method = 'SPLIT'
  OR COALESCE(orders.payment_tenders, '') LIKE '%},{%'
  OR COALESCE(orders.payment_tenders, '') LIKE '%}, {%'
)`;

function normalizeHistoryPaymentMethod(method: string | null | undefined): string | null {
  if (!method) return null;
  return method === 'TRANSFER' ? 'BANK_TRANSFER' : method;
}

function buildHistoryWhere(from: string, to: string, options: OrderHistoryOptions): { sql: string; params: any[] } {
  const parts = [
    'date(orders.created_at) >= date(?)',
    'date(orders.created_at) <= date(?)',
  ];
  const params: any[] = [from, to];

  if (options.fiscalOnly) {
    parts.push(HAS_FISCAL_EXPR);
  }

  const paymentMethod = normalizeHistoryPaymentMethod(options.paymentMethod);
  if (paymentMethod === 'SPLIT') {
    parts.push(HISTORY_SPLIT_PAYMENT_EXPR);
  } else if (paymentMethod === 'INVOICE') {
    parts.push("(orders.customer_nip IS NOT NULL AND TRIM(orders.customer_nip) <> '')");
  } else if (paymentMethod === 'BANK_TRANSFER') {
    parts.push(`orders.payment_method IN (?, ?) AND NOT ${HISTORY_SPLIT_PAYMENT_EXPR}`);
    params.push('BANK_TRANSFER', 'TRANSFER');
  } else if (paymentMethod) {
    parts.push(`orders.payment_method = ? AND NOT ${HISTORY_SPLIT_PAYMENT_EXPR}`);
    params.push(paymentMethod);
  }

  const staffName = options.staffName?.trim().toLowerCase();
  if (staffName) {
    parts.push("LOWER(COALESCE(orders.staff_name, '')) LIKE ?");
    params.push(`%${staffName}%`);
  }

  return { sql: parts.map((part) => `(${part})`).join(' AND '), params };
}

function parseRepairPayload(payload: unknown): any | null {
  if (!payload) return null;
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function incrementReason(result: ServerMirroredGrossItemRepairResult, reason: string): void {
  result.skipped++;
  result.skipped_reasons[reason] = (result.skipped_reasons[reason] ?? 0) + 1;
}

export const orderRepo = {
  create(
    order: OrderRow,
    items: OrderItemRow[],
    options?: { afterInsertInTransaction?: () => void },
  ): string {
    // Generate order number INSIDE transaction for atomicity (prevents race condition)
    let finalOrderNumber: string = '';

    database.transaction(() => {
      // Use atomic sequence counter for order number generation
      if (!order.order_number) {
        finalOrderNumber = orderRepo.generateOrderNumber(
          order.number_series === 'ORDER' ? 'ORDER' : 'FISCAL',
        );
      } else {
        finalOrderNumber = order.order_number;
      }

      const finalOrder = { ...order, order_number: finalOrderNumber };
      database.run(
        `INSERT INTO orders (id, order_number, status, subtotal, discount, tax, total, payment_method, payment_amount, change_amount, staff_id, staff_name, customer_id, customer_name, customer_nip, shift_id, source, table_id, covers, order_type, tip, mode, payment_tenders, kitchen_number, client_attempt_id, billiard_origin_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          finalOrder.id, finalOrder.order_number, finalOrder.status, finalOrder.subtotal ?? 0,
          finalOrder.discount ?? 0, finalOrder.tax ?? 0, finalOrder.total ?? 0,
          finalOrder.payment_method ?? null, finalOrder.payment_amount ?? 0,
          finalOrder.change_amount ?? 0, finalOrder.staff_id ?? null,
          finalOrder.staff_name ?? null, finalOrder.customer_id ?? null,
          finalOrder.customer_name ?? null, finalOrder.customer_nip ?? null,
          finalOrder.shift_id ?? null, finalOrder.source ?? 'POS',
          finalOrder.table_id ?? null, finalOrder.covers ?? null,
          finalOrder.order_type ?? 'standard', finalOrder.tip ?? 0, finalOrder.mode ?? 'retail',
          finalOrder.payment_tenders ?? null, finalOrder.kitchen_number ?? null,
          finalOrder.client_attempt_id ?? null, finalOrder.billiard_origin_json ?? null,
        ],
      );

      for (const item of items) {
        database.run(
          `INSERT INTO order_items (id, order_id, variant_id, name, sku, price, quantity, sale_quantity, sale_unit, sell_by, total, vat_rate, staff_id, staff_name, notes, course, billiard_json, inventory_policy, refund_policy, allocated_discount, payable_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id, item.order_id, item.variant_id ?? null, item.name, item.sku ?? null,
            item.price, item.quantity, getLineSaleQuantity(item), getLineSaleUnit(item), getLineSellBy(item),
            item.total, item.vat_rate ?? 23,
            item.staff_id ?? null, item.staff_name ?? null, item.notes ?? null, item.course ?? 1,
            item.billiard_json ?? null, item.inventory_policy ?? null,
            item.refund_policy ?? null, item.allocated_discount ?? 0,
            item.payable_total ?? item.total,
          ],
        );
      }

      // Safety-ledger hooks (currently Billiard checkout handoff) must cross
      // the same SQL transaction boundary as the paid order. Keep this
      // synchronous: no I/O or renderer work is allowed inside the hook.
      options?.afterInsertInTransaction?.();

    }); // End transaction

    // Flush to disk immediately — financial data must not be lost on crash
    database.markDirty();

    // ERP-AI outbox: emit SaleCompleted + PaymentCaptured for locally-originated
    // PAID sales. This covers POS, SELF_CHECKOUT/kiosk, WEB_ORDER, etc. — every
    // sale born on THIS device. Server-pulled orders are inserted via
    // upsertFromServer (source 'SERVER'), NOT create(), so excluding 'SERVER'
    // here is belt-and-braces. Not-yet-paid open orders (no payment method/
    // tenders) are skipped — they are not finalized facts. Best-effort: the
    // emitter never throws into this path.
    const localPaidSale =
      (order.source ?? 'POS') !== 'SERVER' &&
      (!!order.payment_method || !!order.payment_tenders);
    if (localPaidSale) {
      posEventEmitter.emitOrderFinalized({ ...order, order_number: finalOrderNumber }, items);
    }

    logger.info(`[OrderRepo] Created order ${finalOrderNumber} (${order.id}) with ${items.length} items, mode=${order.mode}`);
    return order.id;
  },

  getById(id: string): OrderRow | null {
    return database.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [id]);
  },

  /**
   * Next daily kitchen pickup number ('0001', '0002', ...). Per-machine
   * counter derived from today's orders — single sequential main process,
   * so MAX+1 inside the create flow is race-free.
   */
  nextKitchenNumber(): string {
    const row = database.get<{ max_no: number | null }>(
      `SELECT MAX(CAST(kitchen_number AS INTEGER)) as max_no
       FROM orders
       WHERE kitchen_number IS NOT NULL AND date(created_at) = date('now')`,
    );
    const next = (row?.max_no ?? 0) + 1;
    return String(next).padStart(4, '0');
  },

  getItemsByOrderId(orderId: string): OrderItemRow[] {
    return database.all<OrderItemRow>('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  },

  deleteLocalUnsynced(id: string): { deleted: boolean; restocked: number } {
    const order = orderRepo.getById(id);
    if (!order) return { deleted: false, restocked: 0 };
    if (order.billiard_origin_json) {
      throw new Error('Billiard POS orders cannot be deleted. Use the owner correction flow.');
    }
    if (order.backend_id || order.synced === 1) {
      throw new Error('Synced orders cannot be deleted locally. Cancel or refund the order instead.');
    }
    if (order.synced === 2) {
      throw new Error('Order sync is in progress. Wait for sync to finish before deleting.');
    }

    const items = orderRepo.getItemsByOrderId(id);
    let restocked = 0;

    database.transaction(() => {
      receiptPrintOutboxRepo.prepareInitialForOrderMutation(
        id,
        'Initial receipt cancelled before deleting the local unsynced order',
      );

      for (const item of items) {
        if (item.variant_id && item.quantity > 0 && item.inventory_policy !== 'ALREADY_CONSUMED') {
          database.run(
            `UPDATE product_variants SET in_stock = in_stock + ?, available_qty = available_qty + ? WHERE id = ? ${STOCK_TRACKED_GUARD_SQL}`,
            [item.quantity, item.quantity, item.variant_id],
          );
          restocked += item.quantity;
        }
      }

      database.run(
        `DELETE FROM sync_conflicts
         WHERE log_entry_id IN (
           SELECT id FROM local_sync_log
           WHERE entity_type = 'order' AND entity_id = ? AND status IN ('pending', 'rejected')
         )`,
        [id],
      );
      database.run(
        "DELETE FROM local_sync_log WHERE entity_type = 'order' AND entity_id = ? AND status IN ('pending', 'rejected')",
        [id],
      );
      database.run('DELETE FROM order_items WHERE order_id = ?', [id]);
      database.run('DELETE FROM orders WHERE id = ?', [id]);
    });

    database.markDirty();
    logger.info(`[OrderRepo] Deleted local unsynced order ${order.order_number || id} (${id}); restocked ${restocked} unit(s)`);
    return { deleted: true, restocked };
  },

  updateLocalUnsynced(id: string, input: OrderMutationInput): { updated: boolean; stockChanged: boolean } {
    const order = orderRepo.getById(id);
    if (!order) return { updated: false, stockChanged: false };
    if (order.billiard_origin_json) {
      throw new Error('Frozen Billiard POS orders cannot be edited.');
    }
    if (order.backend_id || order.synced === 1) {
      throw new Error('Synced orders must be changed on the server.');
    }
    if (order.synced === 2) {
      throw new Error('Order sync is in progress. Wait for sync to finish before editing.');
    }
    if (order.status === 'REFUNDED' || order.status === 'PARTIAL_REFUND' || order.status === 'CANCELLED') {
      throw new Error('Refunded or cancelled orders cannot be edited locally.');
    }

    const currentItems = orderRepo.getItemsByOrderId(id);
    const nextItems = input.items?.map((item) => {
      const sellBy = getLineSellBy(item);
      const quantity = getLineSaleQuantity({ ...item, sell_by: sellBy });
      const price = Math.max(0, Math.round(Number(item.price) || 0));
      return {
        id: item.id,
        order_id: id,
        variant_id: item.variant_id ?? null,
        name: item.name,
        sku: item.sku ?? null,
        price,
        quantity,
        sale_quantity: quantity,
        sale_unit: getLineSaleUnit({ ...item, sell_by: sellBy }),
        sell_by: sellBy,
        total: getLineTotalGrosze({ ...item, price, quantity, sale_quantity: quantity, sell_by: sellBy }),
        vat_rate: Number.isFinite(Number(item.vat_rate)) ? Number(item.vat_rate) : 23,
        staff_id: item.staff_id ?? null,
        staff_name: item.staff_name ?? null,
        notes: item.notes ?? null,
        course: item.course ?? 1,
      };
    }).filter((item) => item.quantity > 0 && item.name.trim().length > 0);

    if (input.items && (!nextItems || nextItems.length === 0)) {
      throw new Error('Order must contain at least one item.');
    }

    const subtotal = nextItems
      ? nextItems.reduce((sum, item) => sum + item.total, 0)
      : order.subtotal;
    const discount = Math.min(order.discount ?? 0, subtotal);
    const tax = nextItems
      ? nextItems.reduce((sum, item) => {
          const rate = item.vat_rate ?? 0;
          if (rate <= 0) return sum;
          return sum + Math.round(item.total - item.total * 100 / (100 + rate));
        }, 0)
      : order.tax;
    const total = Math.max(0, subtotal - discount);
    const paymentMethod = input.paymentMethod ?? order.payment_method;
    const paymentAmount = input.paymentAmount ?? (nextItems ? total : order.payment_amount);
    const changeAmount = input.changeAmount ?? (paymentMethod === 'CASH' ? Math.max(0, paymentAmount - total) : 0);
    const paymentTenders = paymentMethod
      ? JSON.stringify([{ method: paymentMethod, amount: paymentAmount }])
      : null;
    let stockChanged = false;

    database.transaction(() => {
      receiptPrintOutboxRepo.prepareInitialForOrderMutation(
        id,
        'Initial receipt cancelled before mutating the local unsynced order',
      );

      if (nextItems) {
        for (const item of currentItems) {
          if (item.variant_id && item.quantity > 0) {
            database.run(
              `UPDATE product_variants SET in_stock = in_stock + ?, available_qty = available_qty + ? WHERE id = ? ${STOCK_TRACKED_GUARD_SQL}`,
              [item.quantity, item.quantity, item.variant_id],
            );
            stockChanged = true;
          }
        }

        database.run('DELETE FROM order_items WHERE order_id = ?', [id]);
        for (const item of nextItems) {
          if (item.variant_id && item.quantity > 0) {
            database.run(
              `UPDATE product_variants SET in_stock = in_stock - ?, available_qty = available_qty - ? WHERE id = ? ${STOCK_TRACKED_GUARD_SQL}`,
              [item.quantity, item.quantity, item.variant_id],
            );
            stockChanged = true;
          }
          database.run(
            `INSERT INTO order_items (id, order_id, variant_id, name, sku, price, quantity, sale_quantity, sale_unit, sell_by, total, vat_rate, staff_id, staff_name, notes, course)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              item.id, id, item.variant_id, item.name, item.sku, item.price, item.quantity,
              item.sale_quantity, item.sale_unit, item.sell_by,
              item.total, item.vat_rate, item.staff_id, item.staff_name, item.notes, item.course,
            ],
          );
        }
      }

      database.run(
        `UPDATE orders
         SET subtotal = ?, discount = ?, tax = ?, total = ?, payment_method = ?, payment_amount = ?, change_amount = ?, payment_tenders = ?
         WHERE id = ?`,
        [subtotal, discount, tax, total, paymentMethod, paymentAmount, changeAmount, paymentTenders, id],
      );

      const syncPayload = {
        id,
        priceType: 'brutto',
        requiresInvoice: !!order.customer_nip,
        items: (nextItems ?? currentItems).filter((i: any) => i.variant_id || i.id).map((i: any) => buildBackendOrderItem(i)),
        paymentMethod: paymentMethod === 'TRANSFER' || paymentMethod === 'INVOICE' ? 'BANK_TRANSFER' : (paymentMethod || 'CASH'),
        tenders: paymentMethod ? [{ method: paymentMethod === 'TRANSFER' || paymentMethod === 'INVOICE' ? 'BANK_TRANSFER' : paymentMethod, amount: paymentAmount / 100 }] : undefined,
        staffId: order.staff_id ?? undefined,
        staffName: order.staff_name ?? undefined,
        shiftId: order.shift_id ?? undefined,
        customerId: order.customer_id ?? undefined,
        customerNip: order.customer_nip ?? undefined,
        customerName: order.customer_name ?? undefined,
        source: order.source ?? 'POS',
        orderType: order.order_type ?? 'standard',
        mode: order.mode ?? 'retail',
        discountAmount: discount > 0 ? discount / 100 : undefined,
        paymentAmount: paymentAmount / 100,
        changeAmount: changeAmount / 100,
        tip: order.tip && order.tip > 0 ? order.tip / 100 : undefined,
      };
      database.run(
        `UPDATE local_sync_log
         SET payload = ?, status = 'pending', rejection_code = NULL, rejection_detail = NULL
         WHERE entity_type = 'order' AND entity_id = ? AND event = 'created' AND status IN ('pending', 'rejected')`,
        [JSON.stringify(syncPayload), id],
      );
    });

    database.markDirty();
    logger.info(`[OrderRepo] Updated local unsynced order ${order.order_number || id} (${id})`);
    return { updated: true, stockChanged };
  },

  getUnsynced(): OrderRow[] {
    // Only get orders that are pending (0), not currently in-flight (2)
    return database.all<OrderRow>('SELECT * FROM orders WHERE synced = 0');
  },

  hasUnsyncedOrdersForVariant(variantId: string): boolean {
    const row = database.get<{ cnt: number }>(
      `SELECT COUNT(DISTINCT o.id) AS cnt
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE oi.variant_id = ?
         AND o.synced != 1`,
      [variantId],
    );
    return (row?.cnt ?? 0) > 0;
  },

  markSyncing(id: string): void {
    database.run('UPDATE orders SET synced = 2 WHERE id = ?', [id]);
  },

  markSynced(id: string, backendId: string, backendOrderNumber?: string): void {
    if (backendOrderNumber) {
      database.run(
        "UPDATE orders SET synced = 1, backend_id = ?, order_number = ?, synced_at = datetime('now') WHERE id = ?",
        [backendId, backendOrderNumber, id],
      );
      return;
    }

    database.run(
      "UPDATE orders SET synced = 1, backend_id = ?, synced_at = datetime('now') WHERE id = ?",
      [backendId, id],
    );
  },

  markSyncFailed(id: string): void {
    // Revert from syncing (2) back to pending (0) for retry
    database.run('UPDATE orders SET synced = 0 WHERE id = ? AND synced = 2', [id]);
  },

  /**
   * Mark an order as refunded (full or partial).
   */
  markRefunded(id: string, amount: number, reason: string, type: 'FULL' | 'PARTIAL', refundLines?: Array<{
    billiardLineKey?: string;
    orderItemId?: string;
    variantId?: string;
    name?: string;
    quantity: number;
    unit?: string;
    saleUnit?: string;
    sellBy?: string;
    unitPrice: number;
    refundAmount: number;
    vatRate?: number;
    sku?: string;
    restock?: boolean;
    refundedAt?: string;
    refundRequestId?: string;
    reason?: string;
    refundMethod?: string;
  }>): void {
    const status = type === 'FULL' ? 'REFUNDED' : 'PARTIAL_REFUND';
    database.run(
      "UPDATE orders SET status = ?, refund_amount = ?, refund_reason = ?, refunded_at = datetime('now'), refund_lines = ? WHERE id = ?",
      [status, amount, reason, refundLines ? JSON.stringify(refundLines) : null, id],
    );
  },

  getByShift(shiftId: string): OrderRow[] {
    return database.all<OrderRow>(
      `SELECT orders.*, CAST(${HAS_FISCAL_EXPR} AS INTEGER) as has_fiscal
       FROM orders
       WHERE shift_id = ?`,
      [shiftId],
    );
  },

  getUnsyncedCountByShift(shiftId: string): number {
    const row = database.get<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM orders WHERE shift_id = ? AND synced != 1',
      [shiftId],
    );
    return row?.cnt ?? 0;
  },

  getRefundCashflowForDate(date: string, fiscalOnly = false): RefundCashflowStats {
    return queryRefundCashflow(
      "date(e.occurred_at, 'localtime') = date(?)",
      [date],
      "date(orders.refunded_at, 'localtime') = date(?)",
      [date],
      fiscalOnly,
    );
  },

  getRefundCashflowBetween(
    from: string,
    to: string,
    fiscalOnly = false,
    localShiftId?: string,
  ): RefundCashflowStats {
    const eventTimeSql = localShiftId
      ? `(e.shift_id = ? OR (
           e.shift_id IS NULL
           AND julianday(e.occurred_at) >= julianday(?)
           AND julianday(e.occurred_at) < julianday(?)
         ))`
      : 'julianday(e.occurred_at) >= julianday(?) AND julianday(e.occurred_at) < julianday(?)';
    const eventTimeParams = localShiftId ? [localShiftId, from, to] : [from, to];
    return queryRefundCashflow(
      eventTimeSql,
      eventTimeParams,
      'julianday(orders.refunded_at) >= julianday(?) AND julianday(orders.refunded_at) < julianday(?)',
      [from, to],
      fiscalOnly,
    );
  },

  getDailyStats(date: string, fiscalOnly = false): DailyStats {
    const grossOrders = database.all<DailyGrossCashflowRow>(
      `SELECT orders.total, orders.payment_method, orders.payment_tenders
       FROM orders
       WHERE date(orders.created_at, 'localtime') = date(?)
       ${fiscalOnly ? `AND ${HAS_FISCAL_EXPR}` : ''}`,
      [date],
    ) ?? [];
    const gross = {
      order_count: grossOrders.length,
      total_sales: 0,
      cash_total: 0,
      card_total: 0,
    };
    for (const order of grossOrders) {
      const total = Math.max(0, Math.round(Number(order.total) || 0));
      gross.total_sales += total;
      const tenders = allocateRefundTenders(order.payment_tenders, total, order.payment_method);
      for (const tender of tenders) {
        if (tender.method === 'CASH') gross.cash_total += tender.amount;
        else if (tender.method === 'CARD') gross.card_total += tender.amount;
      }
    }
    const refunds = orderRepo.getRefundCashflowForDate(date, fiscalOnly);
    return {
      ...gross,
      total_sales: gross.total_sales - refunds.refund_total,
      cash_total: gross.cash_total - refunds.cash_refund_total,
      card_total: gross.card_total - refunds.card_refund_total,
      refund_count: refunds.refund_count,
      refund_total: refunds.refund_total,
    };
  },

  getByDateRange(from: string, to: string, limit = 20, offset = 0, options: OrderHistoryOptions = {}): { orders: OrderRow[]; total: number } {
    // Use date() to normalize format differences (datetime('now') uses space, ISO uses T)
    const where = buildHistoryWhere(from, to, options);
    const total = database.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt
       FROM orders
       WHERE ${where.sql}`,
      where.params,
    )?.cnt ?? 0;
    const orders = database.all<OrderRow>(
      `SELECT orders.*, CAST(${HAS_FISCAL_EXPR} AS INTEGER) as has_fiscal
       FROM orders
       WHERE ${where.sql}
       ORDER BY julianday(orders.created_at) DESC, orders.created_at DESC LIMIT ? OFFSET ?`,
      [...where.params, limit, offset],
    );
    return { orders, total };
  },

  repairServerMirroredGrossItemPrices(): ServerMirroredGrossItemRepairResult {
    const result: ServerMirroredGrossItemRepairResult = {
      scanned: 0,
      repaired: 0,
      skipped: 0,
      skipped_reasons: {},
    };

    const candidates = database.all<ServerMirroredGrossRepairCandidate>(
      `SELECT
         o.id,
         o.order_number,
         o.backend_id,
         o.source,
         o.total,
         COALESCE(o.discount, 0) AS discount,
         COALESCE(SUM(oi.total), 0) AS local_sum,
         (
           SELECT l.payload
           FROM local_sync_log l
           WHERE l.entity_type = 'order'
             AND l.source = 'server'
             AND (l.entity_id = o.id OR (o.backend_id IS NOT NULL AND l.entity_id = o.backend_id))
           ORDER BY COALESCE(l.server_seq, l.id) DESC, l.id DESC
           LIMIT 1
         ) AS payload
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.source = 'SERVER'
       GROUP BY o.id, o.order_number, o.backend_id, o.source, o.total, o.discount
       HAVING ABS((o.total + COALESCE(o.discount, 0)) - COALESCE(SUM(oi.total), 0)) > 1`,
    );

    result.scanned = candidates.length;

    for (const candidate of candidates) {
      if (candidate.source !== 'SERVER') {
        incrementReason(result, 'source_not_server');
        continue;
      }

      const expectedGross = Math.round(Number(candidate.total) || 0) + Math.round(Number(candidate.discount) || 0);
      const beforeSum = Math.round(Number(candidate.local_sum) || 0);
      if (Math.abs(expectedGross - beforeSum) <= 1) {
        incrementReason(result, 'already_matches_order_gross');
        continue;
      }

      const payload = parseRepairPayload(candidate.payload);
      const payloadItems = Array.isArray(payload?.items) ? payload.items : null;
      if (!payloadItems || payloadItems.length === 0) {
        incrementReason(result, 'missing_payload_items');
        continue;
      }

      if (!payloadItems.every((item: any) => item?.id != null && String(item.id).trim().length > 0)) {
        incrementReason(result, 'missing_item_id');
        continue;
      }

      const adaptedItems = payloadItems.map((item: any) =>
        adaptServerOrderItem(item, candidate.id, payload),
      );
      const adaptedSum = adaptedItems.reduce((sum: number, item: OrderItemRow) => sum + Math.round(Number(item.total) || 0), 0);
      if (Math.abs(adaptedSum - expectedGross) > 1) {
        incrementReason(result, 'adapted_sum_mismatch');
        continue;
      }

      const localItems = database.all<LocalItemRepairRow>(
        'SELECT id, total FROM order_items WHERE order_id = ?',
        [candidate.id],
      );
      if (localItems.length !== adaptedItems.length) {
        incrementReason(result, 'local_item_count_mismatch');
        continue;
      }

      const localById = new Map(localItems.map((item) => [item.id, item]));
      if (!adaptedItems.every((item: OrderItemRow) => localById.has(item.id))) {
        incrementReason(result, 'local_item_id_mismatch');
        continue;
      }

      const hasChanges = adaptedItems.some((item: OrderItemRow) => {
        const local = localById.get(item.id);
        return !local || local.total !== item.total;
      });
      if (!hasChanges) {
        incrementReason(result, 'already_repaired');
        continue;
      }

      database.transaction(() => {
        for (const item of adaptedItems) {
          database.run(
            `UPDATE order_items
             SET price = ?, quantity = ?, sale_quantity = ?, sale_unit = ?, sell_by = ?, total = ?, vat_rate = ?
             WHERE order_id = ? AND id = ?`,
            [
              item.price,
              item.quantity,
              item.sale_quantity ?? item.quantity,
              item.sale_unit ?? null,
              item.sell_by ?? null,
              item.total,
              item.vat_rate,
              candidate.id,
              item.id,
            ],
          );
        }
      });
      database.markDirty();
      result.repaired++;
      logger.warn(
        `[OrderRepo] Repaired server-mirrored gross item prices for ${candidate.order_number || candidate.id} (${candidate.id}): ` +
        `items_sum ${beforeSum} -> ${adaptedSum}, expected=${expectedGross}`,
      );
    }

    return result;
  },

  upsertFromServer(
    adaptedOrder: any,
    items: OrderItemRow[],
    options?: ServerOrderUpsertOptions,
  ): { inserted: boolean; localOrderId: string } {
    const existing = orderRepo.getById(adaptedOrder.id);
    if (existing) {
      if (
        existing.billiard_origin_json
        && adaptedOrder.billiard_origin_json
        && existing.billiard_origin_json !== adaptedOrder.billiard_origin_json
      ) {
        throw new Error('Server Billiard order origin conflicts with the local paid order journal.');
      }
      runServerOrderMutation(options, () => {
        database.run(
          `UPDATE orders
           SET client_attempt_id = COALESCE(client_attempt_id, ?),
               billiard_origin_json = COALESCE(billiard_origin_json, ?)
           WHERE id = ?`,
          [adaptedOrder.client_attempt_id ?? null, adaptedOrder.billiard_origin_json ?? null, existing.id],
        );
        const localItems = orderRepo.getItemsByOrderId(existing.id);
        for (const incoming of items) {
          if (!incoming.billiard_json) continue;
          let incomingLineKey = '';
          try { incomingLineKey = String(JSON.parse(incoming.billiard_json).lineKey || ''); } catch { /* fail below */ }
          if (!incomingLineKey) throw new Error('Server Billiard item is missing its stable line key.');
          const local = localItems.find((candidate) => {
            try { return String(JSON.parse(candidate.billiard_json || '').lineKey || '') === incomingLineKey; }
            catch { return false; }
          });
          if (!local) continue;
          database.run(
            `UPDATE order_items
             SET billiard_json = COALESCE(billiard_json, ?),
                 inventory_policy = COALESCE(inventory_policy, ?),
                 refund_policy = COALESCE(refund_policy, ?),
                 allocated_discount = COALESCE(allocated_discount, ?),
                 payable_total = COALESCE(payable_total, ?)
             WHERE id = ? AND order_id = ?`,
            [
              incoming.billiard_json,
              incoming.inventory_policy ?? null,
              incoming.refund_policy ?? null,
              incoming.allocated_discount ?? null,
              incoming.payable_total ?? null,
              local.id,
              existing.id,
            ],
          );
        }
      });
      database.markDirty();
      return { inserted: false, localOrderId: existing.id };
    }

    if (!items || items.length < 1) {
      throw new Error('Server order has invalid items: empty array');
    }
    for (const item of items) {
      if (!item.name || item.name.length === 0) throw new Error(`Server order has invalid items: missing name`);
      if (typeof item.price !== 'number' || item.price < 0) throw new Error(`Server order has invalid items: bad price for "${item.name}"`);
      if (typeof item.total !== 'number' || item.total < 0) throw new Error(`Server order has invalid items: bad total for "${item.name}"`);
    }

    const { _origin, ...dbRow } = adaptedOrder;

    runServerOrderMutation(options, () => {
      database.run(
        `INSERT INTO orders (id, order_number, status, subtotal, discount, tax, total, payment_method, payment_amount, change_amount, staff_id, staff_name, customer_id, customer_name, customer_nip, shift_id, source, table_id, covers, order_type, tip, mode, payment_tenders, client_attempt_id, billiard_origin_json, synced, backend_id, synced_at, refund_amount, refund_reason, refunded_at, refund_lines, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)`,
        [
          dbRow.id,
          dbRow.order_number ?? null,
          dbRow.status ?? 'COMPLETED',
          dbRow.subtotal ?? 0,
          dbRow.discount ?? 0,
          dbRow.tax ?? 0,
          dbRow.total ?? 0,
          dbRow.payment_method ?? null,
          dbRow.payment_amount ?? 0,
          dbRow.change_amount ?? 0,
          dbRow.staff_id ?? null,
          dbRow.staff_name ?? null,
          dbRow.customer_id ?? null,
          dbRow.customer_name ?? null,
          dbRow.customer_nip ?? null,
          dbRow.shift_id ?? null,
          'SERVER',
          null, // table_id
          null, // covers
          'standard', // order_type
          dbRow.tip ?? 0,
          dbRow.mode ?? 'retail',
          dbRow.payment_tenders ?? null,
          dbRow.client_attempt_id ?? null,
          dbRow.billiard_origin_json ?? null,
          1, // synced
          dbRow.id, // backend_id = server order id
          dbRow.refund_amount ?? 0,
          dbRow.refund_reason ?? null,
          dbRow.refunded_at ?? null,
          dbRow.refund_lines ?? null,
          dbRow.created_at ?? new Date().toISOString(),
        ],
      );

      database.run('DELETE FROM order_items WHERE order_id = ?', [dbRow.id]);

      for (const item of items) {
        database.run(
          `INSERT INTO order_items (id, order_id, variant_id, name, sku, price, quantity, sale_quantity, sale_unit, sell_by, total, vat_rate, staff_id, staff_name, notes, course, billiard_json, inventory_policy, refund_policy, allocated_discount, payable_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id, item.order_id, item.variant_id ?? null, item.name, item.sku ?? null,
            item.price, item.quantity, getLineSaleQuantity(item), getLineSaleUnit(item), getLineSellBy(item),
            item.total, item.vat_rate ?? 23,
            item.staff_id ?? null, item.staff_name ?? null, item.notes ?? null, item.course ?? 1,
            item.billiard_json ?? null, item.inventory_policy ?? null,
            item.refund_policy ?? null, item.allocated_discount ?? 0,
            item.payable_total ?? item.total,
          ],
        );
      }
    });

    database.markDirty();
    logger.info(`[OrderRepo] Mirrored server order ${dbRow.id} (${items.length} items)`);
    return { inserted: true, localOrderId: dbRow.id };
  },

  /**
   * Two independent daily series:
   * - FISCAL (default): POS-YYYYMMDD-#### — orders whose payment flow prints
   *   a fiscal paragon. Counter name unchanged so the existing sequence
   *   continues seamlessly.
   * - ORDER: ZAM-YYYYMMDD-#### — orders that only print the non-fiscal order
   *   copy (cash/BLIK without fiscal). Separate counter so the order-copy
   *   slips never interleave with (or reveal gaps in) the fiscal series.
   */
  generateOrderNumber(series: 'FISCAL' | 'ORDER' = 'FISCAL'): string {
    // Use atomic sequence counter to prevent race conditions
    const dateRow = database.get<{ d: string }>("SELECT strftime('%Y%m%d', 'now') as d");
    const datePrefix = dateRow?.d ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counterName = series === 'ORDER' ? `order-copy-${datePrefix}` : `order-${datePrefix}`;

    // Atomic increment via INSERT + UPDATE
    database.run(
      `INSERT INTO sequence_counters (name, current_value) VALUES (?, 0)
       ON CONFLICT(name) DO NOTHING`,
      [counterName],
    );
    database.run(
      'UPDATE sequence_counters SET current_value = current_value + 1 WHERE name = ?',
      [counterName],
    );
    const row = database.get<{ current_value: number }>(
      'SELECT current_value FROM sequence_counters WHERE name = ?',
      [counterName],
    );
    const seq = (row?.current_value ?? 1).toString().padStart(4, '0');
    return `${series === 'ORDER' ? 'ZAM' : 'POS'}-${datePrefix}-${seq}`;
  },
};
