import { database } from '../database/database';
import { orderRepo } from '../database/repos/order-repo';
import { DailyReportData, PrinterType } from '../../shared/types';
import { apiClient } from '../network/api-client';
import { getConfigValue, getSecureAuthToken } from '../config/store';
import { posEventEmitter } from '../events/pos-event-emitter';
import logger from '../logger';

export interface ShiftReport {
  shiftId: string;
  staffName: string | null;
  openedAt: string;
  closedAt: string;
  openingCash: number;
  closingCash: number;
  totalSales: number;
  totalOrders: number;
  cashTotal: number;
  cardTotal: number;
  blikTotal: number;
  transferTotal: number;
  totalRefunds: number;
  totalDiscounts: number;
  difference: number; // closingCash - (openingCash + cashTotal)
  unsyncedOrders: number;
  fiscalOnlySales?: boolean;
}

type PrinterDriver = {
  isConnected(): boolean;
  printZReport(data: DailyReportData): Promise<void>;
};

const SHIFT_SYNC_MAX_ATTEMPTS = 5;

function shiftSyncErrorMessage(err: unknown): string {
  const value = err as any;
  return (value?.message || value?.code || String(err)).substring(0, 500);
}

function shiftSyncErrorStatus(err: unknown): number | null {
  const value = err as any;
  const candidates = [value?.status, value?.statusCode, value?.response?.status, value?.response?.statusCode];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isFinite(status) && status > 0) return status;
  }
  return null;
}

function isTerminalShiftCloseError(err: unknown): boolean {
  const status = shiftSyncErrorStatus(err);
  if (status === 404 || status === 409 || status === 410) return true;
  const message = shiftSyncErrorMessage(err).toLowerCase();
  return message.includes('not found') || message.includes('already closed') || message.includes('already been closed') || message.includes('no active shift');
}

function isTransferMethod(method: string | null | undefined): boolean {
  return method === 'TRANSFER' || method === 'BANK_TRANSFER';
}

export function canReconcileActiveShift(
  localShiftId: string,
  localStaffId: string | null | undefined,
  serverShift: { id?: string | null; staffId?: string | null } | null | undefined,
  configuredMachineId: string | null | undefined,
): boolean {
  if (!serverShift?.id) return false;
  if (serverShift.id === localShiftId) return true;

  // Staff identity is only safe after the backend active-shift lookup was
  // scoped to this machine. A salon may have the same cashier on two POSes.
  return Boolean(
    String(configuredMachineId ?? '').trim()
    && serverShift.staffId
    && localStaffId
    && serverShift.staffId === localStaffId,
  );
}

export class ShiftController {
  constructor(
    private getPrinter: (type: string) => PrinterDriver | null,
    private isOnline: () => boolean,
  ) {}

  private getMachineId(): string | undefined {
    return String(getConfigValue('machineId') ?? '').trim() || undefined;
  }

  /**
   * Open a new shift
   */
  openShift(staffId: string, staffName: string, openingCash: number): string {
    const shiftId = crypto.randomUUID();

    database.run(
      'INSERT INTO shifts (id, staff_id, staff_name, opening_cash) VALUES (?, ?, ?, ?)',
      [shiftId, staffId, staffName, openingCash],
    );
    database.markDirty();

    posEventEmitter.emitShiftOpened({ shiftId, staffId, staffName, openingCashMinor: openingCash });

    // Async sync to backend (non-blocking)
    this.syncShiftOpen(shiftId, staffId, openingCash);

    logger.info(`[Shift] Opened shift ${shiftId} for ${staffName}, opening cash: ${openingCash}`);
    return shiftId;
  }

  /**
   * Close a shift and generate report
   */
  closeShift(shiftId: string, closingCash: number, fiscalOnly = false): ShiftReport {
    const shift = database.get<{
      id: string;
      staff_id: string | null;
      staff_name: string | null;
      opened_at: string;
      opening_cash: number;
    }>('SELECT * FROM shifts WHERE id = ?', [shiftId]);

    if (!shift) throw new Error(`Shift ${shiftId} not found`);

    // Get orders for this shift — handle split payments
    const orders = orderRepo.getByShift(shiftId);
    const salesOrders = fiscalOnly ? orders.filter((o) => o.has_fiscal === 1) : orders;
    const grossSales = salesOrders.reduce((sum, o) => sum + o.total, 0);
    const closedAt = new Date().toISOString();

    const unsyncedOrders = orderRepo.getUnsyncedCountByShift(shiftId);

    // Aggregate by payment method for the same order set shown in the report,
    // accounting for split tenders.
    const paymentOrders = salesOrders;
    let cashTotal = 0, cardTotal = 0, blikTotal = 0, transferTotal = 0;
    for (const o of paymentOrders) {
      const tendersJson = o.payment_tenders;
      if (tendersJson) {
        try {
          const tenders = JSON.parse(tendersJson) as Array<{ method: string; amount: number }>;
          for (const t of tenders) {
            if (t.method === 'CASH') cashTotal += t.amount;
            else if (t.method === 'CARD') cardTotal += t.amount;
            else if (t.method === 'BLIK') blikTotal += t.amount;
            else if (isTransferMethod(t.method)) transferTotal += t.amount;
          }
          continue; // skip single-method fallback
        } catch { /* fall through */ }
      }
      // Single payment method
      if (o.payment_method === 'CASH') cashTotal += o.total;
      else if (o.payment_method === 'CARD') cardTotal += o.total;
      else if (o.payment_method === 'BLIK') blikTotal += o.total;
      else if (isTransferMethod(o.payment_method)) transferTotal += o.total;
    }

    const totalDiscounts = salesOrders.reduce((sum, o) => sum + (o.discount ?? 0), 0);
    const refundCashflow = orderRepo.getRefundCashflowBetween(
      shift.opened_at,
      closedAt,
      fiscalOnly,
      shiftId,
    );
    const totalRefunds = refundCashflow.refund_total;
    cashTotal -= refundCashflow.cash_refund_total;
    cardTotal -= refundCashflow.card_refund_total;
    blikTotal -= refundCashflow.blik_refund_total;
    transferTotal -= refundCashflow.transfer_refund_total;

    const totalSales = grossSales - totalRefunds - totalDiscounts;
    const difference = closingCash - (shift.opening_cash + cashTotal);

    database.run(
      "UPDATE shifts SET closed_at = datetime('now'), closing_cash = ?, total_sales = ?, total_orders = ?, close_synced = 0, close_sync_attempts = 0, close_sync_error = NULL WHERE id = ?",
      [closingCash, totalSales, salesOrders.length, shiftId],
    );
    database.markDirty();

    const report: ShiftReport = {
      shiftId,
      staffName: shift.staff_name,
      openedAt: shift.opened_at,
      closedAt,
      openingCash: shift.opening_cash,
      closingCash,
      totalSales,
      totalOrders: salesOrders.length,
      cashTotal,
      cardTotal,
      blikTotal,
      transferTotal,
      totalRefunds,
      totalDiscounts,
      difference,
      unsyncedOrders,
      fiscalOnlySales: fiscalOnly,
    };

    posEventEmitter.emitShiftClosed(report);

    // Async sync to backend (non-blocking)
    this.syncShiftClose(shiftId, closingCash);

    logger.info(
      `[Shift] Closed shift ${shiftId}: ${salesOrders.length} sales orders, total ${totalSales}, diff ${difference}`,
    );

    return report;
  }

  /**
   * Print Z-report (shift end report)
   */
  async printZReport(report: ShiftReport): Promise<void> {
    const printer = this.getPrinter(PrinterType.RECEIPT) as PrinterDriver | null;
    if (!printer || !printer.isConnected()) {
      logger.warn('[Shift] No receipt printer connected, skipping Z-report print');
      return;
    }

    const reportData: DailyReportData = {
      date: report.closedAt.split('T')[0],
      transactionCount: report.totalOrders,
      grossSales: report.totalSales + report.totalRefunds + report.totalDiscounts,
      discounts: report.totalDiscounts,
      refunds: report.totalRefunds,
      netSales: report.totalSales,
      paymentSummary: [
        { method: 'CASH', amount: report.cashTotal },
        { method: 'CARD', amount: report.cardTotal },
        { method: 'BLIK', amount: report.blikTotal },
        { method: 'TRANSFER', amount: report.transferTotal },
      ].filter((p) => p.amount > 0),
      cashierName: report.staffName || undefined,
    };

    try {
      await printer.printZReport(reportData);
      logger.info(`[Shift] Z-report printed for shift ${report.shiftId}`);
    } catch (err) {
      logger.error(`[Shift] Z-report print failed: ${err}`);
    }
  }

  /**
   * Retry syncing any unsynced shifts (called on reconnect).
   * Caps retries at 5 — permanently failed shifts are marked synced=-1.
   */
  async retryUnsyncedShifts(): Promise<void> {
    const token = getSecureAuthToken();
    if (!token || !this.isOnline()) return;

    // Retry unsynced shift opens
    const unsyncedOpen = database.all<{ id: string; staff_id: string; opening_cash: number; sync_attempts: number }>(
      'SELECT id, staff_id, opening_cash, COALESCE(sync_attempts, 0) as sync_attempts FROM shifts WHERE synced = 0 AND backend_id IS NULL',
    );
    for (const shift of unsyncedOpen) {
      if (shift.sync_attempts >= SHIFT_SYNC_MAX_ATTEMPTS) {
        database.run("UPDATE shifts SET synced = -1, sync_error = 'Max retry exceeded' WHERE id = ?", [shift.id]);
        logger.warn(`[Shift] Shift open ${shift.id} shelved after ${shift.sync_attempts} failed attempts`);
        continue;
      }

      try {
        database.run('UPDATE shifts SET sync_attempts = COALESCE(sync_attempts, 0) + 1 WHERE id = ?', [shift.id]);
        // Release contract: backend OpenShiftDto must accept this client UUID
        // before a POS build containing this request is distributed.
        const result = await apiClient.openPosShift(token, {
          shiftId: shift.id,
          staffId: shift.staff_id,
          openingCash: shift.opening_cash,
          machineId: this.getMachineId(),
        });
        database.run('UPDATE shifts SET backend_id = ?, synced = 1, sync_error = NULL WHERE id = ?', [
          result.shiftId,
          shift.id,
        ]);
        database.markDirty();
        logger.info(`[Shift] Retry: synced shift open ${shift.id}`);
      } catch (err: any) {
        const errMsg = (err.message || String(err)).substring(0, 500);
        database.run('UPDATE shifts SET sync_error = ? WHERE id = ?', [errMsg, shift.id]);
        database.markDirty();
        logger.warn(`[Shift] Retry failed for shift open ${shift.id} (attempt ${shift.sync_attempts + 1}/${SHIFT_SYNC_MAX_ATTEMPTS}): ${errMsg}`);
      }
    }

    // Retry unsynced shift closes (have backend_id but closed_at set and not synced)
    const unsyncedClose = database.all<{ id: string; backend_id: string; closing_cash: number; close_sync_attempts: number }>(
      `SELECT id, backend_id, closing_cash, COALESCE(close_sync_attempts, 0) as close_sync_attempts
       FROM shifts
       WHERE synced = 1
         AND backend_id IS NOT NULL
         AND closed_at IS NOT NULL
         AND closing_cash IS NOT NULL
         AND COALESCE(close_synced, 0) = 0`,
    );
    for (const shift of unsyncedClose) {
      if (shift.close_sync_attempts >= SHIFT_SYNC_MAX_ATTEMPTS) {
        this.markShiftCloseExhausted(shift.id, shift.close_sync_attempts);
        continue;
      }

      try {
        await this.submitBackendShiftClose(token, shift.id, shift.backend_id, shift.closing_cash);
        logger.info(`[Shift] Retry: synced shift close ${shift.id}`);
      } catch (err: any) {
        this.markShiftCloseFailed(
          shift.id,
          err,
          `Retry failed for shift close ${shift.id} (attempt ${shift.close_sync_attempts + 1}/${SHIFT_SYNC_MAX_ATTEMPTS})`,
        );
      }
    }
  }

  private async submitBackendShiftClose(token: string, shiftId: string, backendShiftId: string, closingCash: number): Promise<void> {
    database.run('UPDATE shifts SET close_sync_attempts = COALESCE(close_sync_attempts, 0) + 1 WHERE id = ?', [shiftId]);
    database.markDirty();
    await apiClient.closePosShift(token, backendShiftId, { closingCash });
    this.markShiftCloseSynced(shiftId);
  }

  private markShiftCloseSynced(shiftId: string): void {
    database.run('UPDATE shifts SET close_synced = 1, close_sync_error = NULL WHERE id = ?', [shiftId]);
    database.markDirty();
  }

  private markShiftCloseFailed(shiftId: string, err: unknown, context: string): void {
    const errMsg = shiftSyncErrorMessage(err);
    if (isTerminalShiftCloseError(err)) {
      database.run('UPDATE shifts SET close_synced = -1, close_sync_error = ? WHERE id = ?', [`Terminal close sync error: ${errMsg}`, shiftId]);
      database.markDirty();
      logger.warn(`[Shift] ${context}; terminal, shelved: ${errMsg}`);
      return;
    }
    database.run('UPDATE shifts SET close_sync_error = ? WHERE id = ?', [errMsg, shiftId]);
    database.markDirty();
    logger.warn(`[Shift] ${context}: ${errMsg}`);
  }

  private markShiftCloseExhausted(shiftId: string, attempts: number): void {
    database.run("UPDATE shifts SET close_synced = -1, close_sync_error = 'Max retry exceeded' WHERE id = ?", [shiftId]);
    database.markDirty();
    logger.warn(`[Shift] Shift close ${shiftId} shelved after ${attempts} failed attempts`);
  }

  private async syncShiftOpen(shiftId: string, staffId: string, openingCash: number): Promise<void> {
    if (!this.isOnline()) {
      logger.info(`[Shift] Offline, shift open ${shiftId} queued for retry`);
      return;
    }
    const token = getSecureAuthToken();
    if (!token) return;

    try {
      // Release contract: backend OpenShiftDto accepts the client UUID and
      // returns the PosShift entity as `{ id }` (normalized by apiClient).
      const result = await apiClient.openPosShift(token, {
        shiftId,
        staffId,
        openingCash,
        machineId: this.getMachineId(),
      });
      database.run('UPDATE shifts SET backend_id = ?, synced = 1 WHERE id = ?', [
        result.shiftId,
        shiftId,
      ]);
      database.markDirty();
    } catch (err) {
      logger.warn(`[Shift] Failed to sync shift open ${shiftId}, will retry on reconnect: ${err}`);
    }
  }

  private async syncShiftClose(shiftId: string, closingCash: number): Promise<void> {
    if (!this.isOnline()) {
      logger.info(`[Shift] Offline, shift close ${shiftId} queued for retry`);
      return;
    }
    const token = getSecureAuthToken();
    if (!token) return;

    const shift = database.get<{ backend_id: string | null; staff_id: string | null; staff_name: string | null }>(
      'SELECT backend_id, staff_id, staff_name FROM shifts WHERE id = ?',
      [shiftId],
    );
    if (!shift?.backend_id) {
      if (!shift) return;
      try {
        const activeShift = await apiClient.getActiveShift(token, this.getMachineId());
        const sameShiftId = activeShift?.id === shiftId;
        const sameStaffId = !!activeShift?.staffId && !!shift.staff_id && activeShift.staffId === shift.staff_id;
        if (activeShift?.id && (sameShiftId || sameStaffId)) {
          await apiClient.closePosShift(token, activeShift.id, { closingCash });
          this.markShiftCloseSynced(shiftId);
          logger.info(`[Shift] Closed server active shift ${activeShift.id} while closing unsynced local shift ${shiftId}`);
        } else if (activeShift?.id) {
          logger.warn(`[Shift] Skipped closing server active shift ${activeShift.id} while closing unsynced local shift ${shiftId}: no shift id/staff id match`);
        }
      } catch (err: any) {
        logger.warn(`[Shift] Failed to close server active shift for unsynced local shift ${shiftId}: ${err?.message ?? err}`);
      }
      return;
    }

    try {
      await this.submitBackendShiftClose(token, shiftId, shift.backend_id, closingCash);
    } catch (err) {
      this.markShiftCloseFailed(shiftId, err, `Failed to sync shift close ${shiftId}, will retry on reconnect`);
    }
  }
}
