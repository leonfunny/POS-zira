import { database } from '../database';
import logger from '../../logger';

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
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  variant_id: string | null;
  name: string;
  sku: string | null;
  price: number;
  quantity: number;
  total: number;
  vat_rate: number;
  // Mode-specific fields (v2)
  staff_id: string | null;
  staff_name: string | null;
  notes: string | null;
  course: number | null;
}

export interface DailyStats {
  order_count: number;
  total_sales: number;
  cash_total: number;
  card_total: number;
}

export const orderRepo = {
  create(order: OrderRow, items: OrderItemRow[]): string {
    // Generate order number INSIDE transaction for atomicity (prevents race condition)
    let finalOrderNumber: string = '';

    database.transaction(() => {
      // Use atomic sequence counter for order number generation
      if (!order.order_number) {
        finalOrderNumber = orderRepo.generateOrderNumber();
      } else {
        finalOrderNumber = order.order_number;
      }

      const finalOrder = { ...order, order_number: finalOrderNumber };
      database.run(
        `INSERT INTO orders (id, order_number, status, subtotal, discount, tax, total, payment_method, payment_amount, change_amount, staff_id, staff_name, customer_id, customer_name, customer_nip, shift_id, source, table_id, covers, order_type, tip, mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          finalOrder.id, finalOrder.order_number, finalOrder.status, finalOrder.subtotal,
          finalOrder.discount, finalOrder.tax, finalOrder.total, finalOrder.payment_method,
          finalOrder.payment_amount, finalOrder.change_amount, finalOrder.staff_id,
          finalOrder.staff_name, finalOrder.customer_id, finalOrder.customer_name,
          finalOrder.customer_nip, finalOrder.shift_id, finalOrder.source,
          finalOrder.table_id ?? null, finalOrder.covers ?? null,
          finalOrder.order_type ?? 'standard', finalOrder.tip ?? 0, finalOrder.mode ?? 'retail',
        ],
      );

      for (const item of items) {
        database.run(
          `INSERT INTO order_items (id, order_id, variant_id, name, sku, price, quantity, total, vat_rate, staff_id, staff_name, notes, course)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id, item.order_id, item.variant_id, item.name, item.sku,
            item.price, item.quantity, item.total, item.vat_rate,
            item.staff_id ?? null, item.staff_name ?? null, item.notes ?? null, item.course ?? 1,
          ],
        );
      }

      // Add to sync queue
      database.run(
        `INSERT INTO sync_queue (entity_type, entity_id, action, payload)
         VALUES ('order', ?, 'create', ?)`,
        [finalOrder.id, JSON.stringify({ order: finalOrder, items })],
      );
    }); // End transaction

    // Flush to disk immediately — financial data must not be lost on crash
    database.save();

    logger.info(`[OrderRepo] Created order ${finalOrderNumber} (${order.id}) with ${items.length} items, mode=${order.mode}`);
    return order.id;
  },

  getById(id: string): OrderRow | null {
    return database.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [id]);
  },

  getItemsByOrderId(orderId: string): OrderItemRow[] {
    return database.all<OrderItemRow>('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  },

  getUnsynced(): OrderRow[] {
    // Only get orders that are pending (0), not currently in-flight (2)
    return database.all<OrderRow>('SELECT * FROM orders WHERE synced = 0');
  },

  markSyncing(id: string): void {
    database.run('UPDATE orders SET synced = 2 WHERE id = ?', [id]);
  },

  markSynced(id: string, backendId: string): void {
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
  markRefunded(id: string, amount: number, reason: string, type: 'FULL' | 'PARTIAL'): void {
    const status = type === 'FULL' ? 'REFUNDED' : 'PARTIAL_REFUND';
    database.run(
      "UPDATE orders SET status = ?, refund_amount = ?, refund_reason = ?, refunded_at = datetime('now') WHERE id = ?",
      [status, amount, reason, id],
    );
  },

  getByShift(shiftId: string): OrderRow[] {
    return database.all<OrderRow>('SELECT * FROM orders WHERE shift_id = ?', [shiftId]);
  },

  getDailyStats(date: string): DailyStats {
    const result = database.get<DailyStats>(
      `SELECT
         COUNT(*) as order_count,
         COALESCE(SUM(total), 0) as total_sales,
         COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN total ELSE 0 END), 0) as cash_total,
         COALESCE(SUM(CASE WHEN payment_method = 'CARD' THEN total ELSE 0 END), 0) as card_total
       FROM orders WHERE date(created_at) = ?`,
      [date],
    );
    return result ?? { order_count: 0, total_sales: 0, cash_total: 0, card_total: 0 };
  },

  getByDateRange(from: string, to: string, limit = 20, offset = 0): { orders: OrderRow[]; total: number } {
    // Use date() to normalize format differences (datetime('now') uses space, ISO uses T)
    const total = database.get<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM orders WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)',
      [from, to],
    )?.cnt ?? 0;
    const orders = database.all<OrderRow>(
      'SELECT * FROM orders WHERE date(created_at) >= date(?) AND date(created_at) <= date(?) ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [from, to, limit, offset],
    );
    return { orders, total };
  },

  generateOrderNumber(): string {
    // Use atomic sequence counter to prevent race conditions
    const dateRow = database.get<{ d: string }>("SELECT strftime('%Y%m%d', 'now') as d");
    const datePrefix = dateRow?.d ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counterName = `order-${datePrefix}`;

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
    return `POS-${datePrefix}-${seq}`;
  },
};
