import { apiClient } from '../network/api-client';
import { staffRepo } from '../database/repos/staff-repo';
import { orderRepo } from '../database/repos/order-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';

/**
 * ChangeFeedSync — Path A: 3 per-entity REST endpoints for catch-up.
 *
 * Fetches missed changes from 3 separate endpoints after offline periods:
 *   GET /print-agent/changes/orders?since=...
 *   GET /print-agent/changes/staff?since=...
 *   GET /print-agent/changes/invoices?since=...
 *
 * Products + Stock are handled by existing ProductSync delta — not included here.
 * Socket.IO events provide instant updates; these REST endpoints catch anything missed.
 * Dark launch safe: pauses on 404/501 per endpoint.
 */
export class ChangeFeedSync {
  private feedTimer: ReturnType<typeof setInterval> | null = null;
  private endpointStatus: Record<string, boolean> = {
    orders: true,
    staff: true,
    invoices: true,
  };

  /**
   * Catch up on all entity types in parallel.
   */
  async catchUp(): Promise<{ orders: number; staff: number; invoices: number }> {
    const results = await Promise.allSettled([
      this.catchUpOrders(),
      this.catchUpStaff(),
      this.catchUpInvoices(),
    ]);

    const counts = {
      orders: results[0].status === 'fulfilled' ? results[0].value : 0,
      staff: results[1].status === 'fulfilled' ? results[1].value : 0,
      invoices: results[2].status === 'fulfilled' ? results[2].value : 0,
    };

    const total = counts.orders + counts.staff + counts.invoices;
    if (total > 0) {
      logger.info(`[ChangeFeed] Catch-up: ${counts.orders} orders, ${counts.staff} staff, ${counts.invoices} invoices`);
    }
    return counts;
  }

  // ─── Per-entity catch-up ──────────────────────────────────

  private async catchUpOrders(): Promise<number> {
    if (!this.endpointStatus.orders) return 0;

    const token = getSecureAuthToken();
    if (!token) return 0;

    const since = this.getCursor('orders');
    const result = await apiClient.getOrderChanges(token, since);

    if (result === null) {
      this.endpointStatus.orders = false;
      logger.debug('[ChangeFeed] orders endpoint not available, pausing');
      return 0;
    }

    let processed = 0;
    if (result.items && result.items.length > 0) {
      database.transaction(() => {
        for (const item of result.items) {
          this.processOrderStatusChange(item);
          processed++;
        }
      });
      database.save();
    }

    if (result.nextSince) this.setCursor('orders', result.nextSince);
    return processed;
  }

  private async catchUpStaff(): Promise<number> {
    if (!this.endpointStatus.staff) return 0;

    const token = getSecureAuthToken();
    if (!token) return 0;

    const since = this.getCursor('staff');
    const result = await apiClient.getStaffChanges(token, since);

    if (result === null) {
      this.endpointStatus.staff = false;
      logger.debug('[ChangeFeed] staff endpoint not available, pausing');
      return 0;
    }

    let processed = 0;
    if (result.items && result.items.length > 0) {
      database.transaction(() => {
        for (const item of result.items) {
          this.processStaffChange(item);
          processed++;
        }
      });
      database.save();
    }

    if (result.nextSince) this.setCursor('staff', result.nextSince);
    return processed;
  }

  private async catchUpInvoices(): Promise<number> {
    if (!this.endpointStatus.invoices) return 0;

    const token = getSecureAuthToken();
    if (!token) return 0;

    const since = this.getCursor('invoices');
    const result = await apiClient.getInvoiceChanges(token, since);

    if (result === null) {
      this.endpointStatus.invoices = false;
      logger.debug('[ChangeFeed] invoices endpoint not available, pausing');
      return 0;
    }

    let processed = 0;
    if (result.items && result.items.length > 0) {
      database.transaction(() => {
        for (const item of result.items) {
          this.processInvoiceChange(item);
          processed++;
        }
      });
      database.save();
    }

    if (result.nextSince) this.setCursor('invoices', result.nextSince);
    return processed;
  }

  // ─── Change processors ────────────────────────────────────

  processOrderStatusChange(data: any): void {
    const orderId = data.orderId || data.id;
    if (!orderId) return;

    // Find local order by backend_id or direct id
    let localId: string | undefined;
    const direct = orderRepo.getById(orderId);
    if (direct) {
      localId = direct.id;
    } else {
      const byBackend = database.get<{ id: string }>('SELECT id FROM orders WHERE backend_id = ?', [orderId]);
      if (byBackend) localId = byBackend.id;
    }

    if (!localId) {
      logger.debug(`[ChangeFeed] Order ${orderId} not found locally, skipping`);
      return;
    }

    // Update server-side status (don't overwrite local status)
    database.run(
      "UPDATE orders SET server_status = ?, server_updated_at = ? WHERE id = ?",
      [data.status, data.updatedAt ?? new Date().toISOString(), localId],
    );
  }

  private processStaffChange(data: any): void {
    if (!data.id) return;

    // Handle both old shape (fullName) and new shape (name)
    const name = data.name || data.fullName || `${data.firstName || ''} ${data.lastName || ''}`.trim() || 'Unknown';

    staffRepo.upsertMany([{
      id: data.id,
      name,
      commission_rate: data.commissionRate ?? data.commission_rate ?? 0,
      is_active: data.isActive !== false ? 1 : 0,
      role: data.role ?? null,
      updated_at: data.updatedAt ?? null,
      backend_synced_at: new Date().toISOString(),
    }]);
  }

  processInboundInvoice(data: any): void {
    this.processInvoiceChange(data);
  }

  private processInvoiceChange(data: any): void {
    if (!data || !data.id) return;

    // Check if invoice exists locally (by id or backend_id)
    const existing = database.get<{ id: string }>(
      'SELECT id FROM invoices WHERE id = ? OR backend_id = ?',
      [data.id, data.id],
    );

    if (existing) {
      // Update status if changed on server
      if (data.status) {
        database.run(
          "UPDATE invoices SET status = ?, synced = 1, synced_at = datetime('now') WHERE id = ?",
          [data.status, existing.id],
        );
      }
    } else {
      // Server-created invoice — log for now, full insert in future
      logger.info(`[ChangeFeed] Server-created invoice ${data.id} received (insert not yet implemented)`);
    }
  }

  // ─── Cursor management ────────────────────────────────────

  private getCursor(entityType: string): string {
    const row = database.get<{ last_timestamp: string }>(
      'SELECT last_timestamp FROM change_feed_cursor WHERE entity_type = ?',
      [entityType],
    );
    // Default: 24h ago on first run
    return row?.last_timestamp ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  }

  private setCursor(entityType: string, timestamp: string): void {
    database.run(
      "INSERT OR REPLACE INTO change_feed_cursor (entity_type, last_timestamp, updated_at) VALUES (?, ?, datetime('now'))",
      [entityType, timestamp],
    );
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  startPeriodicCatchUp(): void {
    if (this.feedTimer) return;
    this.feedTimer = setInterval(async () => {
      try { await this.catchUp(); } catch (err) {
        logger.debug('[ChangeFeed] Periodic catch-up error:', err);
      }
    }, 30_000);
    logger.info('[ChangeFeed] Starting periodic catch-up (30s interval)');
  }

  stop(): void {
    if (this.feedTimer) {
      clearInterval(this.feedTimer);
      this.feedTimer = null;
      logger.info('[ChangeFeed] Periodic catch-up stopped');
    }
  }

  resetEndpointAvailability(): void {
    this.endpointStatus = { orders: true, staff: true, invoices: true };
  }
}
