import { BrowserWindow } from 'electron';
import { apiClient } from '../network/api-client';
import { orderRepo } from '../database/repos/order-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';

/** Max sync attempts for transient (network/5xx) failures before shelving. */
const MAX_SYNC_ATTEMPTS = 5;

/** Business-validation error patterns — these are NOT retried, shelved on first failure. */
const BUSINESS_ERROR_PATTERNS = [
  /insufficient stock/i,
  /stock.*not available/i,
  /price.*mismatch/i,
  /tender.*less than/i,
  /invalid.*product/i,
];

/** Classify an error message — business errors shelve immediately; transient errors retry. */
function classifyError(msg: string): { kind: 'business' | 'transient'; code?: string } {
  if (BUSINESS_ERROR_PATTERNS.some(p => p.test(msg))) {
    if (/insufficient stock/i.test(msg)) return { kind: 'business', code: 'INSUFFICIENT_STOCK' };
    return { kind: 'business', code: 'BUSINESS_RULE' };
  }
  return { kind: 'transient' };
}

function getBackendOrderNumber(response: any): string | undefined {
  const direct = response?.orderNumber ?? response?.order_number;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const nested = response?.order?.orderNumber ?? response?.order?.order_number;
  return typeof nested === 'string' && nested.trim() ? nested : undefined;
}

export interface OrderSyncResult {
  orderId: string;
  orderNumber: string | null;
  status: 'synced' | 'failed' | 'shelved';
  backendId?: string;
  error?: string;
  code?: string;
}

export interface OrderSyncSummary {
  attempted: number;
  synced: number;
  failed: number;
  results: OrderSyncResult[];
}

export class OrderSync {
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Upload all unsynced orders to backend.
   * Uses synced column as tri-state: 0=pending, 1=synced, 2=syncing (in-flight).
   * Transient errors retry up to MAX_SYNC_ATTEMPTS; business errors shelve immediately.
   */
  async syncPendingOrders(): Promise<OrderSyncSummary> {
    const summary: OrderSyncSummary = { attempted: 0, synced: 0, failed: 0, results: [] };
    const token = getSecureAuthToken();
    if (!token) return summary;

    // Recover stranded in-flight orders (synced=2 from a previous crash)
    database.run('UPDATE orders SET synced = 0 WHERE synced = 2');

    const pending = orderRepo.getUnsynced();
    if (pending.length === 0) return summary;

    summary.attempted = pending.length;

    for (const order of pending) {
      // Check retry cap — shelve orders that keep failing
      const attempts = order.sync_attempts ?? 0;
      if (attempts >= MAX_SYNC_ATTEMPTS) {
        database.run('UPDATE orders SET synced = -1 WHERE id = ?', [order.id]);
        summary.failed++;
        summary.results.push({
          orderId: order.id, orderNumber: order.order_number,
          status: 'shelved', error: order.sync_error ?? 'Max retries exceeded',
        });
        logger.warn(`[OrderSync] Order ${order.order_number || order.id} shelved after ${attempts} failed attempts`);
        continue;
      }

      try {
        // Mark as syncing (2) to prevent re-send by concurrent sync cycles
        orderRepo.markSyncing(order.id);
        database.run(
          'UPDATE orders SET sync_attempts = sync_attempts + 1 WHERE id = ?',
          [order.id],
        );
        database.save();

        const items = orderRepo.getItemsByOrderId(order.id);

        // Skip orders with no items (can't sync empty orders)
        if (items.length === 0) {
          logger.warn(`[OrderSync] Order ${order.id} has no items, skipping`);
          orderRepo.markSynced(order.id, 'no-items');
          summary.results.push({ orderId: order.id, orderNumber: order.order_number, status: 'synced', backendId: 'no-items' });
          continue;
        }

        // Transform local OrderRow + OrderItemRow[] into CreateB2BPOSOrderDto format
        const dto: Record<string, any> = {
          id: order.id, // idempotency key
          priceType: 'brutto',
          requiresInvoice: !!order.customer_nip,
          items: items
            .filter((item) => item.variant_id || item.id) // skip items with no product ID
            .map((item) => ({
              productId: item.variant_id || item.id,
              variantId: item.variant_id || item.id,
              ...(item.sku ? { variantSku: item.sku } : {}),
              packQuantity: Math.max(1, Math.round(item.quantity || 1)),
              ...(typeof item.price === 'number' && Number.isFinite(item.price) ? { customPrice: item.price / 100 } : {}),
            })),
        };

        // Skip if all items were filtered out
        if (dto.items.length === 0) {
          logger.warn(`[OrderSync] Order ${order.id} has no valid items (missing variant_id), skipping`);
          orderRepo.markSynced(order.id, 'no-valid-items');
          summary.results.push({ orderId: order.id, orderNumber: order.order_number, status: 'synced', backendId: 'no-valid-items' });
          continue;
        }

        // Payment — split or single
        const PM_MAP: Record<string, string> = {
          'CASH': 'CASH', 'CARD': 'CARD', 'BLIK': 'BLIK',
          'TRANSFER': 'BANK_TRANSFER', 'BANK_TRANSFER': 'BANK_TRANSFER',
          'CREDIT': 'CREDIT', 'INVOICE': 'BANK_TRANSFER',
        };

        const tendersJson = order.payment_tenders;
        if (tendersJson) {
          try {
            const tenders = JSON.parse(tendersJson) as Array<{ method: string; amount: number }>;
            if (tenders.length > 0) {
              // Send tenders[] — amounts in PLN (backend expects decimal, not grosze)
              dto.tenders = tenders.map(t => ({
                method: PM_MAP[t.method] || t.method,
                amount: t.amount / 100,
              }));
            }
          } catch { /* fall through to single method */ }
        }

        // Always include paymentMethod as fallback (primary/largest tender)
        if (order.payment_method) {
          dto.paymentMethod = PM_MAP[order.payment_method] || 'CASH';
        }
        // Optional fields
        if (order.staff_id) dto.staffId = order.staff_id;
        if (order.staff_name) dto.staffName = order.staff_name;
        if (order.shift_id) dto.shiftId = order.shift_id;
        if (order.customer_id) dto.customerId = order.customer_id;
        if (order.customer_nip) dto.customerNip = order.customer_nip;
        if (order.customer_name) dto.customerName = order.customer_name;
        if (order.source) dto.source = order.source;
        if (order.order_type) dto.orderType = order.order_type;
        if (order.mode) dto.mode = order.mode;
        if (order.discount > 0) dto.discountAmount = order.discount / 100;
        if (order.payment_amount > 0) dto.paymentAmount = order.payment_amount / 100;
        if (order.change_amount > 0) dto.changeAmount = order.change_amount / 100;
        if (order.tip && order.tip > 0) dto.tip = order.tip / 100;

        const result = await apiClient.createPosOrder(token, dto);
        const backendId = result.id ?? result.orderId ?? order.id;
        let backendOrderNumber = getBackendOrderNumber(result);

        // Finalize immediately — POS orders are paid at the counter, no draft stage.
        // This triggers stock deduction on the backend.
        try {
          const finishResult = await apiClient.finishOrder(token, backendId);
          backendOrderNumber = getBackendOrderNumber(finishResult) ?? backendOrderNumber;
          logger.info(`[OrderSync] Finished order ${backendId} → ${JSON.stringify(finishResult)?.substring(0, 200)}`);
        } catch (e) {
          logger.warn(`[OrderSync] finishOrder failed for ${backendId} (non-fatal): ${e}`);
        }

        orderRepo.markSynced(order.id, backendId, backendOrderNumber);
        database.run('UPDATE orders SET sync_error = NULL WHERE id = ?', [order.id]);
        database.save();
        summary.synced++;
        summary.results.push({ orderId: order.id, orderNumber: backendOrderNumber ?? order.order_number, status: 'synced', backendId });
        logger.info(`[OrderSync] Synced order ${order.order_number} → backend ${backendId}`);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('pos:order-synced', { orderId: order.id, backendId });
          }
        }
      } catch (err: any) {
        const errMsg = (err.message || String(err)).substring(0, 500);
        const classified = classifyError(errMsg);

        if (classified.kind === 'business') {
          // Business-rule rejection — don't retry. Shelve immediately.
          database.run('UPDATE orders SET synced = -1, sync_error = ? WHERE id = ?', [errMsg, order.id]);
          database.save();
          summary.failed++;
          summary.results.push({
            orderId: order.id, orderNumber: order.order_number,
            status: 'shelved', error: errMsg, code: classified.code,
          });
          logger.warn(`[OrderSync] Order ${order.order_number || order.id} shelved (${classified.code}): ${errMsg}`);
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('pos:order-sync-failed', {
                orderId: order.id, orderNumber: order.order_number, error: errMsg, code: classified.code,
              });
            }
          }
        } else {
          // Transient error — revert to pending (0) for retry
          orderRepo.markSyncFailed(order.id);
          database.run('UPDATE orders SET sync_error = ? WHERE id = ?', [errMsg, order.id]);
          database.save();
          summary.failed++;
          summary.results.push({
            orderId: order.id, orderNumber: order.order_number,
            status: 'failed', error: errMsg,
          });
          logger.warn(`[OrderSync] Failed to sync order ${order.order_number || order.id} (attempt ${attempts + 1}/${MAX_SYNC_ATTEMPTS}): ${errMsg}`);
        }
      }
    }

    if (summary.synced > 0) {
      logger.info(`[OrderSync] Synced ${summary.synced}/${summary.attempted} orders (${summary.failed} failed)`);
    }

    return summary;
  }

  /**
   * Reset a specific order for manual retry (e.g., after backend stock was corrected).
   * Only resets orders that are currently shelved (synced=-1).
   */
  resetForRetry(orderId: string): boolean {
    const order = orderRepo.getById(orderId);
    if (!order || order.synced !== -1) return false;

    database.run(
      'UPDATE orders SET synced = 0, sync_attempts = 0, sync_error = NULL WHERE id = ?',
      [orderId],
    );
    database.save();
    logger.info(`[OrderSync] Reset order ${orderId} for manual retry`);
    return true;
  }

  /**
   * One-time repair path: reset orders shelved due to INSUFFICIENT_STOCK.
   * Called manually after backend stock has been corrected.
   */
  repairStockFailures(): number {
    const rows = database.all<{ id: string }>(
      "SELECT id FROM orders WHERE synced = -1 AND backend_id IS NULL AND sync_error LIKE 'Insufficient stock%'",
    );
    if (rows.length === 0) return 0;
    database.run(
      "UPDATE orders SET synced = 0, sync_attempts = 0, sync_error = NULL WHERE synced = -1 AND backend_id IS NULL AND sync_error LIKE 'Insufficient stock%'",
    );
    database.save();
    logger.info(`[OrderSync] Reset ${rows.length} stock-failed orders for retry`);
    return rows.length;
  }

  /**
   * Start periodic sync (every 30s when online)
   */
  startPeriodicSync(): void {
    if (this.retryTimer) return; // Already running

    logger.info('[OrderSync] Starting periodic sync (30s interval)');
    this.retryTimer = setInterval(async () => {
      try {
        await this.syncPendingOrders();
      } catch (err) {
        logger.debug(`[OrderSync] Periodic sync error: ${err}`);
      }
    }, 30000);
  }

  /**
   * Stop periodic sync
   */
  stop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
      logger.info('[OrderSync] Periodic sync stopped');
    }
  }
}
