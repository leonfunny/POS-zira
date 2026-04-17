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
import { OrderSync } from '../sync/order-sync';
import { BilliardSync } from '../sync/billiard-sync';
import { CheckinSync } from '../sync/checkin-sync';
import { ChangeFeedSync } from '../sync/change-feed-sync';
import { InvoiceSync } from '../sync/invoice-sync';
import { StaffSync } from '../sync/staff-sync';
import { SyncLogService, SYNC_MODES } from '../sync/sync-log-service';
import { productRepo } from '../database/repos/product-repo';
import { billiardResourceRepo } from '../database/repos/billiard-resource-repo';
import { billiardSessionRepo } from '../database/repos/billiard-session-repo';
import { billiardComboRepo } from '../database/repos/billiard-combo-repo';
import { billiardFloorPlanRepo } from '../database/repos/billiard-floor-plan-repo';
import { database } from '../database/database';
import { PrinterType, ReceiptData } from '../../shared/types';
import { getConfig } from '../config/store';
import SocketClient from '../network/socket-client';
import { WindowManager } from '../windows/window-manager';
import { ShiftController } from '../pos/shift-controller';
import type { HardwareModule } from './hardware.module';
import logger from '../logger';

export class SyncModule extends BaseModule {
  readonly name = 'sync';

  private productSync: ProductSync | null = null;
  private orderSync: OrderSync | null = null;
  private billiardSync: BilliardSync | null = null;
  private checkinSync: CheckinSync | null = null;
  private changeFeedSync: ChangeFeedSync | null = null;
  private invoiceSync: InvoiceSync | null = null;
  private staffSync: StaffSync | null = null;
  private syncLogService: SyncLogService | null = null;
  private _syncInProgress = false;

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[SyncModule] Initializing...');
    this.productSync = new ProductSync();
    this.orderSync = new OrderSync();
    this.billiardSync = new BilliardSync();
    this.checkinSync = new CheckinSync();
    this.changeFeedSync = new ChangeFeedSync();
    this.invoiceSync = new InvoiceSync();
    this.staffSync = new StaffSync();
    this.syncLogService = new SyncLogService();
    this.container.set(SERVICE_TOKENS.PRODUCT_SYNC, this.productSync);
    this.container.set(SERVICE_TOKENS.ORDER_SYNC, this.orderSync);
    this.container.set(SERVICE_TOKENS.BILLIARD_SYNC, this.billiardSync);
    this.container.set(SERVICE_TOKENS.CHECKIN_SYNC, this.checkinSync);
    this.container.set(SERVICE_TOKENS.CHANGE_FEED_SYNC, this.changeFeedSync);
    this.container.set(SERVICE_TOKENS.INVOICE_SYNC, this.invoiceSync);
    this.container.set(SERVICE_TOKENS.STAFF_SYNC, this.staffSync);
    this.container.set(SERVICE_TOKENS.SYNC_LOG_SERVICE, this.syncLogService);
    this.setState(ModuleState.READY);
  }

  registerIpcHandlers(): void {
    ipcMain.handle('pos:sync:products', async () => {
      try {
        await this.productSync?.deltaSync();
        return { success: true };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('pos:sync:orders', async () => {
      try {
        await this.orderSync?.syncPendingOrders();
        return { success: true };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('pos:sync:checkins', async () => {
      try {
        this.checkinSync?.resetEndpointAvailability();
        const result = await this.checkinSync?.syncPending();
        return { success: true, ...result };
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

        const hw = this.container.getOptional<HardwareModule>(SERVICE_TOKENS.HARDWARE_MODULE);
        const printer = hw?.getPrinterForType(PrinterType.RECEIPT);
        if (!printer || !printer.isConnected()) {
          logger.warn('[SyncModule] billiard:print:receipt — no receipt printer connected');
          return { success: true, receiptPrinted: false };
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
      const wm = this.container.getOptional<WindowManager>(SERVICE_TOKENS.WINDOW_MANAGER);

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
        // These are always needed — Path B pull only delivers CHANGES after
        // sync_log was deployed, not the historical product catalog.
        if (this.productSync) {
          try {
            await this.productSync.deltaSync();
            const posWindow = wm?.getWindow('pos');
            if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:products-synced');
          } catch (err) { logger.warn(`[SyncModule] Product sync failed: ${err}`); }
        }

        try { await this.staffSync?.pullStaff(); }
        catch (err) { logger.debug('[SyncModule] Staff pull failed:', err); }

        // ── Path B Pull: supplements ProductSync with real-time changes ──
        if (usePathBPull) {
          try {
            await this.syncLogService!.pullFromServer();
          } catch (err) { logger.warn(`[SyncModule] Path B pull failed: ${err}`); }
          this.syncLogService!.startPeriodicPull();
        }

        // ── Path A ChangeFeedSync: only when NOT using Path B pull ──
        if (!usePathBPull) {
          if (this.changeFeedSync) {
            this.changeFeedSync.resetEndpointAvailability();
            try { await this.changeFeedSync.catchUp(); } catch (err) { logger.debug('[SyncModule] Change feed catch-up failed:', err); }
            this.changeFeedSync.startPeriodicCatchUp();
          }
        }

        // ── Always: OrderSync + CheckinSync + InvoiceSync outbox ──
        // Path B push is not yet wired to order creation — orders still use
        // direct POST /b2b/pos/orders via OrderSync (Path A outbox).
        // This will be replaced in Phase 3 when order creation writes to local_sync_log.
        this.orderSync?.startPeriodicSync();
        try { await this.orderSync?.syncPendingOrders(); } catch (err: any) { logger.debug('[SyncModule] sync pending orders failed:', err?.message); }

        if (this.checkinSync) {
          this.checkinSync.resetEndpointAvailability();
          try { await this.checkinSync.syncPending(); } catch (err: any) { logger.debug('[SyncModule] sync pending checkins failed:', err?.message); }
          this.checkinSync.startPeriodicSync();
        }

        if (this.invoiceSync) {
          this.invoiceSync.resetEndpointAvailability();
          try { await this.invoiceSync.syncPending(); } catch (err) { logger.debug('[SyncModule] Invoice sync failed:', err); }
          this.invoiceSync.startPeriodicSync();
        }

        // ── Path B Push: for future use (sync log push) ──
        if (usePathBPush) {
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
        await this.productSync.deltaSync();
        const wm = this.container.getOptional<WindowManager>(SERVICE_TOKENS.WINDOW_MANAGER);
        const posWindow = wm?.getWindow('pos');
        if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:products-synced');
        logger.info('[SyncModule] Post-login product sync completed');
      } catch (err) { logger.warn(`[SyncModule] Post-login product sync failed: ${err}`); }
    });

    bus.on('socket:disconnected', () => {
      this.orderSync?.stop();
      this.checkinSync?.stop();
      this.invoiceSync?.stop();
      this.changeFeedSync?.stop();
      this.syncLogService?.stop();
      if (this.billiardSync) {
        this.billiardSync.setOnline(false);
        this.billiardSync.stopPeriodicDashboardRefresh();
      }
    });
  }

  /**
   * Wire up real-time socket events.
   */
  setupSocketHandlers(socket: SocketClient): void {
    const wm = this.container.getOptional<WindowManager>(SERVICE_TOKENS.WINDOW_MANAGER);

    socket.on('catalog:updated', (data: { variantId: string; changes: any }) => {
      // Path B handles this via sync:entry
      if (this.syncLogService?.isModeAtLeast(SYNC_MODES.PATH_B_FULL)) return;

      if (data.changes) productRepo.upsertMany([data.changes]);
      const posWindow = wm?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:catalog-updated', data);
    });

    socket.on('stock:updated', (data: { variantId: string; newStock: number }) => {
      // Path B handles this via sync:entry
      if (this.syncLogService?.isModeAtLeast(SYNC_MODES.PATH_B_FULL)) return;

      database.run('UPDATE product_variants SET in_stock = ? WHERE id = ?', [data.newStock, data.variantId]);
      const posWindow = wm?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:stock-updated', data);
    });

    // Billiard real-time events
    socket.on('billiard:session-updated', () => {
      this.billiardSync?.refreshDashboard().catch((e: any) => { logger.debug('[SyncModule] billiard dashboard refresh failed:', e?.message); });
    });

    socket.on('billiard:resource-updated', () => {
      this.billiardSync?.fullSync().catch((e: any) => { logger.debug('[SyncModule] billiard full sync failed:', e?.message); });
    });

    // Phase 3: Server→Client push events
    socket.on('order:status-changed', (data: any) => {
      // Path B handles this via sync:entry
      if (this.syncLogService?.isModeAtLeast(SYNC_MODES.PATH_B_FULL)) return;

      // Pass flat data directly — processOrderStatusChange expects { orderId, status, updatedAt } at top level
      this.changeFeedSync?.processOrderStatusChange(data);
      const posWindow = wm?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:order-status-changed', data);
    });

    socket.on('staff:updated', (data: any) => {
      // Path B handles this via sync:entry
      if (this.syncLogService?.isModeAtLeast(SYNC_MODES.PATH_B_FULL)) return;

      // Map camelCase from backend → snake_case for staffRepo
      const s = data.changes || data;
      if (s && s.id) {
        const { staffRepo } = require('../database/repos/staff-repo');
        staffRepo.upsertMany([{
          id: s.id,
          name: s.name || s.fullName || 'Staff',
          commission_rate: s.commissionRate ?? s.commission_rate ?? 0,
          is_active: s.isActive !== false ? 1 : 0,
          updated_at: s.updatedAt ?? null,
          role: s.role ?? null,
          backend_synced_at: new Date().toISOString(),
        }]);
        database.save();
      }
      const posWindow = wm?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:staff-updated', data);
    });

    socket.on('invoice:updated', (data: any) => {
      // Path B handles this via sync:entry — skip if in full mode
      if (this.syncLogService?.isModeAtLeast(SYNC_MODES.PATH_B_FULL)) return;

      // Pass flat invoice data — processInvoiceChange expects { id, status } at top level
      const invoice = data.changes || data;
      if (invoice) {
        // Ensure id is set (backend may send invoiceId instead)
        if (!invoice.id && data.invoiceId) invoice.id = data.invoiceId;
        this.changeFeedSync?.processInboundInvoice(invoice);
      }
    });

    // ── Path B: Real-time sync log entries ──────────────────
    socket.on('sync:entry', async (entry: any) => {
      if (!this.syncLogService?.isModeAtLeast(SYNC_MODES.PATH_B_PULL)) return;

      try {
        await this.syncLogService.processRealtimeEntry(entry);

        // Notify renderer about the change
        const posWindow = wm?.getWindow('pos');
        if (posWindow && !posWindow.isDestroyed()) {
          // Targeted notification based on entity type
          if (entry.entity_type === 'product' || entry.entity_type === 'category') {
            posWindow.webContents.send('pos:products-synced');
          } else if (entry.entity_type === 'stock') {
            posWindow.webContents.send('pos:stock-updated', {
              variantId: entry.entity_id,
              newStock: entry.payload?.newStock,
            });
          } else if (entry.entity_type === 'order') {
            posWindow.webContents.send('pos:order-status-changed', entry.payload);
          } else if (entry.entity_type === 'staff') {
            posWindow.webContents.send('pos:staff-updated', entry.payload);
          }

          // Always send generic sync event
          posWindow.webContents.send('pos:sync-entry', entry);
        }
      } catch (err: any) {
        logger.debug(`[SyncModule] sync:entry processing failed: ${err.message}`);
      }
    });
  }

  getToolDefinitions(): ToolDefinition[] {
    return [];
  }

  async start(): Promise<void> { this.setState(ModuleState.RUNNING); }

  async stop(): Promise<void> {
    this.orderSync?.stop();
    this.checkinSync?.stop();
    this.invoiceSync?.stop();
    this.changeFeedSync?.stop();
    this.syncLogService?.stop();
    this.billiardSync?.stopPeriodicDashboardRefresh();
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> {
    this.invoiceSync?.stop();
    this.changeFeedSync?.stop();
    this.syncLogService?.stop();
    this.billiardSync?.stopPeriodicDashboardRefresh();
    this.setState(ModuleState.STOPPED);
  }
}
