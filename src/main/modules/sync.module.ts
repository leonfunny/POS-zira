/**
 * SyncModule
 *
 * Owns ProductSync, OrderSync, and BilliardSync services.
 * Listens to socket events for real-time catalog/stock/billiard updates.
 */

import { ipcMain } from 'electron';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import { ProductSync } from '../sync/product-sync';
import { draftProductSync } from '../sync/draft-product-sync';
import { fullSyncOnCooldown } from '../sync/full-sync-cooldown';
import { OrderSync } from '../sync/order-sync';
import { BilliardSync } from '../sync/billiard-sync';
import { StaffSync } from '../sync/staff-sync';
import { SyncLogService, SYNC_MODES } from '../sync/sync-log-service';
import { productRepo } from '../database/repos/product-repo';
import { billiardResourceRepo } from '../database/repos/billiard-resource-repo';
import { billiardSessionRepo } from '../database/repos/billiard-session-repo';
import { billiardComboRepo } from '../database/repos/billiard-combo-repo';
import { billiardFloorPlanRepo } from '../database/repos/billiard-floor-plan-repo';
import type { BackupRunReason, LocalBackupService } from '../database/backup-service';
import { PrinterType, ReceiptData } from '../../shared/types';
import { getConfig, getSecureAuthToken } from '../config/store';
import SocketClient from '../network/socket-client';
import { notifyPosRenderers } from '../windows/notify-pos-renderers';
import { ShiftController } from '../pos/shift-controller';
import { PosEventUploader } from '../sync/pos-event-uploader';
import { submitSharedReceiptPrint } from '../printing/shared-receipt-printer';
import type { HardwareModule } from './hardware.module';
import logger from '../logger';

export interface ProductSyncResult {
  success: boolean;
  productsCount?: number;
  error?: string;
}

interface ProductSyncRunOptions {
  force?: boolean;
  bypassBackoff?: boolean;
  reason?: string;
}

export class SyncModule extends BaseModule {
  readonly name = 'sync';

  private productSync: ProductSync | null = null;
  private orderSync: OrderSync | null = null;
  private billiardSync: BilliardSync | null = null;
  private staffSync: StaffSync | null = null;
  private syncLogService: SyncLogService | null = null;
  private posEventUploader: PosEventUploader | null = null;
  private _syncInProgress = false;
  private _didFullProductSync = false;

  // ── Periodic product sync (POS-side polling) ────────────────────
  // Web admin (zira-ai.com / chesaigon.eshoper.pro) writes products and
  // prices straight to the same backend the POS pulls from, but the
  // existing ProductSync triggers were socket connect / login / manual
  // IPC — none fire while the app stays open. A 30s deltaSync poll fixes
  // that without depending on the socket. The fields below back a single
  // shared in-flight promise (so a manual button press during a periodic
  // tick re-uses the same network call) and a lightweight backoff so a
  // failing backend isn't hit every 30s.
  private _productPollTimer: ReturnType<typeof setInterval> | null = null;
  private _productPollJitterTimer: ReturnType<typeof setTimeout> | null = null;
  private _productSyncInFlight: Promise<ProductSyncResult> | null = null;
  private _productSyncInFlightForce = false;
  private _productQueuedForceSync: Promise<ProductSyncResult> | null = null;
  // Backoff schedule (ms) on consecutive failures: 60s, 120s, 300s cap.
  private static readonly PRODUCT_BACKOFF_MS = [60_000, 120_000, 300_000];
  private _productBackoffStep = 0;
  private _productSkipUntil = 0;

  // ── Periodic draft-product sync ─────────────────────────────────
  // Drafts change less often than priced products (admin reviews them
  // out of band) so 60s is plenty. The deltaSync auto-falls-back to
  // fullSync when no cursor is stored, so the timer is safe to call
  // before any other sync has run.
  private _draftPollTimer: ReturnType<typeof setInterval> | null = null;
  private _draftSyncInFlight: Promise<void> | null = null;
  private _shiftRetryTimer: ReturnType<typeof setInterval> | null = null;
  private _shiftRetryInFlight = false;

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[SyncModule] Initializing...');
    this.productSync = new ProductSync({
      createRestorePoint: (reason: BackupRunReason) => this.createRestorePoint(reason),
    });
    this.orderSync = new OrderSync();
    this.billiardSync = new BilliardSync();
    this.staffSync = new StaffSync();
    this.syncLogService = new SyncLogService();
    this.container.set(SERVICE_TOKENS.PRODUCT_SYNC, this.productSync);
    this.container.set(SERVICE_TOKENS.ORDER_SYNC, this.orderSync);
    this.container.set(SERVICE_TOKENS.BILLIARD_SYNC, this.billiardSync);
    this.container.set(SERVICE_TOKENS.STAFF_SYNC, this.staffSync);
    this.container.set(SERVICE_TOKENS.SYNC_LOG_SERVICE, this.syncLogService);

    // Path A outbound timers start as fallback — stopped once Path B push detected.
    this.orderSync.startPeriodicSync();

    // ERP-AI POS event outbox uploader: drains pos_event_outbox to
    // POST /api/v1/pos-events/batch. Independent of order/product sync; backoff
    // handles offline. Always attempts (POST fails fast + backs off when offline).
    this.posEventUploader = new PosEventUploader();
    this.posEventUploader.startPeriodicSync();

    // Periodic ProductSync runs from module init, NOT bound to socket
    // lifecycle. ProductSync is HTTP-based; the socket is only a bonus
    // realtime channel and may be down for long stretches without
    // affecting product polling.
    this.startPeriodicProductSync();
    // Drafts poll on a longer 60s cadence — admin edits them out of band,
    // socket events handle real-time updates, this is the backstop so a
    // long-running kiosk doesn't drift from the master catalog.
    this.startPeriodicDraftProductSync();
    this.startPeriodicShiftRetry();

    this.setState(ModuleState.READY);
  }

  registerIpcHandlers(): void {
    // Manual button bypasses the failure backoff (`force: true`) — the
    // user pressed it intentionally, they want a fresh pull. Still
    // shares the in-flight promise with any concurrent periodic tick so
    // we never double-pull the catalogue.
    ipcMain.handle('pos:sync:products', async () => (
      this.runProductSync({ force: true, bypassBackoff: true, reason: 'manual' })
    ));

    ipcMain.handle('pos:sync:orders', async () => {
      try {
        if (this.productSync) {
          const reconciledLocalImports = await this.productSync.reconcileLocalVariantImports();
          if (reconciledLocalImports > 0) {
            await this.runProductSync({
              bypassBackoff: true,
              reason: 'orders-reconcile-local-imports',
            });
          }
        }
        const summary = await this.orderSync?.syncPendingOrders();
        return { success: true, summary };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    // ERP-AI POS event outbox: lightweight status for the sync indicator and a
    // manual drain (mirrors pos:sync:orders).
    ipcMain.handle('pos:events:status', async () => {
      try {
        return { success: true, status: this.posEventUploader?.getStatus() ?? null };
      } catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:events:flush', async () => {
      try {
        const result = await this.posEventUploader?.flush();
        return { success: true, result, status: this.posEventUploader?.getStatus() ?? null };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('pos:sync:staff', async () => {
      try {
        const count = await this.staffSync?.pullStaff();
        notifyPosRenderers(this.container, 'pos:staff-updated', { count: count ?? 0 });
        return { success: true, count: count ?? 0 };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    // ── Billiard IPC handlers ─────────────────────────
    ipcMain.handle('billiard:get:overview', async () => {
      try {
        if (!this.billiardSync) return { tables: [], floorPlans: [], layouts: [], sessions: [], _fromCache: true };
        return this.billiardSync.getLocalFloorOverview();
      } catch (e: any) {
        logger.warn(`[SyncModule] billiard:get:overview error: ${e.message}`);
        return { tables: [], floorPlans: [], layouts: [], sessions: [], _fromCache: true };
      }
    });

    ipcMain.handle('billiard:get:session', async (_event, id: string) => {
      try {
        const s = billiardSessionRepo.getById(id);
        if (!s) return null;
        // Map to camelCase matching getLocalFloorOverview() shape
        return {
          id: s.id,
          resourceId: s.resource_id,
          status: s.status,
          billingMode: s.billing_mode,
          guestCount: s.guest_count,
          startedAt: s.started_at,
          pausedAt: s.paused_at,
          endedAt: s.ended_at,
          totalMinutes: s.total_minutes,
          totalCharges: s.total_charges,
          comboId: s.combo_id,
          notes: s.notes,
          items: (s.items || []).map((i) => ({
            id: i.id,
            variantId: i.variant_id,
            name: i.name,
            quantity: i.quantity,
            unitPrice: i.unit_price,
          })),
        };
      } catch (e: any) {
        logger.warn(`[SyncModule] billiard:get:session error: ${e.message}`);
        return null;
      }
    });

    ipcMain.handle('billiard:get:combos', async (_event, activeOnly?: boolean) => {
      try {
        return billiardComboRepo.getAll(activeOnly);
      } catch (e: any) {
        logger.warn(`[SyncModule] billiard:get:combos error: ${e.message}`);
        return [];
      }
    });

    ipcMain.handle('billiard:get:floor-plans', async () => {
      try {
        const plans = billiardFloorPlanRepo.getAll();
        return plans.map((p) => ({
          ...p,
          layouts: billiardFloorPlanRepo.getLayouts(p.id),
        }));
      } catch (e: any) {
        logger.warn(`[SyncModule] billiard:get:floor-plans error: ${e.message}`);
        return [];
      }
    });

    // F&B products/categories — read from local ProductSync cache (offline-safe)
    ipcMain.handle('billiard:get:fnb-products', async (_event, search?: string, categoryId?: string) => {
      try {
        if (search) return productRepo.search(search);
        if (categoryId) return productRepo.getByCategory(categoryId);
        return productRepo.getAll();
      } catch (e: any) {
        logger.warn(`[SyncModule] billiard:get:fnb-products error: ${e.message}`);
        return [];
      }
    });

    ipcMain.handle('billiard:get:fnb-categories', async () => {
      try {
        return productRepo.getCategories();
      } catch (e: any) {
        logger.warn(`[SyncModule] billiard:get:fnb-categories error: ${e.message}`);
        return [];
      }
    });

    // Resource type lookup — derive from cached billiard_resources table
    ipcMain.handle('billiard:get:resource-type', async (_event, code: string) => {
      try {
        const resources = billiardResourceRepo.getAll();
        // Find the first resource whose type_name matches the code
        const match = resources.find((r) => r.type_name === code || r.type_id === code);
        if (match && match.type_id) {
          return { id: match.type_id, code: match.type_name, name: match.type_name };
        }
        return null;
      } catch (e: any) {
        logger.warn(`[SyncModule] billiard:get:resource-type error: ${e.message}`);
        return null;
      }
    });

    // Restaurant combos — in-memory cache from BilliardSync (offline-safe)
    ipcMain.handle('billiard:get:restaurant-combos', async () => {
      try {
        if (!this.billiardSync) return [];
        return this.billiardSync.getRestaurantCombos();
      } catch (e: any) {
        logger.warn(`[SyncModule] billiard:get:restaurant-combos error: ${e.message}`);
        return [];
      }
    });

    ipcMain.handle('billiard:mutate', async (_event, op: string, method: string, path: string, body?: any) => {
      if (!this.billiardSync) return { success: false, error: 'Billiard sync not initialized' };
      return await this.billiardSync.executeMutation(op, method, path, body);
    });

    ipcMain.handle('billiard:sync:status', async () => {
      try {
        if (!this.billiardSync) return { pending: 0, lastSync: null, online: false };
        return this.billiardSync.getSyncStatus();
      } catch {
        return { pending: 0, lastSync: null, online: false };
      }
    });

    // ── Billiard Print / Cash Drawer handlers ───────────
    ipcMain.handle('billiard:print:receipt', async (_event, sessionId: string, payment: { method: string; amount: number }) => {
      try {
        const session = billiardSessionRepo.getById(sessionId);
        if (!session) {
          logger.warn(`[SyncModule] billiard:print:receipt — session ${sessionId} not found`);
          return { success: false, receiptPrinted: false };
        }


        // Look up the table/resource name
        const resource = session.resource_id ? billiardResourceRepo.getById(session.resource_id) : null;
        const tableName = resource?.name || 'Table';

        // Build time-charge line item
        const hours = Math.floor((session.total_minutes || 0) / 60);
        const mins = (session.total_minutes || 0) % 60;
        const timeDuration = hours > 0 ? `${hours}h ${mins}min` : `${mins}min`;
        const timeCharge = session.total_charges || 0;

        const receiptItems: ReceiptData['items'] = [];

        // Time charge as first item (amount in grosze — prices in billiard DB are already in grosze)
        if (timeCharge > 0 || session.billing_mode !== 'PACKAGE_COUNTDOWN') {
          receiptItems.push({
            name: `${tableName} — ${timeDuration}`,
            quantity: 1,
            unitPrice: timeCharge,
            totalPrice: timeCharge,
            vatRate: 23,
          });
        }

        // Package price (if package mode)
        if (session.billing_mode === 'PACKAGE_COUNTDOWN' && session.combo_id) {
          const combo = billiardComboRepo.getAll(false).find((c: any) => c.id === session.combo_id);
          const packagePrice = combo?.combo_price ?? 0;
          if (packagePrice > 0) {
            receiptItems.push({
              name: `${tableName} — ${combo?.name || 'Package'}`,
              quantity: 1,
              unitPrice: packagePrice,
              totalPrice: packagePrice,
              vatRate: 23,
            });
          }
        }

        // F&B items
        for (const item of session.items || []) {
          receiptItems.push({
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.unit_price,
            totalPrice: item.unit_price * item.quantity,
            vatRate: 23,
          });
        }

        const total = receiptItems.reduce((sum, i) => sum + i.totalPrice, 0);
        const config = getConfig();

        const receiptData: ReceiptData = {
          orderNumber: sessionId.substring(0, 8).toUpperCase(),
          salonName: config.salonName || undefined,
          items: receiptItems,
          payment: { method: payment.method, amount: payment.amount },
          subtotal: total,
          total,
        };

        const shared = await submitSharedReceiptPrint(receiptData, {
          referenceType: 'BILLIARD_RECEIPT',
          referenceId: sessionId,
          source: 'billiard',
        });
        if (shared.handled) {
          return { success: true, receiptPrinted: shared.printed };
        }

        const hw = this.container.getOptional<HardwareModule>(SERVICE_TOKENS.HARDWARE_MODULE);
        const printer = hw?.getPrinterForType(PrinterType.RECEIPT);
        if (!printer || !printer.isConnected()) {
          logger.warn('[SyncModule] billiard:print:receipt - no receipt printer connected');
          return { success: true, receiptPrinted: false };
        }

        await printer.printReceipt(receiptData);
        logger.info(`[SyncModule] Billiard receipt printed for session ${sessionId.substring(0, 8)}`);
        return { success: true, receiptPrinted: true };
      } catch (err: any) {
        logger.error(`[SyncModule] billiard:print:receipt failed: ${err.message}`);
        return { success: false, receiptPrinted: false };
      }
    });

    ipcMain.handle('billiard:print:open-drawer', async () => {
      try {
        const hw = this.container.getOptional<HardwareModule>(SERVICE_TOKENS.HARDWARE_MODULE);
        const printer = hw?.getPrinterForType(PrinterType.RECEIPT);
        if (!printer || !printer.isConnected()) {
          logger.warn('[SyncModule] billiard:print:open-drawer — no receipt printer connected');
          return { success: false };
        }
        await printer.openDrawer();
        logger.info('[SyncModule] Cash drawer opened (billiard)');
        return { success: true };
      } catch (err: any) {
        logger.error(`[SyncModule] billiard:print:open-drawer failed: ${err.message}`);
        return { success: false };
      }
    });

    // ── Path B Sync Log IPC handlers ─────────────────────
    ipcMain.handle('pos:sync:conflicts', async () => {
      try {
        return this.syncLogService?.getUnresolvedConflicts() ?? [];
      } catch (e: any) { return []; }
    });

    ipcMain.handle('pos:sync:resolve-conflict', async (_event, conflictId: number, resolution: string, adjustments?: any) => {
      try {
        this.syncLogService?.resolveConflict(conflictId, resolution, adjustments);
        return { success: true };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('pos:sync:mode', async () => {
      return this.syncLogService?.getSyncMode() ?? 'path_a';
    });

    logger.info('[SyncModule] IPC handlers registered (including billiard + sync log)');
  }

  registerEventHandlers(bus: EventBus): void {
    bus.on('socket:connected', async () => {
      if (this._syncInProgress) return;
      this._syncInProgress = true;
      try {
        // ── Path B: Detect server capability and auto-upgrade mode ──
        let syncMode = this.syncLogService?.getSyncMode() ?? 'path_a';

        if (this.syncLogService) {
          try {
            const capability = await this.syncLogService.detectServerCapability();
            if (capability.pull) this.syncLogService.upgradeSyncMode(SYNC_MODES.PATH_B_PULL);
            if (capability.push) this.syncLogService.upgradeSyncMode(SYNC_MODES.PATH_B_PUSH);
            if (capability.pull && capability.push) this.syncLogService.upgradeSyncMode(SYNC_MODES.PATH_B_FULL);
            syncMode = this.syncLogService.getSyncMode();
            logger.info(`[SyncModule] Sync mode after detection: ${syncMode}`);
          } catch (err: any) {
            logger.debug(`[SyncModule] Path B detection failed, staying on ${syncMode}: ${err.message}`);
          }
        }

        const usePathBPull = this.syncLogService?.isModeAtLeast(SYNC_MODES.PATH_B_PULL) ?? false;
        const usePathBPush = this.syncLogService?.isModeAtLeast(SYNC_MODES.PATH_B_PUSH) ?? false;

        // ── Always: ProductSync + StaffSync (baseline catalog) ──
        // First sync of each session = FULL sync (catches server-side stock
        // changes that may not bump product.updated_at — e.g., admin adjustments,
        // backfills, bulk imports). Subsequent polls use delta.
        //
        // Guard the forced full sweep with a persisted cooldown so a flapping
        // socket / restart storm can't trigger a ~14MB full catalogue pull on
        // every reconnect (which would feed the overload→reconnect loop). An
        // empty local catalogue still full-syncs regardless — deltaSync() forces
        // a full when productCount === 0 — so this never strands the cashier.
        if (this.productSync) {
          const forceInitialFullSync =
            !this._didFullProductSync && !fullSyncOnCooldown('products');
          const result = await this.runProductSync({
            force: forceInitialFullSync,
            bypassBackoff: forceInitialFullSync,
            reason: forceInitialFullSync ? 'socket-connected-initial-full' : 'socket-connected-delta',
          });
          if (!result.success && result.error !== 'backoff' && result.error !== 'no-auth') {
            logger.warn(
              `[SyncModule] Product sync failed on socket connect: ${result.error ?? 'unknown'}`,
            );
          }
        }

        try { await this.staffSync?.pullStaff(); }
        catch (err) { logger.debug('[SyncModule] Staff pull failed:', err); }

        // Master Catalog draft products mirror — deltaSync auto-falls-back
        // to fullSync on first run (no cursor stored yet).
        try {
          await draftProductSync.deltaSync();
          notifyPosRenderers(this.container, 'pos:draft-products-synced');
        } catch (err: any) { logger.warn(`[SyncModule] Draft product sync failed: ${err?.message ?? err}`); }

        // ── Path B Pull: supplements ProductSync with real-time changes ──
        if (usePathBPull) {
          try {
            await this.syncLogService!.pullFromServer();
          } catch (err) { logger.warn(`[SyncModule] Path B pull failed: ${err}`); }
          this.syncLogService!.startPeriodicPull();
        }

        // ── Path A OrderSync: flush pending if Path B push not active ──
        if (!usePathBPush) {
          try { await this.orderSync?.syncPendingOrders(); } catch (err: any) { logger.debug('[SyncModule] sync pending orders failed:', err?.message); }
        }

        // ── Path B Push ──
        if (usePathBPush) {
          this.orderSync?.stop();
          try { await this.syncLogService!.pushToServer(); } catch (err: any) { logger.debug('[SyncModule] Path B push failed:', err?.message); }
          this.syncLogService!.startPeriodicPush();
        }

        // ── Always run (both Path A and B) ──

        // Retry unsynced shifts
        const shiftCtrl = this.container.getOptional<ShiftController>(SERVICE_TOKENS.SHIFT_CONTROLLER);
        try { await shiftCtrl?.retryUnsyncedShifts(); } catch (err: any) { logger.debug('[SyncModule] retry unsynced shifts failed:', err?.message); }

        // Billiard: full sync + replay queue + start polling (not part of Path B yet)
        if (this.billiardSync) {
          this.billiardSync.setOnline(true);
          try {
            await this.billiardSync.fullSync();
            await this.billiardSync.replayQueue();
          } catch (err) { logger.warn(`[SyncModule] Billiard sync failed: ${err}`); }
          this.billiardSync.startPeriodicDashboardRefresh();
        }
      } finally {
        this._syncInProgress = false;
      }
    });

    // Re-sync products after login — clearSalonData may have wiped
    // the DB while the socket was already connected (no re-connect event).
    bus.on('user:logged-in', async () => {
      if (!this.productSync) return;
      try {
        const forceEmptyCatalogFullSync = this.productSync.getLocalProductCount() === 0;
        const result = await this.runProductSync({
          force: forceEmptyCatalogFullSync,
          bypassBackoff: true,
          reason: forceEmptyCatalogFullSync ? 'post-login-empty-catalog' : 'post-login-delta',
        });
        if (result.success) {
          logger.info('[SyncModule] Post-login product sync completed');
        } else if (result.error !== 'backoff' && result.error !== 'no-auth') {
          logger.warn(`[SyncModule] Post-login product sync failed: ${result.error ?? 'unknown'}`);
        }
      } catch (err) { logger.warn(`[SyncModule] Post-login product sync failed: ${err}`); }
      try {
        await draftProductSync.deltaSync();
        notifyPosRenderers(this.container, 'pos:draft-products-synced');
      } catch (err) { logger.warn(`[SyncModule] Post-login draft sync failed: ${err}`); }
    });

    // Billiard REST recovery is independent from the realtime socket. Start
    // it after login as well, so HTTPS-healthy / WebSocket-down cashiers still
    // refresh tables and pending payments.
    bus.on('user:logged-in', async () => {
      if (!this.billiardSync) return;
      try {
        await this.billiardSync.fullSync();
        await this.billiardSync.replayQueue();
      } catch (err) {
        logger.warn(`[SyncModule] Post-login billiard sync failed: ${err}`);
      }
      this.billiardSync.startPeriodicDashboardRefresh();
    });

    bus.on('socket:disconnected', () => {
      this.syncLogService?.stop();
      if (this.billiardSync) {
        this.billiardSync.setOnline(false);
      }
    });
  }

  /**
   * Wire up real-time socket events.
   */
  setupSocketHandlers(socket: SocketClient): void {
    // Billiard real-time events
    socket.on('billiard:session-updated', () => {
      this.billiardSync?.refreshDashboard().catch((e: any) => { logger.debug('[SyncModule] billiard dashboard refresh failed:', e?.message); });
    });

    socket.on('billiard:resource-updated', () => {
      this.billiardSync?.fullSync().catch((e: any) => { logger.debug('[SyncModule] billiard full sync failed:', e?.message); });
    });

    socket.on('staff:updated', async () => {
      try {
        await this.staffSync?.pullStaff();
        notifyPosRenderers(this.container, 'pos:staff-updated');
      } catch (e: any) {
        logger.debug('[SyncModule] staff:updated pull failed:', e?.message);
      }
    });

    // ── Path B: Real-time sync log entries ──────────────────
    socket.on('sync:entry', async (entry: any) => {
      if (!this.syncLogService?.isModeAtLeast(SYNC_MODES.PATH_B_PULL)) return;

      try {
        await this.syncLogService.processRealtimeEntry(entry);

        // Backend gateway emits socket payloads with TypeORM-style
        // camelCase keys (`entityType`, `entityId`) — not the snake_case
        // the existing branches below were written against. Normalize
        // once here so every branch can rely on a single shape, and so
        // the notifications actually fire (they never did before).
        const entityType = entry.entityType ?? entry.entity_type;
        const entityId = entry.entityId ?? entry.entity_id;

        // Product/category sync-log payloads are often lightweight
        // invalidations, not complete catalogue rows. Pull the canonical HTTP
        // mirror before notifying renderers so this terminal and other POS
        // devices converge on the same fields without blanking absent values.
        if (entityType === 'product' || entityType === 'category' || entityType === 'stock') {
          const result = await this.runProductSync({
            bypassBackoff: true,
            reason: `sync-entry-${entityType}`,
          });
          if (!result.success && result.error !== 'no-auth') {
            logger.debug(
              `[SyncModule] Canonical refresh after ${entityType} event failed: ${result.error ?? 'unknown'}`,
            );
          }
        }

        // Targeted notification based on entity type.
        if (entityType === 'product' || entityType === 'category') {
          notifyPosRenderers(this.container, 'pos:products-synced');
        } else if (entityType === 'stock') {
          notifyPosRenderers(this.container, 'pos:stock-updated', {
            variantId: entityId,
            newStock: entry.payload?.newStock,
          });
        } else if (entityType === 'order') {
          notifyPosRenderers(this.container, 'pos:order-status-changed', entry.payload);
        } else if (entityType === 'staff') {
          notifyPosRenderers(this.container, 'pos:staff-updated', entry.payload);
        } else if (entityType === 'booking') {
          notifyPosRenderers(this.container, 'pos:bookings-updated', {
            bookingId: entityId,
            event: entry.event,
          });
        } else if (entityType === 'service' || entityType === 'service_rule') {
          notifyPosRenderers(this.container, 'pos:services-updated');
        }

        // Always send generic sync event.
        notifyPosRenderers(this.container, 'pos:sync-entry', entry);
      } catch (err: any) {
        logger.debug(`[SyncModule] sync:entry processing failed: ${err.message}`);
      }
    });
  }

  getToolDefinitions(): ToolDefinition[] {
    return [];
  }

  private async createRestorePoint(reason: BackupRunReason): Promise<void> {
    const backup = this.container.getOptional<LocalBackupService>(SERVICE_TOKENS.BACKUP_SERVICE);
    if (!backup) {
      logger.debug(`[SyncModule] ${reason} restore point skipped: backup service not ready`);
      return;
    }
    const result = await backup.runBackupNow(reason);
    if (!result.success) {
      logger.warn(`[SyncModule] ${reason} backup failed: ${result.error}`);
    }
  }

  // ── Periodic product sync helpers ───────────────────────────────

  /**
   * Run a single ProductSync.deltaSync. Polite by default:
   *   - skips silently if no auth token (avoids 30s log spam)
   *   - shares an in-flight promise so concurrent callers get the same result
   *     without double-pulling, except the first-session full sync: that must
   *     queue behind an in-flight delta instead of being downgraded
   *   - honours an exponential backoff after consecutive failures
   *     (60s -> 120s -> 300s cap) so a flaky backend isn't hit every 30s
   *
   * Pass `{ force: true }` to run a full sync and bypass backoff. Pass
   * `{ bypassBackoff: true }` for deliberate delta retries.
   *
   * Notifies the POS renderer with `pos:products-synced` on success so
   * the product/category grid reloads immediately.
   */
  async runProductSync(opts: ProductSyncRunOptions = {}): Promise<ProductSyncResult> {
    if (!opts.force && !opts.bypassBackoff && Date.now() < this._productSkipUntil) {
      return { success: false, error: 'backoff' };
    }
    const token = getSecureAuthToken();
    if (!token) {
      // Silent — periodic timer fires every 30s before login completes
      // and we don't want the warning log to fill up with no-auth entries.
      return { success: false, error: 'no-auth' };
    }
    if (this._productSyncInFlight) {
      if (opts.force && !this._productSyncInFlightForce && !this._didFullProductSync) {
        if (!this._productQueuedForceSync) {
          const inFlight = this._productSyncInFlight;
          this._productQueuedForceSync = (async () => {
            const currentResult = await inFlight;
            if (this._didFullProductSync) return currentResult;
            return this.runProductSync(opts);
          })().finally(() => {
            this._productQueuedForceSync = null;
          });
        }
        return this._productQueuedForceSync;
      }
      return this._productSyncInFlight;
    }
    this._productSyncInFlightForce = !!opts.force;
    this._productSyncInFlight = this._doProductSync(opts);
    try {
      return await this._productSyncInFlight;
    } finally {
      this._productSyncInFlight = null;
      this._productSyncInFlightForce = false;
    }
  }

  private async _doProductSync(opts: ProductSyncRunOptions = {}): Promise<ProductSyncResult> {
    if (!this.productSync) return { success: false, error: 'no-product-sync' };
    try {
      let productsCount: number;
      if (opts.force) {
        logger.info(`[SyncModule] Product sync starting full sync (${opts.reason ?? 'unspecified'})`);
        const result = await this.productSync.fullSync();
        productsCount = result.productsCount;
        this._didFullProductSync = true;
      } else {
        logger.info(`[SyncModule] Product sync starting delta sync (${opts.reason ?? 'unspecified'})`);
        productsCount = await this.productSync.deltaSync();
      }
      const reconciledLocalImports = await this.productSync.reconcileLocalVariantImports();
      if (reconciledLocalImports > 0) {
        productsCount += await this.productSync.deltaSync();
      }
      // Reset backoff state on the first success.
      this._productBackoffStep = 0;
      this._productSkipUntil = 0;
      // Notify renderer so the product/category grid reloads.
      notifyPosRenderers(this.container, 'pos:products-synced');
      return { success: true, productsCount };
    } catch (err: any) {
      const step = Math.min(this._productBackoffStep, SyncModule.PRODUCT_BACKOFF_MS.length - 1);
      const backoffMs = SyncModule.PRODUCT_BACKOFF_MS[step];
      this._productSkipUntil = Date.now() + backoffMs;
      this._productBackoffStep = Math.min(
        this._productBackoffStep + 1,
        SyncModule.PRODUCT_BACKOFF_MS.length - 1,
      );
      logger.warn(
        `[SyncModule] Product sync failed: ${err?.message ?? err}; backing off ${backoffMs / 1000}s`,
      );
      return { success: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * Start the 30s periodic product polling. Idempotent — calling twice
   * does not schedule two timers. Defaults to 30s; tests pass a shorter
   * interval to exercise the timing.
   */
  startPeriodicProductSync(intervalMs = 30_000): void {
    if (this._productPollTimer || this._productPollJitterTimer) return;
    // Random 0-5s startup jitter prevents this timer from aligning with the
    // other sync workers — otherwise every multiple of 30s, ProductSync,
    // OrderSync, sync-log push/pull all fire together and the event loop
    // stalls long enough for users to notice IPC lag. Vitest sets the VITEST
    // env so timer-cadence tests stay deterministic.
    const jitter = process.env.VITEST ? 0 : Math.floor(Math.random() * Math.min(intervalMs, 5000));
    this._productPollJitterTimer = setTimeout(() => {
      this._productPollJitterTimer = null;
      this._productPollTimer = setInterval(() => {
        // Swallow rejections — runProductSync resolves with { success: false }
        // for every failure mode, but defend in depth.
        this.runProductSync().catch((err) => {
          logger.debug(`[SyncModule] Periodic product sync threw: ${err?.message ?? err}`);
        });
      }, intervalMs);
    }, jitter);
    logger.info(`[SyncModule] Started periodic product sync (${intervalMs / 1000}s interval, jitter ${jitter}ms)`);
  }

  stopPeriodicProductSync(): void {
    // Cancel the pending jitter setTimeout too — otherwise stop() called
    // during the jitter window leaves the timeout queued, which then arms
    // the interval after stop returns and breaks single-flight tests.
    if (this._productPollJitterTimer) {
      clearTimeout(this._productPollJitterTimer);
      this._productPollJitterTimer = null;
    }
    if (this._productPollTimer) {
      clearInterval(this._productPollTimer);
      this._productPollTimer = null;
    }
  }

  /**
   * Run a single draft-product delta sync, coalescing concurrent calls into
   * one in-flight promise so the timer + a manual trigger can't double-pull.
   * Notifies POS renderers on success so any open Draft tab can refresh.
   */
  async runDraftSync(): Promise<void> {
    if (this._draftSyncInFlight) return this._draftSyncInFlight;
    this._draftSyncInFlight = (async () => {
      try {
        await draftProductSync.deltaSync();
        notifyPosRenderers(this.container, 'pos:draft-products-synced');
      } catch (err: any) {
        logger.debug(`[SyncModule] Periodic draft sync failed: ${err?.message ?? err}`);
      } finally {
        this._draftSyncInFlight = null;
      }
    })();
    return this._draftSyncInFlight;
  }

  /**
   * Start the periodic draft-product polling. Idempotent. Defaults to 60s;
   * tests pass a shorter interval to exercise the timing.
   */
  startPeriodicDraftProductSync(intervalMs = 60_000): void {
    if (this._draftPollTimer) return;
    this._draftPollTimer = setInterval(() => {
      this.runDraftSync().catch((err) => {
        logger.debug(`[SyncModule] Periodic draft sync threw: ${err?.message ?? err}`);
      });
    }, intervalMs);
    logger.info(`[SyncModule] Started periodic draft product sync (${intervalMs / 1000}s interval)`);
  }

  stopPeriodicDraftProductSync(): void {
    if (this._draftPollTimer) {
      clearInterval(this._draftPollTimer);
      this._draftPollTimer = null;
    }
  }

  startPeriodicShiftRetry(intervalMs = 300_000): void {
    if (this._shiftRetryTimer) return;
    this._shiftRetryTimer = setInterval(() => {
      if (this._shiftRetryInFlight) return;
      this._shiftRetryInFlight = true;
      const shiftCtrl = this.container.getOptional<ShiftController>(SERVICE_TOKENS.SHIFT_CONTROLLER);
      Promise.resolve(shiftCtrl?.retryUnsyncedShifts())
        .catch((err: any) => {
          logger.debug('[SyncModule] periodic shift retry failed:', err?.message);
        })
        .finally(() => {
          this._shiftRetryInFlight = false;
        });
    }, intervalMs);
    logger.info(`[SyncModule] Started periodic shift retry (${intervalMs / 1000}s interval)`);
  }

  stopPeriodicShiftRetry(): void {
    if (this._shiftRetryTimer) {
      clearInterval(this._shiftRetryTimer);
      this._shiftRetryTimer = null;
    }
    this._shiftRetryInFlight = false;
  }

  async start(): Promise<void> { this.setState(ModuleState.RUNNING); }

  async stop(): Promise<void> {
    this.orderSync?.stop();
    this.syncLogService?.stop();
    this.billiardSync?.stopPeriodicDashboardRefresh();
    this.stopPeriodicProductSync();
    this.stopPeriodicDraftProductSync();
    this.stopPeriodicShiftRetry();
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> {
    this.orderSync?.stop();
    this.syncLogService?.stop();
    this.billiardSync?.stopPeriodicDashboardRefresh();
    this.stopPeriodicProductSync();
    this.stopPeriodicDraftProductSync();
    this.stopPeriodicShiftRetry();
    this.setState(ModuleState.STOPPED);
  }
}
