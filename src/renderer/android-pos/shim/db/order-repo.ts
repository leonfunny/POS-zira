/**
 * Android order/shift repo — port of the Windows order-repo + shift-controller
 * subset the retail CASH flow needs (packet S8+S9).
 *
 * Parity sources (COPIED, not redesigned):
 *  - create + item insert:        src/main/database/repos/order-repo.ts:202-268
 *  - generateOrderNumber:         order-repo.ts (sequence_counters, POS-/ZAM- prefix)
 *  - getUnsynced/mark* tri-state: order-repo.ts:474-514 (0 pending, 1 synced,
 *                                 2 in-flight, -1 shelved)
 *  - shift open (local-first):    src/main/pos/shift-controller.ts:75-92
 *  - shift close report:          shift-controller.ts:96-170 (split tenders)
 *  - line normalization helpers:  src/main/pos/order-line-contract.ts (thin
 *                                 wrappers over pure src/shared/pos-sale)
 *
 * Divergences (documented): no posEventEmitter (ERP outbox is a later packet);
 * no kitchen pickup settle (restaurant, EXCLUDE); history filters are the
 * S1 §2.G subset.
 */

import {
  buildBackendOrderItem,
  getLineSaleQuantity,
  getLineSaleUnit,
  getLineSellBy,
  getLineTotalGrosze,
  type LocalOrderLineContract,
} from '../../../../shared/pos/order-line-contract';
import type { AndroidDatabase } from './db';

// The line contract is IMPORTED, not re-implemented. It used to be a hand copy
// here, and the copy had quietly dropped the per-line `billiard` block — which
// only surfaced against a real backend, as a rejected settle. Re-export so the
// shim's existing importers keep their paths.
export {
  buildBackendOrderItem,
  getLineSaleQuantity,
  getLineSaleUnit,
  getLineSellBy,
  getLineTotalGrosze,
  type LocalOrderLineContract,
};

// ─── Repo ──────────────────────────────────────────────────────────────────

export function createOrderRepo(database: AndroidDatabase) {
  const generateOrderNumber = (series: 'FISCAL' | 'ORDER' = 'FISCAL'): string => {
    const dateRow = database.get<{ d: string }>("SELECT strftime('%Y%m%d', 'now') as d");
    const datePrefix = dateRow?.d ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counterName = series === 'ORDER' ? `order-copy-${datePrefix}` : `order-${datePrefix}`;
    database.run(
      'INSERT INTO sequence_counters (name, current_value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING',
      [counterName],
    );
    database.run('UPDATE sequence_counters SET current_value = current_value + 1 WHERE name = ?', [counterName]);
    const row = database.get<{ current_value: number }>(
      'SELECT current_value FROM sequence_counters WHERE name = ?', [counterName],
    );
    const seq = (row?.current_value ?? 1).toString().padStart(4, '0');
    return `${series === 'ORDER' ? 'ZAM' : 'POS'}-${datePrefix}-${seq}`;
  };

  return {
    generateOrderNumber,

    /** ported from order-repo.ts:202-268 (minus ERP outbox + kitchen settle). */
    create(order: any, items: any[]): string {
      let finalOrderNumber = '';
      database.transaction(() => {
        finalOrderNumber = order.order_number
          ? order.order_number
          : generateOrderNumber(order.number_series === 'ORDER' ? 'ORDER' : 'FISCAL');
        database.run(
          `INSERT INTO orders (id, order_number, status, subtotal, discount, tax, total, payment_method, payment_amount, change_amount, staff_id, staff_name, customer_id, customer_name, customer_nip, shift_id, source, table_id, covers, order_type, tip, mode, payment_tenders, kitchen_number, client_attempt_id, billiard_origin_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            order.id, finalOrderNumber, order.status ?? 'COMPLETED', order.subtotal ?? 0,
            order.discount ?? 0, order.tax ?? 0, order.total ?? 0,
            order.payment_method ?? null, order.payment_amount ?? 0,
            order.change_amount ?? 0, order.staff_id ?? null,
            order.staff_name ?? null, order.customer_id ?? null,
            order.customer_name ?? null, order.customer_nip ?? null,
            order.shift_id ?? null, order.source ?? 'POS',
            order.table_id ?? null, order.covers ?? null,
            order.order_type ?? 'standard', order.tip ?? 0, order.mode ?? 'retail',
            order.payment_tenders ?? null, order.kitchen_number ?? null,
            // v7: the payment-attempt identity + frozen billiard origin. The
            // shared PaymentModal sends both on every create
            // (PaymentModal.tsx:673-677) and they used to be dropped here, so
            // a committed billiard order could not be verified against its
            // journal at all.
            order.client_attempt_id ?? null, order.billiard_origin_json ?? null,
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
              // v7: frozen billiard line metadata (PaymentModal.tsx:701-705).
              // `payable_total` falls back to the line total exactly like the
              // renderer does, so ordinary lines stay consistent.
              item.billiard_json ?? null, item.inventory_policy ?? null, item.refund_policy ?? null,
              item.allocated_discount ?? 0, item.payable_total ?? item.total ?? null,
            ],
          );
        }
      });
      return order.id;
    },

    getById(id: string): any | null {
      return database.get('SELECT * FROM orders WHERE id = ?', [id]) ?? null;
    },
    getItemsByOrderId(orderId: string): any[] {
      return database.all('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    },
    /** Only pending (0) — never in-flight (2). order-repo.ts:474-477. */
    getUnsynced(): any[] {
      return database.all('SELECT * FROM orders WHERE synced = 0');
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
    /** Revert in-flight (2) → pending (0). order-repo.ts:510-513. */
    markSyncFailed(id: string): void {
      database.run('UPDATE orders SET synced = 0 WHERE id = ? AND synced = 2', [id]);
    },
    shelve(id: string, error: string): void {
      database.run('UPDATE orders SET synced = -1, sync_error = ? WHERE id = ?', [error, id]);
    },
    /**
     * Mark an order refunded (full or partial). Ported from Windows
     * order-repo.ts:518-524 — sets status REFUNDED/PARTIAL_REFUND, the cumulative
     * refund_amount (grosze), reason, refunded_at, and the merged refund_lines
     * JSON. The Z-report (closeShift) reads refund_amount + status to subtract
     * refunds from sales + the matching tender bucket (shift-controller.ts:139-177).
     */
    markRefunded(
      id: string,
      amount: number,
      reason: string,
      type: 'FULL' | 'PARTIAL',
      refundLines?: Array<{ name: string; quantity: number; unitPrice: number; refundAmount: number; vatRate?: number; sku?: string; unit?: string; variantId?: string }>,
    ): void {
      const status = type === 'FULL' ? 'REFUNDED' : 'PARTIAL_REFUND';
      database.run(
        "UPDATE orders SET status = ?, refund_amount = ?, refund_reason = ?, refunded_at = datetime('now'), refund_lines = ? WHERE id = ?",
        [status, amount, reason, refundLines ? JSON.stringify(refundLines) : null, id],
      );
    },
    /**
     * Delete an UNSYNCED local order and restock its lines (order-repo.ts
     * deleteLocalUnsynced). Refuses a synced/in-flight order — those must be
     * cancelled/refunded server-side, never silently dropped. Returns whether
     * it deleted and how many units were restocked.
     */
    deleteLocalUnsynced(id: string): { deleted: boolean; restocked: number; error?: string } {
      const order = database.get<any>('SELECT * FROM orders WHERE id = ?', [id]);
      if (!order) return { deleted: false, restocked: 0, error: 'not-found' };
      if (order.backend_id || order.synced === 1) {
        return { deleted: false, restocked: 0, error: 'Synced orders cannot be deleted locally. Cancel or refund via the backend instead.' };
      }
      if (order.synced === 2) {
        return { deleted: false, restocked: 0, error: 'Order sync is in progress. Wait for it to finish before deleting.' };
      }
      const items = database.all<any>('SELECT * FROM order_items WHERE order_id = ?', [id]);
      let restocked = 0;
      database.transaction(() => {
        for (const item of items) {
          if (item.variant_id && item.quantity > 0) {
            database.run(
              'UPDATE product_variants SET in_stock = in_stock + ?, available_qty = available_qty + ? WHERE id = ? AND track_inventory = 1',
              [item.quantity, item.quantity, item.variant_id],
            );
            restocked += item.quantity;
          }
        }
        database.run('DELETE FROM order_items WHERE order_id = ?', [id]);
        database.run('DELETE FROM orders WHERE id = ?', [id]);
      });
      return { deleted: true, restocked };
    },

    /** Reset a shelved (-1) order for manual retry. order-repo.ts resetForRetry. */
    resetForRetry(id: string): boolean {
      const row = database.get<{ synced: number }>('SELECT synced FROM orders WHERE id = ?', [id]);
      if (!row || row.synced !== -1) return false;
      database.run('UPDATE orders SET synced = 0, sync_attempts = 0, sync_error = NULL WHERE id = ?', [id]);
      return true;
    },
    /** Recover stranded in-flight rows after process death. order-sync.ts:71-79. */
    recoverStrandedSyncing(): number {
      const stranded = database.get<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM orders WHERE synced = 2',
      )?.cnt ?? 0;
      if (stranded > 0) database.run('UPDATE orders SET synced = 0 WHERE synced = 2');
      return stranded;
    },

    /** S1 §2.G local history subset (from/to/paymentMethod/staffName/page/limit). */
    getHistory(filters: any = {}): { orders: any[]; total: number; page: number; limit: number } {
      const where: string[] = [];
      const params: any[] = [];
      if (filters.from) { where.push("date(created_at) >= date(?)"); params.push(filters.from); }
      if (filters.to) { where.push("date(created_at) <= date(?)"); params.push(filters.to); }
      if (filters.paymentMethod) { where.push('payment_method = ?'); params.push(filters.paymentMethod); }
      if (filters.staffName) { where.push('staff_name LIKE ?'); params.push(`%${filters.staffName}%`); }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const page = Math.max(1, Number(filters.page) || 1);
      const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50));
      const total = database.get<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM orders ${whereSql}`, params,
      )?.cnt ?? 0;
      const orders = database.all(
        `SELECT * FROM orders ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, (page - 1) * limit],
      );
      return { orders, total, page, limit };
    },

    getByShift(shiftId: string): any[] {
      return database.all('SELECT * FROM orders WHERE shift_id = ?', [shiftId]);
    },
    getUnsyncedCountByShift(shiftId: string): number {
      return database.get<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM orders WHERE shift_id = ? AND synced != 1',
        [shiftId],
      )?.cnt ?? 0;
    },

    // ── Shifts (shift-controller.ts:75-170 port) ───────────────────────────
    openShift(shiftId: string, staffId: string, staffName: string, openingCash: number): void {
      database.run(
        'INSERT INTO shifts (id, staff_id, staff_name, opening_cash) VALUES (?, ?, ?, ?)',
        [shiftId, staffId, staffName, openingCash],
      );
    },
    getActiveShift(): any | null {
      return database.get(
        'SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1',
      ) ?? null;
    },
    getOpenShiftById(shiftId: string): any | null {
      return database.get('SELECT * FROM shifts WHERE id = ? AND closed_at IS NULL', [shiftId]) ?? null;
    },
    /** Close + Z-report aggregation (split tenders honored). Refunds are
     *  subtracted from totalSales AND the matching tender bucket (a cash refund
     *  reduces cashTotal); discounts are subtracted from totalSales — ported from
     *  Windows shift-controller.ts:139-177 (the deferred REVIEW_FIXES item). */
    closeShift(shiftId: string, closingCash: number): any {
      const shift = database.get<any>('SELECT * FROM shifts WHERE id = ?', [shiftId]);
      if (!shift) throw new Error(`Shift ${shiftId} not found`);
      const orders = database.all<any>('SELECT * FROM orders WHERE shift_id = ?', [shiftId]);
      const grossSales = orders.reduce((sum: number, o: any) => sum + (o.total ?? 0), 0);
      const totalDiscounts = orders.reduce((sum: number, o: any) => sum + (o.discount ?? 0), 0);
      // Per-order cumulative refund_amount for REFUNDED/PARTIAL_REFUND orders
      // (shift-controller.ts:140-143). Refunds of unsynced orders can't happen
      // (refundOrder refuses them), so every refund_amount here is backend-confirmed.
      const totalRefunds = orders.reduce(
        (sum: number, o: any) => sum + (o.refund_amount && o.refund_amount > 0 ? o.refund_amount : 0),
        0,
      );

      let cashTotal = 0; let cardTotal = 0; let blikTotal = 0; let transferTotal = 0;
      // Bucket classifier shared by the sale-aggregation and refund-subtraction
      // passes so a refund always comes out of the same bucket the sale went into
      // (CASH/CARD/BLIK; TRANSFER|BANK_TRANSFER|unknown → transferTotal). `sign`
      // is +1 for sales, -1 for refunds.
      const applyTender = (method: string | null | undefined, amount: number, sign: number) => {
        const m = String(method ?? '').toUpperCase();
        if (m === 'CASH') cashTotal += sign * amount;
        else if (m === 'CARD') cardTotal += sign * amount;
        else if (m === 'BLIK') blikTotal += sign * amount;
        else transferTotal += sign * amount;
      };
      const parseTenders = (o: any): Array<{ method: string; amount: number }> | null => {
        if (!o.payment_tenders) return null;
        try {
          const parsed = JSON.parse(o.payment_tenders);
          return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
        } catch { return null; }
      };

      // 1. Aggregate sales (split tenders honored; single-method fallback).
      for (const o of orders) {
        const tenders = parseTenders(o);
        const buckets = tenders ?? [{ method: o.payment_method ?? 'CASH', amount: o.total ?? 0 }];
        for (const t of buckets) applyTender(t.method, t.amount ?? 0, +1);
      }

      // 2. Subtract each order's refund from the matching tender bucket
      //    (shift-controller.ts:145-175). Split tenders distribute the refund
      //    proportionally with the last tender absorbing the rounding remainder;
      //    a single-method order refunds straight against that method.
      for (const o of orders) {
        if (!(o.refund_amount > 0)) continue;
        const tenders = parseTenders(o);
        if (tenders) {
          const orderTotal = tenders.reduce((s: number, t: any) => s + (t.amount ?? 0), 0);
          if (orderTotal > 0) {
            let distributed = 0;
            for (let i = 0; i < tenders.length; i += 1) {
              const isLast = i === tenders.length - 1;
              const share = isLast
                ? o.refund_amount - distributed
                : Math.round(o.refund_amount * ((tenders[i].amount ?? 0) / orderTotal));
              distributed += share;
              applyTender(tenders[i].method, share, -1);
            }
            continue;
          }
        }
        applyTender(o.payment_method, o.refund_amount, -1);
      }

      const totalSales = grossSales - totalRefunds - totalDiscounts;

      database.run(
        "UPDATE shifts SET closing_cash = ?, closed_at = datetime('now') WHERE id = ?",
        [closingCash, shiftId],
      );
      const closedAt = database.get<{ closed_at: string }>(
        'SELECT closed_at FROM shifts WHERE id = ?', [shiftId],
      )?.closed_at ?? null;
      return {
        shiftId,
        staffName: shift.staff_name ?? '',
        openedAt: shift.opened_at,
        closedAt,
        openingCash: shift.opening_cash ?? 0,
        closingCash,
        totalSales,
        totalOrders: orders.length,
        cashTotal, cardTotal, blikTotal, transferTotal,
        totalRefunds,
        totalDiscounts,
        difference: closingCash - ((shift.opening_cash ?? 0) + cashTotal),
        unsyncedOrders: this.getUnsyncedCountByShift(shiftId),
      };
    },

    // ── Staff (staff picker; seeded at login until a staff-sync packet) ─────
    upsertStaff(staff: { id: string; user_id?: string | null; name: string; role?: string | null }): void {
      database.run(
        `INSERT INTO staff (id, user_id, name, commission_rate, is_active, role)
         VALUES (?, ?, ?, 0, 1, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, is_active = 1`,
        [staff.id, staff.user_id ?? null, staff.name, staff.role ?? null],
      );
    },
    /**
     * Bulk REPLACE the staff table from a sync pull (E2a — GET /api/v1/staff).
     * One transaction: wipe the local rows, then insert the backend's current
     * list. This makes the picker a faithful mirror of the backend staff roster
     * — a technician removed server-side disappears from the per-line `<select>`,
     * and the login-time cashier seed is superseded once the real roster lands
     * (in production the cashier is themselves a staff row the backend returns).
     * Honors the backend's commission_rate + is_active. A FAILED pull never
     * reaches this method (syncStaff returns early on fetch error), so the local
     * cache survives a transient outage.
     */
    bulkUpsertStaff(rows: Array<{ id: string; user_id?: string | null; name: string; commission_rate?: number; is_active?: number; role?: string | null }>): void {
      database.transaction(() => {
        database.run('DELETE FROM staff');
        for (const s of rows) {
          database.run(
            `INSERT INTO staff (id, user_id, name, commission_rate, is_active, role)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [s.id, s.user_id ?? null, s.name, s.commission_rate ?? 0, s.is_active ?? 1, s.role ?? null],
          );
        }
      });
    },
    getStaff(): any[] {
      return database.all('SELECT * FROM staff WHERE is_active = 1 ORDER BY name');
    },
  };
}

export type AndroidOrderRepo = ReturnType<typeof createOrderRepo>;
