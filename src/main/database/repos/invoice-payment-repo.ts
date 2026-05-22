import { database } from '../database';
import { InvoicePaymentRow } from '../../../shared/types';
import logger from '../../logger';
import { randomUUID } from 'crypto';

export interface PaymentCreateDTO {
  invoice_id: string;
  amount: number;  // in grosze
  payment_method?: string;
  paid_at?: string;  // ISO date string
  reference_number?: string;
  notes?: string;
}

export const invoicePaymentRepo = {
  /**
   * Get all payments for an invoice
   */
  getByInvoiceId(invoiceId: string): InvoicePaymentRow[] {
    return database.all<InvoicePaymentRow>(
      'SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_at DESC',
      [invoiceId],
    );
  },

  /**
   * Get total paid amount for an invoice
   */
  getTotalPaid(invoiceId: string): number {
    const result = database.get<{ total: number }>(
      'SELECT COALESCE(SUM(amount), 0) as total FROM invoice_payments WHERE invoice_id = ?',
      [invoiceId],
    );
    return result?.total ?? 0;
  },

  /**
   * Get payment by ID
   */
  getById(id: string): InvoicePaymentRow | null {
    return database.get<InvoicePaymentRow>('SELECT * FROM invoice_payments WHERE id = ?', [id]);
  },

  /**
   * Add payment to invoice
   */
  create(data: PaymentCreateDTO): InvoicePaymentRow {
    const id = randomUUID();
    const paidAt = data.paid_at || new Date().toISOString();

    database.run(
      `INSERT INTO invoice_payments (
        id, invoice_id, amount, payment_method, paid_at, reference_number, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.invoice_id,
        data.amount,
        data.payment_method ?? null,
        paidAt,
        data.reference_number ?? null,
        data.notes ?? null,
      ],
    );

    database.markDirty();
    logger.info(`[InvoicePaymentRepo] Created payment: ${data.amount} grosze for invoice ${data.invoice_id}`);
    return this.getById(id)!;
  },

  /**
   * Delete payment
   */
  delete(id: string): void {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Payment not found: ${id}`);
    }

    database.run('DELETE FROM invoice_payments WHERE id = ?', [id]);
    database.markDirty();
    logger.info(`[InvoicePaymentRepo] Deleted payment: ${id}`);
  },

  /**
   * Get payments summary by date range
   */
  getSummary(dateFrom: string, dateTo: string): { total: number; count: number; byMethod: Record<string, number> } {
    const payments = database.all<InvoicePaymentRow>(
      `SELECT * FROM invoice_payments
       WHERE date(paid_at) >= date(?) AND date(paid_at) <= date(?)`,
      [dateFrom, dateTo],
    );

    const byMethod: Record<string, number> = {};
    let total = 0;

    for (const p of payments) {
      total += p.amount;
      const method = p.payment_method || 'UNKNOWN';
      byMethod[method] = (byMethod[method] || 0) + p.amount;
    }

    return { total, count: payments.length, byMethod };
  },
};
