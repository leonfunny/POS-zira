import { createHash, randomUUID } from 'crypto';
import { database } from '../database';
import logger from '../../logger';
import { invoiceHandoffRepo } from './invoice-handoff-repo';
import type { ReceiptData } from '../../../shared/types';

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

export interface InvoiceHandoffRuntimeContext {
  salonId: string;
  companyNip?: string | null;
}

// Fail-closed local activation gate. Once the owner-bound salon/NIP/channel
// scope is valid, the provider journals eligible fiscal sales durably even if
// the remote Zira bridge is unavailable. Remote authentication and dispatch
// remain separate gates in InvoiceGatewayModule.
let invoiceHandoffContextProvider: (() => InvoiceHandoffRuntimeContext | null) | null = null;

export function configureInvoiceHandoffContextProvider(
  provider: (() => InvoiceHandoffRuntimeContext | null) | null,
): void {
  invoiceHandoffContextProvider = provider;
}

function serialize(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true, text: String(value) });
  }
}

function resultRecord(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function canonicalRemoteEvidence(
  value: unknown,
  jobId?: string | null,
  printerId?: string | null,
): Record<string, unknown> | null {
  const current = resultRecord(value);
  const cleanJobId = String(jobId ?? '').trim()
    || String(current.jobId ?? current.id ?? '').trim();
  const cleanPrinterId = String(printerId ?? '').trim()
    || String(current.printerId ?? '').trim();
  if (!cleanJobId || !cleanPrinterId) return null;
  return {
    ...current,
    remote: true,
    jobId: cleanJobId,
    printerId: cleanPrinterId,
  };
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

/**
 * Only a confirmed, original retail sale can create a Zira Invoice handoff.
 * Refunds and copies/reprints are different fiscal operations and must never
 * create a new FISCALISED_RETAIL semantic intent. Invalid/legacy snapshots
 * fail closed for the optional handoff while the fiscal journal remains the
 * source of truth.
 */
function isFiscalisedRetailSale(payload: unknown): payload is ReceiptData {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const receipt = payload as Partial<ReceiptData>;
  return receipt.isRefund !== true
    && receipt.isReprint !== true
    && Array.isArray(receipt.items)
    && receipt.items.length > 0
    && !!receipt.payment
    && typeof receipt.payment === 'object'
    && Number.isFinite(Number(receipt.total));
}

function parseFiscalisedRetailSale(payloadJson: string): ReceiptData | null {
  try {
    const payload = JSON.parse(payloadJson);
    return isFiscalisedRetailSale(payload) ? payload : null;
  } catch {
    return null;
  }
}

const INVOICE_HANDOFF_BACKFILL_CURSOR_KEY = '__zira_invoice_handoff_backfill_cursor_v2';
const LEGACY_INVOICE_HANDOFF_BACKFILL_CURSOR_KEY = '__zira_invoice_handoff_backfill_cursor_v1';
const INVOICE_HANDOFF_BACKFILL_PAGE_SIZE = 100;
const INVOICE_HANDOFF_BACKFILL_MAX_SCAN = 10_000;

interface InvoiceHandoffBackfillCursor {
  version: 2;
  orderId: string;
  attemptNo: number | null;
  attemptId: string | null;
  orderComplete: boolean;
}

interface InvoiceHandoffBackfillAttempt {
  order_id: string;
  attempt_no: number;
  attempt_id: string;
  printer_type: string;
  payload_json: string;
  result_json: string | null;
}

function parseInvoiceHandoffBackfillCursor(value: unknown): InvoiceHandoffBackfillCursor | null {
  try {
    const parsed = JSON.parse(String(value || '')) as Partial<InvoiceHandoffBackfillCursor>;
    const orderId = String(parsed.orderId || '').trim();
    if (parsed.version !== 2 || !orderId || typeof parsed.orderComplete !== 'boolean') return null;
    if (parsed.orderComplete) {
      return { version: 2, orderId, attemptNo: null, attemptId: null, orderComplete: true };
    }
    const attemptNo = Number(parsed.attemptNo);
    const attemptId = String(parsed.attemptId || '').trim();
    if (
      !Number.isSafeInteger(attemptNo)
      || !attemptId
    ) return null;
    return { version: 2, orderId, attemptNo, attemptId, orderComplete: false };
  } catch {
    return null;
  }
}

function readInvoiceHandoffBackfillCursor(): InvoiceHandoffBackfillCursor | null {
  const legacy = database.get<{ value: string }>(
    'SELECT value FROM sync_metadata WHERE key = ?',
    [LEGACY_INVOICE_HANDOFF_BACKFILL_CURSOR_KEY],
  );
  if (legacy !== null && legacy !== undefined) {
    // v1 used SQLite rowid as its tie-breaker. Never reinterpret it after the
    // stable-id upgrade: clear both formats and rescan from the beginning.
    clearInvoiceHandoffBackfillCursor(true);
    return null;
  }
  const row = database.get<{ value: string }>(
    'SELECT value FROM sync_metadata WHERE key = ?',
    [INVOICE_HANDOFF_BACKFILL_CURSOR_KEY],
  );
  if (row === null || row === undefined) return null;
  const cursor = parseInvoiceHandoffBackfillCursor(row.value);
  if (!cursor) clearInvoiceHandoffBackfillCursor();
  return cursor;
}

function writeInvoiceHandoffBackfillCursor(cursor: InvoiceHandoffBackfillCursor): void {
  database.run(
    `INSERT OR REPLACE INTO sync_metadata (key, value, updated_at)
     VALUES (?, ?, datetime('now'))`,
    [INVOICE_HANDOFF_BACKFILL_CURSOR_KEY, JSON.stringify(cursor)],
  );
}

function clearInvoiceHandoffBackfillCursor(includeLegacy = false): void {
  database.run(
    includeLegacy
      ? 'DELETE FROM sync_metadata WHERE key IN (?, ?)'
      : 'DELETE FROM sync_metadata WHERE key = ?',
    includeLegacy
      ? [INVOICE_HANDOFF_BACKFILL_CURSOR_KEY, LEGACY_INVOICE_HANDOFF_BACKFILL_CURSOR_KEY]
      : [INVOICE_HANDOFF_BACKFILL_CURSOR_KEY],
  );
}

function cursorForBackfillAttempt(
  attempt: InvoiceHandoffBackfillAttempt,
): InvoiceHandoffBackfillCursor | null {
  const orderId = String(attempt.order_id || '').trim();
  const attemptNo = Number(attempt.attempt_no);
  const attemptId = String(attempt.attempt_id || '').trim();
  if (
    !orderId
    || !Number.isSafeInteger(attemptNo)
    || !attemptId
  ) return null;
  return { version: 2, orderId, attemptNo, attemptId, orderComplete: false };
}

export function normalizeValidPolishNip(value: unknown): string | null {
  const digits = String(value || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(digits)) return null;
  // All-identical placeholders (notably 0000000000) satisfy the arithmetic
  // checksum but are not valid taxpayer identities and are rejected by the
  // receiving Zira Invoice contract as well.
  if (new Set(digits).size === 1) return null;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const checksum = weights.reduce(
    (sum, weight, index) => sum + Number(digits[index]) * weight,
    0,
  ) % 11;
  return checksum !== 10 && checksum === Number(digits[9]) ? digits : null;
}

function tryEnsureInvoiceHandoff(orderId: string, payload: unknown): boolean {
  const cleanOrderId = String(orderId || '').trim();
  if (!cleanOrderId || !isFiscalisedRetailSale(payload)) return false;
  try {
    const context = invoiceHandoffContextProvider?.() ?? null;
    const salonId = String(context?.salonId || '').trim();
    if (!salonId) {
      logger.debug(
        `[FiscalAttemptRepo] Invoice handoff skipped for ${cleanOrderId}: no active salon`,
      );
      return false;
    }
    const companyNip = normalizeValidPolishNip(context?.companyNip);
    const fiscalPayloadNip = normalizeValidPolishNip((payload as ReceiptData).sellerNip);
    if (!companyNip || !fiscalPayloadNip || companyNip !== fiscalPayloadNip) {
      logger.debug(
        `[FiscalAttemptRepo] Invoice handoff skipped for ${cleanOrderId}: `
        + 'fiscal payload seller NIP is missing, invalid, or differs from the active context',
      );
      return false;
    }
    invoiceHandoffRepo.enqueue({
      orderId: cleanOrderId,
      salonId,
      tenantGeneration: database.getTenantGeneration(),
      companyNip,
    });
    return true;
  } catch (error) {
    // Fiscal printing is legally/operationally primary. The durable fiscal
    // row remains backfillable on activation; bridge bookkeeping cannot turn
    // a valid fiscal print into a checkout failure.
    logger.warn(
      `[FiscalAttemptRepo] Invoice handoff unavailable for ${cleanOrderId}; `
      + `fiscal flow continues: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export const fiscalAttemptRepo: FiscalAttemptJournal & {
  markOpenSentAsUnknownOnStartup(): number;
  findLatestByOrder(orderId: string): FiscalAttemptRow | null;
  findLatestRemoteByOrder(orderId: string): FiscalAttemptRow | null;
  getConfirmedOrderIds(orderIds: string[]): string[];
  getReceiptSnapshot(orderId: string): any | null;
  getOriginalSaleReceiptSnapshot(orderId: string): ReceiptData | null;
  backfillFiskalColumns(): number;
  backfillInvoiceHandoffs(limit?: number): number;
  recordRemoteFiscalSuccess(
    orderId: string,
    jobId?: string | null,
    printerId?: string | null,
    receiptData?: ReceiptData | null,
  ): void;
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
  recordRemoteFiscalSuccess(
    orderId: string,
    jobId?: string | null,
    printerId?: string | null,
    receiptData?: ReceiptData | null,
  ): void {
    if (!orderId) return;
    const existing = database.get<FiscalAttemptRow>(
      `SELECT * FROM fiscal_attempts
       WHERE order_id = ? AND status = 'SUCCESS_CONFIRMED'
       ORDER BY CASE WHEN printer_type = 'REMOTE' THEN 0 ELSE 1 END,
                attempt_no DESC
       LIMIT 1`,
      [orderId],
    );
    if (existing) {
      if (existing.printer_type === 'REMOTE') {
        const evidence = canonicalRemoteEvidence(existing.result_json, jobId, printerId);
        if (evidence) {
          const resultJson = serialize(evidence)!;
          if (resultJson !== existing.result_json) {
            database.run(
              `UPDATE fiscal_attempts
               SET result_json = ?
               WHERE id = ? AND printer_type = 'REMOTE' AND status = 'SUCCESS_CONFIRMED'`,
              [resultJson, existing.id],
            );
            database.markDirty();
          }
          tryEnsureInvoiceHandoff(orderId, receiptData);
        }
      } else {
        tryEnsureInvoiceHandoff(orderId, receiptData);
      }
      return;
    }
    const payloadJson = receiptData ? JSON.stringify(receiptData) : '{}';
    const payloadHash = receiptData
      ? createHash('sha256').update(payloadJson).digest('hex')
      : '';
    const id = randomUUID();
    const remoteEvidence = canonicalRemoteEvidence(null, jobId, printerId);
    database.run(
      `INSERT INTO fiscal_attempts (
        id, order_id, payment_id, attempt_no, idempotency_key, printer_type,
        payload_json, payload_hash, status, sent_at, resolved_at, result_json
      ) VALUES (?, ?, NULL, ?, ?, 'REMOTE', ?, ?, 'SUCCESS_CONFIRMED', datetime('now'), datetime('now'), ?)`,
      [
        id,
        orderId,
        fiscalAttemptRepo.getNextAttemptNo(orderId, null),
        `remote-${jobId || orderId}`,
        payloadJson,
        payloadHash,
        serialize(remoteEvidence ?? {
          remote: true,
          jobId: jobId ?? null,
          printerId: printerId ?? null,
        }),
      ],
    );
    database.markDirty();
    if (remoteEvidence) tryEnsureInvoiceHandoff(orderId, receiptData);
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

  /**
   * Durable identity/snapshot for fiscal jobs delegated to another POS.
   * Retaining the first payload is essential: order sync may replace the
   * display number while the backend idempotency key intentionally stays tied
   * to the immutable local order id.
   */
  findLatestRemoteByOrder(orderId: string): FiscalAttemptRow | null {
    return database.get<FiscalAttemptRow>(
      `SELECT * FROM fiscal_attempts
       WHERE order_id = ? AND printer_type = 'REMOTE'
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
      const remoteEvidence = attempt.printer_type === 'REMOTE'
        ? canonicalRemoteEvidence(attempt.result_json)
        : null;
      const result = remoteEvidence
        ? { ...remoteEvidence, ...reconciliation }
        : reconciliation;
      markResolved(attempt.id, 'SUCCESS_CONFIRMED', undefined, result);
      const receipt = parseFiscalisedRetailSale(attempt.payload_json);
      if (receipt && (attempt.printer_type !== 'REMOTE' || remoteEvidence)) {
        tryEnsureInvoiceHandoff(orderId, receipt);
      }
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

  /**
   * Return the newest trustworthy original-sale payload, not merely the last
   * successful fiscal operation. A later refund or reprint must never hide
   * the immutable sale evidence used to fence backend mutations.
   */
  getOriginalSaleReceiptSnapshot(orderId: string): ReceiptData | null {
    const rows = database.all<{
      printer_type: string;
      payload_json: string;
      result_json: string | null;
    }>(
      `SELECT printer_type, payload_json, result_json
       FROM fiscal_attempts
       WHERE order_id = ? AND status = 'SUCCESS_CONFIRMED'
       ORDER BY attempt_no DESC, id DESC`,
      [orderId],
    );
    for (const row of rows) {
      const receipt = parseFiscalisedRetailSale(row.payload_json);
      if (!receipt) continue;
      if (row.printer_type === 'REMOTE' && !canonicalRemoteEvidence(row.result_json)) {
        continue;
      }
      return receipt;
    }
    return null;
  },

  /**
   * Bounded activation backfill for receipts confirmed while the optional
   * runtime was inactive. Only orders that are still COMPLETED are candidates;
   * refunded/cancelled history belongs to the future adjustment contract and
   * must not create a purge-blocking v1 handoff.
   *
   * Eligibility needs JSON, remote-evidence, and NIP checks that cannot safely
   * be reduced to SQL. Page by the journal's stable sort key instead of applying
   * one LIMIT before those checks: otherwise 100 legacy reprints/bad snapshots
   * permanently hide every valid sale behind them. The cursor is only progress
   * metadata (never fiscal evidence); a crash may repeat work but cannot skip a
   * sale. A hard scan cap keeps activation bounded, while the persisted cursor
   * lets a later activation continue through an unusually large legacy journal.
   */
  backfillInvoiceHandoffs(limit = 100): number {
    const requested = Number.isFinite(limit) ? Math.floor(limit) : 100;
    const boundedLimit = Math.min(500, Math.max(1, requested));
    const scanLimit = Math.min(
      INVOICE_HANDOFF_BACKFILL_MAX_SCAN,
      Math.max(1_000, boundedLimit * 20),
    );
    let cursor = readInvoiceHandoffBackfillCursor();
    let cursorPersisted = cursor !== null;
    let scanned = 0;
    let ensured = 0;
    const handled = new Set<string>();

    while (scanned < scanLimit && ensured < boundedLimit) {
      const pageLimit = Math.min(
        INVOICE_HANDOFF_BACKFILL_PAGE_SIZE,
        scanLimit - scanned,
      );
      const cursorClause = cursor
        ? cursor.orderComplete
          ? 'AND fa.order_id > ?'
          : `AND (
               fa.order_id > ?
               OR (
                 fa.order_id = ?
                 AND (
                   fa.attempt_no < ?
                   OR (fa.attempt_no = ? AND fa.id < ?)
                 )
               )
             )`
        : '';
      const cursorParams = cursor
        ? cursor.orderComplete
          ? [cursor.orderId]
          : [
              cursor.orderId,
              cursor.orderId,
              cursor.attemptNo,
              cursor.attemptNo,
              cursor.attemptId,
            ]
        : [];
      const attempts = database.all<InvoiceHandoffBackfillAttempt>(
        `SELECT fa.order_id, fa.attempt_no, fa.id AS attempt_id,
                fa.printer_type, fa.payload_json, fa.result_json
         FROM fiscal_attempts fa
         INNER JOIN orders o ON o.id = fa.order_id
         WHERE fa.status = 'SUCCESS_CONFIRMED'
           AND UPPER(COALESCE(o.status, '')) = 'COMPLETED'
           AND NOT EXISTS (
             SELECT 1 FROM invoice_handoffs ih WHERE ih.order_id = fa.order_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM pos_event_outbox e
             WHERE e.local_order_id = fa.order_id AND e.event_type = 'RefundIssued'
           )
           ${cursorClause}
         ORDER BY fa.order_id ASC, fa.attempt_no DESC, fa.id DESC
         LIMIT ?`,
        [...cursorParams, pageLimit],
      );

      if (attempts.length === 0) {
        if (cursorPersisted) clearInvoiceHandoffBackfillCursor();
        return ensured;
      }

      let stoppedEarly = false;
      for (const attempt of attempts) {
        const nextCursor = cursorForBackfillAttempt(attempt);
        if (!nextCursor) {
          logger.warn('[FiscalAttemptRepo] Invoice handoff backfill stopped on an invalid journal cursor');
          stoppedEarly = true;
          break;
        }
        scanned += 1;
        const orderId = nextCursor.orderId;

        // Once the newest eligible original attempt for an order was chosen,
        // older duplicates must never replace it. Keep the order-complete cursor
        // while consuming any remaining same-order rows already in this page.
        if (handled.has(orderId)) continue;
        cursor = nextCursor;

        const receipt = parseFiscalisedRetailSale(attempt.payload_json);
        if (!receipt) continue;
        if (
          attempt.printer_type === 'REMOTE'
          && !canonicalRemoteEvidence(attempt.result_json)
        ) {
          continue;
        }

        if (tryEnsureInvoiceHandoff(orderId, receipt)) {
          ensured += 1;
          handled.add(orderId);
          cursor = {
            version: 2,
            orderId,
            attemptNo: null,
            attemptId: null,
            orderComplete: true,
          };
        }
        if (ensured >= boundedLimit) {
          stoppedEarly = true;
          break;
        }
      }

      if (!cursor) return ensured;
      if (stoppedEarly || scanned >= scanLimit) {
        writeInvoiceHandoffBackfillCursor(cursor);
        return ensured;
      }
      if (attempts.length < pageLimit) {
        if (cursorPersisted) clearInvoiceHandoffBackfillCursor();
        return ensured;
      }
      writeInvoiceHandoffBackfillCursor(cursor);
      cursorPersisted = true;
    }

    if (cursor) writeInvoiceHandoffBackfillCursor(cursor);
    return ensured;
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
    const attempt = database.get<{
      order_id: string;
      payload_json: string;
      printer_type: string;
      result_json: string | null;
    }>(
      'SELECT order_id, payload_json, printer_type, result_json FROM fiscal_attempts WHERE id = ?',
      [id],
    );
    if (attempt?.order_id) {
      const receipt = parseFiscalisedRetailSale(attempt.payload_json);
      let remoteEvidenceValid = attempt.printer_type !== 'REMOTE';
      if (attempt.printer_type === 'REMOTE') {
        const remoteEvidence = canonicalRemoteEvidence(attempt.result_json);
        if (remoteEvidence) {
          const resultJson = serialize(remoteEvidence)!;
          if (resultJson !== attempt.result_json) {
            database.run(
              `UPDATE fiscal_attempts
               SET result_json = ?
               WHERE id = ? AND printer_type = 'REMOTE' AND status = 'SUCCESS_CONFIRMED'`,
              [resultJson, id],
            );
            database.markDirty();
          }
          remoteEvidenceValid = true;
        }
      }
      if (receipt && remoteEvidenceValid) tryEnsureInvoiceHandoff(attempt.order_id, receipt);
    }
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
