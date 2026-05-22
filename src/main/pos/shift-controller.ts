import { database } from '../database/database';
import { orderRepo } from '../database/repos/order-repo';
import { DailyReportData, PrinterType } from '../../shared/types';
import { apiClient } from '../network/api-client';
import { getConfigValue, getSecureAuthToken } from '../config/store';
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
}

type PrinterDriver = {
  isConnected(): boolean;
  printZReport(data: DailyReportData): Promise<void>;
};

function isTransferMethod(method: string | null | undefined): boolean {
  return method === 'TRANSFER' || method === 'BANK_TRANSFER';
}

export class ShiftController {
  constructor(
    private getPrinter: (type: string) => PrinterDriver | null,
    private isOnline: () => boolean,
  ) {}

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

    // Async sync to backend (non-blocking)
    this.syncShiftOpen(shiftId, staffId, openingCash);

    logger.info(`[Shift] Opened shift ${shiftId} for ${staffName}, opening cash: ${openingCash}`);
    return shiftId;
  }

  /**
   * Close a shift and generate report
   */
  closeShift(shiftId: string, closingCash: number): ShiftReport {
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
    const grossSales = orders.reduce((sum, o) => sum + o.total, 0);

    const unsyncedOrders = orderRepo.getUnsyncedCountByShift(shiftId);

    // Aggregate by payment method, accounting for split tenders
    let cashTotal = 0, cardTotal = 0, blikTotal = 0, transferTotal = 0;
    for (const o of orders) {
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

    const totalDiscounts = orders.reduce((sum, o) => sum + (o.discount ?? 0), 0);

    let totalRefunds = 0;
    for (const o of orders) {
      if (o.refund_amount && o.refund_amount > 0) {
        totalRefunds += o.refund_amount;

        const tendersJson = o.payment_tenders;
        if (tendersJson) {
          try {
            const tenders = JSON.parse(tendersJson) as Array<{ method: string; amount: number }>;
            const orderTotal = tenders.reduce((s, t) => s + t.amount, 0);
            if (orderTotal > 0) {
              let distributed = 0;
              for (let i = 0; i < tenders.length; i++) {
                const isLast = i === tenders.length - 1;
                const share = isLast
                  ? o.refund_amount - distributed
                  : Math.round(o.refund_amount * (tenders[i].amount / orderTotal));
                distributed += share;
                if (tenders[i].method === 'CASH') cashTotal -= share;
                else if (tenders[i].method === 'CARD') cardTotal -= share;
                else if (tenders[i].method === 'BLIK') blikTotal -= share;
                else if (isTransferMethod(tenders[i].method)) transferTotal -= share;
              }
              continue;
            }
          } catch { /* fall through to single method */ }
        }

        if (o.payment_method === 'CASH') cashTotal -= o.refund_amount;
        else if (o.payment_method === 'CARD') cardTotal -= o.refund_amount;
        else if (o.payment_method === 'BLIK') blikTotal -= o.refund_amount;
        else if (isTransferMethod(o.payment_method)) transferTotal -= o.refund_amount;
      }
    }

    const totalSales = grossSales - totalRefunds - totalDiscounts;
    const difference = closingCash - (shift.opening_cash + cashTotal);

    database.run(
      "UPDATE shifts SET closed_at = datetime('now'), closing_cash = ?, total_sales = ?, total_orders = ? WHERE id = ?",
      [closingCash, totalSales, orders.length, shiftId],
    );
    database.markDirty();

    const report: ShiftReport = {
      shiftId,
      staffName: shift.staff_name,
      openedAt: shift.opened_at,
      closedAt: new Date().toISOString(),
      openingCash: shift.opening_cash,
      closingCash,
      totalSales,
      totalOrders: orders.length,
      cashTotal,
      cardTotal,
      blikTotal,
      transferTotal,
      totalRefunds,
      totalDiscounts,
      difference,
      unsyncedOrders,
    };

    // Async sync to backend (non-blocking)
    this.syncShiftClose(shiftId, closingCash);

    logger.info(
      `[Shift] Closed shift ${shiftId}: ${orders.length} orders, total ${totalSales}, diff ${difference}`,
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

    const MAX_ATTEMPTS = 5;

    // Retry unsynced shift opens
    const unsyncedOpen = database.all<{ id: string; staff_id: string; opening_cash: number; sync_attempts: number }>(
      'SELECT id, staff_id, opening_cash, COALESCE(sync_attempts, 0) as sync_attempts FROM shifts WHERE synced = 0 AND backend_id IS NULL',
    );
    for (const shift of unsyncedOpen) {
      if (shift.sync_attempts >= MAX_ATTEMPTS) {
        database.run("UPDATE shifts SET synced = -1, sync_error = 'Max retry exceeded' WHERE id = ?", [shift.id]);
        logger.warn(`[Shift] Shift open ${shift.id} shelved after ${shift.sync_attempts} failed attempts`);
        continue;
      }

      try {
        database.run('UPDATE shifts SET sync_attempts = COALESCE(sync_attempts, 0) + 1 WHERE id = ?', [shift.id]);
        const result = await apiClient.openPosShift(token, {
          staffId: shift.staff_id,
          openingCash: shift.opening_cash,
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
        logger.warn(`[Shift] Retry failed for shift open ${shift.id} (attempt ${shift.sync_attempts + 1}/${MAX_ATTEMPTS}): ${errMsg}`);
      }
    }

    // Retry unsynced shift closes (have backend_id but closed_at set and not synced)
    const unsyncedClose = database.all<{ id: string; backend_id: string; closing_cash: number }>(
      'SELECT id, backend_id, closing_cash FROM shifts WHERE synced = 1 AND backend_id IS NOT NULL AND closed_at IS NOT NULL AND closing_cash IS NOT NULL',
    );
    for (const shift of unsyncedClose) {
      try {
        await apiClient.closePosShift(token, shift.backend_id, {
          closingCash: shift.closing_cash,
        });
        logger.info(`[Shift] Retry: synced shift close ${shift.id}`);
      } catch (err: any) {
        logger.warn(`[Shift] Retry failed for shift close ${shift.id}: ${err.message}`);
      }
    }
  }

  private async syncShiftOpen(shiftId: string, staffId: string, openingCash: number): Promise<void> {
    if (!this.isOnline()) {
      logger.info(`[Shift] Offline, shift open ${shiftId} queued for retry`);
      return;
    }
    const token = getSecureAuthToken();
    if (!token) return;

    try {
      const result = await apiClient.openPosShift(token, { staffId, openingCash });
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

    const shift = database.get<{ backend_id: string | null }>(
      'SELECT backend_id FROM shifts WHERE id = ?',
      [shiftId],
    );
    if (!shift?.backend_id) return;

    try {
      await apiClient.closePosShift(token, shift.backend_id, { closingCash });
    } catch (err) {
      logger.warn(`[Shift] Failed to sync shift close ${shiftId}, will retry on reconnect: ${err}`);
    }
  }
}
