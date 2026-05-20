/**
 * WarehouseModule
 *
 * Owns Magazyn IPC handlers. Official posting, numbering, stock movements,
 * and print payloads are delegated to the backend; this module must not edit
 * local product stock directly.
 */

import { ipcMain } from 'electron';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import { apiClient } from '../network/api-client';
import { getSecureAuthToken } from '../config/store';
import { notifyPosRenderers } from '../windows/notify-pos-renderers';
import logger from '../logger';
import {
  IPC_CHANNELS,
  type WarehouseDocument,
  type WarehouseDocumentCreateInput,
  type WarehouseDocumentLineInput,
  type WarehouseDocumentListFilter,
  type WarehouseDocumentUpdateInput,
  type WarehouseInventoryCount,
  type WarehouseInventoryCountCreateInput,
  type WarehouseInventoryCountLineInput,
  type WarehousePrintPayload,
} from '../../shared/types';

type WarehouseIpcResult<T> = {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
};

const BACKEND_UNAVAILABLE = 'Warehouse backend endpoint is not deployed yet';

export class WarehouseModule extends BaseModule {
  readonly name = 'warehouse';

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[WarehouseModule] Initializing...');
    this.setState(ModuleState.READY);
  }

  registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.WAREHOUSE_WAREHOUSES_LIST, async () =>
      this.withAuth('list warehouses', (token) => apiClient.listWarehouses(token)),
    );

    ipcMain.handle(
      IPC_CHANNELS.WAREHOUSE_DOCUMENTS_LIST,
      async (_e, filter?: WarehouseDocumentListFilter) =>
        this.withAuth('list warehouse documents', (token) =>
          apiClient.listWarehouseDocuments(token, filter || {}),
        ),
    );

    ipcMain.handle(IPC_CHANNELS.WAREHOUSE_DOCUMENTS_GET, async (_e, id: string) =>
      this.withAuth('get warehouse document', (token) => apiClient.getWarehouseDocument(token, id)),
    );

    ipcMain.handle(
      IPC_CHANNELS.WAREHOUSE_DOCUMENTS_CREATE,
      async (_e, payload: WarehouseDocumentCreateInput) =>
        this.withAuth('create warehouse document', (token) =>
          apiClient.createWarehouseDocument(token, payload),
        ),
    );

    ipcMain.handle(
      IPC_CHANNELS.WAREHOUSE_DOCUMENTS_UPDATE,
      async (_e, id: string, payload: WarehouseDocumentUpdateInput) =>
        this.withAuth('update warehouse document', (token) =>
          apiClient.updateWarehouseDocument(token, id, payload),
        ),
    );

    ipcMain.handle(
      IPC_CHANNELS.WAREHOUSE_DOCUMENTS_SET_LINES,
      async (_e, id: string, lines: WarehouseDocumentLineInput[]) =>
        this.withAuth('set warehouse document lines', (token) =>
          apiClient.setWarehouseDocumentLines(token, id, lines || []),
        ),
    );

    ipcMain.handle(IPC_CHANNELS.WAREHOUSE_DOCUMENTS_POST, async (_e, id: string) => {
      const result = await this.withAuth<WarehouseDocument>('post warehouse document', (token) =>
        apiClient.postWarehouseDocument(token, id),
      );
      if (result.success) {
        notifyPosRenderers(this.container, IPC_CHANNELS.POS_STOCK_UPDATED, {
          source: 'warehouse',
          document: result.data,
        });
        notifyPosRenderers(this.container, IPC_CHANNELS.POS_PRODUCTS_SYNCED);
      }
      return result;
    });

    ipcMain.handle(
      IPC_CHANNELS.WAREHOUSE_DOCUMENTS_CANCEL,
      async (_e, id: string, reason?: string) =>
        this.withAuth('cancel warehouse document', (token) =>
          apiClient.cancelWarehouseDocument(token, id, reason),
        ),
    );

    ipcMain.handle(IPC_CHANNELS.WAREHOUSE_DOCUMENTS_PRINT, async (_e, id: string) =>
      this.withAuth<WarehousePrintPayload>('get warehouse document print payload', (token) =>
        apiClient.getWarehouseDocumentPrint(token, id),
      ),
    );

    ipcMain.handle(
      IPC_CHANNELS.WAREHOUSE_INVENTORY_CREATE,
      async (_e, payload: WarehouseInventoryCountCreateInput) =>
        this.withAuth('create warehouse inventory count', (token) =>
          apiClient.createWarehouseInventoryCount(token, payload),
        ),
    );

    ipcMain.handle(
      IPC_CHANNELS.WAREHOUSE_INVENTORY_SET_LINES,
      async (_e, id: string, lines: WarehouseInventoryCountLineInput[]) =>
        this.withAuth('set warehouse inventory lines', (token) =>
          apiClient.setWarehouseInventoryLines(token, id, lines || []),
        ),
    );

    ipcMain.handle(IPC_CHANNELS.WAREHOUSE_INVENTORY_RECONCILE, async (_e, id: string) =>
      this.withAuth('reconcile warehouse inventory count', (token) =>
        apiClient.reconcileWarehouseInventory(token, id),
      ),
    );

    ipcMain.handle(IPC_CHANNELS.WAREHOUSE_INVENTORY_POST, async (_e, id: string) => {
      const result = await this.withAuth<WarehouseInventoryCount>('post warehouse inventory count', (token) =>
        apiClient.postWarehouseInventory(token, id),
      );
      if (result.success) {
        notifyPosRenderers(this.container, IPC_CHANNELS.POS_STOCK_UPDATED, {
          source: 'warehouse_inventory',
          inventoryCount: result.data,
        });
        notifyPosRenderers(this.container, IPC_CHANNELS.POS_PRODUCTS_SYNCED);
      }
      return result;
    });

    ipcMain.handle(IPC_CHANNELS.WAREHOUSE_INVENTORY_PRINT, async (_e, id: string) =>
      this.withAuth<WarehousePrintPayload>('get warehouse inventory print payload', (token) =>
        apiClient.getWarehouseInventoryPrint(token, id),
      ),
    );

    logger.info('[WarehouseModule] IPC handlers registered');
  }

  registerEventHandlers(_bus: EventBus): void {
    // No cross-module subscriptions yet.
  }

  async start(): Promise<void> {
    this.setState(ModuleState.RUNNING);
    logger.info('[WarehouseModule] Started');
  }

  async stop(): Promise<void> {
    this.setState(ModuleState.STOPPED);
    logger.info('[WarehouseModule] Stopped');
  }

  async destroy(): Promise<void> {
    this.setState(ModuleState.STOPPED);
  }

  private async withAuth<T>(
    action: string,
    run: (token: string) => Promise<T | null>,
  ): Promise<WarehouseIpcResult<T>> {
    const token = getSecureAuthToken();
    if (!token) {
      return { success: false, error: 'Not authenticated', code: 'NOT_AUTHENTICATED' };
    }

    try {
      const data = await run(token);
      if (data === null) {
        return {
          success: false,
          error: BACKEND_UNAVAILABLE,
          code: 'WAREHOUSE_BACKEND_UNAVAILABLE',
        };
      }
      return { success: true, data };
    } catch (err: any) {
      const message = err?.message || `${action} failed`;
      logger.warn(`[WarehouseModule] ${action} failed: ${message}`);
      return { success: false, error: message };
    }
  }
}
