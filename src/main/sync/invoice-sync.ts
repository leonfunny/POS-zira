import { apiClient } from '../network/api-client';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';

/**
 * InvoiceSync — pushes locally-created invoices to the server.
 * Follows the same tri-state outbox pattern as OrderSync:
 *   synced=0 (pending) → synced=2 (in-flight) → synced=1 (synced)
 * Dark launch safe: pauses on 404/501 until next reconnect.
 */
export class InvoiceSync {
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private endpointUnavailable = false;

  async syncPending(): Promise<number> {
    if (this.endpointUnavailable) return 0;

    const token = getSecureAuthToken();
    if (!token) return 0;

    // Only sync non-DRAFT invoices
    const unsynced = database.all<any>(
      "SELECT * FROM invoices WHERE synced = 0 AND status != 'DRAFT'",
    );
    if (unsynced.length === 0) return 0;

    let synced = 0;
    for (const invoice of unsynced) {
      // Mark in-flight
      database.run('UPDATE invoices SET synced = 2 WHERE id = ? AND synced = 0', [invoice.id]);
      database.save();

      try {
        const items = database.all<any>('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoice.id]);
        const result = await apiClient.createInvoice(token, { ...invoice, items });

        if (result === null) {
          // Endpoint not deployed — revert and pause
          database.run('UPDATE invoices SET synced = 0 WHERE id = ? AND synced = 2', [invoice.id]);
          this.endpointUnavailable = true;
          logger.debug('[InvoiceSync] Endpoint not available, pausing');
          break;
        }

        // Success
        database.run(
          "UPDATE invoices SET synced = 1, backend_id = ?, synced_at = datetime('now'), sync_error = NULL WHERE id = ?",
          [result.invoiceId, invoice.id],
        );
        database.save();
        synced++;
        logger.info(`[InvoiceSync] Synced invoice ${invoice.invoice_number} → ${result.invoiceId}`);
      } catch (err: any) {
        // Revert to pending for retry
        database.run(
          'UPDATE invoices SET synced = 0, sync_error = ? WHERE id = ? AND synced = 2',
          [err.message, invoice.id],
        );
        database.save();
        logger.warn(`[InvoiceSync] Failed to sync invoice ${invoice.id}: ${err.message}`);
      }
    }

    return synced;
  }

  startPeriodicSync(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(async () => {
      try { await this.syncPending(); } catch (err) {
        logger.debug('[InvoiceSync] Periodic sync error:', err);
      }
    }, 30_000);
    logger.info('[InvoiceSync] Starting periodic sync (30s interval)');
  }

  stop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
      logger.info('[InvoiceSync] Periodic sync stopped');
    }
  }

  resetEndpointAvailability(): void {
    this.endpointUnavailable = false;
  }
}
