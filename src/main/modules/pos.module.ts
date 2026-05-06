/**
 * PosModule
 *
 * Owns PosStore, PaymentController, ShiftController, and all POS IPC handlers.
 */

import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import { repairOrphanBookings } from '../sync/booking-sync';
import { PosStore } from '../pos/pos-store';
import { PaymentController } from '../pos/payment-controller';
import { ShiftController } from '../pos/shift-controller';
import { WindowManager } from '../windows/window-manager';
import { productRepo } from '../database/repos/product-repo';
import { orderRepo } from '../database/repos/order-repo';
import { tableRepo } from '../database/repos/table-repo';
import { customerRepo } from '../database/repos/customer-repo';
import { staffRepo } from '../database/repos/staff-repo';
import { holdOrderRepo } from '../database/repos/hold-repo';
import { quickKeyLayoutRepo } from '../database/repos/quickkey-layout-repo';
import { checkinRepo } from '../database/repos/checkin-repo';
import { bookingRepo } from '../database/repos/booking-repo';
import { serviceRepo } from '../database/repos/service-repo';
import { serviceRuleRepo } from '../database/repos/service-rule-repo';
import { database } from '../database/database';
import SocketClient from '../network/socket-client';
import { apiClient } from '../network/api-client';
import { getConfig, getSecureAuthToken } from '../config/store';
import type { SelectedService } from '../../shared/types';
import { PrinterType, IPC_CHANNELS } from '../../shared/types';
import { seedIfEmpty } from '../database/seed';
import { adaptServerOrder, adaptServerOrderItem } from '../sync/pos-order-adapter';
import type { SyncLogService } from '../sync/sync-log-service';
import {
  writeBookingStatusChanged,
  writeBookingCancelled,
  writeBookingUpdated,
  writeBookingCreated,
  type BookingUpdatePatch,
  type WalkInBookingInput,
} from '../sync/booking-sync';
import logger from '../logger';

export class PosModule extends BaseModule {
  readonly name = 'pos';

  private posStore: PosStore | null = null;
  private windowManager: WindowManager | null = null;
  private paymentController: PaymentController | null = null;
  private shiftController: ShiftController | null = null;

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[PosModule] Initializing...');

    this.posStore = new PosStore();
    this.windowManager = new WindowManager(this.posStore);

    // Get printer accessor from hardware module
    const getPrinterForType = (type: string) => {
      const printers = this.container.getOptional<Record<string, any>>(SERVICE_TOKENS.PRINTERS) || {};
      return printers[type] || null;
    };
    const isConnected = () => {
      const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
      return socket?.isConnected() || false;
    };

    this.paymentController = new PaymentController(
      getPrinterForType,
      isConnected,
      () => getConfig().salonName,
      () => getConfig().receiptSellerName,
      () => getConfig().receiptSellerAddress,
      () => getConfig().receiptSellerNip,
    );
    this.shiftController = new ShiftController(
      getPrinterForType,
      isConnected,
    );

    this.container.set(SERVICE_TOKENS.POS_STORE, this.posStore);
    this.container.set(SERVICE_TOKENS.WINDOW_MANAGER, this.windowManager);
    this.container.set(SERVICE_TOKENS.PAYMENT_CONTROLLER, this.paymentController);
    this.container.set(SERVICE_TOKENS.SHIFT_CONTROLLER, this.shiftController);

    // Crash recovery: orders marked synced=2 (in-flight) when the app crashed → reset to 0
    database.run('UPDATE orders SET synced = 0 WHERE synced = 2');
    // Repair corrupted state: synced=1 but no backend_id (response-shape bug fix side-effect)
    const corruptedCount = database.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM orders WHERE synced = 1 AND (backend_id IS NULL OR backend_id = '')",
    )?.cnt ?? 0;
    if (corruptedCount > 0) {
      database.run("UPDATE orders SET synced = 0, sync_attempts = 0, sync_error = NULL WHERE synced = 1 AND (backend_id IS NULL OR backend_id = '')");
      database.save();
      logger.warn(`[PosModule] Reset ${corruptedCount} orders with missing backend_id for re-sync`);
    }
    // NOTE: shelved orders (synced = -1) are NOT auto-reset. They require an explicit
    // retry via `pos:orders:retrySync` or one-time repair via `pos:orders:repairStockFailures`.

    // Orphan booking repair: bookings created via the Booking tab BEFORE
    // the atomic write fix (TEST123 / 5KOL on 2026-04-30) ended up in
    // `bookings` with no matching `local_sync_log` entry of
    // event='created', so the server never received them. Detect those
    // rows at boot and enqueue a fresh `booking/created` (plus a
    // follow-up `status_changed` for non-BOOKED orphans) so the next
    // push cycle delivers them.
    //
    // Idempotent: the SQL filters on
    //   NOT EXISTS (SELECT FROM local_sync_log WHERE event='created')
    // so a booking that already has a created log — even if its
    // companion status_changed got rejected — is left alone.
    try {
      const syncLog = this.container.getOptional<SyncLogService>(SERVICE_TOKENS.SYNC_LOG_SERVICE);
      if (syncLog) {
        const repair = repairOrphanBookings(syncLog);
        if (repair.scanned > 0) {
          logger.warn(
            `[PosModule] Orphan booking repair: scanned=${repair.scanned} enqueued=${repair.enqueued} enqueued_status=${repair.enqueued_status} skipped=${repair.skipped} reasons=${JSON.stringify(repair.skipped_reasons)}`,
          );
        }
      }
    } catch (err: any) {
      // Non-fatal — repair is a best-effort cleanup. A failure here must
      // not block the rest of POS init.
      logger.error(`[PosModule] Orphan booking repair failed: ${err?.message ?? err}`);
    }

    // Finish any synced orders that were created before the /finish call was added.
    // Non-blocking — runs in background after init completes.
    setTimeout(async () => {
      const token = getSecureAuthToken();
      if (!token) return;
      const unfinished = database.all<{ backend_id: string; order_number: string }>(
        "SELECT backend_id, order_number FROM orders WHERE synced = 1 AND backend_id IS NOT NULL AND backend_id != ''",
      );
      for (const o of unfinished) {
        try {
          await apiClient.finishOrder(token, o.backend_id);
          logger.info(`[PosModule] Retroactively finished order ${o.order_number}`);
        } catch { /* already finished or endpoint not available */ }
      }
    }, 5000);

    // Recover open shift from local DB (app restart during active shift)
    const openShift = database.get<{ id: string; staff_id: string | null; staff_name: string | null; opened_at: string }>(
      'SELECT id, staff_id, staff_name, opened_at FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1',
    );
    if (openShift) {
      this.posStore.dispatch({
        type: 'session/open',
        payload: { shiftId: openShift.id, staffId: openShift.staff_id, staffName: openShift.staff_name, openedAt: openShift.opened_at },
      });
      logger.info(`[PosModule] Recovered open shift ${openShift.id} (${openShift.staff_name})`);
    }

    // Cross-verify with server (async, non-blocking)
    this.verifyShiftWithServer(openShift?.id ?? null);

    this.setState(ModuleState.READY);
    logger.info('[PosModule] Initialized');
  }

  private async verifyShiftWithServer(localShiftId: string | null): Promise<void> {
    try {
      const token = getSecureAuthToken();
      if (!token) return;
      const serverShift = await apiClient.getActiveShift(token);
      if (serverShift && !localShiftId) {
        logger.warn(`[PosModule] Server has active shift ${serverShift.id} but local DB has none — restoring`);
        this.posStore?.dispatch({
          type: 'session/open',
          payload: { shiftId: serverShift.id, staffId: serverShift.staffId, staffName: serverShift.staffName, openedAt: serverShift.openedAt },
        });
      } else if (!serverShift && localShiftId) {
        logger.warn(`[PosModule] Local shift ${localShiftId} is open but server says no active shift — local shift may have been closed elsewhere`);
      }
    } catch {
      logger.debug('[PosModule] Server shift verification skipped (offline or error)');
    }
  }

  registerIpcHandlers(): void {
    // State & dispatch
    ipcMain.handle('pos:get-state', (e) => {
      const state = this.posStore?.getState();
      logger.info(`[PosModule] IPC pos:get-state from window="${e.sender.getTitle?.() ?? 'unknown'}" → mode=${state?.display?.mode}`);
      return state;
    });
    ipcMain.handle('pos:dispatch', (_e, action) => { this.posStore?.dispatch(action); return { success: true }; });

    // Seed demo data for offline mode
    ipcMain.handle('pos:seed-demo', () => {
      seedIfEmpty();
      return { success: true };
    });

    // Customer display touch
    ipcMain.handle('display:touch', (e) => {
      logger.info(`[PosModule] IPC display:touch from window="${e.sender.getTitle?.() ?? 'unknown'}"`);
      this.posStore?.handleTouch();
      return { success: true };
    });

    // Customer display: service request
    ipcMain.handle('display:request-service', (_e, serviceId: string) => {
      this.posStore?.handleServiceRequest(serviceId);
      // Notify POS window
      const posWindow = this.windowManager?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) {
        // Find service name from state
        const state = this.posStore?.getState();
        let serviceName = serviceId;
        for (const cat of state?.display?.serviceCategories || []) {
          const svc = cat.services.find((s: any) => s.id === serviceId);
          if (svc) { serviceName = svc.name; break; }
        }
        posWindow.webContents.send('pos:customer-request', { id: `req-${Date.now()}`, serviceName });
      }
      return { success: true };
    });

    // Customer display: get bookings for check-in
    ipcMain.handle('display:get-bookings', () => {
      const booksySync = this.container.getOptional(SERVICE_TOKENS.BOOKSY_SYNC) as any;
      return booksySync?.getBookings?.() || [];
    });

    // Customer display: check-in
    ipcMain.handle('display:check-in', (_e, data: any) => {
      const services = normalizeSelectedServices(data.services);
      const normalizedData = {
        ...data,
        services,
        serviceName: data.serviceName?.trim() || deriveLegacyServiceName(services),
      };

      this.posStore?.handleCheckIn(normalizedData);
      // Persist to checkins table
      let bookingNumber: string | undefined;
      let checkinId: string | undefined;
      try {
        bookingNumber = checkinRepo.nextBookingNumber();
        checkinId = `ci-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        checkinRepo.create({
          id: checkinId,
          booking_number: bookingNumber,
          customer_name: normalizedData.customerName,
          customer_phone: normalizedData.customerPhone,
          customer_email: normalizedData.customerEmail,
          service_name: normalizedData.serviceName,
          staff_name: normalizedData.staffName,
          booking_id: normalizedData.bookingId?.toString(),
          booking_source: normalizedData.bookingId ? 'booksy' : undefined,
          is_walkin: normalizedData.isWalkIn ? 1 : 0,
        });
        database.save();

        // Path B: write to sync log for outbound push
        try {
          const syncLog = this.container.getOptional<SyncLogService>(SERVICE_TOKENS.SYNC_LOG_SERVICE);
          if (syncLog && checkinId) {
            syncLog.writeLocalEntry('checkin', checkinId, 'created', {
              id: checkinId,
              bookingNumber,
              customerName: normalizedData.customerName,
              customerPhone: normalizedData.customerPhone,
              customerEmail: normalizedData.customerEmail,
              serviceName: normalizedData.serviceName,
              staffName: normalizedData.staffName,
              bookingId: normalizedData.bookingId?.toString(),
              bookingSource: normalizedData.bookingId ? 'booksy' : undefined,
              isWalkin: !!normalizedData.isWalkIn,
              status: 'WAITING',
              checkedInAt: new Date().toISOString(),
            });
          }
        } catch (e) { logger.debug('[PosModule] Sync log write failed for check-in:', e); }
      } catch (e) {
        logger.error('[PosModule] Failed to persist check-in:', e);
      }

      // Add selected upsells to POS cart
      if (data.upsellsAdded?.length && this.posStore) {
        const upsellItems = this.posStore.getState().display?.upsellItems || [];
        for (const upsellId of data.upsellsAdded) {
          const item = upsellItems.find((u: any) => u.id === upsellId);
          if (item) {
            this.posStore.dispatch({
              type: 'cart/addItem',
              payload: {
                id: `upsell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                variantId: item.id,
                name: item.name,
                sku: '',
                price: item.price,
                quantity: 1,
                total: item.price,
              },
            });
            logger.info(`[PosModule] Added upsell "${item.name}" to cart from check-in`);
          }
        }
      }

      // Print check-in confirmation label (fire-and-forget)
      try {
        const hw = this.container.getOptional<any>(SERVICE_TOKENS.HARDWARE_MODULE);
        if (hw?.printCheckinConfirmation) {
          const printServices = (services || []).map((s: any) => ({ name: s.name, price: s.price || 0 }));
          hw.printCheckinConfirmation({
            bookingNumber,
            customerName: normalizedData.customerName,
            customerPhone: normalizedData.customerPhone,
            services: printServices.length > 0 ? printServices : normalizedData.serviceName ? [{ name: normalizedData.serviceName, price: 0 }] : [],
            staffName: normalizedData.staffName,
            checkinTime: new Date().toISOString(),
          }).catch((e: any) => logger.warn('[PosModule] Check-in print failed:', e));
        }
      } catch (e) {
        logger.warn('[PosModule] Check-in print setup failed:', e);
      }

      // Notify POS window
      const posWindow = this.windowManager?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) {
        posWindow.webContents.send('pos:customer-checkin', normalizedData);
      }
      return { success: true };
    });

    // Customer display: switch to browse services from checkin
    // Optional categoryId: if provided, SalonInteractiveView opens directly in that category.
    ipcMain.handle('display:browse-services', (_e, categoryId?: string) => {
      this.posStore?.handleBrowseFromCheckin(categoryId);
      return { success: true };
    });

    // Customer display: back from browse services to check-in hub
    ipcMain.handle('display:back-to-checkin', () => {
      this.posStore?.handleBackToCheckin();
      return { success: true };
    });

    // Customer display: back to idle/promo
    ipcMain.handle('display:back-to-idle', () => {
      this.posStore?.handleBackToIdle();
      return { success: true };
    });

    // Customer display: interaction ping (resets idle timer)
    ipcMain.handle('display:interaction-ping', () => {
      this.posStore?.handleInteractionPing();
      return { success: true };
    });

    // ── Bookings (dashboard-synced appointments) ──────────────────
    // Reads hit the local `bookings` table (populated by applyBooking
    // from sync_log). Writes apply locally + enqueue sync_log so the
    // backend receives them on the next push cycle.
    ipcMain.handle(IPC_CHANNELS.BOOKINGS_GET_TODAY, () => bookingRepo.getToday());
    ipcMain.handle(IPC_CHANNELS.BOOKINGS_GET_BY_ID, (_e, id: string) =>
      bookingRepo.getById(id),
    );
    ipcMain.handle(
      IPC_CHANNELS.BOOKINGS_GET_BY_DATE,
      (_e, dateIso: string) => {
        const start = new Date(dateIso);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start.getTime() + 86_400_000);
        return bookingRepo.getByDateRange(start.toISOString(), end.toISOString());
      },
    );
    ipcMain.handle(
      IPC_CHANNELS.BOOKINGS_GET_BY_DATE_RANGE,
      (_e, fromIso: string, toIso: string) =>
        bookingRepo.getByDateRange(fromIso, toIso),
    );

    ipcMain.handle(
      IPC_CHANNELS.BOOKINGS_STATUS_CHANGE,
      (_e, id: string, status: string, opts?: { note?: string }) => {
        const sync = this.container.getOptional<SyncLogService>(
          SERVICE_TOKENS.SYNC_LOG_SERVICE,
        );
        if (!sync) return { success: false, error: 'sync-unavailable' };
        try {
          writeBookingStatusChanged(sync, id, status, opts);
          return { success: true };
        } catch (err: any) {
          logger.error(`[pos.bookings.status] ${err.message}`);
          return { success: false, error: err.message };
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.BOOKINGS_CANCEL,
      (_e, id: string, reason: string) => {
        const sync = this.container.getOptional<SyncLogService>(
          SERVICE_TOKENS.SYNC_LOG_SERVICE,
        );
        if (!sync) return { success: false, error: 'sync-unavailable' };
        try {
          writeBookingCancelled(sync, id, reason || 'Cancelled at POS');
          return { success: true };
        } catch (err: any) {
          logger.error(`[pos.bookings.cancel] ${err.message}`);
          return { success: false, error: err.message };
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.BOOKINGS_UPDATE,
      (_e, id: string, patch: BookingUpdatePatch) => {
        const sync = this.container.getOptional<SyncLogService>(
          SERVICE_TOKENS.SYNC_LOG_SERVICE,
        );
        if (!sync) return { success: false, error: 'sync-unavailable' };
        try {
          writeBookingUpdated(sync, id, patch);
          return { success: true };
        } catch (err: any) {
          logger.error(`[pos.bookings.update] ${err.message}`);
          return { success: false, error: err.message };
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.BOOKINGS_CREATE,
      (_e, input: WalkInBookingInput) => {
        const sync = this.container.getOptional<SyncLogService>(
          SERVICE_TOKENS.SYNC_LOG_SERVICE,
        );
        if (!sync) return { success: false, error: 'sync-unavailable' };
        try {
          const bookingId = writeBookingCreated(sync, input);
          return { success: true, bookingId };
        } catch (err: any) {
          logger.error(`[pos.bookings.create] ${err.message}`);
          return { success: false, error: err.message };
        }
      },
    );

    // ── Services master data (read-only, fed by sync_log applicator) ─
    ipcMain.handle(IPC_CHANNELS.SERVICES_GET_ALL_ACTIVE, () =>
      serviceRepo.getAllActive(),
    );
    ipcMain.handle(
      IPC_CHANNELS.SERVICES_GET_BY_ID,
      (_e, id: string) => serviceRepo.getById(id),
    );
    ipcMain.handle(
      IPC_CHANNELS.SERVICE_RULES_GET_BY_SERVICE,
      (_e, serviceId: string) => serviceRuleRepo.getByService(serviceId),
    );

    // Products
    ipcMain.handle('pos:products:getAll', () => productRepo.getAll());
    ipcMain.handle('pos:products:getByCategory', (_e, catId: string) => productRepo.getByCategory(catId));
    ipcMain.handle('pos:products:search', (_e, query: string) => productRepo.search(query));
    ipcMain.handle('pos:products:getByBarcode', (_e, barcode: string) => productRepo.getByBarcode(barcode));
    ipcMain.handle('pos:categories:getAll', () => productRepo.getCategories());

    // Orders
    ipcMain.handle('pos:orders:create', (_e, order, items) => {
      try {
        const id = orderRepo.create(order, items);
        for (const item of items) {
          if (item.variant_id && item.quantity > 0) {
            productRepo.decrementStock(item.variant_id, item.quantity);
          }
        }
        database.save();

        // Path B: write to sync log for outbound push
        try {
          const syncLog = this.container.getOptional<SyncLogService>(SERVICE_TOKENS.SYNC_LOG_SERVICE);
          if (syncLog) {
            const PM: Record<string, string> = { CASH: 'CASH', CARD: 'CARD', BLIK: 'BLIK', TRANSFER: 'BANK_TRANSFER', BANK_TRANSFER: 'BANK_TRANSFER', CREDIT: 'CREDIT', INVOICE: 'BANK_TRANSFER' };
            const dto: Record<string, any> = {
              id,
              priceType: 'brutto',
              requiresInvoice: !!order.customer_nip,
              items: (items || []).filter((i: any) => i.variant_id || i.id).map((i: any) => ({
                productId: i.variant_id || i.id,
                variantId: i.variant_id || i.id,
                ...(i.sku ? { variantSku: i.sku } : {}),
                packQuantity: Math.max(1, Math.round(i.quantity || 1)),
                ...(typeof i.price === 'number' && Number.isFinite(i.price) ? { customPrice: i.price / 100 } : {}),
              })),
            };
            if (order.payment_tenders) {
              try {
                const tenders = JSON.parse(order.payment_tenders) as Array<{ method: string; amount: number }>;
                if (tenders.length > 0) dto.tenders = tenders.map((t: any) => ({ method: PM[t.method] || t.method, amount: t.amount / 100 }));
              } catch { /* single method fallback below */ }
            }
            if (order.payment_method) dto.paymentMethod = PM[order.payment_method] || 'CASH';
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
            syncLog.writeLocalEntry('order', id, 'created', dto);
          }
        } catch (e) { logger.debug('[PosModule] Sync log write failed for order:', e); }

        return { success: true, id };
      }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:orders:getDailyStats', (_e, date: string) => orderRepo.getDailyStats(date));

    ipcMain.handle('pos:orders:getHistory', (_e, filters: { from: string; to: string; paymentMethod?: string; staffName?: string; page?: number; limit?: number }) => {
      const limit = filters.limit || 20;
      const page = filters.page || 1;
      const hasFilter = Boolean(filters.paymentMethod || filters.staffName);

      if (!hasFilter) {
        const offset = (page - 1) * limit;
        const result = orderRepo.getByDateRange(filters.from, filters.to, limit, offset);
        return { orders: result.orders, total: result.total, page, limit };
      }

      // Filter path: fetch wider window, filter in JS, then paginate.
      // 1000 cap — single-day POS rarely exceeds 500 orders.
      const wide = orderRepo.getByDateRange(filters.from, filters.to, 1000, 0);
      let orders = wide.orders;
      if (filters.paymentMethod) orders = orders.filter(o => o.payment_method === filters.paymentMethod);
      if (filters.staffName) orders = orders.filter(o => o.staff_name === filters.staffName);
      const total = orders.length;
      const offset = (page - 1) * limit;
      return { orders: orders.slice(offset, offset + limit), total, page, limit };
    });

    ipcMain.handle('pos:orders:getDetail', (_e, orderId: string) => {
      const order = orderRepo.getById(orderId);
      if (!order) return null;
      const items = orderRepo.getItemsByOrderId(orderId);
      return { order, items };
    });

    // Tables (restaurant mode)
    ipcMain.handle('pos:tables:getAll', () => tableRepo.getAll());
    ipcMain.handle('pos:tables:getActive', () => tableRepo.getActive());
    ipcMain.handle('pos:tables:updateStatus', (_e, id: string, status: string, orderId?: string) => { tableRepo.updateStatus(id, status, orderId); return { success: true }; });
    ipcMain.handle('pos:tables:clearTable', (_e, id: string) => { tableRepo.clear(id); return { success: true }; });
    ipcMain.handle('pos:tables:setCovers', (_e, id: string, covers: number) => { tableRepo.setCovers(id, covers); return { success: true }; });

    // Customers (B2B)
    ipcMain.handle('pos:customers:getAll', () => customerRepo.getAll());
    ipcMain.handle('pos:customers:search', (_e, query: string) => customerRepo.search(query));
    ipcMain.handle('pos:customers:getById', (_e, id: string) => customerRepo.getById(id));
    ipcMain.handle('pos:customers:increaseDebt', (_e, id: string, amount: number) => { customerRepo.increaseDebt(id, amount); return { success: true }; });

    // Staff
    ipcMain.handle('pos:staff:getAll', () => staffRepo.getAll());

    // Hold orders
    ipcMain.handle('pos:hold:create', (_e, id: string, title: string, payload: any) => {
      try { holdOrderRepo.create(id, title, payload); holdOrderRepo.prune(); database.save(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:hold:list', () => holdOrderRepo.list());
    ipcMain.handle('pos:hold:get', (_e, id: string) => holdOrderRepo.get(id));
    ipcMain.handle('pos:hold:remove', (_e, id: string) => { holdOrderRepo.remove(id); database.save(); return { success: true }; });

    // Quick keys
    ipcMain.handle('pos:quickkeys:list', (_e, mode?: string) => quickKeyLayoutRepo.list(mode));
    ipcMain.handle('pos:quickkeys:get', (_e, id: string) => quickKeyLayoutRepo.get(id));
    ipcMain.handle('pos:quickkeys:create', (_e, id: string, data: any) => {
      try { quickKeyLayoutRepo.create(id, data); database.save(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:quickkeys:update', (_e, id: string, data: any) => {
      try { quickKeyLayoutRepo.update(id, data); database.save(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:quickkeys:remove', (_e, id: string) => { quickKeyLayoutRepo.remove(id); database.save(); return { success: true }; });
    ipcMain.handle('pos:quickkeys:assign', (_e, regId: string, mode: string, layoutId: string) => {
      try { quickKeyLayoutRepo.assign(regId, mode, layoutId); database.save(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:quickkeys:getAssigned', (_e, regId: string, mode: string) => quickKeyLayoutRepo.getAssigned(regId, mode));

    // Checkin
    ipcMain.handle('checkin:getToday', () => checkinRepo.getToday());
    ipcMain.handle('checkin:getByDate', (_e, date: string) => checkinRepo.getByDate(date));
    ipcMain.handle('checkin:create', (_e, data: any) => {
      try { checkinRepo.create(data); database.save(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:updateStatus', (_e, id: string, status: string) => {
      try { checkinRepo.updateStatus(id, status); database.save(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:startService', (_e, id: string) => {
      try { checkinRepo.startService(id); database.save(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:complete', (_e, id: string) => {
      try { checkinRepo.complete(id); database.save(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:markNoShow', (_e, id: string) => {
      try { checkinRepo.markNoShow(id); database.save(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:searchPhone', (_e, phone: string) => checkinRepo.searchByPhone(phone));
    ipcMain.handle('checkin:addUpsells', (_e, id: string, upsells: string[]) => {
      try { checkinRepo.addUpsells(id, JSON.stringify(upsells)); database.save(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:updateNotes', (_e, id: string, notes: string) => {
      try { checkinRepo.updateNotes(id, notes); database.save(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:getStats', (_e, date?: string) => checkinRepo.getStats(date));

    // Customer display: phone search
    ipcMain.handle('display:search-by-phone', (_e, phone: string) => {
      // Validate phone input: must be digits only, at least 3 characters
      const sanitized = (phone || '').replace(/\D/g, '');
      if (sanitized.length < 3) return { customers: [], bookings: [] };

      const booksySync = this.container.getOptional(SERVICE_TOKENS.BOOKSY_SYNC) as any;
      const customers = booksySync?.getCustomers?.() || [];
      const matched = customers.filter((c: any) => c.cell_phone?.includes(sanitized)).slice(0, 20);
      if (!matched.length) return { customers: [], bookings: [] };
      const bookings = booksySync?.getBookings?.() || [];
      const names = new Set(matched.map((c: any) => c.full_name));
      return { customers: matched, bookings: bookings.filter((b: any) => names.has(b.customerName)) };
    });

    // Payment & shift
    ipcMain.handle('pos:print-receipt', async (_e, orderId: string) => {
      try { const printed = await this.paymentController?.printReceipt(orderId); return { success: true, receiptPrinted: printed ?? false }; }
      catch (e: any) { return { success: false, receiptPrinted: false, error: e.message }; }
    });

    ipcMain.handle('pos:reprint-receipt', async (_e, orderId: string) => {
      try { const printed = await this.paymentController?.reprintReceipt(orderId); return { success: true, receiptPrinted: printed ?? false }; }
      catch (e: any) { return { success: false, receiptPrinted: false, error: e.message }; }
    });

    ipcMain.handle('pos:print-refund-receipt', async (_e, orderId: string) => {
      try { const printed = await this.paymentController?.printRefundReceipt(orderId); return { success: true, receiptPrinted: printed ?? false }; }
      catch (e: any) { return { success: false, receiptPrinted: false, error: e.message }; }
    });

    ipcMain.handle('pos:orders:refund', async (_e, orderId: string, data: {
      type: 'FULL' | 'PARTIAL'; reason?: string;
      lines?: Array<{ variantId?: string; sku?: string; name?: string; quantity: number; unitPrice: number; refundAmount: number; restock: boolean }>;
      manualAdjustmentAmount?: number;
    }) => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };
        if (order.status === 'REFUNDED') return { success: false, error: 'Order already fully refunded' };
        if (order.status === 'PARTIAL_REFUND') {
          const alreadyRefunded = order.refund_amount ?? 0;
          const requestedAmount = data.type === 'FULL'
            ? order.total - alreadyRefunded
            : (data.lines ?? []).reduce((s, l) => s + l.refundAmount, 0);
          if (alreadyRefunded + requestedAmount > order.total) {
            return { success: false, error: `Refund would exceed order total (${order.total} grosze). Already refunded: ${alreadyRefunded}` };
          }
        }

        const activeShift = database.get<{ id: string }>(
          'SELECT id FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1',
        );
        if (!activeShift) return { success: false, error: 'Cannot refund without an active shift. Open a shift first.' };

        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        // Convert line amounts from grosze → PLN for backend
        const lines = (data.lines ?? []).map(l => ({
          variantId: l.variantId,
          sku: l.sku,
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice / 100,
          refundAmount: l.refundAmount / 100,
          restock: l.restock,
        }));

        const backendPayload: Record<string, any> = {
          type: data.type,
          reason: data.reason,
        };
        if (lines.length > 0) {
          backendPayload.lines = lines;
        }
        if (data.manualAdjustmentAmount != null) {
          backendPayload.manualAdjustmentAmount = data.manualAdjustmentAmount / 100;
        }

        logger.info(`[PosModule] Refund ${order.order_number}: ${data.type}, ${lines.length} lines, payload=${JSON.stringify(backendPayload).substring(0, 300)}`);

        const result = await apiClient.refundOrder(token, order.backend_id, backendPayload);
        if (result === null) return { success: false, error: 'Refund endpoint not available' };

        // Update local DB from backend response
        const refundedAmount = result.totalRefundedAmount != null
          ? Math.round(result.totalRefundedAmount * 100)
          : result.refundAmount != null
            ? Math.round(result.refundAmount * 100)
            : data.type === 'FULL' ? order.total : lines.reduce((s, l) => s + Math.round(l.refundAmount * 100), 0);
        const status = result.status === 'REFUNDED' ? 'FULL' : 'PARTIAL';
        const localRefundLines = (data.lines ?? []).map(l => ({
          name: l.name || '',
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          refundAmount: l.refundAmount,
          vatRate: 0,
          sku: l.sku || undefined,
        }));
        const orderItems = orderRepo.getItemsByOrderId(orderId);
        for (const rl of localRefundLines) {
          const match = orderItems.find(oi => oi.variant_id === (data.lines ?? []).find(dl => dl.name === rl.name)?.variantId || oi.name === rl.name);
          if (match) rl.vatRate = match.vat_rate;
        }
        orderRepo.markRefunded(orderId, refundedAmount, data.reason || '', status, localRefundLines.length > 0 ? localRefundLines : undefined);
        database.save();

        // Print refund receipt
        let receiptPrinted = false;
        try { receiptPrinted = await this.paymentController?.printRefundReceipt(orderId) ?? false; } catch (e: any) {
          logger.warn(`[PosModule] Refund receipt print failed: ${e.message}`);
        }

        if (order.payment_method === 'CASH') {
          try { await this.paymentController?.openCashDrawer(); } catch {}
        }

        // Trigger product sync to refresh stock after restock
        if (lines.some(l => l.restock)) {
          const productSync = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
          if (productSync) {
            try { await productSync.deltaSync(); } catch {}
          }
        }

        logger.info(`[PosModule] Order ${order.order_number} refunded: ${data.type}, backend status=${result.status}`);
        const { success: _s, ...rest } = result;
        return { success: true, receiptPrinted, ...rest };
      } catch (e: any) {
        logger.error(`[PosModule] Refund failed for order ${orderId}: ${e.message}`);
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('pos:orders:downloadPdf', async (e, orderId: string, kind: 'receipt' | 'invoice', invoiceType?: 'VAT' | 'PROFORMA') => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };

        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        const pdf = await apiClient.getOrderPdf(token, order.backend_id, kind, invoiceType ?? 'VAT');
        if (!pdf) return { success: false, error: 'PDF not available on server' };

        const suggestedName = `${kind === 'invoice' ? 'invoice' : 'receipt'}-${order.order_number || order.id.substring(0, 8)}.pdf`;
        const parentWindow = BrowserWindow.fromWebContents(e.sender) ?? undefined;
        const result = await dialog.showSaveDialog(parentWindow!, {
          title: `Save ${kind === 'invoice' ? 'Invoice' : 'Receipt'} PDF`,
          defaultPath: path.join(app.getPath('downloads'), suggestedName),
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (result.canceled || !result.filePath) return { success: false, error: 'Cancelled' };

        await fs.writeFile(result.filePath, pdf);
        shell.openPath(result.filePath).catch(() => {});
        return { success: true, filePath: result.filePath };
      } catch (err: any) {
        logger.error(`[PosModule] downloadPdf failed: ${err.message}`);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:addInvoice', async (_e, orderId: string, data: { customerNip: string; invoiceType?: 'VAT' | 'PROFORMA' }) => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };

        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        const nip = (data.customerNip || '').replace(/\D/g, '');
        if (nip.length !== 10) return { success: false, error: 'NIP must be 10 digits' };

        const result = await apiClient.addInvoiceToOrder(token, order.backend_id, {
          customerNip: nip,
          invoiceType: data.invoiceType ?? 'VAT',
        });

        database.run('UPDATE orders SET customer_nip = ? WHERE id = ?', [nip, orderId]);
        database.save();

        logger.info(`[PosModule] Invoice attached to order ${order.order_number} (NIP ${nip})`);
        return { success: true, order: result };
      } catch (err: any) {
        logger.error(`[PosModule] addInvoice failed: ${err.message}`);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:generateProforma', async (_e, orderId: string) => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };

        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        const result = await apiClient.generateProforma(token, order.backend_id);
        logger.info(`[PosModule] Proforma generated for order ${order.order_number}`);
        return { success: true, proforma: result };
      } catch (err: any) {
        logger.error(`[PosModule] generateProforma failed: ${err.message}`);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:customers:lookupNip', async (_e, nip: string) => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };
        const cleanNip = (nip || '').replace(/\D/g, '');
        if (cleanNip.length !== 10) return { success: false, error: 'NIP must be 10 digits' };
        const data = await apiClient.lookupCustomerByNip(token, cleanNip);
        return { success: true, data };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:getServerHistory', async (_e, orderId: string) => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };
        const history = await apiClient.getOrderServerHistory(token, order.backend_id);
        return { success: true, history };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:retrySync', async (_e, orderId: string) => {
      try {
        const orderSync = this.container.getOptional<any>(SERVICE_TOKENS.ORDER_SYNC);
        if (!orderSync) return { success: false, error: 'OrderSync not initialized' };
        const reset = orderSync.resetForRetry(orderId);
        if (!reset) return { success: false, error: 'Order not in shelved state or not found' };
        const summary = await orderSync.syncPendingOrders();
        const result = summary.results.find((r: any) => r.orderId === orderId);
        return { success: true, result, summary };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:repairStockFailures', async () => {
      try {
        const orderSync = this.container.getOptional<any>(SERVICE_TOKENS.ORDER_SYNC);
        if (!orderSync) return { success: false, error: 'OrderSync not initialized' };
        const resetCount = orderSync.repairStockFailures();
        if (resetCount === 0) return { success: true, resetCount: 0, summary: null };
        const summary = await orderSync.syncPendingOrders();
        return { success: true, resetCount, summary };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:cancel', async (_e, orderId: string) => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced — cannot cancel on server' };
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };
        await apiClient.cancelOrder(token, order.backend_id);
        database.run("UPDATE orders SET status = 'CANCELLED' WHERE id = ?", [order.id]);
        database.save();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:getServerList', async (_e, params: { period?: string; paymentStatus?: string; page?: number; limit?: number }) => {
      const serverUrl = getConfig().serverUrl;
      if (!serverUrl) {
        return { orders: [], items: {}, total: 0, page: 1, limit: params.limit ?? 20, source: 'unconfigured' };
      }
      const token = getSecureAuthToken();
      if (!token) {
        return { orders: [], items: {}, total: 0, page: 1, limit: params.limit ?? 20, source: 'unconfigured' };
      }
      try {
        const data = await apiClient.getServerOrders(token, params);
        const itemsMap: Record<string, any[]> = {};
        const orders = data.orders.map((s: any) => {
          const adapted = adaptServerOrder(s);
          if (Array.isArray(s.items)) {
            itemsMap[adapted.id] = s.items.map((item: any) => adaptServerOrderItem(item, adapted.id));
          }
          return adapted;
        });
        return { orders, items: itemsMap, total: data.total, page: data.page, limit: data.limit, source: 'server' };
      } catch (err: any) {
        return { orders: [], items: {}, total: 0, page: 1, limit: params.limit ?? 20, source: 'network-error', error: err.message };
      }
    });

    ipcMain.handle('pos:orders:getTodayServer', async () => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };
        const orders = await apiClient.getTodayOrders(token);
        return { success: true, orders, count: orders.length };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:mirrorFromServer', async (_e, orderId: string, kind: 'cash' | 'invoiced') => {
      try {
        if (!getConfig().serverUrl) return { success: false, error: 'Server URL not configured' };
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        let detail = await apiClient.getServerOrderDetail(token, orderId, kind);
        if (!detail) {
          const fallbackKind = kind === 'cash' ? 'invoiced' : 'cash';
          detail = await apiClient.getServerOrderDetail(token, orderId, fallbackKind);
        }
        if (!detail) return { success: false, error: 'Order not found on server' };

        const adaptedItems = detail.items;
        if (!Array.isArray(adaptedItems) || adaptedItems.length === 0) {
          return { success: false, error: 'Server response missing items array' };
        }

        const adapted = adaptServerOrder(detail);
        const items = adaptedItems.map((i: any) => adaptServerOrderItem(i, adapted.id));

        const result = orderRepo.upsertFromServer(adapted, items);
        const wasSplit = detail.paymentMethod === 'SPLIT';

        logger.info(`[PosModule] Mirrored ${orderId} from server (kind=${kind})`);
        return { success: true, localOrderId: result.localOrderId, wasSplit };
      } catch (err: any) {
        logger.warn(`[PosModule] Mirror failed for ${orderId}: ${err.message}`);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:shift:getActive', async () => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };
        const shift = await apiClient.getActiveShift(token);
        return { success: true, shift };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:open-cash-drawer', async () => {
      try {
        const drawerOpened = await this.paymentController?.openCashDrawer() ?? false;
        return {
          success: drawerOpened,
          drawerOpened,
          ...(drawerOpened ? {} : { error: 'Cash drawer did not open' }),
        };
      } catch (e: any) {
        return { success: false, drawerOpened: false, error: e.message };
      }
    });

    ipcMain.handle('pos:payment:card', async (_e, data: { amount: number; orderId: string }) => {
      const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
      if (!socket?.isConnected()) return { success: false, error: 'Not connected to server' };

      return new Promise((resolve) => {
        let settled = false;
        const cleanup = () => {
          socket.removeListener('elavon:payment-response', onResponse);
          socket.removeListener('disconnect', onDisconnect);
          clearTimeout(timeout);
        };
        const onResponse = (response: any) => {
          if (response.orderId !== data.orderId || settled) return;
          settled = true;
          cleanup();
          resolve(response.success ? { success: true, transactionId: response.transactionId } : { success: false, error: response.error || 'Payment declined' });
        };
        const onDisconnect = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ success: false, error: 'Connection lost during payment' });
        };
        const timeout = setTimeout(() => { if (settled) return; settled = true; cleanup(); resolve({ success: false, error: 'Payment timeout (60s)' }); }, 60000);
        socket.on('elavon:payment-response', onResponse);
        socket.once('disconnect', onDisconnect);
        socket.requestElavonPayment(data);
      });
    });

    ipcMain.handle('pos:shift:open', (_e, data: { staffId: string; staffName: string; openingCash: number }) => {
      try {
        if (!this.shiftController) return { success: false, error: 'Shift controller not initialized' };
        const shiftId = this.shiftController.openShift(data.staffId, data.staffName, data.openingCash);
        this.posStore?.dispatch({ type: 'session/open', payload: { shiftId, staffId: data.staffId, staffName: data.staffName } });
        return { success: true, shiftId };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('pos:shift:close', async (_e, data: { shiftId: string; closingCash: number }) => {
      try {
        if (!this.shiftController) return { success: false, error: 'Shift controller not initialized' };

        // Check shift exists in DB — if not, clear the ghost session and return gracefully
        const shiftExists = database.get<{ id: string }>('SELECT id FROM shifts WHERE id = ?', [data.shiftId]);
        if (!shiftExists) {
          logger.warn(`[PosModule] Ghost shift ${data.shiftId.substring(0, 8)} — not in DB, clearing session`);
          this.posStore?.dispatch({ type: 'session/close' });
          return { success: true, report: null };
        }

        // Attempt to sync pending orders before closing shift
        const orderSync = this.container.getOptional<any>(SERVICE_TOKENS.ORDER_SYNC);
        if (orderSync) {
          try { await orderSync.syncPendingOrders(); } catch { /* best-effort */ }
        }
        const report = this.shiftController.closeShift(data.shiftId, data.closingCash);
        this.posStore?.dispatch({ type: 'session/close' });
        await this.shiftController.printZReport(report);
        return { success: true, report };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    logger.info('[PosModule] IPC handlers registered');
  }

  registerEventHandlers(bus: EventBus): void {
    // Clear cart & shift on logout to prevent data leakage between accounts
    bus.on('user:logged-out', () => {
      logger.info('[PosModule] User logged out — clearing POS state');
      this.posStore?.dispatch({ type: 'cart/clear' });
      this.posStore?.dispatch({ type: 'session/close' });
    });
  }

  setupSocketHandlers(socket: SocketClient): void {
    socket.on('elavon:payment-status-update', (data: any) => {
      const posWindow = this.windowManager?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:elavon-status', data);
      // Forward payment status to customer display via PosStore broadcast
      if (this.posStore) {
        const currentDisplay = this.posStore.getState().display;
        this.posStore.dispatch({
          type: 'display/setMode',
          payload: { ...currentDisplay, paymentStatus: data.status },
        });
      }
    });
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        definition: {
          type: 'function',
          function: {
            name: 'search_products',
            description: 'Search POS products by name or barcode',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string', description: 'Search query' } },
              required: ['query'],
            },
          },
        },
        module: this.name,
        category: 'pos',
        execute: async (args) => {
          const results = productRepo.search(args.query as string);
          if (results.length === 0) return `❌ No products found for "${args.query}"`;
          return `🔍 ${results.length} products:\n` + results.slice(0, 10).map((p: any) => `  ${p.name} - ${(p.price / 100).toFixed(2)} PLN`).join('\n');
        },
      },
    ];
  }

  async start(): Promise<void> {
    this.setState(ModuleState.RUNNING);
    // Set salon display info from config
    const config = getConfig();
    const salonSlug = config.salonSlug as string | undefined;
    this.posStore?.setSalonDisplayInfo({
      salonName: (config.salonName as string | undefined) || undefined,
      bookingUrl: salonSlug ? `https://zira-ai.com/s/${salonSlug}` : undefined,
    });
  }

  async stop(): Promise<void> {
    this.windowManager?.destroy();
    if (this.posStore && typeof this.posStore.destroy === 'function') {
      this.posStore.destroy();
    }
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> { this.setState(ModuleState.STOPPED); }
}

function normalizeSelectedServices(services?: SelectedService[]): SelectedService[] | undefined {
  const normalized = (services || [])
    .map((service) => ({
      id: service.id,
      name: service.name,
      price: service.price,
      duration: service.duration,
    }))
    .filter((service) => service.id && service.name);

  return normalized.length > 0 ? normalized : undefined;
}

function deriveLegacyServiceName(services?: SelectedService[]): string | undefined {
  const names = (services || [])
    .map((service) => service.name?.trim())
    .filter((name): name is string => !!name);

  return names.length > 0 ? names.join(', ') : undefined;
}


