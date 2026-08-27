import { BrowserWindow } from 'electron';
import { apiClient } from '../network/api-client';
import { orderRepo } from '../database/repos/order-repo';
import { billiardPosHandoffRepo } from '../database/repos/billiard-pos-handoff-repo';
import { localVariantImportsRepo } from '../database/repos/local-variant-imports-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import { buildBackendOrderItem } from '../pos/order-line-contract';
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

function normalizePosLocalCreatedAt(value: string | null | undefined): string | undefined {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
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
  private retryJitterTimer: ReturnType<typeof setTimeout> | null = null;
  private syncInFlight: Promise<OrderSyncSummary> | null = null;

  constructor() {
    this.recoverStrandedSyncingOrders();
  }

  private recoverStrandedSyncingOrders(): void {
    const stranded = database.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM orders WHERE synced = 2',
    )?.cnt ?? 0;
    if (stranded === 0) return;

    database.run('UPDATE orders SET synced = 0 WHERE synced = 2');
    database.markDirty();
    logger.warn(`[OrderSync] Recovered ${stranded} stranded in-flight order(s) from previous session`);
  }

  /**
   * Upload all unsynced orders to backend.
   * Uses synced column as tri-state: 0=pending, 1=synced, 2=syncing (in-flight).
   * Transient errors retry up to MAX_SYNC_ATTEMPTS; business errors shelve immediately.
   */
  async syncPendingOrders(): Promise<OrderSyncSummary> {
    if (this.syncInFlight) return this.syncInFlight;

    this.syncInFlight = this.runSyncPendingOrders()
      .finally(() => {
        this.syncInFlight = null;
      });
    return this.syncInFlight;
  }

  private async runSyncPendingOrders(): Promise<OrderSyncSummary> {
    const summary: OrderSyncSummary = { attempted: 0, synced: 0, failed: 0, results: [] };
    const token = getSecureAuthToken();
    if (!token) return summary;

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
        const items = orderRepo.getItemsByOrderId(order.id);

        // Defer pushing orders that reference a locally-imported variant
        // (created from a draft without a server roundtrip). The server
        // doesn't know the variant id yet and would reject the order as
        // "invalid product", shelving it. Don't increment attempts — wait
        // for the local-import reconciler to materialize the variant first.
        const unresolved = items.find((it): it is typeof it & { variant_id: string } =>
          !!it.variant_id && localVariantImportsRepo.isUnresolvedVariant(it.variant_id),
        );
        if (unresolved) {
          const unresolvedVariantId = unresolved.variant_id as string;
          const importRow = localVariantImportsRepo.getByVariantId(unresolvedVariantId);
          const reason = importRow?.status === 'FAILED'
            ? `variant-import-failed:${unresolvedVariantId}:${importRow.last_error ?? 'unknown'}`
            : `waiting-for-variant:${unresolvedVariantId}`;
          database.run(
            'UPDATE orders SET sync_error = ? WHERE id = ?',
            [reason, order.id],
          );
          database.markDirty();
          logger.debug(`[OrderSync] Order ${order.id} deferred — variant ${unresolved.variant_id} not yet on server`);
          continue;
        }

        // Mark as syncing (2) to prevent re-send by concurrent sync cycles
        orderRepo.markSyncing(order.id);
        database.run(
          'UPDATE orders SET sync_attempts = sync_attempts + 1 WHERE id = ?',
          [order.id],
        );
        database.markDirty();

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
          posLocalCreatedAt: normalizePosLocalCreatedAt(order.created_at),
          items: items
            .filter((item) => item.variant_id || item.id) // skip items with no product ID
            .map((item) => {
              const localId = item.variant_id || item.id;
              const serverVariantId = localVariantImportsRepo.getServerVariantId(localId) ?? localId;
              return buildBackendOrderItem(item, () => serverVariantId);
            }),
        };
        if (order.billiard_origin_json) {
          try {
            dto.billiardOrigin = JSON.parse(order.billiard_origin_json);
            dto.clientAttemptId = order.client_attempt_id;
          } catch {
            throw new Error('Invalid persisted billiard order origin');
          }
        }

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
        if (!order.billiard_origin_json) {
          try {
            const finishResult = await apiClient.finishOrder(token, backendId);
            backendOrderNumber = getBackendOrderNumber(finishResult) ?? backendOrderNumber;
            logger.info(`[OrderSync] Finished order ${backendId} → ${JSON.stringify(finishResult)?.substring(0, 200)}`);
          } catch (e) {
            logger.warn(`[OrderSync] finishOrder failed for ${backendId} (non-fatal): ${e}`);
          }
        } else {
          // The authoritative Billiard create endpoint atomically creates a
          // DELIVERED order and settles checkoutId. Calling finish again is a
          // false failure ("already finished"). A successful create response
          // is the settlement acknowledgement for this origin.
          logger.info(`[OrderSync] Billiard order ${backendId} was finalized atomically by createPosOrder`);
        }

        orderRepo.markSynced(order.id, backendId, backendOrderNumber);
        const billiardHandoff = billiardPosHandoffRepo.getByOrderId(order.id);
        if (billiardHandoff?.state === 'POS_PAID_SYNC_PENDING') {
          billiardPosHandoffRepo.markState(billiardHandoff.checkoutId, 'SETTLED');
        }
        database.run('UPDATE orders SET sync_error = NULL WHERE id = ?', [order.id]);
        database.markDirty();
        if (billiardHandoff) {
          const flush = await database.saveCoalesced();
          if (!flush.success) {
            throw new Error(`Billiard settlement was accepted but local durability failed: ${flush.error || 'database flush failed'}`);
          }
        }
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
          database.markDirty();
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
          database.markDirty();
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
    database.markDirty();
    logger.info(`[OrderSync] Reset order ${orderId} for manual retry`);
    return true;
  }

  /**
   * End-of-day repair: orders shelved (synced = -1) after transient failures
   * — "fetch failed" while the counter was offline, timeouts, 5xx — get one
   * more full round of attempts. Business rejections stay shelved.
   */
  requeueShelvedTransient(): number {
    const rows = database.all<{ id: string; sync_error: string | null }>(
      "SELECT id, sync_error FROM orders WHERE synced = -1 AND (backend_id IS NULL OR backend_id = '')",
    );
    const ids = rows
      .filter((r) => !r.sync_error || classifyError(r.sync_error).kind === 'transient')
      .map((r) => r.id);
    if (ids.length === 0) return 0;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      database.run(
        `UPDATE orders SET synced = 0, sync_attempts = 0 WHERE id IN (${chunk.map(() => '?').join(',')})`,
        chunk,
      );
    }
    database.markDirty();
    logger.info(`[OrderSync] Re-queued ${ids.length} shelved order(s) with transient errors for retry`);
    return ids.length;
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
    database.markDirty();
    logger.info(`[OrderSync] Reset ${rows.length} stock-failed orders for retry`);
    return rows.length;
  }

  /**
   * Start periodic sync (every 30s when online). Adds a 0-5s startup jitter
   * so this timer doesn't tick at the same instant as the other sync workers
   * (product, sync-log push/pull) — otherwise every multiple of 30s all four
   * fire together, stall the event loop, and renderer IPC feels laggy.
   */
  startPeriodicSync(): void {
    if (this.retryTimer || this.retryJitterTimer) return; // Already running

    const jitter = process.env.VITEST ? 0 : Math.floor(Math.random() * 5000);
    logger.info(`[OrderSync] Starting periodic sync (30s interval, jitter ${jitter}ms)`);
    this.retryJitterTimer = setTimeout(() => {
      this.retryJitterTimer = null;
      this.retryTimer = setInterval(async () => {
        try {
          await this.syncPendingOrders();
        } catch (err) {
          logger.debug(`[OrderSync] Periodic sync error: ${err}`);
        }
      }, 30000);
    }, jitter);
  }

  /**
   * Stop periodic sync
   */
  stop(): void {
    // Cancel the pending jitter setTimeout too so a stop during the jitter
    // window doesn't leave a timer queued that re-arms the interval later.
    if (this.retryJitterTimer) {
      clearTimeout(this.retryJitterTimer);
      this.retryJitterTimer = null;
    }
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
      logger.info('[OrderSync] Periodic sync stopped');
    }
  }
}
