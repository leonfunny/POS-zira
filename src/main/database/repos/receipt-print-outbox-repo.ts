import { createHash, randomUUID } from 'crypto';
import { database } from '../database';

export const RECEIPT_PRINT_OUTBOX_STATUSES = [
  'PENDING',
  'DISPATCHING',
  'REMOTE_ACCEPTED',
  'COMPLETED',
  'FAILED_SAFE',
  'NEEDS_REVIEW',
  'CANCELLED',
] as const;

export type ReceiptPrintOutboxStatus = typeof RECEIPT_PRINT_OUTBOX_STATUSES[number];
export type ReceiptPrintOutboxRoute = 'LOCAL' | 'SHARED_NETWORK';
export type ReceiptPrintOutboxFailureClass =
  | 'SAFE_BEFORE_PRINT'
  | 'UNCERTAIN_AFTER_PRINT';
export type ReceiptPrintOutboxDocumentType = 'INITIAL_ORDER_COPY';

export interface ReceiptPrintOutboxRow {
  seq: number;
  job_id: string;
  idempotency_key: string;
  order_id: string;
  salon_id: string;
  device_id: string;
  shift_id: string | null;
  document_type: ReceiptPrintOutboxDocumentType;
  open_drawer: number;
  payload_json: string;
  payload_hash: string;
  route: ReceiptPrintOutboxRoute | null;
  printer_id: string | null;
  remote_job_id: string | null;
  status: ReceiptPrintOutboxStatus;
  failure_class: ReceiptPrintOutboxFailureClass | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
}

export interface EnqueueReceiptPrintInput {
  jobId?: string;
  orderId: string;
  salonId: string;
  deviceId: string;
  shiftId?: string | null;
  openDrawer: boolean;
  payload: unknown;
  createdAt?: string;
}

export interface ReceiptPrintCompletionInput {
  route: ReceiptPrintOutboxRoute;
  printerId?: string | null;
  remoteJobId?: string | null;
  completedAt?: string;
}

export interface ReceiptPrintRemoteAcceptedInput {
  printerId: string;
  remoteJobId: string;
  nextAttemptAt: string;
  error?: string | null;
  updatedAt?: string;
}

export interface ReceiptPrintFailedSafeInput {
  error: string;
  nextAttemptAt: string;
  route?: ReceiptPrintOutboxRoute | null;
  printerId?: string | null;
  updatedAt?: string;
}

export interface ReceiptPrintNeedsReviewInput {
  error: string;
  failureClass?: ReceiptPrintOutboxFailureClass;
  route?: ReceiptPrintOutboxRoute | null;
  printerId?: string | null;
  remoteJobId?: string | null;
  updatedAt?: string;
}

const ORDER_MUTATION_ACTIVE_BLOCKERS: ReceiptPrintOutboxStatus[] = [
  'DISPATCHING',
  'REMOTE_ACCEPTED',
];

const ACTIVE_STATUSES: ReceiptPrintOutboxStatus[] = [
  'PENDING',
  'FAILED_SAFE',
  'REMOTE_ACCEPTED',
];

function cleanRequired(value: unknown, label: string): string {
  const clean = String(value || '').trim();
  if (!clean) {
    const error = new Error(`receipt-print-outbox-${label}-required`) as Error & {
      code?: string;
    };
    error.code = 'INVALID_RECEIPT_PRINT_INTENT';
    throw error;
  }
  return clean;
}

function normalizeError(value: unknown): string {
  return String(value || 'unknown receipt print error').trim().slice(0, 2000);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableValue(record[key])]),
  );
}

/**
 * The exact JSON persisted in the local outbox and sent on every shared-print
 * retry. Sorting object keys prevents harmless construction-order differences
 * from changing the backend idempotency payload hash after a restart.
 */
export function stableReceiptPrintPayloadJson(payload: unknown): string {
  const encoded = JSON.stringify(stableValue(payload));
  if (!encoded || encoded === 'null') {
    const error = new Error('receipt-print-outbox-payload-required') as Error & {
      code?: string;
    };
    error.code = 'INVALID_RECEIPT_PRINT_INTENT';
    throw error;
  }
  return encoded;
}

export function receiptPrintPayloadHash(payloadJson: string): string {
  return `sha256:${createHash('sha256').update(payloadJson, 'utf8').digest('hex')}`;
}

/**
 * Must stay identical to the initial POS receipt key used by
 * shared-receipt-printer. One order on one source device has one initial copy.
 */
export function initialReceiptPrintIdempotencyKey(deviceId: string, orderId: string): string {
  return `pos-receipt:${cleanRequired(deviceId, 'device-id')}:${cleanRequired(orderId, 'order-id')}:order:v1`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function findByIdempotencyKey(idempotencyKey: string): ReceiptPrintOutboxRow | null {
  return database.get<ReceiptPrintOutboxRow>(
    'SELECT * FROM receipt_print_outbox WHERE idempotency_key = ?',
    [idempotencyKey],
  );
}

function transitionAllowed(
  jobId: string,
  allowed: ReceiptPrintOutboxStatus[],
): ReceiptPrintOutboxRow | null {
  const row = receiptPrintOutboxRepo.getByJobId(jobId);
  return row && allowed.includes(row.status) ? row : null;
}

function markDirtyAndRead(jobId: string): ReceiptPrintOutboxRow | null {
  database.markDirty();
  return receiptPrintOutboxRepo.getByJobId(jobId);
}

function idempotencyConflict(): Error {
  const error = new Error('receipt-print-idempotency-key-reused') as Error & {
    code?: string;
    status?: number;
  };
  error.code = 'IDEMPOTENCY_KEY_REUSED';
  error.status = 409;
  return error;
}

function remoteIdentityConflict(): Error {
  const error = new Error('receipt-print-remote-identity-mismatch') as Error & {
    code?: string;
  };
  error.code = 'REMOTE_PRINT_IDENTITY_MISMATCH';
  return error;
}

function orderMutationBlocked(row: ReceiptPrintOutboxRow): Error {
  const error = new Error(
    `Không thể sửa hoặc xóa đơn khi kết quả in ban đầu chưa chắc chắn `
    + `(${row.status}, job ${row.job_id}). Hãy kiểm tra giấy/máy in và xử lý cảnh báo in trước.`,
  ) as Error & { code?: string; receiptPrintJobId?: string };
  error.code = 'RECEIPT_PRINT_OUTCOME_UNCERTAIN';
  error.receiptPrintJobId = row.job_id;
  return error;
}

export const receiptPrintOutboxRepo = {
  enqueue(input: EnqueueReceiptPrintInput): ReceiptPrintOutboxRow {
    const orderId = cleanRequired(input.orderId, 'order-id');
    const salonId = cleanRequired(input.salonId, 'salon-id');
    const deviceId = cleanRequired(input.deviceId, 'device-id');
    const shiftId = String(input.shiftId || '').trim() || null;
    const idempotencyKey = initialReceiptPrintIdempotencyKey(deviceId, orderId);
    const payloadJson = stableReceiptPrintPayloadJson(input.payload);
    const payloadHash = receiptPrintPayloadHash(payloadJson);
    const existing = findByIdempotencyKey(idempotencyKey);

    if (existing) {
      if (
        existing.order_id !== orderId
        || existing.salon_id !== salonId
        || existing.device_id !== deviceId
        || existing.shift_id !== shiftId
        || existing.document_type !== 'INITIAL_ORDER_COPY'
        || existing.open_drawer !== (input.openDrawer ? 1 : 0)
        || existing.payload_hash !== payloadHash
        || existing.payload_json !== payloadJson
      ) {
        throw idempotencyConflict();
      }
      return existing;
    }

    const jobId = String(input.jobId || '').trim() || randomUUID();
    const createdAt = input.createdAt || nowIso();
    database.run(
      `INSERT INTO receipt_print_outbox (
         job_id, idempotency_key, order_id, salon_id, device_id, shift_id,
         document_type, open_drawer, payload_json, payload_hash, status,
         attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'INITIAL_ORDER_COPY', ?, ?, ?, 'PENDING', 0, ?, ?)`,
      [
        jobId,
        idempotencyKey,
        orderId,
        salonId,
        deviceId,
        shiftId,
        input.openDrawer ? 1 : 0,
        payloadJson,
        payloadHash,
        createdAt,
        createdAt,
      ],
    );
    return markDirtyAndRead(jobId)!;
  },

  getByJobId(jobId: string): ReceiptPrintOutboxRow | null {
    return database.get<ReceiptPrintOutboxRow>(
      'SELECT * FROM receipt_print_outbox WHERE job_id = ?',
      [jobId],
    );
  },

  findByIdempotencyKey,

  findInitialByOrder(orderId: string): ReceiptPrintOutboxRow | null {
    return database.get<ReceiptPrintOutboxRow>(
      `SELECT * FROM receipt_print_outbox
       WHERE order_id = ? AND document_type = 'INITIAL_ORDER_COPY'
       ORDER BY seq ASC LIMIT 1`,
      [orderId],
    );
  },

  /**
   * Must run inside the same database transaction as an order mutation.
   *
   * A PENDING/FAILED_SAFE row is known not to have crossed the physical-print
   * boundary, so it is cancelled before the order snapshot can become stale.
   * While dispatch is active, changing/deleting the order could race a
   * paper/drawer side effect, so fail closed. NEEDS_REVIEW is immutable and
   * may accompany a correction or deletion because migration v63 deliberately
   * removed the order cascade; the full warning/evidence row survives.
   */
  prepareInitialForOrderMutation(
    orderId: string,
    reason: string,
    updatedAt = nowIso(),
  ): ReceiptPrintOutboxRow | null {
    const row = receiptPrintOutboxRepo.findInitialByOrder(orderId);
    if (!row) return null;
    if (ORDER_MUTATION_ACTIVE_BLOCKERS.includes(row.status)) {
      throw orderMutationBlocked(row);
    }
    if (row.status === 'PENDING' || row.status === 'FAILED_SAFE') {
      const cancelled = receiptPrintOutboxRepo.cancel(row.job_id, reason, updatedAt);
      if (cancelled?.status !== 'CANCELLED') {
        const latest = receiptPrintOutboxRepo.getByJobId(row.job_id);
        if (latest && ORDER_MUTATION_ACTIVE_BLOCKERS.includes(latest.status)) {
          throw orderMutationBlocked(latest);
        }
        throw new Error(
          `Không thể hủy tác vụ in ban đầu của đơn ${orderId}; đơn chưa được thay đổi.`,
        );
      }
      return cancelled;
    }
    // COMPLETED/CANCELLED/NEEDS_REVIEW are terminal. NEEDS_REVIEW warnings
    // intentionally remain unresolved/visible; there is no implicit operator
    // acknowledgement or status rewrite in the mutation path.
    return row;
  },

  /**
   * The oldest unresolved row is the queue head even when its retry/poll time
   * has not arrived. Callers must not skip it and print a newer receipt first.
   */
  getHead(salonId: string, deviceId: string): ReceiptPrintOutboxRow | null {
    return database.get<ReceiptPrintOutboxRow>(
      `SELECT * FROM receipt_print_outbox
       WHERE salon_id = ? AND device_id = ?
         AND status IN ('PENDING', 'FAILED_SAFE', 'REMOTE_ACCEPTED')
       ORDER BY seq ASC LIMIT 1`,
      [salonId, deviceId],
    );
  },

  listReplayable(
    salonId: string,
    deviceId: string,
    now: string,
    limit = 25,
  ): ReceiptPrintOutboxRow[] {
    return database.all<ReceiptPrintOutboxRow>(
      `SELECT * FROM receipt_print_outbox
       WHERE seq = (
         SELECT seq FROM receipt_print_outbox
         WHERE salon_id = ? AND device_id = ?
           AND status IN ('PENDING', 'FAILED_SAFE', 'REMOTE_ACCEPTED')
         ORDER BY seq ASC LIMIT 1
       )
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY seq ASC LIMIT ?`,
      [salonId, deviceId, now, Math.max(1, limit)],
    );
  },

  markDispatching(jobId: string, updatedAt = nowIso()): ReceiptPrintOutboxRow | null {
    if (!transitionAllowed(jobId, ['PENDING', 'FAILED_SAFE'])) {
      return receiptPrintOutboxRepo.getByJobId(jobId);
    }
    database.run(
      `UPDATE receipt_print_outbox
       SET status = 'DISPATCHING',
           attempts = attempts + 1,
           failure_class = NULL,
           last_error = NULL,
           next_attempt_at = NULL,
           dispatched_at = ?,
           updated_at = ?
       WHERE job_id = ? AND status IN ('PENDING', 'FAILED_SAFE')`,
      [updatedAt, updatedAt, jobId],
    );
    return markDirtyAndRead(jobId);
  },

  markRemoteAccepted(
    jobId: string,
    input: ReceiptPrintRemoteAcceptedInput,
  ): ReceiptPrintOutboxRow | null {
    const existing = transitionAllowed(jobId, ['DISPATCHING', 'REMOTE_ACCEPTED']);
    if (!existing) {
      return receiptPrintOutboxRepo.getByJobId(jobId);
    }
    const printerId = cleanRequired(input.printerId, 'printer-id');
    const remoteJobId = cleanRequired(input.remoteJobId, 'remote-job-id');
    if (
      existing.status === 'REMOTE_ACCEPTED'
      && (
        existing.route !== 'SHARED_NETWORK'
        || existing.printer_id !== printerId
        || existing.remote_job_id !== remoteJobId
      )
    ) {
      throw remoteIdentityConflict();
    }
    const updatedAt = input.updatedAt || nowIso();
    database.run(
      `UPDATE receipt_print_outbox
       SET status = 'REMOTE_ACCEPTED',
           route = 'SHARED_NETWORK',
           printer_id = ?,
           remote_job_id = ?,
           failure_class = NULL,
           last_error = ?,
           next_attempt_at = ?,
           updated_at = ?
      WHERE job_id = ? AND status IN ('DISPATCHING', 'REMOTE_ACCEPTED')`,
      [
        printerId,
        remoteJobId,
        input.error ? normalizeError(input.error) : null,
        input.nextAttemptAt,
        updatedAt,
        jobId,
      ],
    );
    return markDirtyAndRead(jobId);
  },

  markCompleted(
    jobId: string,
    input: ReceiptPrintCompletionInput,
  ): ReceiptPrintOutboxRow | null {
    const existing = transitionAllowed(jobId, ['DISPATCHING', 'REMOTE_ACCEPTED']);
    if (!existing) {
      return receiptPrintOutboxRepo.getByJobId(jobId);
    }
    if (
      existing.status === 'REMOTE_ACCEPTED'
      && (
        input.route !== 'SHARED_NETWORK'
        || (input.printerId != null && input.printerId !== existing.printer_id)
        || (input.remoteJobId != null && input.remoteJobId !== existing.remote_job_id)
      )
    ) {
      throw remoteIdentityConflict();
    }
    const completedAt = input.completedAt || nowIso();
    database.run(
      `UPDATE receipt_print_outbox
       SET status = 'COMPLETED',
           route = ?,
           printer_id = COALESCE(printer_id, ?),
           remote_job_id = COALESCE(remote_job_id, ?),
           failure_class = NULL,
           last_error = NULL,
           next_attempt_at = NULL,
           completed_at = ?,
           updated_at = ?
       WHERE job_id = ? AND status IN ('DISPATCHING', 'REMOTE_ACCEPTED')`,
      [
        input.route,
        input.printerId ?? null,
        input.remoteJobId ?? null,
        completedAt,
        completedAt,
        jobId,
      ],
    );
    return markDirtyAndRead(jobId);
  },

  markFailedSafe(
    jobId: string,
    input: ReceiptPrintFailedSafeInput,
  ): ReceiptPrintOutboxRow | null {
    if (!transitionAllowed(jobId, ['PENDING', 'DISPATCHING', 'FAILED_SAFE'])) {
      return receiptPrintOutboxRepo.getByJobId(jobId);
    }
    const updatedAt = input.updatedAt || nowIso();
    database.run(
      `UPDATE receipt_print_outbox
       SET status = 'FAILED_SAFE',
           route = COALESCE(?, route),
           printer_id = COALESCE(?, printer_id),
           failure_class = 'SAFE_BEFORE_PRINT',
           last_error = ?,
           next_attempt_at = ?,
           updated_at = ?
       WHERE job_id = ? AND status IN ('PENDING', 'DISPATCHING', 'FAILED_SAFE')`,
      [
        input.route ?? null,
        input.printerId ?? null,
        normalizeError(input.error),
        input.nextAttemptAt,
        updatedAt,
        jobId,
      ],
    );
    return markDirtyAndRead(jobId);
  },

  markNeedsReview(
    jobId: string,
    input: ReceiptPrintNeedsReviewInput,
  ): ReceiptPrintOutboxRow | null {
    if (!transitionAllowed(jobId, [
      'PENDING',
      'DISPATCHING',
      'REMOTE_ACCEPTED',
      'FAILED_SAFE',
    ])) {
      return receiptPrintOutboxRepo.getByJobId(jobId);
    }
    const updatedAt = input.updatedAt || nowIso();
    database.run(
      `UPDATE receipt_print_outbox
       SET status = 'NEEDS_REVIEW',
           route = COALESCE(route, ?),
           printer_id = COALESCE(printer_id, ?),
           remote_job_id = COALESCE(remote_job_id, ?),
           failure_class = ?,
           last_error = ?,
           next_attempt_at = NULL,
           updated_at = ?
       WHERE job_id = ?
         AND status IN ('PENDING', 'DISPATCHING', 'REMOTE_ACCEPTED', 'FAILED_SAFE')`,
      [
        input.route ?? null,
        input.printerId ?? null,
        input.remoteJobId ?? null,
        input.failureClass ?? 'UNCERTAIN_AFTER_PRINT',
        normalizeError(input.error),
        updatedAt,
        jobId,
      ],
    );
    return markDirtyAndRead(jobId);
  },

  cancel(jobId: string, reason: string, updatedAt = nowIso()): ReceiptPrintOutboxRow | null {
    // Once dispatch begins, "cancel" cannot prove that paper/drawer side effects
    // did not happen. Only definitively pre-dispatch rows may be cancelled.
    if (!transitionAllowed(jobId, ['PENDING', 'FAILED_SAFE'])) {
      return receiptPrintOutboxRepo.getByJobId(jobId);
    }
    database.run(
      `UPDATE receipt_print_outbox
       SET status = 'CANCELLED',
           failure_class = 'SAFE_BEFORE_PRINT',
           last_error = ?,
           next_attempt_at = NULL,
           updated_at = ?
       WHERE job_id = ? AND status IN ('PENDING', 'FAILED_SAFE')`,
      [normalizeError(reason), updatedAt, jobId],
    );
    return markDirtyAndRead(jobId);
  },

  /**
   * A process died after crossing the durable DISPATCHING boundary. With a
   * local ESC/POS printer there is no authoritative acknowledgement to prove
   * whether WritePrinter ran, so recovery must never auto-reprint these rows.
   * REMOTE_ACCEPTED is deliberately untouched: it has a backend job id and is
   * safe to reconcile by polling that exact job.
   */
  recoverInterruptedDispatches(
    salonId: string,
    deviceId: string,
    updatedAt = nowIso(),
  ): number {
    const interrupted = database.all<ReceiptPrintOutboxRow>(
      `SELECT * FROM receipt_print_outbox
       WHERE salon_id = ? AND device_id = ? AND status = 'DISPATCHING'
       ORDER BY seq ASC`,
      [salonId, deviceId],
    );
    for (const row of interrupted) {
      receiptPrintOutboxRepo.markNeedsReview(row.job_id, {
        error: 'App restarted while receipt dispatch was in progress; check the paper before reprinting',
        failureClass: 'UNCERTAIN_AFTER_PRINT',
        updatedAt,
      });
    }
    return interrupted.length;
  },

  pruneTerminalBefore(cutoff: string): number {
    const terminalCount = database.get<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM receipt_print_outbox
       WHERE status IN ('COMPLETED', 'CANCELLED') AND updated_at < ?`,
      [cutoff],
    )?.count ?? 0;
    if (terminalCount <= 0) return 0;
    database.run(
      `DELETE FROM receipt_print_outbox
       WHERE status IN ('COMPLETED', 'CANCELLED') AND updated_at < ?`,
      [cutoff],
    );
    database.markDirty();
    return terminalCount;
  },

  activeStatuses(): readonly ReceiptPrintOutboxStatus[] {
    return ACTIVE_STATUSES;
  },
};
