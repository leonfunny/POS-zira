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
  // Payment & sync
  payment_tenders: string | null; // JSON array of {method, amount}
  sync_attempts: number;
  sync_error: string | null;
  // Refund
  refund_amount: number | null;
  refund_reason: string | null;
  refunded_at: string | null;
  refund_lines: string | null;
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

export interface OrderMutationItemInput {
  id: string;
  variant_id?: string | null;
  name: string;
  sku?: string | null;
  price: number;
  quantity: number;
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
        `INSERT INTO orders (id, order_number, status, subtotal, discount, tax, total, payment_method, payment_amount, change_amount, staff_id, staff_name, customer_id, customer_name, customer_nip, shift_id, source, table_id, covers, order_type, tip, mode, payment_tenders)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          finalOrder.payment_tenders ?? null,
        ],
      );

      for (const item of items) {
        database.run(
          `INSERT INTO order_items (id, order_id, variant_id, name, sku, price, quantity, total, vat_rate, staff_id, staff_name, notes, course)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id, item.order_id, item.variant_id ?? null, item.name, item.sku ?? null,
            item.price, item.quantity, item.total, item.vat_rate ?? 23,
            item.staff_id ?? null, item.staff_name ?? null, item.notes ?? null, item.course ?? 1,
          ],
        );
      }

    }); // End transaction

    // Flush to disk immediately — financial data must not be lost on crash
    database.markDirty();

    logger.info(`[OrderRepo] Created order ${finalOrderNumber} (${order.id}) with ${items.length} items, mode=${order.mode}`);
    return order.id;
  },

  getById(id: string): OrderRow | null {
    return database.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [id]);
  },

  getItemsByOrderId(orderId: string): OrderItemRow[] {
    return database.all<OrderItemRow>('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  },

  deleteLocalUnsynced(id: string): { deleted: boolean; restocked: number } {
    const order = orderRepo.getById(id);
    if (!order) return { deleted: false, restocked: 0 };
    if (order.backend_id || order.synced === 1) {
      throw new Error('Synced orders cannot be deleted locally. Cancel or refund the order instead.');
    }
    if (order.synced === 2) {
      throw new Error('Order sync is in progress. Wait for sync to finish before deleting.');
    }

    const items = orderRepo.getItemsByOrderId(id);
    let restocked = 0;

    database.transaction(() => {
      for (const item of items) {
        if (item.variant_id && item.quantity > 0) {
          database.run(
            'UPDATE product_variants SET in_stock = in_stock + ?, available_qty = available_qty + ? WHERE id = ?',
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
      const quantity = Math.max(0, Math.round(Number(item.quantity) || 0));
      const price = Math.max(0, Math.round(Number(item.price) || 0));
      return {
        id: item.id,
        order_id: id,
        variant_id: item.variant_id ?? null,
        name: item.name,
        sku: item.sku ?? null,
        price,
        quantity,
        total: price * quantity,
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
      if (nextItems) {
        for (const item of currentItems) {
          if (item.variant_id && item.quantity > 0) {
            database.run(
              'UPDATE product_variants SET in_stock = in_stock + ?, available_qty = available_qty + ? WHERE id = ?',
              [item.quantity, item.quantity, item.variant_id],
            );
            stockChanged = true;
          }
        }

        database.run('DELETE FROM order_items WHERE order_id = ?', [id]);
        for (const item of nextItems) {
          if (item.variant_id && item.quantity > 0) {
            database.run(
              'UPDATE product_variants SET in_stock = in_stock - ?, available_qty = available_qty - ? WHERE id = ?',
              [item.quantity, item.quantity, item.variant_id],
            );
            stockChanged = true;
          }
          database.run(
            `INSERT INTO order_items (id, order_id, variant_id, name, sku, price, quantity, total, vat_rate, staff_id, staff_name, notes, course)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              item.id, id, item.variant_id, item.name, item.sku, item.price, item.quantity,
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
        items: (nextItems ?? currentItems).filter((i: any) => i.variant_id || i.id).map((i: any) => ({
          productId: i.variant_id || i.id,
          variantId: i.variant_id || i.id,
          ...(i.sku ? { variantSku: i.sku } : {}),
          packQuantity: Math.max(1, Math.round(i.quantity || 1)),
          ...(typeof i.price === 'number' && Number.isFinite(i.price) ? { customPrice: i.price / 100 } : {}),
        })),
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
  markRefunded(id: string, amount: number, reason: string, type: 'FULL' | 'PARTIAL', refundLines?: Array<{name: string; quantity: number; unitPrice: number; refundAmount: number; vatRate?: number; sku?: string}>): void {
    const status = type === 'FULL' ? 'REFUNDED' : 'PARTIAL_REFUND';
    database.run(
      "UPDATE orders SET status = ?, refund_amount = ?, refund_reason = ?, refunded_at = datetime('now'), refund_lines = ? WHERE id = ?",
      [status, amount, reason, refundLines ? JSON.stringify(refundLines) : null, id],
    );
  },

  getByShift(shiftId: string): OrderRow[] {
    return database.all<OrderRow>('SELECT * FROM orders WHERE shift_id = ?', [shiftId]);
  },

  getUnsyncedCountByShift(shiftId: string): number {
    const row = database.get<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM orders WHERE shift_id = ? AND synced != 1',
      [shiftId],
    );
    return row?.cnt ?? 0;
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

  upsertFromServer(adaptedOrder: any, items: OrderItemRow[]): { inserted: boolean; localOrderId: string } {
    const existing = orderRepo.getById(adaptedOrder.id);
    if (existing) {
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

    database.transaction(() => {
      database.run(
        `INSERT INTO orders (id, order_number, status, subtotal, discount, tax, total, payment_method, payment_amount, change_amount, staff_id, staff_name, customer_id, customer_name, customer_nip, shift_id, source, table_id, covers, order_type, tip, mode, payment_tenders, synced, backend_id, synced_at, refund_amount, refund_reason, refunded_at, refund_lines, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)`,
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
          `INSERT INTO order_items (id, order_id, variant_id, name, sku, price, quantity, total, vat_rate, staff_id, staff_name, notes, course)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id, item.order_id, item.variant_id ?? null, item.name, item.sku ?? null,
            item.price, item.quantity, item.total, item.vat_rate ?? 23,
            item.staff_id ?? null, item.staff_name ?? null, item.notes ?? null, item.course ?? 1,
          ],
        );
      }
    });

    database.markDirty();
    logger.info(`[OrderRepo] Mirrored server order ${dbRow.id} (${items.length} items)`);
    return { inserted: true, localOrderId: dbRow.id };
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
