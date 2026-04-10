/**
 * PosModule
 *
 * Owns PosStore, PaymentController, ShiftController, and all POS IPC handlers.
 */

import { ipcMain } from 'electron';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
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
import { database } from '../database/database';
import SocketClient from '../network/socket-client';
import { getConfig } from '../config/store';
import type { SelectedService } from '../../shared/types';
import { PrinterType } from '../../shared/types';
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
    );
    this.shiftController = new ShiftController(
      getPrinterForType,
      isConnected,
    );

    this.container.set(SERVICE_TOKENS.POS_STORE, this.posStore);
    this.container.set(SERVICE_TOKENS.WINDOW_MANAGER, this.windowManager);
    this.container.set(SERVICE_TOKENS.PAYMENT_CONTROLLER, this.paymentController);
    this.container.set(SERVICE_TOKENS.SHIFT_CONTROLLER, this.shiftController);

    this.setState(ModuleState.READY);
    logger.info('[PosModule] Initialized');
  }

  registerIpcHandlers(): void {
    // State & dispatch
    ipcMain.handle('pos:get-state', (e) => {
      const state = this.posStore?.getState();
      logger.info(`[PosModule] IPC pos:get-state from window="${e.sender.getTitle?.() ?? 'unknown'}" → mode=${state?.display?.mode}`);
      return state;
    });
    ipcMain.handle('pos:dispatch', (_e, action) => { this.posStore?.dispatch(action); return { success: true }; });

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
      try {
        bookingNumber = checkinRepo.nextBookingNumber();
        checkinRepo.create({
          id: `ci-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

    // Products
    ipcMain.handle('pos:products:getAll', () => productRepo.getAll());
    ipcMain.handle('pos:products:getByCategory', (_e, catId: string) => productRepo.getByCategory(catId));
    ipcMain.handle('pos:products:search', (_e, query: string) => productRepo.search(query));
    ipcMain.handle('pos:products:getByBarcode', (_e, barcode: string) => productRepo.getByBarcode(barcode));
    ipcMain.handle('pos:categories:getAll', () => productRepo.getCategories());

    // Orders
    ipcMain.handle('pos:orders:create', (_e, order, items) => {
      try { return { success: true, id: orderRepo.create(order, items) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:orders:getDailyStats', (_e, date: string) => orderRepo.getDailyStats(date));

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

    ipcMain.handle('pos:open-cash-drawer', async () => {
      try { await this.paymentController?.openCashDrawer(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
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
        const report = this.shiftController.closeShift(data.shiftId, data.closingCash);
        this.posStore?.dispatch({ type: 'session/close' });
        await this.shiftController.printZReport(report);
        return { success: true, report };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    logger.info('[PosModule] IPC handlers registered');
  }

  registerEventHandlers(bus: EventBus): void {
    // Forward Elavon status updates to POS window
    // (wired separately in setupSocketHandlers)
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


