import { database } from '../database';

export type KitchenOrderStatus = 'new' | 'in_progress' | 'ready' | 'delivered' | 'cancelled';

export interface KitchenOrderRow {
  id: string;
  session_id: string;
  resource_id: string | null;
  table_name: string | null;
  floor_name: string | null;
  status: KitchenOrderStatus;
  priority: number;
  notes: string | null;
  created_at: string;
  accepted_at: string | null;
  ready_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
}

export interface KitchenOrderItemRow {
  id: string;
  kitchen_order_id: string;
  session_item_id: string | null;
  variant_id: string | null;
  name: string;
  quantity: number;
  unit_price: number;
  notes: string | null;
}

export const kitchenOrderRepo = {
  /** Get all active orders (not delivered/cancelled), newest first */
  getActive(): (KitchenOrderRow & { items: KitchenOrderItemRow[] })[] {
    const orders = database.all<KitchenOrderRow>(
      "SELECT * FROM kitchen_orders WHERE status IN ('new', 'in_progress', 'ready') ORDER BY priority DESC, created_at ASC",
    );
    return orders.map((o) => ({
      ...o,
      items: database.all<KitchenOrderItemRow>(
        'SELECT * FROM kitchen_order_items WHERE kitchen_order_id = ?',
        [o.id],
      ),
    }));
  },

  /** Get orders by session (e.g. to show on billiard table) */
  getBySession(sessionId: string): (KitchenOrderRow & { items: KitchenOrderItemRow[] })[] {
    const orders = database.all<KitchenOrderRow>(
      'SELECT * FROM kitchen_orders WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId],
    );
    return orders.map((o) => ({
      ...o,
      items: database.all<KitchenOrderItemRow>(
        'SELECT * FROM kitchen_order_items WHERE kitchen_order_id = ?',
        [o.id],
      ),
    }));
  },

  /** Get a single order by ID */
  getById(id: string): (KitchenOrderRow & { items: KitchenOrderItemRow[] }) | null {
    const order = database.get<KitchenOrderRow>(
      'SELECT * FROM kitchen_orders WHERE id = ?',
      [id],
    );
    if (!order) return null;
    return {
      ...order,
      items: database.all<KitchenOrderItemRow>(
        'SELECT * FROM kitchen_order_items WHERE kitchen_order_id = ?',
        [id],
      ),
    };
  },

  /** Create a new kitchen order with items */
  create(order: {
    id: string;
    sessionId: string;
    resourceId?: string;
    tableName?: string;
    floorName?: string;
    priority?: number;
    notes?: string;
    items: {
      id: string;
      sessionItemId?: string;
      variantId?: string;
      name: string;
      quantity: number;
      unitPrice: number;
      notes?: string;
    }[];
  }): void {
    database.run(
      `INSERT INTO kitchen_orders (id, session_id, resource_id, table_name, floor_name, status, priority, notes)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?)`,
      [
        order.id,
        order.sessionId,
        order.resourceId || null,
        order.tableName || null,
        order.floorName || null,
        order.priority || 0,
        order.notes || null,
      ],
    );
    for (const item of order.items) {
      database.run(
        `INSERT INTO kitchen_order_items (id, kitchen_order_id, session_item_id, variant_id, name, quantity, unit_price, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          order.id,
          item.sessionItemId || null,
          item.variantId || null,
          item.name,
          item.quantity,
          item.unitPrice,
          item.notes || null,
        ],
      );
    }
  },

  /** Update order status with timestamp */
  updateStatus(id: string, status: KitchenOrderStatus): void {
    const now = new Date().toISOString();
    let timestampCol = '';
    switch (status) {
      case 'in_progress': timestampCol = 'accepted_at'; break;
      case 'ready': timestampCol = 'ready_at'; break;
      case 'delivered': timestampCol = 'delivered_at'; break;
      case 'cancelled': timestampCol = 'cancelled_at'; break;
    }
    if (timestampCol) {
      database.run(
        `UPDATE kitchen_orders SET status = ?, ${timestampCol} = ? WHERE id = ?`,
        [status, now, id],
      );
    } else {
      database.run(
        'UPDATE kitchen_orders SET status = ? WHERE id = ?',
        [status, id],
      );
    }
  },

  /** Count active orders (for badge display) */
  countActive(): { new: number; in_progress: number; ready: number } {
    const rows = database.all<{ status: string; cnt: number }>(
      "SELECT status, COUNT(*) as cnt FROM kitchen_orders WHERE status IN ('new', 'in_progress', 'ready') GROUP BY status",
    );
    const counts = { new: 0, in_progress: 0, ready: 0 };
    for (const r of rows) {
      if (r.status in counts) (counts as any)[r.status] = r.cnt;
    }
    return counts;
  },

  /** Check if a session has any pending (non-delivered) kitchen orders */
  hasReadyOrders(sessionId: string): boolean {
    const row = database.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM kitchen_orders WHERE session_id = ? AND status = 'ready'",
      [sessionId],
    );
    return (row?.cnt ?? 0) > 0;
  },

  /** Clean up old delivered/cancelled orders (older than 24h) */
  cleanupOld(): void {
    database.run(
      "DELETE FROM kitchen_order_items WHERE kitchen_order_id IN (SELECT id FROM kitchen_orders WHERE status IN ('delivered', 'cancelled') AND created_at < datetime('now', '-24 hours'))",
    );
    database.run(
      "DELETE FROM kitchen_orders WHERE status IN ('delivered', 'cancelled') AND created_at < datetime('now', '-24 hours')",
    );
  },
};
