/**
 * BooksyModule
 *
 * Owns Booksy calendar synchronization via Chrome DevTools Protocol.
 */

import { ipcMain, safeStorage } from 'electron';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import { BooksySync } from '../booksy/booksy-sync';
import { IPC_CHANNELS, BooksySyncConfig } from '../../shared/types';
import { getConfig, getConfigValue, setConfig, setConfigValue } from '../config/store';
import logger from '../logger';

export class BooksyModule extends BaseModule {
  readonly name = 'booksy';

  private booksySync: BooksySync | null = null;

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[BooksyModule] Initializing...');
    this.initializeBooksySync();
    this.container.set(SERVICE_TOKENS.BOOKSY_SYNC, this.booksySync);
    this.setState(ModuleState.READY);
  }

  private initializeBooksySync(): void {
    const config = getConfig();
    const booksyConfig = config.booksy as BooksySyncConfig | undefined;

    if (!booksyConfig?.enabled) {
      logger.info('[BooksyModule] Booksy sync disabled');
      return;
    }

    // Decrypt JWT if encrypted
    let jwt = booksyConfig.enailJwt || '';
    if (booksyConfig.encryptedEnailJwt && safeStorage.isEncryptionAvailable()) {
      try {
        jwt = safeStorage.decryptString(Buffer.from(booksyConfig.encryptedEnailJwt, 'base64'));
      } catch { logger.error('[BooksyModule] JWT decrypt failed'); }
    }

    if (!jwt) {
      logger.info('[BooksyModule] No eNail JWT — Booksy fetch will work, push to eNail will skip');
    }

    this.booksySync = new BooksySync({ ...booksyConfig, enailJwt: jwt }, (ids) => {
      setConfigValue('booksy.knownCustomerIds' as any, ids);
    });

    if (booksyConfig.knownCustomerIds && booksyConfig.knownCustomerIds.length > 0) {
      this.booksySync.restoreKnownCustomerIds(booksyConfig.knownCustomerIds);
    }

    this.booksySync.on('statusChanged', (status: any) => {
      const mainWindow = this.container.getOptional<Electron.BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW);
      mainWindow?.webContents.send(IPC_CHANNELS.BOOKSY_STATUS_CHANGED, status);
    });

    // BooksySync.start() is deferred to the module start() lifecycle phase
    logger.info('[BooksyModule] Booksy sync configured (will start in start() phase)');
  }

  private restartBooksySync(): void {
    const cachedToken = this.booksySync?.getToken() || null;
    if (this.booksySync) {
      if (this.booksySync.getStatus().running) {
        logger.info('[BooksyModule] Sync in progress, stopping for restart...');
      }
      this.booksySync.stop();
    }
    this.booksySync = null;
    this.initializeBooksySync();
    // TS can't track that initializeBooksySync() may have set this.booksySync
    const sync: BooksySync | null = this.booksySync as unknown as BooksySync | null;
    if (sync) {
      if (cachedToken) sync.setToken(cachedToken);
      sync.start();
    }
    this.container.set(SERVICE_TOKENS.BOOKSY_SYNC, sync);
  }

  registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_STATUS, () => {
      return this.booksySync?.getStatus() || { running: false };
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_CONFIG, () => {
      const config = getConfig();
      const bc = config.booksy || {};
      return { ...bc, enailJwt: undefined, encryptedEnailJwt: undefined }; // Don't expose JWT
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SET_CONFIG, (_, data: Partial<BooksySyncConfig>) => {
      const config = getConfig();
      const current = config.booksy || {};
      const updated = { ...current, ...data } as BooksySyncConfig;

      // Encrypt JWT if provided
      if (data.enailJwt && safeStorage.isEncryptionAvailable()) {
        updated.encryptedEnailJwt = safeStorage.encryptString(data.enailJwt).toString('base64');
        delete (updated as any).enailJwt;
      }

      setConfig({ booksy: updated });
      this.restartBooksySync();
      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_NOW, async () => {
      if (!this.booksySync) return { success: false, error: 'Booksy not initialized' };
      try { await this.booksySync.syncNow(); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_CUSTOMERS, async () => {
      if (!this.booksySync) return { success: false, error: 'Not initialized' };
      try { await this.booksySync.syncCustomersNow(); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_STAFF, async () => {
      if (!this.booksySync) return { success: false, error: 'Not initialized' };
      try { await this.booksySync.syncStaffNow(); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_RESOURCES, async () => {
      if (!this.booksySync) return { success: false, error: 'Not initialized' };
      try { await this.booksySync.syncResourcesNow(); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_SERVICES, async () => {
      if (!this.booksySync) return { success: false, error: 'Not initialized' };
      try { await this.booksySync.syncServicesNow(); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_ADDONS, async () => {
      if (!this.booksySync) return { success: false, error: 'Not initialized' };
      try { await this.booksySync.syncAddonsNow(); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_SYNC_ALL, async () => {
      if (!this.booksySync) return { success: false, error: 'Not initialized' };
      try { await this.booksySync.syncAllNow(); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_BOOKINGS, () => {
      return this.booksySync?.getBookings() || [];
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_CUSTOMERS, () => {
      return this.booksySync?.getCustomers() || [];
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_STAFF, () => {
      return this.booksySync?.getStaff() || [];
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_RESOURCES, () => {
      return this.booksySync?.getResources() || [];
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_SERVICES, () => {
      return this.booksySync?.getServices() || [];
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_GET_ADDONS, () => {
      return this.booksySync?.getAddons() || [];
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_START, () => {
      setConfigValue('booksy.enabled' as any, true);
      this.initializeBooksySync();
      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.BOOKSY_STOP, () => {
      this.booksySync?.stop();
      this.booksySync = null;
      setConfigValue('booksy.enabled' as any, false);
      return { success: true };
    });

    logger.info('[BooksyModule] IPC handlers registered');
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        definition: {
          type: 'function',
          function: {
            name: 'booksy_get_bookings',
            description: 'Get bookings/appointments for a specific date from Booksy',
            parameters: {
              type: 'object',
              properties: { date: { type: 'string', description: 'Date: "today", "tomorrow", or YYYY-MM-DD' } },
              required: ['date'],
            },
          },
        },
        module: this.name,
        category: 'booksy',
        execute: async (args) => {
          if (!this.booksySync) return '❌ Booksy sync not configured';
          const date = args.date as string;
          const bookings = date ? await this.booksySync.fetchBookingsForDate(date) : this.booksySync.getBookings();
          if (!bookings || bookings.length === 0) return `📅 No bookings for ${args.date}`;
          return `📅 ${bookings.length} bookings for ${args.date}:\n` + bookings.map((b: any) =>
            `  ${b.time} - ${b.customerName} (${b.serviceName}) [${b.staffName}]`
          ).join('\n');
        },
      },
      {
        definition: {
          type: 'function',
          function: { name: 'booksy_get_customers', description: 'Get customer list from Booksy', parameters: { type: 'object', properties: {}, required: [] } },
        },
        module: this.name, category: 'booksy',
        execute: async () => {
          if (!this.booksySync) return '❌ Booksy not configured';
          const customers = this.booksySync.getCustomers();
          return `👥 ${customers.length} customers synced from Booksy`;
        },
      },
      {
        definition: {
          type: 'function',
          function: { name: 'booksy_get_staff', description: 'Get staff members from Booksy', parameters: { type: 'object', properties: {}, required: [] } },
        },
        module: this.name, category: 'booksy',
        execute: async () => {
          if (!this.booksySync) return '❌ Booksy not configured';
          const staff = this.booksySync.getStaff();
          return `👨‍💼 ${staff.length} staff: ` + staff.map((s: any) => s.name).join(', ');
        },
      },
      {
        definition: {
          type: 'function',
          function: { name: 'booksy_get_services', description: 'Get services offered from Booksy', parameters: { type: 'object', properties: {}, required: [] } },
        },
        module: this.name, category: 'booksy',
        execute: async () => {
          if (!this.booksySync) return '❌ Booksy not configured';
          const services = this.booksySync.getServices();
          return `💅 ${services.length} services: ` + services.map((s: any) => s.name).join(', ');
        },
      },
      {
        definition: {
          type: 'function',
          function: { name: 'booksy_sync_now', description: 'Trigger immediate sync with Booksy', parameters: { type: 'object', properties: {}, required: [] } },
        },
        module: this.name, category: 'booksy',
        execute: async () => {
          if (!this.booksySync) return '❌ Booksy not configured';
          try { await this.booksySync.syncNow(); return '✅ Booksy sync completed'; } catch (e: any) { return `❌ Sync failed: ${e.message}`; }
        },
      },
    ];
  }

  registerEventHandlers(bus: EventBus): void {
    bus.on('config:changed', (payload) => {
      const booksyKeys = ['booksy', 'booksy.enabled'];
      if (payload.changedKeys.some(k => booksyKeys.includes(k))) {
        logger.info('[BooksyModule] Config changed, reinitializing sync...');
        this.restartBooksySync();
      }
    });

    bus.on('user:logged-out', () => {
      logger.info('[BooksyModule] User logged out, stopping sync');
      this.booksySync?.stop();
      this.booksySync = null;
      this.container.set(SERVICE_TOKENS.BOOKSY_SYNC, null);
    });
  }

  async start(): Promise<void> {
    // Start booksy sync here (proper lifecycle phase)
    if (this.booksySync) {
      this.booksySync.start();
      logger.info('[BooksyModule] Booksy sync started');
    }
    this.setState(ModuleState.RUNNING);
  }

  async stop(): Promise<void> {
    this.booksySync?.stop();
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> { this.setState(ModuleState.STOPPED); }
}
