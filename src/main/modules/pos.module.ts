/**
 * PosModule
 *
 * Owns PosStore, PaymentController, ShiftController, and all POS IPC handlers.
 */

import { ipcMain, dialog, shell, BrowserWindow, app, type IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import { repairOrphanBookings } from '../sync/booking-sync';
import { PosStore } from '../pos/pos-store';
import { PaymentController } from '../pos/payment-controller';
import { buildBackendOrderItem, getLineSaleQuantity, getLineSaleUnit, getLineSellBy, getLineTotalGrosze } from '../pos/order-line-contract';
import { submitSharedReceiptPrint } from '../printing/shared-receipt-printer';
import { getSharedFiscalPrinterStatus, submitSharedFiscalPrint } from '../printing/shared-fiscal-printer';
import { toCashDrawerIpcResult } from '../pos/cash-drawer-ipc-result';
import {
  buildRefundMutationError,
  getRefundBackendResponseSummary,
  mergeRefundLines,
  toRefundBackendPayload,
  validateRefundBackendResponse,
  type RefundBackendValidationResult,
  type RefundIpcPayload,
} from '../pos/refund-backend-payload';
import { ShiftController } from '../pos/shift-controller';
import { toQuickAddVariantRow } from '../pos/quick-add-product';
import { WindowManager } from '../windows/window-manager';
import { productRepo } from '../database/repos/product-repo';
import { draftProductRepo } from '../database/repos/draft-product-repo';
import { draftProductSync } from '../sync/draft-product-sync';
import { localVariantImportsRepo } from '../database/repos/local-variant-imports-repo';
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
import {
  apiClient,
  type NailTurnBoardResponse,
  type ServerOrderListParams,
} from '../network/api-client';
import {
  getConfig,
  getSecureAuthToken,
  getConfigValue,
  setConfigValue,
  getSecureApiKey,
} from '../config/store';
import type {
  ProductAdminCategoryListResponse,
  ProductAdminCategoryMutationInput,
  ProductAdminCategoryMutationResponse,
  ProductAdminCapabilities,
  ProductAdminCreateProductInput,
  ProductAdminDeactivateVariantInput,
  ProductAdminIpcResult,
  ProductAdminProductMutationResponse,
  ProductAdminStockAdjustmentInput,
  ProductAdminStockAdjustmentResponse,
  ProductAdminUpdateVariantInput,
  ProductAdminVariantMutationResponse,
  PosScheduleAssignNextPayload,
  PosScheduleDayResponse,
  PosScheduleRequestStaffPayload,
  PosScheduleStaffStatusPayload,
  SelectedService,
  LiveCustomerDisplayProfile,
} from '../../shared/types';
import { PrinterType, IPC_CHANNELS } from '../../shared/types';
import { resolveCustomerDisplayProfile } from '../../shared/customer-display-profile';
import { seedIfEmpty } from '../database/seed';
import { adaptServerOrder, adaptServerOrderItem, normalizeRefundLinesJson } from '../sync/pos-order-adapter';
import type { SyncLogService } from '../sync/sync-log-service';
import { notifyPosRenderers } from '../windows/notify-pos-renderers';
import {
  writeBookingStatusChanged,
  writeBookingCancelled,
  writeBookingUpdated,
  writeBookingCreated,
  type BookingUpdatePatch,
  type WalkInBookingInput,
} from '../sync/booking-sync';
import logger from '../logger';

function parseOrderPaymentTenders(order: any): Array<{ method: string; amount: number }> {
  if (!order?.payment_tenders) return [];
  try {
    const tenders = JSON.parse(order.payment_tenders);
    if (!Array.isArray(tenders)) return [];
    return tenders.filter((t: any) => typeof t?.method === 'string' && typeof t?.amount === 'number');
  } catch {
    return [];
  }
}

function isSplitPaymentOrder(order: any): boolean {
  return order?.payment_method === 'SPLIT' || parseOrderPaymentTenders(order).length > 1;
}

function normalizeOrderPaymentMethod(method: string | null | undefined): string | null {
  if (!method) return null;
  return method === 'TRANSFER' ? 'BANK_TRANSFER' : method;
}

function orderMatchesPaymentFilter(order: any, paymentMethod?: string): boolean {
  if (!paymentMethod) return true;
  const isSplit = isSplitPaymentOrder(order);
  if (paymentMethod === 'SPLIT') return isSplit;
  if (paymentMethod === 'INVOICE') return Boolean(order?.requires_invoice || order?.customer_nip);
  return !isSplit && normalizeOrderPaymentMethod(order?.payment_method) === normalizeOrderPaymentMethod(paymentMethod);
}

type NailTurnCheckoutGroup = {
  staffId: string;
  staffName: string | null;
  amountGrosze: number;
  tipGrosze: number;
};

function moneyGroszeToPln(grosze: number): number {
  return Math.max(0, Math.round(grosze)) / 100;
}

function positiveGrosze(value: unknown): number {
  const amount = Math.round(Number(value) || 0);
  return amount > 0 ? amount : 0;
}

function getRefundExpectedDeltaCandidates(data: RefundIpcPayload, requestedAmountGrosze: number, order: any): number[] {
  const candidates: number[] = [];
  const lines = data.lines ?? [];
  if (lines.length > 0 && lines.every((line) => typeof line.vatRate === 'number')) {
    const lineGrossTotal = lines.reduce((sum, line) => {
      const vatRate = typeof line.vatRate === 'number' ? line.vatRate : 0;
      return sum + Math.round(line.refundAmount * (1 + Math.max(0, vatRate) / 100));
    }, 0);
    if (lineGrossTotal > 0 && lineGrossTotal !== requestedAmountGrosze) {
      candidates.push(lineGrossTotal);
    }
  }

  const subtotalGrosze = Number(order?.subtotal) || 0;
  const taxGrosze = Number(order?.tax) || 0;
  const netSubtotalGrosze = subtotalGrosze - taxGrosze;
  if (requestedAmountGrosze > 0 && taxGrosze > 0 && netSubtotalGrosze > 0) {
    candidates.push(Math.round(requestedAmountGrosze * (subtotalGrosze / netSubtotalGrosze)));
  }

  return candidates;
}

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
      submitSharedReceiptPrint,
      submitSharedFiscalPrint,
      getSharedFiscalPrinterStatus,
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
      database.markDirty();
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
        const existingShift = database.get<{ id: string; closed_at: string | null }>(
          'SELECT id, closed_at FROM shifts WHERE id = ?',
          [serverShift.id],
        );
        if (!existingShift) {
          database.run(
            `INSERT INTO shifts (id, staff_id, staff_name, opened_at, opening_cash, synced, backend_id)
             VALUES (?, ?, ?, ?, ?, 1, ?)`,
            [
              serverShift.id,
              serverShift.staffId ?? null,
              serverShift.staffName ?? null,
              serverShift.openedAt || new Date().toISOString(),
              Number(serverShift.openingCash) || 0,
              serverShift.id,
            ],
          );
          database.markDirty();
          logger.info(`[PosModule] Materialized server shift ${serverShift.id} in local DB`);
        } else if (existingShift.closed_at) {
          logger.warn(`[PosModule] Server shift ${serverShift.id} is active but local row is closed — payments will stay blocked until shift is closed/reopened`);
        }
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

  private allowCustomerDisplayIpc(
    event: IpcMainInvokeEvent,
    channel: string,
    requiredProfile?: LiveCustomerDisplayProfile,
  ): boolean {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    const customerWin = this.windowManager?.getWindow('customer');
    if (!senderWin || !customerWin || senderWin !== customerWin) {
      logger.warn(`[PosModule] Rejected ${channel} from non-customer window`);
      return false;
    }

    if (requiredProfile) {
      const profile = resolveCustomerDisplayProfile(getConfig());
      if (profile !== requiredProfile) {
        logger.warn(`[PosModule] Rejected ${channel} for profile=${profile}; required=${requiredProfile}`);
        return false;
      }
    }

    return true;
  }

  private buildNailTurnCheckoutGroups(order: any, items: any[]): NailTurnCheckoutGroup[] {
    if (String(order?.mode || '').toLowerCase() !== 'salon') return [];

    const staffedItems = (items || [])
      .map((item: any) => ({
        staffId: String(item?.staff_id || '').trim(),
        staffName: item?.staff_name ? String(item.staff_name) : null,
        totalGrosze: positiveGrosze(item?.total),
      }))
      .filter((item) => item.staffId && item.totalGrosze > 0);
    if (staffedItems.length === 0) return [];

    const grossTotal = staffedItems.reduce((sum, item) => sum + item.totalGrosze, 0);
    const discount = Math.min(positiveGrosze(order?.discount), grossTotal);
    const tip = positiveGrosze(order?.tip);
    const netTotal = Math.max(0, grossTotal - discount);
    const groups = new Map<string, NailTurnCheckoutGroup>();

    let remainingNet = netTotal;
    staffedItems.forEach((item, index) => {
      const netLine = index === staffedItems.length - 1
        ? remainingNet
        : Math.max(0, item.totalGrosze - Math.round((item.totalGrosze / grossTotal) * discount));
      remainingNet = Math.max(0, remainingNet - netLine);

      const group = groups.get(item.staffId) || {
        staffId: item.staffId,
        staffName: item.staffName,
        amountGrosze: 0,
        tipGrosze: 0,
      };
      group.amountGrosze += netLine;
      if (!group.staffName && item.staffName) group.staffName = item.staffName;
      groups.set(item.staffId, group);
    });

    const result = Array.from(groups.values());
    if (tip > 0 && result.length > 0) {
      let remainingTip = tip;
      result.forEach((group, index) => {
        const share = index === result.length - 1
          ? remainingTip
          : netTotal > 0
            ? Math.round(tip * (group.amountGrosze / netTotal))
            : Math.round(tip / result.length);
        group.tipGrosze = Math.max(0, share);
        remainingTip = Math.max(0, remainingTip - group.tipGrosze);
      });
    }

    return result.filter((group) => group.amountGrosze > 0 || group.tipGrosze > 0);
  }

  private resolveNailTurnStaffProfileId(board: NailTurnBoardResponse, staffId: string): string | null {
    const staff = (board.staff || []).find((s: any) => s.staff_profile_id === staffId || s.user_id === staffId);
    return staff?.staff_profile_id || staffId || null;
  }

  private async syncNailTurnCheckoutForOrder(orderId: string, order: any, items: any[]): Promise<void> {
    const groups = this.buildNailTurnCheckoutGroups(order, items);
    if (groups.length === 0) return;

    const token = getSecureAuthToken();
    if (!token) {
      logger.debug(`[PosModule] Nail turn checkout skipped for ${orderId}: no auth token`);
      return;
    }

    const board = await apiClient.getNailTurnBoard(token);
    if (!board) {
      logger.debug(`[PosModule] Nail turn checkout skipped for ${orderId}: board unavailable`);
      return;
    }

    const usedAssignments = new Set<string>();
    let checkedOut = 0;
    for (const group of groups) {
      const staffProfileId = this.resolveNailTurnStaffProfileId(board, group.staffId);
      if (!staffProfileId) continue;

      const assignment = (board.active_assignments || []).find((item: any) =>
        item.staff_profile_id === staffProfileId
        && item.status === 'ASSIGNED'
        && !usedAssignments.has(item.id),
      );
      if (!assignment?.id) {
        logger.warn(
          `[PosModule] Nail turn checkout skipped for order ${orderId}: no active assignment for ${group.staffName || group.staffId}`,
        );
        continue;
      }

      const idempotencyKey = `pos-zira:nail-turn-checkout:${orderId}:${assignment.id}`;
      const result = await apiClient.checkoutNailTurnAssignment(token, assignment.id, {
        amount_pln: moneyGroszeToPln(group.amountGrosze),
        tip_pln: moneyGroszeToPln(group.tipGrosze),
        idempotency_key: idempotencyKey,
      });
      if (!result) {
        logger.debug(`[PosModule] Nail turn checkout unavailable for order ${orderId}, assignment ${assignment.id}`);
        continue;
      }

      checkedOut += 1;
      usedAssignments.add(assignment.id);
      logger.info(
        `[PosModule] Nail turn checked out for order ${orderId}: ${group.staffName || staffProfileId}, amount=${moneyGroszeToPln(group.amountGrosze).toFixed(2)} tip=${moneyGroszeToPln(group.tipGrosze).toFixed(2)}`,
      );
    }

    if (checkedOut > 0) {
      notifyPosRenderers(this.container, 'pos:nail-turns-updated', { orderId, checkedOut });
    }
  }

  private scheduleCacheKey(date?: string | null): string {
    const businessDate = date || new Date().toISOString().slice(0, 10);
    return `pos-schedule:${businessDate}`;
  }

  private saveScheduleCache(schedule: PosScheduleDayResponse): void {
    if (!schedule?.business_date) return;
    const updatedAt = new Date().toISOString();
    database.run(
      `INSERT OR REPLACE INTO pos_schedule_cache
        (cache_key, salon_id, business_date, payload_json, server_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        this.scheduleCacheKey(schedule.business_date),
        schedule.salon?.id ?? null,
        schedule.business_date,
        JSON.stringify(schedule),
        Number(schedule.version || 0),
        updatedAt,
      ],
    );
  }

  private getScheduleCache(date?: string | null): PosScheduleDayResponse | null {
    const row = database.get<{ payload_json: string; updated_at: string }>(
      `SELECT payload_json, updated_at
       FROM pos_schedule_cache
       WHERE cache_key = ?
       LIMIT 1`,
      [this.scheduleCacheKey(date)],
    );
    if (!row?.payload_json) return null;
    try {
      return {
        ...JSON.parse(row.payload_json),
        stale: true,
        cached_at: row.updated_at,
      };
    } catch (e: any) {
      logger.warn(`[PosModule] Failed to read POS schedule cache: ${e?.message ?? e}`);
      return null;
    }
  }

  private async fetchPosScheduleToday(date?: string): Promise<{ schedule: PosScheduleDayResponse; authMode: 'jwt' | 'agent' } | null> {
    const token = getSecureAuthToken();
    if (token) {
      try {
        const schedule = await apiClient.getPosScheduleToday(token, date);
        if (schedule) return { schedule, authMode: 'jwt' };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule JWT fetch failed, trying agent key: ${e?.message ?? e}`);
      }
    }

    const apiKey = getSecureApiKey();
    if (!apiKey) return null;
    const schedule = await apiClient.getPosScheduleTodayWithApiKey(apiKey, date);
    return schedule ? { schedule, authMode: 'agent' } : null;
  }

  private async fetchPosScheduleWeek(from?: string, days = 7): Promise<{ week: any; authMode: 'jwt' | 'agent' } | null> {
    const token = getSecureAuthToken();
    if (token) {
      try {
        const week = await apiClient.getPosScheduleWeek(token, from, days);
        if (week) return { week, authMode: 'jwt' };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule week JWT fetch failed, trying agent key: ${e?.message ?? e}`);
      }
    }

    const apiKey = getSecureApiKey();
    if (!apiKey) return null;
    const week = await apiClient.getPosScheduleWeekWithApiKey(apiKey, from, days);
    return week ? { week, authMode: 'agent' } : null;
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
    ipcMain.handle('display:request-service', (e, serviceId: string) => {
      if (!this.allowCustomerDisplayIpc(e, 'display:request-service', 'salon_checkin')) {
        return { success: false, error: 'display_ipc_not_allowed' };
      }

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
    ipcMain.handle('display:check-in', async (e, data: any) => {
      if (!this.allowCustomerDisplayIpc(e, 'display:check-in', 'salon_checkin')) {
        return { success: false, error: 'display_ipc_not_allowed' };
      }

      const rawData = data && typeof data === 'object' ? data : {};
      const customerName = typeof rawData.customerName === 'string' ? rawData.customerName.trim() : '';
      if (!customerName) return { success: false, error: 'customer_name_required' };

      const services = normalizeSelectedServices(rawData.services);
      const normalizedData = {
        ...rawData,
        customerName,
        services,
        serviceName: rawData.serviceName?.trim() || deriveLegacyServiceName(services),
      };

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
          services_json: services ? JSON.stringify(services) : undefined,
        });

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
        const flush = await database.save();
        if (!flush.success) {
          logger.error('[PosModule] Failed to flush check-in:', flush.error);
          return { success: false, error: 'failed_to_save_check_in' };
        }
      } catch (e) {
        logger.error('[PosModule] Failed to persist check-in:', e);
        return { success: false, error: 'failed_to_save_check_in' };
      }

      this.posStore?.handleCheckIn(normalizedData);

      // Add selected upsells to POS cart
      if (rawData.upsellsAdded?.length && this.posStore) {
        const upsellItems = this.posStore.getState().display?.upsellItems || [];
        for (const upsellId of rawData.upsellsAdded) {
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
      return { success: true, bookingNumber, checkinId };
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
    ipcMain.handle('pos:products:searchByCode', (_e, query: string) => productRepo.searchByCode(query));
    ipcMain.handle('pos:products:getByBarcode', (_e, barcode: string) => productRepo.getByBarcode(barcode));
    ipcMain.handle('pos:products:getById', (_e, id: string) => productRepo.getById(id));
    ipcMain.handle('pos:categories:getAll', () => productRepo.getCategories());

    const emptyProductAdminCapabilities = (): ProductAdminCapabilities => ({
      version: 0,
      canCreateProduct: false,
      canUpdateProduct: false,
      canDeactivateProduct: false,
      canAdjustStock: false,
      canCreateCategory: false,
      canUpdateCategory: false,
      supportsOptimisticConcurrency: false,
    });

    ipcMain.handle(IPC_CHANNELS.POS_PRODUCT_ADMIN_CAPABILITIES, async () => {
      const token = getSecureAuthToken();
      if (!token) {
        return { ok: false, capabilities: emptyProductAdminCapabilities(), error: 'no-auth' };
      }
      try {
        const capabilities = await apiClient.getProductAdminCapabilities(token);
        return { ok: true, capabilities };
      } catch (err: any) {
        logger.debug(`[PosModule] product-admin capabilities unavailable: ${err?.message ?? err}`);
        return {
          ok: false,
          capabilities: emptyProductAdminCapabilities(),
          error: err?.message ?? 'product-admin-unavailable',
        };
      }
    });

    const toProductAdminError = <T>(err: any, fallback: string): ProductAdminIpcResult<T> => ({
      ok: false,
      error: err?.message ?? fallback,
      code: err?.code,
      field: err?.field,
      details: err?.details,
    });

    const refreshProductsAfterProductAdminMutation = async (source: string) => {
      try {
        const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
        await syncMod?.deltaSync?.();
      } catch (syncErr: any) {
        logger.debug(`[PosModule] product-admin post-mutation sync skipped (${source}): ${syncErr?.message ?? syncErr}`);
      }
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_PRODUCTS_SYNCED);
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_CATALOG_UPDATED, { source });
    };

    type ProductAdminCapability = keyof Pick<
      ProductAdminCapabilities,
      | 'canCreateProduct'
      | 'canUpdateProduct'
      | 'canDeactivateProduct'
      | 'canAdjustStock'
      | 'canCreateCategory'
      | 'canUpdateCategory'
    >;

    const withProductAdminCapability = async <T>(
      capability: ProductAdminCapability,
      label: string,
      action: (token: string) => Promise<T>,
      afterSuccess?: (data: T) => Promise<void>,
    ): Promise<ProductAdminIpcResult<T>> => {
      const token = getSecureAuthToken();
      if (!token) return { ok: false, error: 'no-auth', code: 'UNAUTHORIZED_PRODUCT_ADMIN' };
      try {
        const capabilities = await apiClient.getProductAdminCapabilities(token);
        if (capabilities[capability] !== true) {
          return { ok: false, error: 'unsupported-capability', code: 'UNSUPPORTED_CAPABILITY' };
        }
        const data = await action(token);
        if (afterSuccess) await afterSuccess(data);
        return { ok: true, data };
      } catch (err: any) {
        logger.warn(`[PosModule] product-admin ${label} failed: ${err?.message ?? err}`);
        return toProductAdminError<T>(err, `${label}-failed`);
      }
    };

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_CREATE_PRODUCT,
      async (_e, payload: ProductAdminCreateProductInput) => {
        const input = {
          ...(payload || {}),
          idempotencyKey: payload?.idempotencyKey || randomUUID(),
        } as ProductAdminCreateProductInput;
        return withProductAdminCapability<ProductAdminProductMutationResponse>(
          'canCreateProduct',
          'create product',
          (token) => apiClient.createProductVariant(token, input),
          () => refreshProductsAfterProductAdminMutation('product_admin_create'),
        );
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_UPDATE_VARIANT,
      async (_e, variantId: string, payload: ProductAdminUpdateVariantInput) =>
        withProductAdminCapability<ProductAdminVariantMutationResponse>(
          'canUpdateProduct',
          'update variant',
          (token) => apiClient.updateProductVariant(token, variantId, payload || {}),
          () => refreshProductsAfterProductAdminMutation('product_admin_update'),
        ),
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_DEACTIVATE_VARIANT,
      async (_e, variantId: string, payload: ProductAdminDeactivateVariantInput) =>
        withProductAdminCapability<ProductAdminVariantMutationResponse>(
          'canDeactivateProduct',
          'deactivate variant',
          (token) => apiClient.deactivateProductVariant(token, variantId, payload || { reason: '' }),
          () => refreshProductsAfterProductAdminMutation('product_admin_deactivate'),
        ),
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_ADJUST_STOCK,
      async (_e, variantId: string, payload: ProductAdminStockAdjustmentInput) => {
        const input = {
          ...(payload || {}),
          idempotencyKey: payload?.idempotencyKey || randomUUID(),
        } as ProductAdminStockAdjustmentInput;
        return withProductAdminCapability<ProductAdminStockAdjustmentResponse>(
          'canAdjustStock',
          'adjust stock',
          (token) => apiClient.adjustProductStock(token, variantId, input),
          async (data) => {
            await refreshProductsAfterProductAdminMutation('product_admin_stock_adjustment');
            notifyPosRenderers(this.container, IPC_CHANNELS.POS_STOCK_UPDATED, {
              source: 'product_admin',
              adjustment: data.adjustment,
              variant: data.variant,
            });
          },
        );
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_CATEGORIES_LIST,
      async () => {
        const token = getSecureAuthToken();
        if (!token) {
          return { ok: false, error: 'no-auth', code: 'UNAUTHORIZED_PRODUCT_ADMIN' } as ProductAdminIpcResult<ProductAdminCategoryListResponse>;
        }
        try {
          const capabilities = await apiClient.getProductAdminCapabilities(token);
          if (!capabilities.canCreateCategory && !capabilities.canUpdateCategory) {
            return { ok: false, error: 'unsupported-capability', code: 'UNSUPPORTED_CAPABILITY' } as ProductAdminIpcResult<ProductAdminCategoryListResponse>;
          }
          const data = await apiClient.listProductAdminCategories(token);
          return { ok: true, data } as ProductAdminIpcResult<ProductAdminCategoryListResponse>;
        } catch (err: any) {
          logger.warn(`[PosModule] product-admin list categories failed: ${err?.message ?? err}`);
          return toProductAdminError<ProductAdminCategoryListResponse>(err, 'list categories failed');
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_CATEGORIES_CREATE,
      async (_e, payload: ProductAdminCategoryMutationInput) => {
        const input = {
          ...(payload || {}),
          idempotencyKey: payload?.idempotencyKey || randomUUID(),
        } as ProductAdminCategoryMutationInput;
        return withProductAdminCapability<ProductAdminCategoryMutationResponse>(
          'canCreateCategory',
          'create category',
          (token) => apiClient.createProductAdminCategory(token, input),
          () => refreshProductsAfterProductAdminMutation('product_admin_category_create'),
        );
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_CATEGORIES_UPDATE,
      async (_e, categoryId: string, payload: ProductAdminCategoryMutationInput) =>
        withProductAdminCapability<ProductAdminCategoryMutationResponse>(
          'canUpdateCategory',
          'update category',
          (token) => apiClient.updateProductAdminCategory(token, categoryId, payload || {}),
          () => refreshProductsAfterProductAdminMutation('product_admin_category_update'),
        ),
    );

    // Draft products (server-mirrored, see DraftProductSync)
    ipcMain.handle('pos:draft-products:getAll', (_e, limit?: number) => draftProductRepo.getAll(limit));
    ipcMain.handle('pos:draft-products:getByStatus', (_e, status: string) => draftProductRepo.getByStatus(status));
    ipcMain.handle('pos:draft-products:getByBarcode', (_e, barcode: string) => draftProductRepo.getByBarcode(barcode));
    ipcMain.handle('pos:draft-products:getById', (_e, id: string) => draftProductRepo.getById(id));
    ipcMain.handle('pos:draft-products:searchByCode', (_e, query: string) => draftProductRepo.searchByCode(query));

    // Local-first import: materialize a draft into product_variants without
    // a server roundtrip so the cashier can sell immediately even when the
    // master-catalog endpoint is down. A `local_variant_imports` marker
    // tracks the row so ProductSync.deactivateExcept keeps it alive and
    // OrderSync defers pushing orders that depend on it.
    ipcMain.handle('pos:master-catalog:import-draft', async (_e, payload: { ean: string }) => {
      const ean = String(payload?.ean ?? '').trim();
      if (!ean) return { ok: false, error: 'missing-ean' };

      const existing = productRepo.getByBarcode(ean);
      if (existing) {
        return { ok: true, outcome: 'EXISTING_VARIANT', variant: existing };
      }

      let draft = draftProductRepo.getByBarcode(ean);
      if (!draft) {
        try {
          const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
          await syncMod?.deltaSync?.();
          const syncedExisting = productRepo.getByBarcode(ean);
          if (syncedExisting) {
            return { ok: true, outcome: 'EXISTING_VARIANT', variant: syncedExisting };
          }
        } catch (syncErr: any) {
          logger.debug(`[PosModule] product sync before draft import skipped: ${syncErr?.message ?? syncErr}`);
        }
        try {
          await draftProductSync.deltaSync();
          draft = draftProductRepo.getByBarcode(ean);
        } catch (syncErr: any) {
          logger.debug(`[PosModule] draft sync before import skipped: ${syncErr?.message ?? syncErr}`);
        }
      }
      if (!draft) return { ok: false, error: 'draft-not-found' };
      if (!(draft.retail_price >= 1)) {
        return { ok: false, error: 'draft-missing-price' };
      }
      if (!(draft.in_stock >= 1)) {
        return { ok: false, error: 'draft-missing-stock' };
      }

      try {
        // Reuse the draft's UUID as the variant id. Clean lineage — when
        // the server eventually creates its own variant for this draft we
        // can match on id (or treat it as an upsert via delta sync).
        const variantId = draft.id;
        const now = new Date().toISOString();

        database.transaction(() => {
          productRepo.upsertMany([{
            id: variantId,
            template_id: null,
            name: draft.name,
            sku: draft.sku,
            barcode: draft.barcode,
            retail_price: draft.retail_price,
            category_id: draft.category_id,
            image_url: draft.image_url,
            in_stock: draft.in_stock,
            vat_rate: draft.vat_rate,
            is_active: 1,
            updated_at: now,
            available_qty: draft.in_stock,
            price_gross: draft.retail_price,
            price_net: Math.round(draft.retail_price * 100 / (100 + (draft.vat_rate || 0))),
            vat_amount: draft.retail_price - Math.round(draft.retail_price * 100 / (100 + (draft.vat_rate || 0))),
            is_on_sale: 0,
            thumbnail_url: draft.image_url,
            sale_unit: null,
            sell_by: 'PIECE',
            name_translations: null,
          }]);
          localVariantImportsRepo.create(variantId, draft.id, ean);
        });
        database.markDirty();

        logger.info(`[PosModule] Local import: draft ${draft.id} → variant ${variantId} (ean=${ean})`);
        notifyPosRenderers(this.container, 'pos:products-synced');
        const variant = productRepo.getById(variantId);
        let syncPending = true;
        try {
          const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
          const reconciled = await syncMod?.reconcileLocalVariantImports?.(1);
          if (reconciled > 0) {
            syncPending = false;
            await syncMod?.deltaSync?.();
            notifyPosRenderers(this.container, 'pos:products-synced');
          }
        } catch (syncErr: any) {
          logger.debug(`[PosModule] immediate online draft import skipped: ${syncErr?.message ?? syncErr}`);
        }
        return { ok: true, outcome: 'LOCAL_IMPORT', variant, syncPending };
      } catch (err: any) {
        logger.error(`[PosModule] Local draft import failed for ean=${ean}: ${err?.message ?? err}`);
        return { ok: false, error: err?.message ?? 'local-import-failed' };
      }
    });

    // Master catalog one-shot API (lookup + scan-create)
    ipcMain.handle('pos:master-catalog:lookup-by-ean', async (_e, ean: string) => {
      const token = getSecureAuthToken();
      try {
        const draft = await apiClient.lookupByEan(token, ean);
        return { ok: true, draft };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? 'lookup-failed', draft: null };
      }
    });
    ipcMain.handle(
      'pos:master-catalog:scan-create',
      async (_e, payload: {
        ean: string;
        purchasePrice?: number;
        retailPrice?: number;
        stockQty?: number;
        taxRate?: number;
        warehouseId?: string;
        idempotencyKey?: string;
      }) => {
        const token = getSecureAuthToken();
        logger.info(`[PosModule] scan-create requested ean=${payload?.ean} stockQty=${payload?.stockQty ?? 'n/a'} idk=${payload?.idempotencyKey ?? 'n/a'}`);
        try {
          const result = await apiClient.scanCreate(token, payload);
          logger.info(`[PosModule] scan-create OK outcome=${result?.outcome} productId=${result?.productId ?? result?.product?.id ?? 'n/a'} variantId=${result?.variantId ?? result?.variant?.id ?? 'n/a'}`);
          // Pull fresh products + drafts so renderer can see the new variant.
          try {
            const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
            await syncMod?.deltaSync?.();
          } catch (syncErr: any) {
            logger.debug(`[PosModule] post-scan-create product sync skipped: ${syncErr?.message ?? syncErr}`);
          }
          try { await draftProductSync.deltaSync(); }
          catch (syncErr: any) { logger.debug(`[PosModule] post-scan-create draft sync skipped: ${syncErr?.message ?? syncErr}`); }
          return { ok: true, ...result };
        } catch (err: any) {
          logger.error(`[PosModule] scan-create FAILED ean=${payload?.ean}: ${err?.message ?? err}`);
          if (err?.serverBody) {
            logger.error(`[PosModule] scan-create server body: ${JSON.stringify(err.serverBody).slice(0, 800)}`);
          }
          return { ok: false, error: err?.message ?? 'scan-create-failed' };
        }
      },
    );

    // Absolute file:// path to the webview bridge preload, for the embedded
    // /add page panel. Computed in main (the sandboxed renderer/preload cannot
    // use `path`). dist layout: this module = dist/main/modules, preload =
    // dist/preload/addbridge-preload.js.
    ipcMain.handle('app:addbridge-preload-path', () => {
      return pathToFileURL(path.join(__dirname, '../../preload/addbridge-preload.js')).href;
    });

    // Pure recognition preview (reusable backend module). Returns structured
    // products[] (type/name/quantity/ean) for the cashier to eyeball BEFORE
    // the existing quick-add create/finalize flow runs. Does not touch stock.
    ipcMain.handle(
      'pos:recognition:analyze',
      async (_e, payload: { images: Array<{ dataUrl?: string; url?: string; mimeType?: string }>; language?: string }) => {
        try {
          if (!Array.isArray(payload?.images) || payload.images.length < 1 || payload.images.length > 5) {
            return { ok: false, error: 'Capture 1 to 5 images before recognizing' };
          }
          const result = await apiClient.recognizeProducts(payload.images, payload.language || 'vi');
          return result?.ok === false
            ? { ok: false, error: result.error || 'recognition-failed' }
            : { ok: true, products: result?.products ?? [], language: result?.language };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? 'recognition-failed' };
        }
      },
    );

    ipcMain.handle(
      'pos:quick-add:prepare',
      async (_e, payload: { images: Array<{ dataUrl: string; mimeType?: string }>; language?: string; idempotencyKey?: string }) => {
        try {
          if (!Array.isArray(payload.images) || payload.images.length < 2 || payload.images.length > 3) {
            return { ok: false, error: 'Capture 2 or 3 images before sending' };
          }
          const token = getSecureAuthToken();
          if (!token) return { ok: false, error: 'no-auth' };

          const uploadedImages = await Promise.all(
            payload.images.map((image, index) =>
              apiClient.quickAddUploadImage(token, {
                dataUrl: image.dataUrl,
                mimeType: image.mimeType || 'image/jpeg',
                filename: `quick-add-${Date.now()}-${index + 1}.jpg`,
              }),
            ),
          );
          const images = uploadedImages.map((image, index) => ({
            url: image.url,
            mimeType: payload.images[index]?.mimeType || 'image/jpeg',
          }));
          const rawAnalysis = await apiClient.quickAddAnalyzeMultiple(token, images, payload.language || 'pl');
          const analysis = normalizeQuickAddAnalysis(rawAnalysis);
          if (!analysis.name) {
            analysis.name = fallbackQuickAddName(analysis);
            analysis.nameNeedsReview = true;
          }

          const createPayload: Record<string, unknown> = {
            name: analysis.name,
            imageUrl: images[0]?.url,
          };
          if (analysis.ean) createPayload.ean = analysis.ean;
          if (analysis.weight != null) createPayload.weight = analysis.weight;
          if (analysis.weightUnit) createPayload.weightUnit = analysis.weightUnit;

          const created = await apiClient.quickAddCreate(token, createPayload, payload.idempotencyKey);
          return {
            ok: true,
            images,
            analysis,
            product: created.product ?? null,
            variant: created.variant ?? null,
          };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? 'quick-add-prepare-failed' };
        }
      },
    );

    ipcMain.handle(
      'pos:quick-add:finalize',
      async (_e, payload: { productId: string; variantId: string; name?: string; retailPrice: number; quantity: number; idempotencyKey?: string }) => {
        try {
          if (!payload.productId || !payload.variantId) return { ok: false, error: 'Missing product or variant id' };
          if (!payload.name?.trim()) return { ok: false, error: 'Product name is required' };
          if (!(payload.retailPrice > 0)) return { ok: false, error: 'Retail price must be greater than zero' };
          if (!(payload.quantity > 0)) return { ok: false, error: 'Quantity must be greater than zero' };
          const token = getSecureAuthToken();
          if (!token) return { ok: false, error: 'no-auth' };

          const finalName = payload.name.trim();
          const result = await apiClient.quickAddCreate(token, {
            productId: payload.productId,
            variantId: payload.variantId,
            name: finalName,
            retailPrice: payload.retailPrice,
            quantity: payload.quantity,
          }, payload.idempotencyKey);

          const productForLocal = {
            ...(result.product ?? {}),
            id: result.product?.id ?? payload.productId,
            name: finalName,
          };
          const variantForLocal = result.variant
            ? { ...result.variant, name: finalName }
            : result.variant;
          const localVariant = toQuickAddVariantRow(productForLocal, variantForLocal, {
            retailPriceGrosze: Math.round(payload.retailPrice * 100),
            quantity: payload.quantity,
          });
          if (localVariant) {
            productRepo.upsertMany([localVariant]);
            database.markDirty();
            notifyPosRenderers(this.container, 'pos:products-synced');
          }

          let syncPending = false;
          try {
            const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
            await syncMod?.deltaSync?.();
            notifyPosRenderers(this.container, 'pos:products-synced');
          } catch (syncErr: any) {
            syncPending = true;
            logger.debug(`[PosModule] post-quick-add product sync skipped: ${syncErr?.message ?? syncErr}`);
          }

          return {
            ok: true,
            product: result.product ?? null,
            variant: localVariant ?? result.variant ?? null,
            syncPending,
          };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? 'quick-add-finalize-failed' };
        }
      },
    );

    // Orders
    ipcMain.handle('pos:orders:create', (_e, order, items) => {
      try {
        const normalizedOrder = { ...(order || {}) };
        const isPosOrder = (normalizedOrder.source ?? 'POS') === 'POS';
        if (isPosOrder) {
          const activeShift = database.get<{ id: string; staff_id: string | null; staff_name: string | null }>(
            'SELECT id, staff_id, staff_name FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1',
          );
          const staffMissing = !String(normalizedOrder.staff_name || '').trim();
          const staffIdMissing = !String(normalizedOrder.staff_id || '').trim();
          const shiftMissing = !normalizedOrder.shift_id;
          if (activeShift && (staffMissing || shiftMissing || staffIdMissing)) {
            normalizedOrder.shift_id = activeShift.id;
            normalizedOrder.staff_id = activeShift.staff_id;
            normalizedOrder.staff_name = activeShift.staff_name;
          }
          const requestedShiftId = String(normalizedOrder.shift_id || '').trim();
          if (!requestedShiftId || !String(normalizedOrder.staff_id || '').trim() || !String(normalizedOrder.staff_name || '').trim()) {
            return {
              success: false,
              error: 'Cannot create POS order without an active shift staff. Close and reopen the shift before payment.',
            };
          }
          const orderShift = database.get<{ id: string; staff_id: string | null; staff_name: string | null }>(
            'SELECT id, staff_id, staff_name FROM shifts WHERE id = ? AND closed_at IS NULL',
            [requestedShiftId],
          );
          if (!orderShift) {
            return {
              success: false,
              error: 'Cannot create POS order without a local active shift. Close and reopen the shift before payment.',
            };
          }
          if (!String(orderShift.staff_id || '').trim() || !String(orderShift.staff_name || '').trim()) {
            return {
              success: false,
              error: 'Cannot create POS order without an active shift staff. Close and reopen the shift before payment.',
            };
          }
          normalizedOrder.shift_id = orderShift.id;
          normalizedOrder.staff_id = orderShift.staff_id;
          normalizedOrder.staff_name = orderShift.staff_name;
        }

        const normalizedItems = (items || []).map((item: any) => {
          const product = item.variant_id ? productRepo.getById(item.variant_id) : null;
          const sell_by = getLineSellBy({
            ...item,
            sell_by: item.sell_by ?? item.sellBy ?? product?.sell_by ?? 'PIECE',
          });
          const sale_quantity = getLineSaleQuantity({ ...item, sell_by });
          const sale_unit = getLineSaleUnit({
            ...item,
            sell_by,
            sale_unit: item.sale_unit ?? item.saleUnit ?? product?.sale_unit ?? null,
          });
          const price = Math.max(0, Math.round(Number(item.price) || 0));
          return {
            ...item,
            price,
            quantity: sale_quantity,
            sale_quantity,
            sale_unit,
            sell_by,
            total: getLineTotalGrosze({ ...item, price, quantity: sale_quantity, sale_quantity, sell_by }),
          };
        });

        const id = orderRepo.create(normalizedOrder, normalizedItems);
        let stockChanged = false;
        for (const item of normalizedItems) {
          if (item.variant_id && item.quantity > 0) {
            productRepo.decrementStock(item.variant_id, item.quantity);
            stockChanged = true;
          }
        }
        database.markDirty();
        if (stockChanged) {
          notifyPosRenderers(this.container, 'pos:products-synced');
        }

        // Path B: write to sync log for outbound push
        try {
          const syncLog = this.container.getOptional<SyncLogService>(SERVICE_TOKENS.SYNC_LOG_SERVICE);
          if (syncLog) {
            const PM: Record<string, string> = { CASH: 'CASH', CARD: 'CARD', BLIK: 'BLIK', TRANSFER: 'BANK_TRANSFER', BANK_TRANSFER: 'BANK_TRANSFER', CREDIT: 'CREDIT', INVOICE: 'BANK_TRANSFER' };
            const dto: Record<string, any> = {
              id,
              priceType: 'brutto',
              requiresInvoice: !!normalizedOrder.customer_nip,
              items: (normalizedItems || []).filter((i: any) => i.variant_id || i.id).map((i: any) => buildBackendOrderItem(i)),
            };
            if (normalizedOrder.payment_tenders) {
              try {
                const tenders = JSON.parse(normalizedOrder.payment_tenders) as Array<{ method: string; amount: number }>;
                if (tenders.length > 0) dto.tenders = tenders.map((t: any) => ({ method: PM[t.method] || t.method, amount: t.amount / 100 }));
              } catch { /* single method fallback below */ }
            }
            if (normalizedOrder.payment_method) dto.paymentMethod = PM[normalizedOrder.payment_method] || 'CASH';
            if (normalizedOrder.staff_id) dto.staffId = normalizedOrder.staff_id;
            if (normalizedOrder.staff_name) dto.staffName = normalizedOrder.staff_name;
            if (normalizedOrder.shift_id) dto.shiftId = normalizedOrder.shift_id;
            if (normalizedOrder.customer_id) dto.customerId = normalizedOrder.customer_id;
            if (normalizedOrder.customer_nip) dto.customerNip = normalizedOrder.customer_nip;
            if (normalizedOrder.customer_name) dto.customerName = normalizedOrder.customer_name;
            if (normalizedOrder.source) dto.source = normalizedOrder.source;
            if (normalizedOrder.order_type) dto.orderType = normalizedOrder.order_type;
            if (normalizedOrder.mode) dto.mode = normalizedOrder.mode;
            if (normalizedOrder.discount > 0) dto.discountAmount = normalizedOrder.discount / 100;
            if (normalizedOrder.payment_amount > 0) dto.paymentAmount = normalizedOrder.payment_amount / 100;
            if (normalizedOrder.change_amount > 0) dto.changeAmount = normalizedOrder.change_amount / 100;
            if (normalizedOrder.tip && normalizedOrder.tip > 0) dto.tip = normalizedOrder.tip / 100;
            syncLog.writeLocalEntry('order', id, 'created', dto);
            }
          } catch (e) { logger.debug('[PosModule] Sync log write failed for order:', e); }

          this.syncNailTurnCheckoutForOrder(id, normalizedOrder, normalizedItems).catch((e: any) => {
            logger.warn(`[PosModule] Nail turn checkout sync failed for order ${id}: ${e?.message ?? e}`);
          });

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
      if (filters.paymentMethod) orders = orders.filter(o => orderMatchesPaymentFilter(o, filters.paymentMethod));
      if (filters.staffName) {
        const staffNeedle = filters.staffName.trim().toLowerCase();
        orders = orders.filter(o => (o.staff_name || '').toLowerCase().includes(staffNeedle));
      }
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

    ipcMain.handle('pos:orders:deleteLocal', (_e, orderId: string) => {
      try {
        const result = orderRepo.deleteLocalUnsynced(orderId);
        if (!result.deleted) return { success: false, error: 'Order not found' };
        if (result.restocked > 0) {
          notifyPosRenderers(this.container, 'pos:products-synced');
        }
        return { success: true, restocked: result.restocked };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('pos:orders:mutate', async (_e, orderId: string, data: any) => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        const mutationId = data?.mutationId || randomUUID();

        if (!order.backend_id && order.synced !== 1) {
          if (data?.type === 'void') {
            const result = orderRepo.deleteLocalUnsynced(orderId);
            if (result.restocked > 0) notifyPosRenderers(this.container, 'pos:products-synced');
            return { success: result.deleted, restocked: result.restocked };
          }
          const result = orderRepo.updateLocalUnsynced(orderId, {
            paymentMethod: data?.paymentMethod,
            paymentAmount: data?.paymentAmount,
            changeAmount: data?.changeAmount,
            items: data?.items,
          });
          if (result.stockChanged) notifyPosRenderers(this.container, 'pos:products-synced');
          return { success: result.updated, localOnly: true };
        }

        if (!order.backend_id) return { success: false, error: 'Synced order is missing backend_id' };
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        const basePayload = {
          mutationId,
          expectedVersion: data?.expectedVersion,
          reason: data?.reason,
          terminalId: getConfigValue('agentId') || 'pos-device',
          clientTimestamp: new Date().toISOString(),
        };
        let response: any | null = null;

        if (data?.type === 'payment') {
          response = await apiClient.updateOrderPayment(token, order.backend_id, {
            ...basePayload,
            paymentMethod: data.paymentMethod,
            paidAmount: (Number(data.paymentAmount) || 0) / 100,
            changeAmount: (Number(data.changeAmount) || 0) / 100,
            tenders: [{ method: data.paymentMethod, amount: (Number(data.paymentAmount) || 0) / 100 }],
          });
        } else if (data?.type === 'items') {
          response = await apiClient.updateOrder(token, order.backend_id, {
            ...basePayload,
            items: (data.items || []).map((item: any) => ({
              orderItemId: item.id,
              variantId: item.variant_id,
              sku: item.sku,
              quantity: item.quantity,
              unitPrice: (Number(item.price) || 0) / 100,
              taxRate: item.vat_rate,
            })),
            paymentMethod: data.paymentMethod ?? order.payment_method,
            paidAmount: (Number(data.paymentAmount ?? order.payment_amount) || 0) / 100,
            changeAmount: (Number(data.changeAmount ?? order.change_amount) || 0) / 100,
          });
        } else if (data?.type === 'void') {
          response = await apiClient.voidOrder(token, order.backend_id, {
            ...basePayload,
            restock: data?.restock !== false,
          });
        } else {
          return { success: false, error: 'Unknown order mutation type' };
        }

        if (response === null) {
          return {
            success: false,
            error: 'Backend does not support this order history mutation yet. Server endpoints from the SCR must be deployed first.',
          };
        }

        const canonical = response.order ?? response;
        if (data?.type === 'payment') {
          database.run(
            'UPDATE orders SET payment_method = ?, payment_amount = ?, change_amount = ?, payment_tenders = ? WHERE id = ?',
            [
              canonical.paymentMethod ?? data.paymentMethod,
              Math.round(Number(canonical.paidAmount ?? data.paymentAmount / 100) * 100),
              Math.round(Number(canonical.changeAmount ?? data.changeAmount / 100) * 100),
              JSON.stringify([{ method: canonical.paymentMethod ?? data.paymentMethod, amount: Math.round(Number(canonical.paidAmount ?? data.paymentAmount / 100) * 100) }]),
              orderId,
            ],
          );
        } else if (data?.type === 'void') {
          database.run("UPDATE orders SET status = 'CANCELLED' WHERE id = ?", [orderId]);
        }
        database.markDirty();
        return { success: true, order: canonical, mutation: response.mutation ?? null };
      } catch (e: any) {
        logger.error(`[PosModule] Order mutation failed for ${orderId}: ${e.message}`);
        return { success: false, error: e.message };
      }
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

    // Nail turn board (backend-driven module; dark-launch safe)
    ipcMain.handle('pos:nail-turns:getToday', async () => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, unavailable: true, error: 'not_authenticated' };
        const board = await apiClient.getNailTurnBoard(token);
        if (!board) return { success: false, unavailable: true, error: 'nail_turns_unavailable' };
        return { success: true, board };
      } catch (e: any) {
        logger.warn(`[PosModule] Nail turn board fetch failed: ${e?.message ?? e}`);
        return { success: false, unavailable: true, error: e?.message ?? 'nail_turns_failed' };
      }
    });

    ipcMain.handle('pos:schedule:getToday', async (_e, date?: string) => {
      try {
        const result = await this.fetchPosScheduleToday(date);
        if (!result) {
          const cached = this.getScheduleCache(date);
          if (cached) return { success: true, schedule: cached, stale: true };
          return { success: false, unavailable: true, error: 'schedule_unavailable' };
        }
        const { schedule, authMode } = result;
        this.saveScheduleCache(schedule);
        logger.info(`[PosModule] POS schedule loaded for ${schedule.business_date}: staff=${schedule.staff?.length ?? 0} bookings=${schedule.bookings?.length ?? 0} auth=${authMode}`);
        return { success: true, schedule };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule fetch failed: ${e?.message ?? e}`);
        const cached = this.getScheduleCache(date);
        if (cached) return { success: true, schedule: cached, stale: true };
        return { success: false, unavailable: true, error: e?.message ?? 'schedule_failed' };
      }
    });

    ipcMain.handle('pos:schedule:getWeek', async (_e, from?: string, days?: number) => {
      try {
        const result = await this.fetchPosScheduleWeek(from, days || 7);
        if (!result) return { success: false, unavailable: true, error: 'schedule_unavailable' };
        const { week, authMode } = result;
        for (const schedule of week.schedules || []) {
          this.saveScheduleCache(schedule);
        }
        logger.info(`[PosModule] POS schedule week loaded from ${week.from}: days=${week.days} auth=${authMode}`);
        return { success: true, week };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule week fetch failed: ${e?.message ?? e}`);
        return { success: false, unavailable: true, error: e?.message ?? 'schedule_week_failed' };
      }
    });

    ipcMain.handle('pos:schedule:setStaffStatus', async (_e, payload: PosScheduleStaffStatusPayload) => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, unavailable: true, error: 'not_authenticated' };
        if (!payload?.staffProfileId || !payload.status) {
          return { success: false, error: 'invalid_staff_status_payload' };
        }
        const schedule = await apiClient.setPosScheduleStaffStatus(
          token,
          payload.staffProfileId,
          payload.status,
          payload.idempotencyKey,
        );
        if (!schedule) return { success: false, unavailable: true, error: 'schedule_unavailable' };
        this.saveScheduleCache(schedule);
        logger.info(`[PosModule] POS schedule staff status updated: staff=${payload.staffProfileId} status=${payload.status}`);
        return { success: true, schedule };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule staff status update failed: ${e?.message ?? e}`);
        return { success: false, error: e?.message ?? 'schedule_staff_status_failed' };
      }
    });

    ipcMain.handle('pos:schedule:assignNext', async (_e, payload: PosScheduleAssignNextPayload) => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, unavailable: true, error: 'not_authenticated' };
        if (!payload?.checkinLogId) return { success: false, error: 'invalid_assign_next_payload' };
        const schedule = await apiClient.assignPosScheduleNext(token, payload.checkinLogId, payload);
        if (!schedule) return { success: false, unavailable: true, error: 'schedule_unavailable' };
        this.saveScheduleCache(schedule);
        logger.info(`[PosModule] POS schedule assign-next completed: checkin=${payload.checkinLogId}`);
        return { success: true, schedule };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule assign-next failed: ${e?.message ?? e}`);
        return { success: false, error: e?.message ?? 'schedule_assign_next_failed' };
      }
    });

    ipcMain.handle('pos:schedule:requestStaff', async (_e, payload: PosScheduleRequestStaffPayload) => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, unavailable: true, error: 'not_authenticated' };
        if (!payload?.checkinLogId || !payload.staffProfileId) {
          return { success: false, error: 'invalid_request_staff_payload' };
        }
        const schedule = await apiClient.requestPosScheduleStaff(token, payload.checkinLogId, payload);
        if (!schedule) return { success: false, unavailable: true, error: 'schedule_unavailable' };
        this.saveScheduleCache(schedule);
        logger.info(`[PosModule] POS schedule request-staff completed: checkin=${payload.checkinLogId} staff=${payload.staffProfileId}`);
        return { success: true, schedule };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule request-staff failed: ${e?.message ?? e}`);
        return { success: false, error: e?.message ?? 'schedule_request_staff_failed' };
      }
    });

    // Hold orders
    ipcMain.handle('pos:hold:create', (_e, id: string, title: string, payload: any) => {
      try { holdOrderRepo.create(id, title, payload); holdOrderRepo.prune(); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:hold:list', () => holdOrderRepo.list());
    ipcMain.handle('pos:hold:get', (_e, id: string) => holdOrderRepo.get(id));
    ipcMain.handle('pos:hold:remove', (_e, id: string) => { holdOrderRepo.remove(id); database.markDirty(); return { success: true }; });

    // Quick keys
    ipcMain.handle('pos:quickkeys:list', (_e, mode?: string) => quickKeyLayoutRepo.list(mode));
    ipcMain.handle('pos:quickkeys:get', (_e, id: string) => quickKeyLayoutRepo.get(id));
    ipcMain.handle('pos:quickkeys:create', (_e, id: string, data: any) => {
      try { quickKeyLayoutRepo.create(id, data); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:quickkeys:update', (_e, id: string, data: any) => {
      try { quickKeyLayoutRepo.update(id, data); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:quickkeys:remove', (_e, id: string) => { quickKeyLayoutRepo.remove(id); database.markDirty(); return { success: true }; });
    ipcMain.handle('pos:quickkeys:assign', (_e, regId: string, mode: string, layoutId: string) => {
      try { quickKeyLayoutRepo.assign(regId, mode, layoutId); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:quickkeys:getAssigned', (_e, regId: string, mode: string) => quickKeyLayoutRepo.getAssigned(regId, mode));

    // Checkin
    ipcMain.handle('checkin:getToday', () => checkinRepo.getToday());
    ipcMain.handle('checkin:getByDate', (_e, date: string) => checkinRepo.getByDate(date));
    ipcMain.handle('checkin:create', (_e, data: any) => {
      try { checkinRepo.create(data); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:updateStatus', (_e, id: string, status: string) => {
      try { checkinRepo.updateStatus(id, status); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:startService', (_e, id: string) => {
      try { checkinRepo.startService(id); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:complete', (_e, id: string) => {
      try { checkinRepo.complete(id); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:markNoShow', (_e, id: string) => {
      try { checkinRepo.markNoShow(id); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:searchPhone', (_e, phone: string) => checkinRepo.searchByPhone(phone));
    ipcMain.handle('checkin:addUpsells', (_e, id: string, upsells: string[]) => {
      try { checkinRepo.addUpsells(id, JSON.stringify(upsells)); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:updateNotes', (_e, id: string, notes: string) => {
      try { checkinRepo.updateNotes(id, notes); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:getStats', (_e, date?: string) => checkinRepo.getStats(date));

    // Customer display: phone search
    ipcMain.handle('display:search-by-phone', (e, phone: string) => {
      if (!this.allowCustomerDisplayIpc(e, 'display:search-by-phone', 'salon_checkin')) {
        return { customers: [], bookings: [], error: 'display_ipc_not_allowed' };
      }

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

    ipcMain.handle('pos:print-receipt-and-open-drawer', async (_e, orderId: string) => {
      try {
        const result = await this.paymentController?.printReceiptAndOpenDrawer(orderId);
        return {
          success: true,
          receiptPrinted: result?.receiptPrinted ?? false,
          drawerOpened: result?.drawerOpened ?? false,
          error: result?.error,
        };
      } catch (e: any) {
        return { success: false, receiptPrinted: false, drawerOpened: false, error: e.message };
      }
    });

    ipcMain.handle('pos:print-fiscal-receipt', async (_e, orderId: string) => {
      try { const printed = await this.paymentController?.printFiscalReceipt(orderId); return { success: true, fiscalPrinted: printed ?? false }; }
      catch (e: any) { return { success: false, fiscalPrinted: false, error: e.message }; }
    });

    ipcMain.handle('pos:has-fiscal-printer', async () => {
      const status = await (this.paymentController?.hasFiscalPrinter?.() ?? Promise.resolve({ configured: false, connected: false }));
      return { success: true, ...status };
    });

    ipcMain.handle('pos:reprint-receipt', async (_e, orderId: string) => {
      try { const printed = await this.paymentController?.reprintReceipt(orderId); return { success: true, receiptPrinted: printed ?? false }; }
      catch (e: any) { return { success: false, receiptPrinted: false, error: e.message }; }
    });

    ipcMain.handle('pos:print-refund-receipt', async (_e, orderId: string) => {
      try { const printed = await this.paymentController?.printRefundReceipt(orderId); return { success: true, receiptPrinted: printed ?? false }; }
      catch (e: any) { return { success: false, receiptPrinted: false, error: e.message }; }
    });

    ipcMain.handle('pos:orders:refund', async (_e, orderId: string, data: RefundIpcPayload) => {
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
          vatRate: l.vatRate,
        }));

        const backendPayload = toRefundBackendPayload(data);
        const alreadyRefundedGrosze = order.refund_amount ?? 0;
        const requestedAmountGrosze = data.type === 'FULL'
          ? order.total - alreadyRefundedGrosze
          : data.amount ?? (data.lines ?? []).reduce((sum, l) => sum + l.refundAmount, 0);
        if (requestedAmountGrosze <= 0) {
          return { success: false, error: 'No refundable amount remains for this order' };
        }
        if (alreadyRefundedGrosze + requestedAmountGrosze > order.total) {
          return { success: false, error: `Refund would exceed order total (${order.total} grosze). Already refunded: ${alreadyRefundedGrosze}` };
        }
        const hasLineRefund = (data.lines ?? []).length > 0;
        const hasRestock = (data.lines ?? []).some(l => l.restock);

        logger.info(`[PosModule] Refund ${order.order_number}: ${data.type}, ${lines.length} lines, payload=${JSON.stringify(backendPayload).substring(0, 300)}`);

        const result = await apiClient.refundOrder(token, order.backend_id, backendPayload);
        if (result === null) return { success: false, error: 'Refund endpoint not available' };

        const summary = getRefundBackendResponseSummary(result);
        logger.info(
          `[PosModule] Refund backend response ${order.order_number}: ` +
          `status=${summary.status ?? 'unknown'} refundAmount=${summary.refundAmount ?? 'null'} ` +
          `refundedLines.length=${summary.refundedLinesLength} stockMovementIds.length=${summary.stockMovementIdsLength}`,
        );
        const expectedDeltaGroszeCandidates = getRefundExpectedDeltaCandidates(data, requestedAmountGrosze, order);
        const validation = validateRefundBackendResponse(result, {
          type: data.type,
          requestedAmountGrosze,
          orderTotalGrosze: order.total,
          alreadyRefundedGrosze,
          requireRefundedLines: hasLineRefund,
          requireStockMovement: hasRestock,
          expectedDeltaGroszeCandidates,
        });
        if (!validation.ok) {
          const error = buildRefundMutationError(validation);
          logger.error(
            `[PosModule] Refund backend response incomplete for ${order.order_number}: ${error}. ` +
            `summary=${JSON.stringify(validation.summary)}`,
          );
          if (validation.mutationDetected) {
            lockRefundMutationLocally(orderId, order, validation, error, data.reason);
            database.markDirty();
            return {
              success: false,
              mutationDetected: true,
              requiresRefresh: true,
              overRefund: validation.overRefund,
              error,
              backendSummary: validation.summary,
            };
          }
          return { success: false, error, backendSummary: validation.summary };
        }

        // Update local DB from backend response
        const refundedAmount = validation.refundedAmountGrosze ?? 0;
        const status = result.status === 'REFUNDED' ? 'FULL' : 'PARTIAL';
        const backendRefundLinesJson = normalizeRefundLinesJson(result.refundedLines);
        const deltaRefundLines = backendRefundLinesJson ? JSON.parse(backendRefundLinesJson) : [];
        const cumulativeRefundLines = mergeRefundLines(order.refund_lines, deltaRefundLines);
        const refundReason = result.refundReason || data.reason || '';
        orderRepo.markRefunded(orderId, refundedAmount, refundReason, status, cumulativeRefundLines.length > 0 ? cumulativeRefundLines : undefined);
        database.markDirty();

        // Print refund receipt
        let receiptPrinted = false;
        try {
          receiptPrinted = await this.paymentController?.printRefundReceipt(orderId, {
            amount: validation.refundAmountGrosze ?? refundedAmount,
            lines: deltaRefundLines,
            reason: refundReason,
          }) ?? false;
        } catch (e: any) {
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
        database.markDirty();

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
        database.markDirty();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:getServerList', async (_e, params: ServerOrderListParams) => {
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
        return toCashDrawerIpcResult(drawerOpened);
      } catch (e: any) {
        return toCashDrawerIpcResult(false, e);
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

    ipcMain.handle('self-checkout:finalize-print', async (_e, payload: { orderId?: string; method?: string }) => {
      const orderId = String(payload?.orderId || '').trim();
      const method = String(payload?.method || '').toUpperCase();
      if (!orderId) return { success: false, printed: false, error: 'missing_order_id' };
      if (!['CASH', 'CARD', 'BLIK'].includes(method)) {
        return { success: false, printed: false, error: 'unsupported_payment_method' };
      }

      try {
        if (method === 'CARD') {
          const fiscalPrinted = await this.paymentController?.printFiscalReceipt(orderId) ?? false;
          return {
            success: fiscalPrinted,
            printed: fiscalPrinted,
            fiscalPrinted,
            receiptPrinted: fiscalPrinted,
            route: 'FISCAL_RECEIPT',
          };
        }

        if (method === 'CASH') {
          const result = await this.paymentController?.printReceiptAndOpenDrawer(orderId);
          const receiptPrinted = result?.receiptPrinted ?? false;
          return {
            success: receiptPrinted,
            printed: receiptPrinted,
            receiptPrinted,
            drawerOpened: result?.drawerOpened ?? false,
            route: 'ORDER_COPY',
            error: result?.error,
          };
        }

        const receiptPrinted = await this.paymentController?.printReceipt(orderId) ?? false;
        return {
          success: receiptPrinted,
          printed: receiptPrinted,
          receiptPrinted,
          drawerOpened: false,
          route: 'ORDER_COPY',
        };
      } catch (e: any) {
        return {
          success: false,
          printed: false,
          receiptPrinted: false,
          fiscalPrinted: false,
          error: e?.message || String(e),
        };
      }
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
        const shiftExists = database.get<{ id: string }>('SELECT id FROM shifts WHERE id = ? AND closed_at IS NULL', [data.shiftId]);
        if (!shiftExists) {
          logger.warn(`[PosModule] Ghost shift ${data.shiftId.substring(0, 8)} — not in DB, clearing session`);
          try {
            const token = getSecureAuthToken();
            if (token) {
              await apiClient.closePosShift(token, data.shiftId, { closingCash: data.closingCash });
              logger.info(`[PosModule] Closed server ghost shift ${data.shiftId.substring(0, 8)}`);
            }
          } catch (err: any) {
            logger.warn(`[PosModule] Failed to close server ghost shift ${data.shiftId.substring(0, 8)}: ${err?.message ?? err}`);
          }
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

    // Self-checkout kiosk: "Wezwij obsługę" round-trip. Renderer is
    // sandboxed to localStorage + window-scoped APIs, so the actual
    // backend REST calls live here in main where we have the api key
    // and can persist a stable terminal id across restarts.
    ipcMain.handle(
      'self-checkout:help-request',
      async (_e, payload: { reason: string; cartTotalGrosze?: number }) => {
        const apiKey = getSecureApiKey() || '';
        if (!apiKey) {
          return { error: 'Print Agent not paired (missing apiKey)' };
        }
        let terminalId = (getConfigValue('selfCheckoutTerminalId') as string) || '';
        if (!terminalId) {
          terminalId = `kiosk-${Math.random().toString(36).slice(2, 10)}`;
          setConfigValue('selfCheckoutTerminalId', terminalId);
        }
        const baseUrl = (getConfigValue('serverUrl') as string) || 'https://api.enail.pro';
        try {
          const r = await fetch(
            `${baseUrl}/api/v1/print-agent/self-checkout/help-request`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                apiKey,
                terminalId,
                reason: payload.reason,
                cartTotalGrosze: payload.cartTotalGrosze ?? null,
              }),
            },
          );
          const body = await r.json().catch(() => ({}));
          if (!r.ok) return { error: body?.message || `HTTP ${r.status}` };
          return body;
        } catch (e: any) {
          return { error: e?.message || 'Network error' };
        }
      },
    );

    ipcMain.handle('self-checkout:help-status', async (_e, id: string) => {
      const apiKey = getSecureApiKey() || '';
      if (!apiKey) return null;
      const baseUrl = (getConfigValue('serverUrl') as string) || 'https://api.enail.pro';
      try {
        // The /open endpoint returns the unresolved queue; finding our id
        // there means it's still open. Anything else (404 / not in list)
        // means it was resolved.
        const r = await fetch(
          `${baseUrl}/api/v1/print-agent/self-checkout/help-requests/open`,
          {
            headers: {
              Authorization: `Bearer ${getSecureAuthToken() || ''}`,
            },
          },
        );
        if (!r.ok) return null;
        const list = (await r.json().catch(() => [])) as Array<any>;
        const row = Array.isArray(list) ? list.find((x) => x.id === id) : null;
        if (!row) {
          return { id, resolvedAt: new Date().toISOString() };
        }
        return {
          id,
          acknowledgedAt: row.acknowledgedAt ?? null,
          resolvedAt: row.resolvedAt ?? null,
        };
      } catch {
        return null;
      }
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
      const selfCheckoutWindow = this.windowManager?.getWindow('selfCheckout');
      if (selfCheckoutWindow && !selfCheckoutWindow.isDestroyed()) selfCheckoutWindow.webContents.send('pos:elavon-status', data);
      // Forward payment status to customer display via PosStore broadcast
      if (this.posStore) {
        const currentDisplay = this.posStore.getState().display;
        this.posStore.dispatch({
          type: 'display/setMode',
          payload: { ...currentDisplay, paymentStatus: data.status },
        });
      }
    });

    socket.on('draft-products:updated', (data: { draft: any }) => {
      if (!data?.draft) return;
      try {
        draftProductSync.applyUpdate(data.draft);
        const posWindow = this.windowManager?.getWindow('pos');
        if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:draft-products-synced');
      } catch (err: any) {
        logger.warn(`[PosModule] Failed to apply draft update: ${err?.message ?? err}`);
      }
    });

    socket.on('draft-products:deleted', (data: { id: string }) => {
      if (!data?.id) return;
      try {
        draftProductSync.applyDelete(data.id);
        const posWindow = this.windowManager?.getWindow('pos');
        if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:draft-products-synced');
      } catch (err: any) {
        logger.warn(`[PosModule] Failed to apply draft delete: ${err?.message ?? err}`);
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

function normalizeQuickAddAnalysis(raw: any): Record<string, any> {
  const candidates = [
    raw?.analysis,
    raw?.data?.analysis,
    raw?.result?.analysis,
    raw?.data,
    raw?.result,
    raw,
  ].filter((candidate) => candidate && typeof candidate === 'object');

  const source = candidates.find((candidate) =>
    candidate.name ||
    candidate.productName ||
    candidate.product_name ||
    candidate.namePreferred ||
    candidate.name_preferred ||
    candidate.title ||
    candidate.label,
  ) ?? candidates[0] ?? {};

  const name = firstString(
    source.name,
    source.productName,
    source.product_name,
    source.namePreferred,
    source.name_preferred,
    source.title,
    source.label,
  );

  return {
    ...source,
    name,
    ean: firstCandidateString(candidates, ['ean', 'barcode', 'detectedEan', 'detected_ean']),
    weight: firstCandidateValue(candidates, ['weight', 'weightGrams', 'weight_grams']),
    weightUnit: firstCandidateValue(candidates, ['weightUnit', 'weight_unit']),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstCandidateString(candidates: Record<string, any>[], keys: string[]): string | undefined {
  return firstString(...candidates.flatMap((candidate) => keys.map((key) => candidate[key])));
}

function firstCandidateValue(candidates: Record<string, any>[], keys: string[]): any {
  for (const candidate of candidates) {
    for (const key of keys) {
      if (candidate[key] != null && candidate[key] !== '') return candidate[key];
    }
  }
  return undefined;
}

function fallbackQuickAddName(analysis: Record<string, any>): string {
  const ean = firstString(analysis.ean, analysis.barcode);
  if (ean) return `New product ${ean}`;
  return `New product ${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
}

function lockRefundMutationLocally(
  orderId: string,
  order: { total: number; refund_amount: number | null },
  validation: RefundBackendValidationResult,
  error: string,
  reason?: string,
): void {
  const reportedAmount = validation.refundedAmountGrosze;
  const status = validation.overRefund || (reportedAmount != null && reportedAmount >= order.total)
    ? 'REFUNDED'
    : 'PARTIAL_REFUND';

  database.run(
    `UPDATE orders
     SET status = ?,
         refund_amount = CASE WHEN ? IS NULL THEN refund_amount ELSE ? END,
         refund_reason = COALESCE(?, refund_reason),
         sync_error = ?,
         refunded_at = COALESCE(refunded_at, datetime('now'))
     WHERE id = ?`,
    [
      status,
      reportedAmount,
      reportedAmount,
      reason ?? 'Backend refund response incomplete',
      error,
      orderId,
    ],
  );
}
