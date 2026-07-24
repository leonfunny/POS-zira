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
  fiskal_number?: string | null;
  gross_total?: number | null;
  fiscalized_at?: string | null;
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
  flush(): Promise<{ success: boolean; error?: string }>;
  findBlockingAttempt(orderId: string, paymentId?: string | null): FiscalAttemptRow | null;
  findReconcilableAttempt(orderId: string, paymentId?: string | null): FiscalAttemptRow | null;
  resolveReconcilable(orderId: string, didPrint: boolean, paymentId?: string | null): FiscalAttemptRow | null;
  getNextAttemptNo(orderId: string, paymentId?: string | null): number;
  createPending(input: CreateFiscalAttemptInput): FiscalAttemptRow;
  markSent(id: string): void;
  markSuccess(id: string, result?: unknown): void;
  markFailed(id: string, errorCode: string, result?: unknown): void;
  markUnknown(id: string, errorCode: string, result?: unknown): void;
  markBlocked(id: string, errorCode: string, result?: unknown): void;
}

const BLOCKING_STATUSES: FiscalAttemptStatus[] = [
  'SENT',
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

function projectFromPayload(payloadJson: string): { fiskalNumber: string | null; grossTotal: number | null } {
  try {
    const payload = JSON.parse(payloadJson);
    const fiskalNumber = typeof payload?.orderNumber === 'string' ? payload.orderNumber : null;
    const grossTotal = Number.isFinite(Number(payload?.total)) ? Math.round(Number(payload.total)) : null;
    return { fiskalNumber, grossTotal };
  } catch {
    return { fiskalNumber: null, grossTotal: null };
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
  database.markDirty();
}

export const fiscalAttemptRepo: FiscalAttemptJournal & {
  markOpenSentAsUnknownOnStartup(): number;
  findLatestByOrder(orderId: string): FiscalAttemptRow | null;
  getConfirmedOrderIds(orderIds: string[]): string[];
  getReceiptSnapshot(orderId: string): any | null;
  backfillFiskalColumns(): number;
  recordRemoteFiscalSuccess(orderId: string, jobId?: string | null, printerId?: string | null): void;
} = {
  async flush(): Promise<{ success: boolean; error?: string }> {
    const result = await database.saveCoalesced();
    return result.success
      ? { success: true }
      : { success: false, error: result.error || 'Database durability flush failed' };
  },

  /**
   * Which of these orders have a confirmed fiscal paragon in the local
   * journal. Used by Order History to apply the fiscal-visibility filter to
   * server-sourced rows (which don't carry the SQL-computed has_fiscal).
   */
  getConfirmedOrderIds(orderIds: string[]): string[] {
    if (orderIds.length === 0) return [];
    const placeholders = orderIds.map(() => '?').join(', ');
    return database
      .all<{ order_id: string }>(
        `SELECT DISTINCT order_id FROM fiscal_attempts
         WHERE status = 'SUCCESS_CONFIRMED' AND order_id IN (${placeholders})`,
        orderIds,
      )
      .map((r) => r.order_id);
  },

  /**
   * Record a paragon printed REMOTELY (shared FISCAL_RECEIPT job on another
   * POS's fiscal printer) so THIS terminal's history and fiscal-visibility
   * filter see the order as fiscalized. Without this, a kiosk/POS that
   * routes fiscal printing to another machine has has_fiscal=0 for every
   * order it sells. Idempotent: one confirmed row per order is enough.
   */
  recordRemoteFiscalSuccess(orderId: string, jobId?: string | null, printerId?: string | null): void {
    if (!orderId) return;
    const existing = database.get<{ id: string }>(
      `SELECT id FROM fiscal_attempts WHERE order_id = ? AND status = 'SUCCESS_CONFIRMED' LIMIT 1`,
      [orderId],
    );
    if (existing) return;
    const id = randomUUID();
    database.run(
      `INSERT INTO fiscal_attempts (
        id, order_id, payment_id, attempt_no, idempotency_key, printer_type,
        payload_json, payload_hash, status, sent_at, resolved_at, result_json
      ) VALUES (?, ?, NULL, ?, ?, 'REMOTE', '{}', '', 'SUCCESS_CONFIRMED', datetime('now'), datetime('now'), ?)`,
      [
        id,
        orderId,
        fiscalAttemptRepo.getNextAttemptNo(orderId, null),
        `remote-${jobId || orderId}`,
        serialize({ remote: true, jobId: jobId ?? null, printerId: printerId ?? null }),
      ],
    );
    database.markDirty();
  },

  // Latest fiscal attempt for an order, any status — used by Order History to
  // render the fiscal print badge (printed / failed / needs-reconcile).
  findLatestByOrder(orderId: string): FiscalAttemptRow | null {
    return database.get<FiscalAttemptRow>(
      `SELECT * FROM fiscal_attempts
       WHERE order_id = ?
       ORDER BY attempt_no DESC
       LIMIT 1`,
      [orderId],
    );
  },

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

  // Latest attempt left in UNKNOWN_NEEDS_RECONCILIATION for an order. Unlike
  // findBlockingAttempt this does NOT exclude pre-print (ReceiptBegin/Conditions)
  // failures — the operator-facing reconcile UI surfaces every unresolved
  // unknown so a stuck order can always be cleared by a human who checked the
  // physical printer.
  findReconcilableAttempt(orderId: string, paymentId?: string | null): FiscalAttemptRow | null {
    const payment = paymentPredicate(paymentId);
    return database.get<FiscalAttemptRow>(
      `SELECT * FROM fiscal_attempts
       WHERE order_id = ?
         AND ${payment.sql}
         AND status = 'UNKNOWN_NEEDS_RECONCILIATION'
       ORDER BY attempt_no DESC
       LIMIT 1`,
      [orderId, ...payment.params],
    );
  },

  // Operator-driven resolution of a stuck unknown attempt after they verified
  // the physical printer. didPrint=true → the receipt is already fiscalized
  // (SUCCESS_CONFIRMED, no reprint). didPrint=false → nothing printed
  // (FAILED_CONFIRMED), which clears the safety gate so a fresh receipt can be
  // printed. Returns the resolved row, or null if there was nothing to resolve.
  resolveReconcilable(orderId: string, didPrint: boolean, paymentId?: string | null): FiscalAttemptRow | null {
    const attempt = this.findReconcilableAttempt(orderId, paymentId);
    if (!attempt) return null;
    const reconciliation = { reconciledBy: 'operator', didPrint, reconciledAt: new Date().toISOString() };
    if (didPrint) {
      markResolved(attempt.id, 'SUCCESS_CONFIRMED', undefined, reconciliation);
    } else {
      markResolved(attempt.id, 'FAILED_CONFIRMED', 'OPERATOR_RECONCILED_NOT_PRINTED', reconciliation);
    }
    return database.get<FiscalAttemptRow>('SELECT * FROM fiscal_attempts WHERE id = ?', [attempt.id]);
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
    const { fiskalNumber, grossTotal } = projectFromPayload(input.payloadJson);
    database.run(
      `INSERT INTO fiscal_attempts (
        id, order_id, payment_id, attempt_no, idempotency_key, printer_type,
        payload_json, payload_hash, status, fiskal_number, gross_total, fiscalized_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
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
        fiskalNumber,
        grossTotal,
      ],
    );
    database.markDirty();
    return database.get<FiscalAttemptRow>('SELECT * FROM fiscal_attempts WHERE id = ?', [id])!;
  },

  getReceiptSnapshot(orderId: string): any | null {
    const row = database.get<{ payload_json: string }>(
      `SELECT payload_json FROM fiscal_attempts
       WHERE order_id = ? AND status = 'SUCCESS_CONFIRMED'
       ORDER BY attempt_no DESC
       LIMIT 1`,
      [orderId],
    );
    if (!row?.payload_json) return null;
    try {
      return JSON.parse(row.payload_json);
    } catch {
      return null;
    }
  },

  backfillFiskalColumns(): number {
    const rows = database.all<{ id: string; payload_json: string; resolved_at: string | null; created_at: string | null }>(
      `SELECT id, payload_json, resolved_at, created_at FROM fiscal_attempts
       WHERE fiskal_number IS NULL AND payload_json LIKE '{%'`,
    );
    let updated = 0;
    for (const row of rows) {
      const { fiskalNumber, grossTotal } = projectFromPayload(row.payload_json);
      database.run(
        `UPDATE fiscal_attempts
         SET fiskal_number = ?, gross_total = ?, fiscalized_at = ?
         WHERE id = ?`,
        [fiskalNumber, grossTotal, row.resolved_at ?? row.created_at ?? null, row.id],
      );
      updated++;
    }
    if (updated > 0) database.markDirty();
    return updated;
  },

  markSent(id: string): void {
    database.run(
      `UPDATE fiscal_attempts
       SET status = 'SENT', sent_at = datetime('now')
       WHERE id = ?`,
      [id],
    );
    database.markDirty();
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
      database.markDirty();
    }
    return count;
  },
};
