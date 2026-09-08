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
  getOrderPaymentAllocations,
  summarizeShiftSales,
} from '../../../../shared/shift-accounting';
import { ShiftAlreadyClosedError } from '../../../../shared/shift-close';

const shiftReportNumbers = ['openingCash', 'closingCash', 'totalSales', 'totalOrders', 'cashTotal',
  'cardTotal', 'blikTotal', 'transferTotal', 'totalRefunds', 'totalDiscounts', 'totalTips',
  'difference', 'unsyncedOrders'] as const;
const shiftReportNonnegative = ['openingCash', 'closingCash', 'totalOrders', 'totalRefunds',
  'totalDiscounts', 'totalTips', 'unsyncedOrders'] as const;

/** Validate stored evidence against the shift, never against mutable orders. */
function readShiftReportSnapshot(shift: any): any | null {
  if (shift.close_report_json === null || shift.close_report_json === undefined) return null;
  const invalid = () => new Error('ANDROID_SHIFT_REPORT_INVALID: Saved close report does not match the finalized shift.');
  let report: any;
  try { report = JSON.parse(shift.close_report_json); } catch { throw invalid(); }
  const date = (value: unknown) => typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || !date(shift.opened_at) || !date(shift.closed_at)
    || report.shiftId !== shift.id || report.openedAt !== shift.opened_at || report.closedAt !== shift.closed_at
    || report.openingCash !== (shift.opening_cash ?? 0) || report.closingCash !== shift.closing_cash
    || typeof report.staffName !== 'string'
    || shiftReportNumbers.some(field => !Number.isSafeInteger(report[field]))
    || shiftReportNonnegative.some(field => report[field] < 0)) throw invalid();
  return report;
}

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

// ─── Repo ──────────────────────────────────────────────────────────────────

const validHistoryId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
const validHistoryMoney = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function hasVerifiedHistoryLines(order: any, items: any[]): boolean {
  if (order.mode !== 'restaurant' || !order._restaurantHeader || !items.length) return false;
  const originalIds = new Set<string>();
  for (const item of items) {
    if (!validHistoryId(item.restaurant_line_id) || originalIds.has(item.restaurant_line_id) || !validHistoryId(item.variant_id)) return false;
    if (!Number.isInteger(item.course) || item.course < 1 || item.course > 99) return false;
    if (item.notes != null && (typeof item.notes !== 'string' || item.notes.length > 4000)) return false;
    originalIds.add(item.restaurant_line_id);
  }
  return true;
}

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

    /** Explicit history cache import, never a local sale or reconciliation.
     * Caller owns authenticated tenant validation and awaits flush afterward. */
    upsertFromServer(adaptedOrder: any, items: any[]): { inserted: boolean; localOrderId: string } {
      if (!validHistoryId(adaptedOrder?.id)) throw new Error('ANDROID_HISTORY_INVALID_ORDER_ID');
      const id = adaptedOrder.id;
      const matches = database.all<any>('SELECT * FROM orders WHERE id = ? OR backend_id = ?', [id, id]);
      const local = matches.find(row => row.source !== 'SERVER' || row.synced !== 1 || row.sync_payload_json);
      if (local) return { inserted: false, localOrderId: local.id };
      if (matches.length > 1 || (matches[0] && matches[0].id !== id)) throw new Error('ANDROID_HISTORY_AMBIGUOUS_ORDER_ID');
      const existing = matches[0];
      if (adaptedOrder._origin !== 'server' || adaptedOrder.backend_id !== id || adaptedOrder.synced !== 1) throw new Error('ANDROID_HISTORY_INVALID_SOURCE');
      if (typeof adaptedOrder.created_at !== 'string' || !Number.isFinite(Date.parse(adaptedOrder.created_at))) throw new Error('ANDROID_HISTORY_INVALID_DATE');
      if (!Array.isArray(items) || !items.length) throw new Error('ANDROID_HISTORY_INVALID_ITEMS');
      if (adaptedOrder.mode === 'billiard' || adaptedOrder.billiard_origin_json || items?.some(item => item?.billiard_json)) {
        throw new Error('ANDROID_HISTORY_BILLIARD_IMPORT_UNSUPPORTED');
      }
      for (const field of ['subtotal', 'discount', 'tax', 'total', 'payment_amount', 'change_amount', 'tip', 'refund_amount']) {
        if (!validHistoryMoney(adaptedOrder[field] ?? 0)) throw new Error(`ANDROID_HISTORY_INVALID_MONEY: ${field}`);
      }
      const ids = new Set<string>();
      for (const item of items) {
        if (!validHistoryId(item?.id) || item.order_id !== id || ids.has(item.id)) throw new Error('ANDROID_HISTORY_INVALID_ITEM_ID');
        if (typeof item.name !== 'string' || !item.name.trim() || !validHistoryMoney(item.price) || !validHistoryMoney(item.total)
          || !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.vat_rate) || item.vat_rate < 0
          || !validHistoryMoney(item.allocated_discount ?? 0) || !validHistoryMoney(item.payable_total ?? item.total)) {
          throw new Error('ANDROID_HISTORY_INVALID_ITEM_VALUES');
        }
        const owner = database.get<{ order_id: string }>('SELECT order_id FROM order_items WHERE id = ?', [item.id]);
        if (owner && owner.order_id !== id) throw new Error('ANDROID_HISTORY_FOREIGN_ITEM_ID');
        ids.add(item.id);
      }
      const linked = hasVerifiedHistoryLines(adaptedOrder, items);
      const header = adaptedOrder._restaurantHeader;
      const localItems = existing ? database.all<any>('SELECT * FROM order_items WHERE order_id = ?', [id]) : [];
      if (existing && (localItems.length !== items.length || items.some(incoming => !localItems.some(row => row.id === incoming.id && row.variant_id === incoming.variant_id)))) {
        throw new Error('ANDROID_HISTORY_ITEM_SET_MISMATCH');
      }
      const repairLinks = linked && localItems.every(row => {
        const incoming = items.find(item => item.id === row.id);
        return !row.restaurant_line_id || row.restaurant_line_id === incoming?.restaurant_line_id;
      });
      database.transaction(() => {
        if (existing) {
          // Import must not change newer refund/accounting facts in the cache.
          database.run('UPDATE orders SET shift_id = NULL WHERE id = ? AND source = ?', [id, 'SERVER']);
          if (header) database.run('UPDATE orders SET table_id = ?, covers = ?, order_type = ? WHERE id = ? AND source = ?',
            [header.tableId, header.covers, header.orderType, id, 'SERVER']);
          if (repairLinks) for (const item of items) database.run(
            'UPDATE order_items SET notes = ?, course = ?, restaurant_line_id = ? WHERE id = ? AND order_id = ? AND variant_id = ?',
            [item.notes ?? null, item.course, item.restaurant_line_id, item.id, id, item.variant_id]);
          return;
        }
        // Fixed column allowlist: never spread network fields into SQL.
        const mirror = {
          id, order_number: adaptedOrder.order_number ?? null, status: adaptedOrder.status ?? 'COMPLETED',
          subtotal: adaptedOrder.subtotal ?? 0, discount: adaptedOrder.discount ?? 0, tax: adaptedOrder.tax ?? 0,
          total: adaptedOrder.total ?? 0, payment_method: adaptedOrder.payment_method ?? null,
          payment_amount: adaptedOrder.payment_amount ?? 0, change_amount: adaptedOrder.change_amount ?? 0,
          staff_id: adaptedOrder.staff_id ?? null, staff_name: adaptedOrder.staff_name ?? null,
          customer_id: adaptedOrder.customer_id ?? null, customer_name: adaptedOrder.customer_name ?? null,
          customer_nip: adaptedOrder.customer_nip ?? null, shift_id: null, source: 'SERVER',
          table_id: header?.tableId ?? null, covers: header?.covers ?? null, order_type: header?.orderType ?? 'standard',
          tip: adaptedOrder.tip ?? 0, mode: adaptedOrder.mode ?? 'retail', payment_tenders: adaptedOrder.payment_tenders ?? null,
          synced: 1, backend_id: id, synced_at: new Date().toISOString(), created_at: adaptedOrder.created_at,
          refund_amount: adaptedOrder.refund_amount ?? 0, refund_reason: adaptedOrder.refund_reason ?? null,
          refunded_at: adaptedOrder.refunded_at ?? null, refund_lines: adaptedOrder.refund_lines ?? null,
        };
        database.run(`INSERT INTO orders (${Object.keys(mirror).join(', ')}) VALUES (${Object.keys(mirror).map(() => '?').join(', ')})`, Object.values(mirror));
        for (const item of items) {
          const row = {
            id: item.id, order_id: id, variant_id: item.variant_id ?? null, name: item.name, sku: item.sku ?? null,
            price: item.price, quantity: item.quantity, sale_quantity: getLineSaleQuantity(item),
            sale_unit: getLineSaleUnit(item), sell_by: getLineSellBy(item), total: item.total, vat_rate: item.vat_rate,
            staff_id: item.staff_id ?? null, staff_name: item.staff_name ?? null,
            notes: linked ? item.notes ?? null : null, course: linked ? item.course : null,
            allocated_discount: item.allocated_discount ?? 0, payable_total: item.payable_total ?? item.total,
            restaurant_line_id: linked ? item.restaurant_line_id : null,
          };
          database.run(`INSERT INTO order_items (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row));
        }
      });
      return { inserted: !existing, localOrderId: id };
    },

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
        database.run('UPDATE orders SET sync_metadata_eligible = 1 WHERE id = ?', [order.id]);
        for (const item of items) {
          database.run(
            `INSERT INTO order_items (id, order_id, variant_id, name, sku, price, quantity, sale_quantity, sale_unit, sell_by, total, vat_rate, staff_id, staff_name, notes, course, allocated_discount, payable_total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              item.id, item.order_id, item.variant_id ?? null, item.name, item.sku ?? null,
              item.price, item.quantity, getLineSaleQuantity(item), getLineSaleUnit(item), getLineSellBy(item),
              item.total, item.vat_rate ?? 23,
              item.staff_id ?? null, item.staff_name ?? null, item.notes ?? null, item.course ?? 1,
              item.allocated_discount ?? 0, item.payable_total ?? (item.total - (item.allocated_discount ?? 0)),
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
      if (database.get('SELECT id FROM orders WHERE id = ? AND refund_event_context_json IS NOT NULL', [id])
        || database.get('SELECT request_id FROM pos_refund_events WHERE local_order_id = ? LIMIT 1', [id])) {
        throw new Error('ANDROID_REFUND_EVENT_LEGACY_WRITE_BLOCKED');
      }
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
      if (order.sync_payload_json) {
        return { deleted: false, restocked: 0, error: 'Order upload is frozen. Reconcile with the server before cancelling.' };
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
      if (filters.fiscalOnly === true) {
        // Android has no durable confirmed fiscal-attempt journal yet. Never
        // label a server mirror, payment method or POS number as fiscal proof.
        throw new Error('Fiscal-only history is not supported on this Android device yet. Enable non-fiscal order history in Settings to view all orders.');
      }
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
    getClosedShiftReport(shiftId: string): any | null {
      const shift = database.get<any>('SELECT * FROM shifts WHERE id = ?', [shiftId]);
      return shift ? readShiftReportSnapshot(shift) : null;
    },
    /** Close + Z-report aggregation (split tenders and tips honored). Refunds
     *  reduce revenue and the matching tender bucket. */
    closeShift(shiftId: string, closingCash: number): any {
      const shift = database.get<any>('SELECT * FROM shifts WHERE id = ?', [shiftId]);
      if (!shift) throw new Error(`Shift ${shiftId} not found`);
      const saved = readShiftReportSnapshot(shift);
      if (saved) return saved;
      if (shift.closed_at !== null) throw new ShiftAlreadyClosedError(shiftId);
      if (!Number.isSafeInteger(closingCash) || closingCash < 0) throw new Error('Closing cash must be a nonnegative safe integer in grosze');
      if (database.get('SELECT id FROM orders WHERE shift_id = ? AND refund_event_context_json IS NOT NULL LIMIT 1', [shiftId])
        || database.get('SELECT request_id FROM pos_refund_events WHERE local_shift_id = ? LIMIT 1', [shiftId])) {
        throw new Error('ANDROID_REFUND_EVENT_REPORT_NOT_ENABLED: Canonical event accounting is required before closing this shift.');
      }
      return database.transaction(() => {
        const orders = database.all<any>('SELECT * FROM orders WHERE shift_id = ?', [shiftId]);
        const accounting = summarizeShiftSales(orders);
        const totalDiscounts = accounting.totalDiscounts;
        // Per-order cumulative refund_amount for REFUNDED/PARTIAL_REFUND orders
        // (shift-controller.ts:140-143). Refunds of unsynced orders can't happen
        // (refundOrder refuses them), so every refund_amount here is backend-confirmed.
        const totalRefunds = orders.reduce(
          (sum: number, o: any) => sum + (o.refund_amount && o.refund_amount > 0 ? o.refund_amount : 0),
          0,
        );

        const paymentBuckets = accounting.payments;

        // 2. Subtract each order's refund from the matching tender bucket
        //    (shift-controller.ts:145-175). Split tenders distribute the refund
        //    proportionally with the last tender absorbing the rounding remainder;
        //    a single-method order refunds straight against that method.
        for (const o of orders) {
          if (!(o.refund_amount > 0)) continue;
          const tenders = getOrderPaymentAllocations(o);
          if (tenders.length > 1) {
            const orderTotal = tenders.reduce((s: number, t: any) => s + (t.amount ?? 0), 0);
            if (orderTotal > 0) {
              let distributed = 0;
              for (let i = 0; i < tenders.length; i += 1) {
                const isLast = i === tenders.length - 1;
                const share = isLast
                  ? o.refund_amount - distributed
                  : Math.round(o.refund_amount * ((tenders[i].amount ?? 0) / orderTotal));
                distributed += share;
                addShiftPayment(paymentBuckets, tenders[i].method, share, -1);
              }
              continue;
            }
          }
          addShiftPayment(paymentBuckets, tenders[0]?.method ?? o.payment_method, o.refund_amount, -1);
        }

        const totalSales = accounting.salesTotal - totalRefunds;

        const closedAt = database.get<{ closed_at: string }>(
          "SELECT datetime('now') AS closed_at",
        )?.closed_at ?? null;
        const report = {
          shiftId,
          staffName: shift.staff_name ?? '',
          openedAt: shift.opened_at,
          closedAt,
          openingCash: shift.opening_cash ?? 0,
          closingCash,
          totalSales,
          totalOrders: orders.length,
          cashTotal: paymentBuckets.cash,
          cardTotal: paymentBuckets.card,
          blikTotal: paymentBuckets.blik,
          transferTotal: paymentBuckets.transfer,
          totalRefunds,
          totalDiscounts,
          totalTips: accounting.totalTips,
          difference: closingCash - ((shift.opening_cash ?? 0) + paymentBuckets.cash),
          unsyncedOrders: this.getUnsyncedCountByShift(shiftId),
        };
        const snapshot = JSON.stringify(report);
        // Validate before mutation; the single UPDATE and transaction bind the
        // cash/date/report so an exception cannot leave a partial close behind.
        readShiftReportSnapshot({ ...shift, closing_cash: closingCash, closed_at: closedAt, close_report_json: snapshot });
        database.run(
          'UPDATE shifts SET closing_cash = ?, closed_at = ?, close_report_json = ? WHERE id = ? AND closed_at IS NULL AND close_report_json IS NULL',
          [closingCash, closedAt, snapshot, shiftId],
        );
        const closed = database.get<{ count: number }>('SELECT changes() AS count')?.count ?? 0;
        if (closed !== 1) throw new ShiftAlreadyClosedError(shiftId);
        return report;
      });
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
