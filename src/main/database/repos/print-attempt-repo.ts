import { randomUUID } from 'crypto';
import { database } from '../database';

export type PrintDocumentType = 'ORDER' | 'REPRINT' | 'REFUND';
export type PrintStatus = 'PRINTED' | 'FAILED' | 'NO_PRINTER';
export type PrintRoute = 'LOCAL' | 'SHARED_NETWORK';

export interface PrintAttemptRow {
  id: string;
  order_id: string;
  document_type: string;
  printer_type: string;
  printer_name: string | null;
  printer_target: string | null;
  route: string | null;
  status: string;
  error: string | null;
  created_at: string | null;
}

export interface RecordPrintAttemptInput {
  orderId: string;
  documentType: PrintDocumentType;
  printerType: string;          // RECEIPT | FISCAL | A4 | LABEL
  printerName?: string | null;
  printerTarget?: string | null;
  route?: PrintRoute | null;
  status: PrintStatus;
  error?: string | null;
}

/**
 * Local journal of non-fiscal document prints (order copy, reprint, refund
 * receipt) — records which printer each order copy was sent to and whether it
 * printed. Fiscal prints are journaled separately in `fiscal_attempts`
 * (richer tax-device status); Order History unions both for display.
 */
export const printAttemptRepo = {
  record(input: RecordPrintAttemptInput): PrintAttemptRow {
    const id = randomUUID();
    database.run(
      `INSERT INTO print_attempts (
        id, order_id, document_type, printer_type, printer_name,
        printer_target, route, status, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.orderId,
        input.documentType,
        input.printerType,
        input.printerName ?? null,
        input.printerTarget ?? null,
        input.route ?? null,
        input.status,
        input.error ?? null,
      ],
    );
    database.markDirty();
    return database.get<PrintAttemptRow>('SELECT * FROM print_attempts WHERE id = ?', [id])!;
  },

  findByOrder(orderId: string): PrintAttemptRow[] {
    return database.all<PrintAttemptRow>(
      `SELECT * FROM print_attempts WHERE order_id = ? ORDER BY created_at DESC, id DESC`,
      [orderId],
    );
  },

  /** Latest print attempt for an order, optionally filtered by document type. */
  findLatestByOrder(orderId: string, documentType?: PrintDocumentType): PrintAttemptRow | null {
    if (documentType) {
      return database.get<PrintAttemptRow>(
        `SELECT * FROM print_attempts
         WHERE order_id = ? AND document_type = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [orderId, documentType],
      );
    }
    return database.get<PrintAttemptRow>(
      `SELECT * FROM print_attempts
       WHERE order_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [orderId],
    );
  },
};
