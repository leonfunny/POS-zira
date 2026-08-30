import { database } from '../database/database';
import { orderRepo } from '../database/repos/order-repo';
import { DailyReportData, PrinterType } from '../../shared/types';
import { apiClient } from '../network/api-client';
import { getConfigValue, getSecureAuthToken } from '../config/store';
import { posEventEmitter } from '../events/pos-event-emitter';
import logger from '../logger';
import { summarizeShiftSales } from '../../shared/shift-accounting';
import { ShiftAlreadyClosedError } from '../../shared/shift-close';

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
  totalTips: number;
  difference: number; // closingCash - (openingCash + cashTotal)
  unsyncedOrders: number;
  fiscalOnlySales?: boolean;
  autoClosed?: boolean; // closed by end-of-day job; closingCash = expected cash, not counted
}

export type ZReportPrintStatus =
  | 'PENDING'
  | 'FAILED_SAFE'
  | 'DISPATCHING'
  | 'NEEDS_REVIEW'
  | 'COMPLETED';

export interface ZReportRecovery {
  shiftId: string;
  report: ShiftReport;
  status: Exclude<ZReportPrintStatus, 'COMPLETED'>;
  attempts: number;
  lastError: string | null;
}

type PrinterDriver = {
  isConnected(): boolean;
  printZReport(data: DailyReportData): Promise<void>;
};

const SHIFT_SYNC_MAX_ATTEMPTS = 5;
const Z_REPORT_PRINTER_UNAVAILABLE = 'Z_REPORT_PRINTER_UNAVAILABLE';

export function isSafeZReportPrintFailure(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === Z_REPORT_PRINTER_UNAVAILABLE;
}

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
  /**
   * SQL.js mutations are visible in memory before the database image crosses
   * its explicit save barrier. Keep reconnect workers away from deferred shift
   * mutations until PosModule confirms that barrier succeeded.
   */
  private readonly durabilityBlockedShiftIds = new Set<string>();

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
  openShift(
    staffId: string,
    staffName: string,
    openingCash: number,
    options: { deferSyncUntilDurable?: boolean } = {},
  ): string {
    const shiftId = crypto.randomUUID();

    database.run(
      'INSERT INTO shifts (id, staff_id, staff_name, opening_cash) VALUES (?, ?, ?, ?)',
      [shiftId, staffId, staffName, openingCash],
    );
    if (options.deferSyncUntilDurable) {
      this.durabilityBlockedShiftIds.add(shiftId);
    }
    database.markDirty();

    posEventEmitter.emitShiftOpened({ shiftId, staffId, staffName, openingCashMinor: openingCash });

    // The live IPC flow defers this external side effect until the SQL.js
    // image has crossed its explicit disk durability barrier.
    if (!options.deferSyncUntilDurable) {
      this.syncShiftOpen(shiftId, staffId, openingCash);
    }

    logger.info(`[Shift] Opened shift ${shiftId} for ${staffName}, opening cash: ${openingCash}`);
    return shiftId;
  }

  syncDurableShiftOpen(shiftId: string, staffId: string, openingCash: number): void {
    this.durabilityBlockedShiftIds.delete(shiftId);
    this.syncShiftOpen(shiftId, staffId, openingCash);
  }

  /**
   * Close a shift and generate report
   */
  /**
   * @param closingCash counted cash, or `null` for an automatic close (EOD):
   *   closing cash is then set to the expected cash (opening + cash sales −
   *   cash refunds) and the report is flagged `autoClosed`.
   */
  closeShift(
    shiftId: string,
    closingCashInput: number | null,
    fiscalOnly = false,
    options: { deferSyncUntilDurable?: boolean } = {},
  ): ShiftReport {
    const autoClosed = closingCashInput === null;
    const shift = database.get<{
      id: string;
      staff_id: string | null;
      staff_name: string | null;
      opened_at: string;
      opening_cash: number;
    }>('SELECT * FROM shifts WHERE id = ? AND closed_at IS NULL', [shiftId]);

    if (!shift) {
      const existing = database.get<{ id: string }>('SELECT id FROM shifts WHERE id = ?', [shiftId]);
      if (existing) throw new ShiftAlreadyClosedError(shiftId);
      throw new Error(`Shift ${shiftId} not found`);
    }

    // Get orders for this shift — handle split payments
    const orders = orderRepo.getByShift(shiftId);
    const salesOrders = fiscalOnly ? orders.filter((o) => o.has_fiscal === 1) : orders;
    const accounting = summarizeShiftSales(salesOrders);
    const closedAt = new Date().toISOString();

    const unsyncedOrders = orderRepo.getUnsyncedCountByShift(shiftId);

    let cashTotal = accounting.payments.cash;
    let cardTotal = accounting.payments.card;
    let blikTotal = accounting.payments.blik;
    let transferTotal = accounting.payments.transfer;
    const totalDiscounts = accounting.totalDiscounts;
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

    // order.total is already net of every line/receipt discount. Discounts are
    // reported separately and must never be subtracted from revenue twice.
    const totalSales = accounting.salesTotal - totalRefunds;
    const closingCash = autoClosed ? shift.opening_cash + cashTotal : (closingCashInput as number);
    const difference = closingCash - (shift.opening_cash + cashTotal);

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
      totalTips: accounting.totalTips,
      difference,
      unsyncedOrders,
      fiscalOnlySales: fiscalOnly,
      autoClosed,
    };

    database.run(
      `UPDATE shifts SET
           closed_at = ?, closing_cash = ?, total_sales = ?, total_orders = ?,
           close_synced = 0, close_sync_attempts = 0, close_sync_error = NULL,
           z_report_payload = ?, z_report_status = 'PENDING',
           z_report_attempts = 0, z_report_error = NULL,
           z_report_dispatched_at = NULL, z_report_completed_at = NULL
       WHERE id = ? AND closed_at IS NULL`,
      [
        closedAt,
        closingCash,
        totalSales,
        salesOrders.length,
        JSON.stringify(report),
        shiftId,
      ],
    );
    const closed = database.get<{ count: number }>('SELECT changes() AS count')?.count ?? 0;
    if (closed !== 1) throw new ShiftAlreadyClosedError(shiftId);
    if (options.deferSyncUntilDurable) {
      this.durabilityBlockedShiftIds.add(shiftId);
    }
    database.markDirty();

    posEventEmitter.emitShiftClosed(report);

    // The live IPC/EOD flows defer this external side effect until the SQL.js
    // image has crossed their explicit disk durability barrier.
    if (!options.deferSyncUntilDurable) {
      void this.syncShiftClose(shiftId, closingCash);
    }

    logger.info(
      `[Shift] Closed shift ${shiftId}${autoClosed ? ' (auto, end-of-day)' : ''}: ${salesOrders.length} sales orders, total ${totalSales}, diff ${difference}`,
    );

    return report;
  }

  syncDurableShiftClose(shiftId: string, closingCash: number): void {
    this.durabilityBlockedShiftIds.delete(shiftId);
    void this.syncShiftClose(shiftId, closingCash);
  }

  getUnresolvedZReport(shiftId?: string): ZReportRecovery | null {
    const whereShift = shiftId ? 'AND id = ?' : '';
    const row = database.get<{
      id: string;
      z_report_payload: string;
      z_report_status: ZReportPrintStatus;
      z_report_attempts: number | null;
      z_report_error: string | null;
    }>(
      `SELECT id, z_report_payload, z_report_status,
              COALESCE(z_report_attempts, 0) AS z_report_attempts,
              z_report_error
       FROM shifts
       WHERE closed_at IS NOT NULL
         AND z_report_payload IS NOT NULL
         AND z_report_status IN ('PENDING', 'FAILED_SAFE', 'DISPATCHING', 'NEEDS_REVIEW')
         ${whereShift}
       ORDER BY closed_at DESC
       LIMIT 1`,
      shiftId ? [shiftId] : [],
    );
    if (!row) return null;

    let report: ShiftReport;
    try {
      report = JSON.parse(row.z_report_payload) as ShiftReport;
    } catch {
      throw new Error(`Stored Z-report for shift ${row.id} is unreadable`);
    }
    if (!report || report.shiftId !== row.id) {
      throw new Error(`Stored Z-report for shift ${row.id} has an invalid identity`);
    }
    return {
      shiftId: row.id,
      report,
      status: row.z_report_status as ZReportRecovery['status'],
      attempts: row.z_report_attempts ?? 0,
      lastError: row.z_report_error ?? null,
    };
  }

  beginZReportPrint(shiftId: string, confirmUncertainReprint = false): ShiftReport {
    const pending = this.getUnresolvedZReport(shiftId);
    if (!pending) throw new Error(`No pending Z-report for shift ${shiftId}`);
    if (
      (pending.status === 'DISPATCHING' || pending.status === 'NEEDS_REVIEW')
      && !confirmUncertainReprint
    ) {
      throw new Error(
        'The previous Z-report outcome is uncertain. Check the printer before choosing whether to print again.',
      );
    }
    database.run(
      `UPDATE shifts
       SET z_report_status = 'DISPATCHING',
           z_report_attempts = COALESCE(z_report_attempts, 0) + 1,
           z_report_error = NULL,
           z_report_dispatched_at = datetime('now')
       WHERE id = ?`,
      [shiftId],
    );
    database.markDirty();
    return pending.report;
  }

  markZReportFailed(shiftId: string, error: unknown, safeToRetry: boolean): void {
    database.run(
      `UPDATE shifts
       SET z_report_status = ?, z_report_error = ?
       WHERE id = ?`,
      [
        safeToRetry ? 'FAILED_SAFE' : 'NEEDS_REVIEW',
        shiftSyncErrorMessage(error),
        shiftId,
      ],
    );
    database.markDirty();
  }

  markZReportCompleted(shiftId: string): void {
    database.run(
      `UPDATE shifts
       SET z_report_status = 'COMPLETED', z_report_error = NULL,
           z_report_completed_at = datetime('now')
       WHERE id = ?`,
      [shiftId],
    );
    database.markDirty();
  }

  /**
   * Print Z-report (shift end report)
   */
  async printZReport(report: ShiftReport): Promise<void> {
    const printer = this.getPrinter(PrinterType.RECEIPT) as PrinterDriver | null;
    if (!printer || !printer.isConnected()) {
      const error = new Error('No receipt printer is connected for the Z-report') as Error & {
        code?: string;
      };
      error.code = Z_REPORT_PRINTER_UNAVAILABLE;
      logger.warn(`[Shift] ${error.message}`);
      throw error;
    }

    const reportData: DailyReportData = {
      date: report.closedAt.split('T')[0],
      transactionCount: report.totalOrders,
      grossSales: report.totalSales + report.totalRefunds + report.totalDiscounts,
      discounts: report.totalDiscounts,
      tips: report.totalTips,
      refunds: report.totalRefunds,
      netSales: report.totalSales,
      paymentSummary: [
        { method: 'CASH', amount: report.cashTotal },
        { method: 'CARD', amount: report.cardTotal },
        { method: 'BLIK', amount: report.blikTotal },
        { method: 'TRANSFER', amount: report.transferTotal },
      ].filter((p) => p.amount > 0),
      cashierName: report.autoClosed
        ? `${report.staffName || ''} (AUTO)`.trim()
        : report.staffName || undefined,
    };

    try {
      await printer.printZReport(reportData);
      logger.info(`[Shift] Z-report printed for shift ${report.shiftId}`);
    } catch (err) {
      logger.error(`[Shift] Z-report print failed: ${err}`);
      throw err;
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
      if (this.durabilityBlockedShiftIds.has(shift.id)) continue;
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
      if (this.durabilityBlockedShiftIds.has(shift.id)) continue;
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
