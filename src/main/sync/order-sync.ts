import { apiClient } from '../network/api-client';
import { orderRepo } from '../database/repos/order-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';

export class OrderSync {
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Upload all unsynced orders to backend.
   * Uses synced column as tri-state: 0=pending, 1=synced, 2=syncing (in-flight).
   * This prevents double-send when sync is called concurrently or on retry after timeout.
   */
  async syncPendingOrders(): Promise<number> {
    const token = getSecureAuthToken();
    if (!token) return 0;

    const pending = orderRepo.getUnsynced();
    if (pending.length === 0) return 0;

    let synced = 0;

    for (const order of pending) {
      try {
        // Mark as syncing (2) to prevent re-send by concurrent sync cycles
        orderRepo.markSyncing(order.id);
        database.save();

        const items = orderRepo.getItemsByOrderId(order.id);
        // Transform local OrderRow + OrderItemRow[] into CreateB2BPOSOrderDto format
        const dto: Record<string, any> = {
          id: order.id, // idempotency key
          requiresInvoice: !!order.customer_nip,
          items: items.map((item) => ({
            productId: item.variant_id || item.id,
            packQuantity: Math.max(1, Math.round(item.quantity)),
            ...(item.price > 0 ? { customPrice: item.price } : {}),
          })),
        };
        // Payment
        if (order.payment_method) {
          dto.paymentMethod = order.payment_method;
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
        // CRITICAL: Save immediately to prevent re-sync if app crashes
        database.save();
        synced++;
        logger.info(`[OrderSync] Synced order ${order.order_number} → backend ${result.orderId}`);
      } catch (err) {
        // Revert to pending (0) so it retries on next cycle
        orderRepo.markSyncFailed(order.id);
        database.save();
        logger.warn(`[OrderSync] Failed to sync order ${order.id}: ${err}`);
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
