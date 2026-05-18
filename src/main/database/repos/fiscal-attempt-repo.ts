import { randomUUID } from 'crypto';
import { database } from '../database';

export type FiscalAttemptStatus =
  | 'PENDING'
  | 'SENT'
  | 'SUCCESS_CONFIRMED'
  | 'FAILED_CONFIRMED'
  | 'UNKNOWN_NEEDS_RECONCILIATION'
  | 'BLOCKED_BY_SAFETY_GATE';

export interface FiscalAttemptRow {
  id: string;
  order_id: string;
  payment_id: string | null;
  attempt_no: number;
  idempotency_key: string;
  printer_type: string;
  payload_json: string;
  payload_hash: string;
  status: FiscalAttemptStatus;
  result_json: string | null;
  error_code: string | null;
  created_at: string | null;
  sent_at: string | null;
  resolved_at: string | null;
}

export interface CreateFiscalAttemptInput {
  orderId: string;
  paymentId?: string | null;
  attemptNo: number;
  idempotencyKey: string;
  printerType: string;
  payloadJson: string;
  payloadHash: string;
}

export interface FiscalAttemptJournal {
  findBlockingAttempt(orderId: string, paymentId?: string | null): FiscalAttemptRow | null;
  getNextAttemptNo(orderId: string, paymentId?: string | null): number;
  createPending(input: CreateFiscalAttemptInput): FiscalAttemptRow;
  markSent(id: string): void;
  markSuccess(id: string, result?: unknown): void;
  markFailed(id: string, errorCode: string, result?: unknown): void;
  markUnknown(id: string, errorCode: string, result?: unknown): void;
  markBlocked(id: string, errorCode: string, result?: unknown): void;
}

const BLOCKING_STATUSES: FiscalAttemptStatus[] = [
  'SUCCESS_CONFIRMED',
  'UNKNOWN_NEEDS_RECONCILIATION',
];

function serialize(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true, text: String(value) });
  }
}

function paymentPredicate(paymentId?: string | null): { sql: string; params: Array<string | null> } {
  if (paymentId) return { sql: 'payment_id = ?', params: [paymentId] };
  return { sql: '1 = 1', params: [] };
}

function markResolved(id: string, status: FiscalAttemptStatus, errorCode?: string, result?: unknown): void {
  database.run(
    `UPDATE fiscal_attempts
     SET status = ?, error_code = ?, result_json = ?, resolved_at = datetime('now')
     WHERE id = ?`,
    [status, errorCode ?? null, serialize(result), id],
  );
  database.save();
}

export const fiscalAttemptRepo: FiscalAttemptJournal & {
  markOpenSentAsUnknownOnStartup(): number;
} = {
  findBlockingAttempt(orderId: string, paymentId?: string | null): FiscalAttemptRow | null {
    const payment = paymentPredicate(paymentId);
    const placeholders = BLOCKING_STATUSES.map(() => '?').join(', ');
    return database.get<FiscalAttemptRow>(
      `SELECT * FROM fiscal_attempts
       WHERE order_id = ?
         AND ${payment.sql}
         AND status IN (${placeholders})
         AND NOT (
           status = 'UNKNOWN_NEEDS_RECONCILIATION'
           AND (
             result_json LIKE '%ReceiptBegin failed:%'
             OR result_json LIKE '%ReceiptConditions failed:%'
           )
         )
       ORDER BY attempt_no DESC
       LIMIT 1`,
      [orderId, ...payment.params, ...BLOCKING_STATUSES],
    );
  },

  getNextAttemptNo(orderId: string, paymentId?: string | null): number {
    const payment = paymentPredicate(paymentId);
    const row = database.get<{ max_attempt: number | null }>(
      `SELECT MAX(attempt_no) as max_attempt
       FROM fiscal_attempts
       WHERE order_id = ?
         AND ${payment.sql}`,
      [orderId, ...payment.params],
    );
    return (row?.max_attempt ?? 0) + 1;
  },

  createPending(input: CreateFiscalAttemptInput): FiscalAttemptRow {
    const id = randomUUID();
    database.run(
      `INSERT INTO fiscal_attempts (
        id, order_id, payment_id, attempt_no, idempotency_key, printer_type,
        payload_json, payload_hash, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.orderId,
        input.paymentId ?? null,
        input.attemptNo,
        input.idempotencyKey,
        input.printerType,
        input.payloadJson,
        input.payloadHash,
        'PENDING',
      ],
    );
    database.save();
    return database.get<FiscalAttemptRow>('SELECT * FROM fiscal_attempts WHERE id = ?', [id])!;
  },

  markSent(id: string): void {
    database.run(
      `UPDATE fiscal_attempts
       SET status = 'SENT', sent_at = datetime('now')
       WHERE id = ?`,
      [id],
    );
    database.save();
  },

  markSuccess(id: string, result?: unknown): void {
    markResolved(id, 'SUCCESS_CONFIRMED', undefined, result);
  },

  markFailed(id: string, errorCode: string, result?: unknown): void {
    markResolved(id, 'FAILED_CONFIRMED', errorCode, result);
  },

  markUnknown(id: string, errorCode: string, result?: unknown): void {
    markResolved(id, 'UNKNOWN_NEEDS_RECONCILIATION', errorCode, result);
  },

  markBlocked(id: string, errorCode: string, result?: unknown): void {
    markResolved(id, 'BLOCKED_BY_SAFETY_GATE', errorCode, result);
  },

  markOpenSentAsUnknownOnStartup(): number {
    const row = database.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM fiscal_attempts WHERE status = 'SENT'",
    );
    const count = row?.count ?? 0;
    if (count > 0) {
      database.run(
        `UPDATE fiscal_attempts
         SET status = 'UNKNOWN_NEEDS_RECONCILIATION',
             error_code = 'APP_RESTART_AFTER_SENT',
             result_json = ?,
             resolved_at = datetime('now')
         WHERE status = 'SENT'`,
        [JSON.stringify({ reason: 'App restarted with fiscal attempt left in SENT state' })],
      );
      database.save();
    }
    return count;
  },
};
