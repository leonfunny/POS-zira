import { apiClient } from '../network/api-client';
import { orderRepo } from '../database/repos/order-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';

/** Max sync attempts before an order is shelved as permanently failed. */
const MAX_SYNC_ATTEMPTS = 5;

export class OrderSync {
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Upload all unsynced orders to backend.
   * Uses synced column as tri-state: 0=pending, 1=synced, 2=syncing (in-flight).
   * Orders exceeding MAX_SYNC_ATTEMPTS are marked synced=-1 (permanently failed).
   */
  async syncPendingOrders(): Promise<number> {
    const token = getSecureAuthToken();
    if (!token) return 0;

    const pending = orderRepo.getUnsynced();
    if (pending.length === 0) return 0;

    let synced = 0;

    for (const order of pending) {
      // Check retry cap — shelve orders that keep failing
      const attempts = (order as any).sync_attempts ?? 0;
      if (attempts >= MAX_SYNC_ATTEMPTS) {
        database.run(
          'UPDATE orders SET synced = -1 WHERE id = ?',
          [order.id],
        );
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
          continue;
        }

        // Transform local OrderRow + OrderItemRow[] into CreateB2BPOSOrderDto format
        const dto: Record<string, any> = {
          id: order.id, // idempotency key
          requiresInvoice: !!order.customer_nip,
          items: items
            .filter((item) => item.variant_id || item.id) // skip items with no product ID
            .map((item) => ({
              productId: item.variant_id || item.id,
              packQuantity: Math.max(1, Math.round(item.quantity || 1)),
              ...(item.price > 0 ? { customPrice: item.price } : {}),
            })),
        };

        // Skip if all items were filtered out
        if (dto.items.length === 0) {
          logger.warn(`[OrderSync] Order ${order.id} has no valid items (missing variant_id), skipping`);
          orderRepo.markSynced(order.id, 'no-valid-items');
          continue;
        }

        // Payment — split or single
        const PM_MAP: Record<string, string> = {
          'CASH': 'CASH', 'CARD': 'CARD', 'BLIK': 'BLIK',
          'TRANSFER': 'BANK_TRANSFER', 'BANK_TRANSFER': 'BANK_TRANSFER',
          'CREDIT': 'CREDIT', 'INVOICE': 'BANK_TRANSFER',
        };

        const tendersJson = (order as any).payment_tenders;
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
        if (order.discount > 0) dto.discountAmount = order.discount;
        if (order.payment_amount > 0) dto.paymentAmount = order.payment_amount;
        if (order.change_amount > 0) dto.changeAmount = order.change_amount;
        if (order.tip && order.tip > 0) dto.tip = order.tip;

        const result = await apiClient.createPosOrder(token, dto);
        orderRepo.markSynced(order.id, result.orderId);
        database.run('UPDATE orders SET sync_error = NULL WHERE id = ?', [order.id]);
        database.save();
        synced++;
        logger.info(`[OrderSync] Synced order ${order.order_number} → backend ${result.orderId}`);
      } catch (err: any) {
        // Revert to pending (0) and record the error
        orderRepo.markSyncFailed(order.id);
        const errMsg = (err.message || String(err)).substring(0, 500);
        database.run('UPDATE orders SET sync_error = ? WHERE id = ?', [errMsg, order.id]);
        database.save();
        logger.warn(`[OrderSync] Failed to sync order ${order.order_number || order.id} (attempt ${attempts + 1}/${MAX_SYNC_ATTEMPTS}): ${errMsg}`);
      }
    }

    if (synced > 0) {
      logger.info(`[OrderSync] Synced ${synced}/${pending.length} orders`);
    }

    return synced;
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
