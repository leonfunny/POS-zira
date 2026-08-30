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
  calculateLineTotalGrosze,
  normalizeSaleUnit,
  normalizeSellBy,
  resolveSaleQuantity,
  type SellBy,
} from '../../../../shared/pos-sale';
import type { AndroidDatabase } from './db';
import {
  addShiftPayment,
  emptyShiftPaymentBuckets,
  getRefundPaymentAllocations,
  isShiftSaleOrder,
  summarizeShiftSales,
} from '../../../../shared/shift-accounting';
import { ShiftAlreadyClosedError } from '../../../../shared/shift-close';

// ─── Line contract (ported from order-line-contract.ts:20-42) ──────────────

export interface LocalOrderLineContract {
  id?: string | null;
  variant_id?: string | null;
  sku?: string | null;
  price?: number | null;
  quantity?: number | null;
  sale_quantity?: number | null;
  sale_unit?: string | null;
  sell_by?: string | null;
}

export function getLineSellBy(line: LocalOrderLineContract): SellBy {
  return normalizeSellBy(line.sell_by);
}

export function getLineSaleQuantity(line: LocalOrderLineContract): number {
  return resolveSaleQuantity({
    quantity: line.quantity,
    sale_quantity: line.sale_quantity,
    sale_unit: line.sale_unit,
    sell_by: line.sell_by,
  });
}

export function getLineSaleUnit(line: LocalOrderLineContract): string {
  return normalizeSaleUnit({ sale_unit: line.sale_unit, sell_by: line.sell_by });
}

export function getLineTotalGrosze(line: LocalOrderLineContract): number {
  return calculateLineTotalGrosze(Number(line.price) || 0, getLineSaleQuantity(line), getLineSellBy(line));
}

/** ported from order-line-contract.ts:44-67 — the backend order-item DTO. */
export function buildBackendOrderItem(line: LocalOrderLineContract): Record<string, any> {
  const localId = line.variant_id || line.id;
  const sellBy = getLineSellBy(line);
  const quantity = getLineSaleQuantity(line);
  const payload: Record<string, any> = {
    productId: localId ?? undefined,
    variantId: localId ?? undefined,
    ...(line.sku ? { variantSku: line.sku } : {}),
    ...(typeof line.price === 'number' && Number.isFinite(line.price) ? { customPrice: line.price / 100 } : {}),
  };
  if (sellBy === 'WEIGHT') {
    payload.saleQuantity = quantity;
    payload.saleUnit = getLineSaleUnit(line);
  } else {
    payload.packQuantity = Math.max(1, Math.round(quantity || 1));
  }
  return payload;
}

interface AndroidRefundCashflow {
  refundCount: number;
  refundTotal: number;
  cashRefundTotal: number;
  cardRefundTotal: number;
  blikRefundTotal: number;
  transferRefundTotal: number;
}

function getAndroidRefundCashflow(
  database: AndroidDatabase,
  shiftId: string,
  openedAt: string,
  closedAt: string,
  fiscalOnly: boolean,
): AndroidRefundCashflow {
  const rows = database.all<any>(
    `SELECT e.amount, e.payment_method, e.payment_tenders
       FROM android_refund_events e
       LEFT JOIN orders o ON o.id = e.order_id
      WHERE (
        e.shift_id = ?
        OR (
          e.shift_id IS NULL
          AND julianday(e.occurred_at) >= julianday(?)
          AND julianday(e.occurred_at) < julianday(?)
        )
      )
      ${fiscalOnly ? 'AND COALESCE(o.has_fiscal, 0) = 1' : ''}`,
    [shiftId, openedAt, closedAt],
  );
  const refunds = emptyShiftPaymentBuckets();
  let refundTotal = 0;
  for (const row of rows) {
    const amount = Math.max(0, Math.round(Number(row.amount) || 0));
    if (amount <= 0) continue;
    refundTotal += amount;
    for (const allocation of getRefundPaymentAllocations(row, amount)) {
      addShiftPayment(refunds, allocation.method, allocation.amount);
    }
  }
  return {
    refundCount: rows.length,
    refundTotal,
    cashRefundTotal: refunds.cash,
    cardRefundTotal: refunds.card,
    blikRefundTotal: refunds.blik,
    transferRefundTotal: refunds.transfer,
  };
}

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
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('POS order must contain at least one item');
      }
      let finalOrderNumber = '';
      database.transaction(() => {
        finalOrderNumber = order.order_number
          ? order.order_number
          : generateOrderNumber(order.number_series === 'ORDER' ? 'ORDER' : 'FISCAL');
        database.run(
          `INSERT INTO orders (id, order_number, status, subtotal, discount, tax, total, payment_method, payment_amount, change_amount, staff_id, staff_name, customer_id, customer_name, customer_nip, shift_id, source, table_id, covers, order_type, tip, mode, payment_tenders, kitchen_number)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ],
        );
        for (const item of items) {
          database.run(
            `INSERT INTO order_items (id, order_id, variant_id, name, sku, price, quantity, sale_quantity, sale_unit, sell_by, total, vat_rate, staff_id, staff_name, notes, course)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              item.id, item.order_id, item.variant_id ?? null, item.name, item.sku ?? null,
              item.price, item.quantity, getLineSaleQuantity(item), getLineSaleUnit(item), getLineSellBy(item),
              item.total, item.vat_rate ?? 23,
              item.staff_id ?? null, item.staff_name ?? null, item.notes ?? null, item.course ?? 1,
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
    recordRefundEvent(input: {
      id: string;
      orderId: string;
      shiftId: string | null;
      amount: number;
      paymentMethod?: string | null;
      paymentTenders?: string | null;
    }): void {
      database.run(
        `INSERT OR IGNORE INTO android_refund_events (
           id, order_id, shift_id, amount, payment_method, payment_tenders, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          input.id,
          input.orderId,
          input.shiftId,
          input.amount,
          input.paymentMethod ?? null,
          input.paymentTenders ?? null,
        ],
      );
    },
    markFiscalPrinted(orderId: string): void {
      database.run('UPDATE orders SET has_fiscal = 1 WHERE id = ?', [orderId]);
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
    /** Close + Z-report aggregation (split tenders and tips honored). Refunds
     *  reduce revenue and the matching tender bucket. */
    closeShift(shiftId: string, closingCash: number, fiscalOnly = false): any {
      const shift = database.get<any>('SELECT * FROM shifts WHERE id = ? AND closed_at IS NULL', [shiftId]);
      if (!shift) {
        const existing = database.get<{ id: string }>('SELECT id FROM shifts WHERE id = ?', [shiftId]);
        if (existing) throw new ShiftAlreadyClosedError(shiftId);
        throw new Error(`Shift ${shiftId} not found`);
      }
      const orders = database.all<any>('SELECT * FROM orders WHERE shift_id = ?', [shiftId]);
      const settledOrders = orders.filter(isShiftSaleOrder);
      const salesOrders = fiscalOnly
        ? settledOrders.filter((order: any) => order.has_fiscal === 1)
        : settledOrders;
      const accounting = summarizeShiftSales(salesOrders);
      const drawerAccounting = fiscalOnly ? summarizeShiftSales(settledOrders) : accounting;
      const totalDiscounts = accounting.totalDiscounts;
      const closedAt = new Date().toISOString();
      const refundCashflow = getAndroidRefundCashflow(
        database,
        shiftId,
        shift.opened_at,
        closedAt,
        fiscalOnly,
      );
      const drawerRefundCashflow = fiscalOnly
        ? getAndroidRefundCashflow(database, shiftId, shift.opened_at, closedAt, false)
        : refundCashflow;
      const totalRefunds = refundCashflow.refundTotal;
      const cashTotal = drawerAccounting.payments.cash - drawerRefundCashflow.cashRefundTotal;
      const cardTotal = drawerAccounting.payments.card - drawerRefundCashflow.cardRefundTotal;
      const blikTotal = drawerAccounting.payments.blik - drawerRefundCashflow.blikRefundTotal;
      const transferTotal = drawerAccounting.payments.transfer - drawerRefundCashflow.transferRefundTotal;
      const totalSales = accounting.salesTotal - totalRefunds;
      const expectedClosingCash = (shift.opening_cash ?? 0) + cashTotal;

      database.run(
        "UPDATE shifts SET closing_cash = ?, closed_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
        [closingCash, shiftId],
      );
      const closed = database.get<{ count: number }>('SELECT changes() AS count')?.count ?? 0;
      if (closed !== 1) throw new ShiftAlreadyClosedError(shiftId);
      const persistedClosedAt = database.get<{ closed_at: string }>(
        'SELECT closed_at FROM shifts WHERE id = ?', [shiftId],
      )?.closed_at ?? null;
      return {
        shiftId,
        staffName: shift.staff_name ?? '',
        openedAt: shift.opened_at,
        closedAt: persistedClosedAt,
        openingCash: shift.opening_cash ?? 0,
        closingCash,
        expectedClosingCash,
        totalSales,
        totalOrders: salesOrders.length,
        refundTransactions: refundCashflow.refundCount,
        cashTotal,
        cardTotal,
        blikTotal,
        transferTotal,
        totalRefunds,
        totalDiscounts,
        totalTips: accounting.totalTips,
        difference: closingCash - expectedClosingCash,
        unsyncedOrders: this.getUnsyncedCountByShift(shiftId),
        fiscalOnlySales: fiscalOnly,
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
