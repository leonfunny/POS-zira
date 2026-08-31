import { database } from '../database';

export const INVOICE_HANDOFF_STATUSES = [
  'WAITING_ELIGIBILITY',
  'PENDING',
  'DISPATCHING',
  'COMPLETED',
  'NOT_APPLICABLE',
  'NEEDS_REVIEW',
] as const;

export type InvoiceHandoffStatus = typeof INVOICE_HANDOFF_STATUSES[number];
export type InvoiceHandoffDocumentIntent = 'FISCALISED_RETAIL';

export interface InvoiceHandoffRow {
  seq: number;
  order_id: string;
  idempotency_key: string;
  salon_id: string;
  tenant_generation: number;
  backend_order_id: string | null;
  company_nip: string | null;
  document_intent: InvoiceHandoffDocumentIntent;
  channel_id: string | null;
  status: InvoiceHandoffStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_request_id: string | null;
  last_error_code: string | null;
  last_error: string | null;
  response_json: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  review_kind:
    | 'INITIAL_HANDOFF'
    | 'CANCELLATION_INTENT'
    | 'REFUND_INTENT'
    | 'POST_COMPLETION_CORRECTION'
    | null;
  review_request_id: string | null;
}

export interface EnqueueInvoiceHandoffInput {
  orderId: string;
  salonId: string;
  tenantGeneration: number;
  backendOrderId?: string | null;
  companyNip?: string | null;
  createdAt?: string;
}

function cleanRequired(value: unknown, label: string): string {
  const clean = String(value || '').trim();
  if (!clean) {
    const error = new Error(`invoice-handoff-${label}-required`) as Error & { code?: string };
    error.code = 'INVALID_INVOICE_HANDOFF_INTENT';
    throw error;
  }
  return clean;
}

function cleanGeneration(value: unknown): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    const error = new Error('invoice-handoff-tenant-generation-invalid') as Error & {
      code?: string;
    };
    error.code = 'INVALID_INVOICE_HANDOFF_INTENT';
    throw error;
  }
  return generation;
}

function cleanNip(value: unknown): string | null {
  const digits = String(value || '').replace(/\D/g, '');
  return digits || null;
}

function cleanOptionalId(value: unknown): string | null {
  const clean = String(value || '').trim();
  return clean || null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeError(value: unknown): string {
  return String(value || 'unknown invoice handoff error').trim().slice(0, 2000);
}

function normalizeCode(value: unknown): string | null {
  const code = String(value || '').trim().slice(0, 120);
  return code || null;
}

export function invoiceHandoffIdempotencyKey(orderId: string): string {
  return `pos-invoice:${cleanRequired(orderId, 'order-id')}:v1`;
}

function idempotencyConflict(): Error {
  const error = new Error('invoice-handoff-idempotency-key-reused') as Error & {
    code?: string;
    status?: number;
  };
  error.code = 'IDEMPOTENCY_KEY_REUSED';
  error.status = 409;
  return error;
}

function mutationBlocked(kind: 'cancellation' | 'refund', status: string): Error {
  const error = new Error(`invoice-handoff-${kind}-blocked:${status}`) as Error & {
    code?: string;
  };
  error.code = `INVOICE_HANDOFF_${kind.toUpperCase()}_BLOCKED`;
  return error;
}

function hasImportedEvidence(row: InvoiceHandoffRow): boolean {
  return !!row.completed_at || !!row.response_json;
}

function markDirtyAndRead(orderId: string): InvoiceHandoffRow | null {
  database.markDirty();
  return invoiceHandoffRepo.getByOrderId(orderId);
}

export const invoiceHandoffRepo = {
  enqueue(input: EnqueueInvoiceHandoffInput): InvoiceHandoffRow {
    const orderId = cleanRequired(input.orderId, 'order-id');
    const salonId = cleanRequired(input.salonId, 'salon-id');
    const tenantGeneration = cleanGeneration(input.tenantGeneration);
    const companyNip = cleanNip(input.companyNip);
    const backendOrderId = cleanOptionalId(
      input.backendOrderId
      ?? database.get<{ backend_id: string | null }>(
        'SELECT backend_id FROM orders WHERE id = ?',
        [orderId],
      )?.backend_id,
    );
    const idempotencyKey = invoiceHandoffIdempotencyKey(orderId);
    const existing = database.get<InvoiceHandoffRow>(
      'SELECT * FROM invoice_handoffs WHERE order_id = ? OR idempotency_key = ? LIMIT 1',
      [orderId, idempotencyKey],
    );
    if (existing) {
      if (
        existing.order_id !== orderId
        || existing.idempotency_key !== idempotencyKey
        || existing.salon_id !== salonId
        || Number(existing.tenant_generation) !== tenantGeneration
        || (!!existing.backend_order_id && !!backendOrderId
          && existing.backend_order_id !== backendOrderId)
        || existing.company_nip !== companyNip
        || existing.document_intent !== 'FISCALISED_RETAIL'
      ) {
        throw idempotencyConflict();
      }
      if (!existing.backend_order_id && backendOrderId) {
        database.run(
          `UPDATE invoice_handoffs
           SET backend_order_id = ?, updated_at = ?
           WHERE order_id = ? AND backend_order_id IS NULL`,
          [backendOrderId, nowIso(), orderId],
        );
        return markDirtyAndRead(orderId)!;
      }
      return existing;
    }

    const createdAt = input.createdAt || nowIso();
    database.run(
      `INSERT INTO invoice_handoffs (
         order_id, idempotency_key, salon_id, tenant_generation, backend_order_id, company_nip,
         document_intent, status, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'FISCALISED_RETAIL', 'WAITING_ELIGIBILITY', 0, ?, ?)`,
      [
        orderId,
        idempotencyKey,
        salonId,
        tenantGeneration,
        backendOrderId,
        companyNip,
        createdAt,
        createdAt,
      ],
    );
    return markDirtyAndRead(orderId)!;
  },

  getByOrderId(orderId: string): InvoiceHandoffRow | null {
    return database.get<InvoiceHandoffRow>(
      'SELECT * FROM invoice_handoffs WHERE order_id = ?',
      [orderId],
    );
  },

  getByOrderIdentity(orderId: string, backendOrderId?: string | null): InvoiceHandoffRow | null {
    const backendId = cleanOptionalId(backendOrderId);
    return database.get<InvoiceHandoffRow>(
      `SELECT * FROM invoice_handoffs
       WHERE order_id = ?
          OR (? IS NOT NULL AND backend_order_id = ?)
       ORDER BY CASE WHEN order_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      [orderId, backendId, backendId, orderId],
    );
  },

  bindBackendOrderId(orderId: string, backendOrderId?: string | null): InvoiceHandoffRow | null {
    const backendId = cleanOptionalId(backendOrderId);
    if (!backendId) return this.getByOrderId(orderId);
    const existing = this.getByOrderId(orderId);
    if (!existing) return null;
    if (existing.backend_order_id && existing.backend_order_id !== backendId) {
      throw idempotencyConflict();
    }
    if (!existing.backend_order_id) {
      database.run(
        `UPDATE invoice_handoffs
         SET backend_order_id = ?, updated_at = ?
         WHERE order_id = ? AND backend_order_id IS NULL`,
        [backendId, nowIso(), orderId],
      );
      return markDirtyAndRead(orderId);
    }
    return existing;
  },

  listDue(
    salonId: string,
    tenantGeneration: number,
    now: string,
    limit = 25,
  ): InvoiceHandoffRow[] {
    return database.all<InvoiceHandoffRow>(
      `SELECT * FROM invoice_handoffs
       WHERE salon_id = ? AND tenant_generation = ?
         AND status IN ('WAITING_ELIGIBILITY', 'PENDING', 'DISPATCHING')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY seq ASC LIMIT ?`,
      [salonId, tenantGeneration, now, Math.max(1, limit)],
    );
  },

  listDueDispatching(
    salonId: string,
    tenantGeneration: number,
    now: string,
    limit = 25,
  ): InvoiceHandoffRow[] {
    return database.all<InvoiceHandoffRow>(
      `SELECT * FROM invoice_handoffs
       WHERE salon_id = ? AND tenant_generation = ?
         AND status = 'DISPATCHING'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY seq ASC LIMIT ?`,
      [salonId, tenantGeneration, now, Math.max(1, limit)],
    );
  },

  /**
   * A completed sale handoff is not the end of the source lifecycle: the POS
   * may later receive a full/partial refund or cancellation. Keep this query
   * narrow and source-backed so the runtime only reopens rows with an explicit
   * correction state; ordinary completed rows remain terminal and purgeable.
   */
  listCompletedCorrections(
    salonId: string,
    tenantGeneration: number,
    limit = 25,
  ): InvoiceHandoffRow[] {
    return database.all<InvoiceHandoffRow>(
      `SELECT DISTINCT ih.* FROM invoice_handoffs ih
       INNER JOIN orders o ON (
         o.id = ih.order_id
         OR (
           ih.backend_order_id IS NOT NULL
           AND ih.backend_order_id != ''
           AND (o.id = ih.backend_order_id OR o.backend_id = ih.backend_order_id)
         )
       )
       WHERE ih.salon_id = ? AND ih.tenant_generation = ?
         AND ih.status = 'COMPLETED'
         AND (
           UPPER(COALESCE(o.status, '')) IN ('REFUNDED', 'PARTIAL_REFUND', 'CANCELLED', 'VOIDED')
           OR EXISTS (
             SELECT 1 FROM pos_event_outbox e
             WHERE e.event_type = 'RefundIssued'
               AND (
                 e.local_order_id = ih.order_id
                 OR (ih.backend_order_id IS NOT NULL AND e.local_order_id = ih.backend_order_id)
               )
           )
         )
       ORDER BY ih.seq ASC LIMIT ?`,
      [salonId, tenantGeneration, Math.max(1, limit)],
    );
  },

  flagCompletedCorrections(
    salonId: string,
    tenantGeneration: number,
    updatedAt = nowIso(),
    limit = 25,
  ): number {
    const rows = this.listCompletedCorrections(salonId, tenantGeneration, limit);
    let flagged = 0;
    for (const row of rows) {
      const order = database.get<{ status: string }>(
        `SELECT status FROM orders
         WHERE id = ?
            OR (? IS NOT NULL AND (id = ? OR backend_id = ?))
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
        [
          row.order_id,
          row.backend_order_id,
          row.backend_order_id,
          row.backend_order_id,
          row.order_id,
        ],
      );
      const status = String(order?.status || '').trim().toUpperCase();
      const cancellation = ['CANCELLED', 'VOIDED'].includes(status);
      const changed = this.markCompletedNeedsReview(
        row.order_id,
        cancellation ? 'CANCELLATION_CORRECTION_REQUIRED' : 'REFUND_CORRECTION_REQUIRED',
        cancellation
          ? `Order is ${status}; manual Zira Invoice correction is required`
          : 'POS refund evidence exists after the original Zira Invoice import; manual correction is required',
        updatedAt,
      );
      if (changed?.status === 'NEEDS_REVIEW') flagged += 1;
    }
    return flagged;
  },

  markWaitingEligibility(
    orderId: string,
    nextAttemptAt: string,
    updatedAt = nowIso(),
  ): InvoiceHandoffRow | null {
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'WAITING_ELIGIBILITY', next_attempt_at = ?, channel_id = NULL,
           last_error_code = NULL, last_error = NULL, updated_at = ?
       WHERE order_id = ? AND status IN ('WAITING_ELIGIBILITY', 'PENDING')`,
      [nextAttemptAt, updatedAt, orderId],
    );
    return markDirtyAndRead(orderId);
  },

  markPending(
    orderId: string,
    channelId: string | null,
    updatedAt = nowIso(),
  ): InvoiceHandoffRow | null {
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'PENDING', channel_id = ?, next_attempt_at = NULL,
           last_error_code = NULL, last_error = NULL, updated_at = ?
       WHERE order_id = ? AND status IN ('WAITING_ELIGIBILITY', 'PENDING')`,
      [String(channelId || '').trim() || null, updatedAt, orderId],
    );
    return markDirtyAndRead(orderId);
  },

  markDispatching(
    orderId: string,
    channelId: string,
    requestId: string,
    updatedAt = nowIso(),
  ): InvoiceHandoffRow | null {
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'DISPATCHING', channel_id = ?, attempts = attempts + 1,
           last_request_id = ?, next_attempt_at = NULL,
           last_error_code = NULL, last_error = NULL,
           dispatched_at = ?, updated_at = ?
       WHERE order_id = ? AND status = 'PENDING'`,
      [
        cleanRequired(channelId, 'channel-id'),
        cleanRequired(requestId, 'request-id'),
        updatedAt,
        updatedAt,
        orderId,
      ],
    );
    return markDirtyAndRead(orderId);
  },

  markAmbiguous(
    orderId: string,
    errorCode: string | null,
    error: unknown,
    nextAttemptAt: string,
    updatedAt = nowIso(),
  ): InvoiceHandoffRow | null {
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'DISPATCHING', last_error_code = ?, last_error = ?,
           next_attempt_at = ?, updated_at = ?
       WHERE order_id = ? AND status = 'DISPATCHING'`,
      [normalizeCode(errorCode), normalizeError(error), nextAttemptAt, updatedAt, orderId],
    );
    return markDirtyAndRead(orderId);
  },

  markRetryPending(
    orderId: string,
    errorCode: string | null,
    error: unknown,
    nextAttemptAt: string,
    updatedAt = nowIso(),
  ): InvoiceHandoffRow | null {
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'PENDING', last_error_code = ?, last_error = ?,
           next_attempt_at = ?, updated_at = ?
       WHERE order_id = ? AND status IN ('PENDING', 'DISPATCHING')`,
      [normalizeCode(errorCode), normalizeError(error), nextAttemptAt, updatedAt, orderId],
    );
    return markDirtyAndRead(orderId);
  },

  markCompleted(
    orderId: string,
    responseJson: string,
    completedAt = nowIso(),
  ): InvoiceHandoffRow | null {
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'COMPLETED', response_json = ?, next_attempt_at = NULL,
           last_error_code = NULL, last_error = NULL,
           review_kind = NULL, review_request_id = NULL,
           completed_at = ?, updated_at = ?
       WHERE order_id = ? AND status IN ('PENDING', 'DISPATCHING')`,
      [responseJson, completedAt, completedAt, orderId],
    );
    return markDirtyAndRead(orderId);
  },

  markNotApplicable(
    orderId: string,
    reason: unknown,
    completedAt = nowIso(),
  ): InvoiceHandoffRow | null {
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'NOT_APPLICABLE', next_attempt_at = NULL,
           last_error_code = 'NOT_APPLICABLE', last_error = ?,
           review_kind = NULL, review_request_id = NULL,
           completed_at = ?, updated_at = ?
       WHERE order_id = ? AND status IN ('WAITING_ELIGIBILITY', 'PENDING')`,
      [normalizeError(reason), completedAt, completedAt, orderId],
    );
    return markDirtyAndRead(orderId);
  },

  markNeedsReview(
    orderId: string,
    errorCode: string | null,
    error: unknown,
    responseJson: string | null = null,
    updatedAt = nowIso(),
  ): InvoiceHandoffRow | null {
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'NEEDS_REVIEW', last_error_code = ?, last_error = ?,
           response_json = COALESCE(?, response_json), next_attempt_at = NULL,
           review_kind = COALESCE(review_kind, 'INITIAL_HANDOFF'),
           updated_at = ?
       WHERE order_id = ? AND status != 'COMPLETED'`,
      [
        normalizeCode(errorCode),
        normalizeError(error),
        responseJson,
        updatedAt,
        orderId,
      ],
    );
    return markDirtyAndRead(orderId);
  },

  /**
   * Reopen a remotely completed sale only when the local source subsequently
   * entered an unsupported correction state. Preserve response_json and
   * completed_at as immutable evidence of the original successful import.
   */
  markCompletedNeedsReview(
    orderId: string,
    errorCode: string,
    error: unknown,
    updatedAt = nowIso(),
  ): InvoiceHandoffRow | null {
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'NEEDS_REVIEW', last_error_code = ?, last_error = ?,
           next_attempt_at = NULL, review_kind = 'POST_COMPLETION_CORRECTION',
           review_request_id = NULL,
           updated_at = ?
       WHERE order_id = ? AND status = 'COMPLETED'`,
      [normalizeCode(errorCode), normalizeError(error), updatedAt, orderId],
    );
    return markDirtyAndRead(orderId);
  },

  retry(orderId: string, updatedAt = nowIso()): InvoiceHandoffRow | null {
    const existing = this.getByOrderId(orderId);
    if (!existing || existing.status !== 'NEEDS_REVIEW') return existing;
    const safeInitialRetry = existing.attempts === 0
      && !existing.last_request_id
      && !existing.response_json
      && !existing.completed_at
      && (!existing.review_kind || existing.review_kind === 'INITIAL_HANDOFF');
    if (!safeInitialRetry) {
      const error = new Error('invoice-handoff-review-retry-requires-owner-resolution') as Error & {
        code?: string;
      };
      error.code = 'INVOICE_HANDOFF_RETRY_BLOCKED';
      throw error;
    }
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'WAITING_ELIGIBILITY', channel_id = NULL,
           next_attempt_at = NULL, last_error_code = NULL, last_error = NULL,
           response_json = NULL, completed_at = NULL,
           review_kind = NULL, review_request_id = NULL, updated_at = ?
       WHERE order_id = ? AND status = 'NEEDS_REVIEW'
         AND attempts = 0 AND last_request_id IS NULL
         AND response_json IS NULL AND completed_at IS NULL
         AND COALESCE(review_kind, 'INITIAL_HANDOFF') = 'INITIAL_HANDOFF'`,
      [updatedAt, orderId],
    );
    return markDirtyAndRead(orderId);
  },

  /**
   * Persist a cancellation intent before the backend mutation. Confirmation
   * later turns imported evidence into a correction review, or an undispatched
   * handoff into NOT_APPLICABLE. DISPATCHING is never changed because its
   * remote outcome must first be reconciled.
   */
  prepareForCancellation(
    orderId: string,
    backendOrderId?: string | null,
    updatedAt = nowIso(),
    fallback?: EnqueueInvoiceHandoffInput | null,
  ): InvoiceHandoffRow | null {
    let existing = this.getByOrderIdentity(orderId, backendOrderId);
    if (existing) {
      existing = this.bindBackendOrderId(existing.order_id, backendOrderId);
    }
    if (!existing && fallback) {
      existing = this.enqueue({
        ...fallback,
        orderId,
        backendOrderId,
      });
    }
    if (!existing || existing.status === 'NOT_APPLICABLE') return existing;
    if (
      existing.status === 'NEEDS_REVIEW'
      && existing.review_kind === 'CANCELLATION_INTENT'
    ) {
      return this.bindBackendOrderId(existing.order_id, backendOrderId);
    }
    if (existing.status === 'DISPATCHING' || existing.status === 'NEEDS_REVIEW') {
      throw mutationBlocked('cancellation', existing.status);
    }
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'NEEDS_REVIEW', review_kind = 'CANCELLATION_INTENT',
           review_request_id = NULL, next_attempt_at = NULL,
           last_error_code = 'CANCELLATION_CONFIRMATION_PENDING',
           last_error = 'Server cancellation was prepared locally; its remote outcome must be confirmed',
           backend_order_id = COALESCE(backend_order_id, ?), updated_at = ?
       WHERE order_id = ? AND status = ?`,
      [cleanOptionalId(backendOrderId), updatedAt, existing.order_id, existing.status],
    );
    return markDirtyAndRead(existing.order_id);
  },

  confirmCancellation(
    orderId: string,
    backendOrderId?: string | null,
    confirmedAt = nowIso(),
  ): InvoiceHandoffRow | null {
    let existing = this.getByOrderIdentity(orderId, backendOrderId);
    if (!existing) return null;
    existing = this.bindBackendOrderId(existing.order_id, backendOrderId);
    if (!existing) return null;
    if (existing.review_kind !== 'CANCELLATION_INTENT') return existing;
    if (hasImportedEvidence(existing)) {
      database.run(
        `UPDATE invoice_handoffs
         SET status = 'NEEDS_REVIEW', review_kind = 'POST_COMPLETION_CORRECTION',
             review_request_id = NULL,
             last_error_code = 'CANCELLATION_CORRECTION_REQUIRED',
             last_error = 'The server order was cancelled after the original Zira Invoice import; manual correction is required',
             backend_order_id = COALESCE(backend_order_id, ?),
             updated_at = ?
         WHERE order_id = ? AND status = 'NEEDS_REVIEW'
           AND review_kind = 'CANCELLATION_INTENT'`,
        [cleanOptionalId(backendOrderId), confirmedAt, existing.order_id],
      );
    } else {
      database.run(
        `UPDATE invoice_handoffs
         SET status = 'NOT_APPLICABLE', review_kind = NULL,
             review_request_id = NULL, last_error_code = 'NOT_APPLICABLE',
             last_error = 'Order was cancelled on the server before the original invoice import',
             backend_order_id = COALESCE(backend_order_id, ?),
             completed_at = ?, updated_at = ?
         WHERE order_id = ? AND status = 'NEEDS_REVIEW'
           AND review_kind = 'CANCELLATION_INTENT'`,
        [cleanOptionalId(backendOrderId), confirmedAt, confirmedAt, existing.order_id],
      );
    }
    return markDirtyAndRead(existing.order_id);
  },

  /**
   * Persist the stable backend refund idempotency key before opening the
   * mutation. A replay may resume only the same request id; a different refund
   * can never reuse or overwrite an ambiguous invoice correction intent.
   */
  prepareForRefund(
    orderId: string,
    backendOrderId: string | null | undefined,
    refundRequestId: string,
    updatedAt = nowIso(),
    fallback?: EnqueueInvoiceHandoffInput | null,
  ): InvoiceHandoffRow | null {
    const requestId = cleanRequired(refundRequestId, 'refund-request-id');
    let existing = this.getByOrderIdentity(orderId, backendOrderId);
    if (existing) {
      existing = this.bindBackendOrderId(existing.order_id, backendOrderId);
    }
    if (!existing && fallback) {
      existing = this.enqueue({
        ...fallback,
        orderId,
        backendOrderId,
      });
    }
    if (!existing || existing.status === 'NOT_APPLICABLE') return existing;
    if (existing.status === 'NEEDS_REVIEW' && existing.review_kind === 'REFUND_INTENT') {
      if (existing.review_request_id !== requestId) {
        throw mutationBlocked('refund', 'REQUEST_ID_MISMATCH');
      }
      return this.bindBackendOrderId(existing.order_id, backendOrderId);
    }
    if (existing.status === 'DISPATCHING' || existing.status === 'NEEDS_REVIEW') {
      throw mutationBlocked('refund', existing.status);
    }
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'NEEDS_REVIEW', review_kind = 'REFUND_INTENT',
           review_request_id = ?, next_attempt_at = NULL,
           last_error_code = 'REFUND_CONFIRMATION_PENDING',
           last_error = 'Server refund was prepared locally; its remote outcome must be confirmed with the same request id',
           backend_order_id = COALESCE(backend_order_id, ?), updated_at = ?
       WHERE order_id = ? AND status = ?`,
      [requestId, cleanOptionalId(backendOrderId), updatedAt, existing.order_id, existing.status],
    );
    return markDirtyAndRead(existing.order_id);
  },

  confirmRefund(
    orderId: string,
    backendOrderId: string | null | undefined,
    refundRequestId: string,
    confirmedAt = nowIso(),
  ): InvoiceHandoffRow | null {
    const requestId = cleanRequired(refundRequestId, 'refund-request-id');
    let existing = this.getByOrderIdentity(orderId, backendOrderId);
    if (!existing) return null;
    existing = this.bindBackendOrderId(existing.order_id, backendOrderId);
    if (!existing) return null;
    if (existing.review_kind !== 'REFUND_INTENT') return existing;
    if (existing.review_request_id !== requestId) {
      throw mutationBlocked('refund', 'REQUEST_ID_MISMATCH');
    }
    if (hasImportedEvidence(existing)) {
      database.run(
        `UPDATE invoice_handoffs
         SET status = 'NEEDS_REVIEW', review_kind = 'POST_COMPLETION_CORRECTION',
             last_error_code = 'REFUND_CORRECTION_REQUIRED',
             last_error = 'The server refund completed after the original Zira Invoice import; manual correction is required',
             backend_order_id = COALESCE(backend_order_id, ?), updated_at = ?
         WHERE order_id = ? AND status = 'NEEDS_REVIEW'
           AND review_kind = 'REFUND_INTENT' AND review_request_id = ?`,
        [cleanOptionalId(backendOrderId), confirmedAt, existing.order_id, requestId],
      );
    } else {
      database.run(
        `UPDATE invoice_handoffs
         SET status = 'NOT_APPLICABLE', review_kind = NULL,
             last_error_code = 'NOT_APPLICABLE',
             last_error = 'Order was refunded on the server before the original invoice import',
             backend_order_id = COALESCE(backend_order_id, ?),
             completed_at = ?, updated_at = ?
         WHERE order_id = ? AND status = 'NEEDS_REVIEW'
           AND review_kind = 'REFUND_INTENT' AND review_request_id = ?`,
        [
          cleanOptionalId(backendOrderId),
          confirmedAt,
          confirmedAt,
          existing.order_id,
          requestId,
        ],
      );
    }
    return markDirtyAndRead(existing.order_id);
  },
};

export type InvoiceHandoffRepository = typeof invoiceHandoffRepo;
