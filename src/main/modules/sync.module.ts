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
    this.container.set(SERVICE_TOKENS.PRODUCT_SYNC, this.productSync);
    this.container.set(SERVICE_TOKENS.ORDER_SYNC, this.orderSync);
    this.container.set(SERVICE_TOKENS.BILLIARD_SYNC, this.billiardSync);
    this.container.set(SERVICE_TOKENS.CHECKIN_SYNC, this.checkinSync);
    this.container.set(SERVICE_TOKENS.CHANGE_FEED_SYNC, this.changeFeedSync);
    this.container.set(SERVICE_TOKENS.INVOICE_SYNC, this.invoiceSync);
    this.container.set(SERVICE_TOKENS.STAFF_SYNC, this.staffSync);
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

    logger.info('[SyncModule] IPC handlers registered (including billiard)');
  }

  registerEventHandlers(bus: EventBus): void {
    bus.on('socket:connected', async () => {
      if (this._syncInProgress) return;
      this._syncInProgress = true;
      const wm = this.container.getOptional<WindowManager>(SERVICE_TOKENS.WINDOW_MANAGER);

      try {
        if (this.productSync) {
          try {
            await this.productSync.deltaSync();
            const posWindow = wm?.getWindow('pos');
            if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:products-synced');
          } catch (err) { logger.warn(`[SyncModule] Product sync failed: ${err}`); }
        }

        this.orderSync?.startPeriodicSync();
        try { await this.orderSync?.syncPendingOrders(); } catch (err: any) { logger.debug('[SyncModule] sync pending orders failed:', err?.message); }

        // Check-in sync (Phase 1 of log-based sync). Resets the endpoint-available
        // flag so a freshly-deployed server endpoint starts working without an app restart.
        if (this.checkinSync) {
          this.checkinSync.resetEndpointAvailability();
          try { await this.checkinSync.syncPending(); } catch (err: any) { logger.debug('[SyncModule] sync pending checkins failed:', err?.message); }
          this.checkinSync.startPeriodicSync();
        }

        // Retry unsynced shifts
        const shiftCtrl = this.container.getOptional<ShiftController>(SERVICE_TOKENS.SHIFT_CONTROLLER);
        try { await shiftCtrl?.retryUnsyncedShifts(); } catch (err: any) { logger.debug('[SyncModule] retry unsynced shifts failed:', err?.message); }

        // Billiard: full sync + replay queue + start polling
        if (this.billiardSync) {
          this.billiardSync.setOnline(true);
          try {
            await this.billiardSync.fullSync();
            await this.billiardSync.replayQueue();
          } catch (err) { logger.warn(`[SyncModule] Billiard sync failed: ${err}`); }
          this.billiardSync.startPeriodicDashboardRefresh();
        }

        // Phase 3: Staff pull + Invoice push + Change feed catch-up
        try { await this.staffSync?.pullStaff(); }
        catch (err) { logger.debug('[SyncModule] Staff pull failed:', err); }

        if (this.invoiceSync) {
          this.invoiceSync.resetEndpointAvailability();
          try { await this.invoiceSync.syncPending(); } catch (err) { logger.debug('[SyncModule] Invoice sync failed:', err); }
          this.invoiceSync.startPeriodicSync();
        }

        // Change feed catch-up runs LAST (after all outbound pushes complete)
        if (this.changeFeedSync) {
          this.changeFeedSync.resetEndpointAvailability();
          try { await this.changeFeedSync.catchUp(); } catch (err) { logger.debug('[SyncModule] Change feed catch-up failed:', err); }
          this.changeFeedSync.startPeriodicCatchUp();
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
      if (data.changes) productRepo.upsertMany([data.changes]);
      const posWindow = wm?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:catalog-updated', data);
    });

    socket.on('stock:updated', (data: { variantId: string; newStock: number }) => {
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
      this.changeFeedSync?.processOrderStatusChange({
        type: 'order', id: data.orderId, event: 'status_changed', data, timestamp: new Date().toISOString(),
      });
      const posWindow = wm?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:order-status-changed', data);
    });

    socket.on('staff:updated', (data: any) => {
      if (data.changes) {
        const { staffRepo } = require('../database/repos/staff-repo');
        staffRepo.upsertMany([data.changes]);
      }
      const posWindow = wm?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:staff-updated', data);
    });

    socket.on('invoice:updated', (data: any) => {
      this.changeFeedSync?.processInboundInvoice({
        type: 'invoice', id: data.invoiceId, event: 'updated', data: data.changes, timestamp: new Date().toISOString(),
      });
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
    this.billiardSync?.stopPeriodicDashboardRefresh();
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> {
    this.invoiceSync?.stop();
    this.changeFeedSync?.stop();
    this.billiardSync?.stopPeriodicDashboardRefresh();
    this.setState(ModuleState.STOPPED);
  }
}
