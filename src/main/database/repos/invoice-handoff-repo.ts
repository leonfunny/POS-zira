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
}

export interface EnqueueInvoiceHandoffInput {
  orderId: string;
  salonId: string;
  tenantGeneration: number;
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
        || existing.company_nip !== companyNip
        || existing.document_intent !== 'FISCALISED_RETAIL'
      ) {
        throw idempotencyConflict();
      }
      return existing;
    }

    const createdAt = input.createdAt || nowIso();
    database.run(
      `INSERT INTO invoice_handoffs (
         order_id, idempotency_key, salon_id, tenant_generation, company_nip,
         document_intent, status, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'FISCALISED_RETAIL', 'WAITING_ELIGIBILITY', 0, ?, ?)`,
      [orderId, idempotencyKey, salonId, tenantGeneration, companyNip, createdAt, createdAt],
    );
    return markDirtyAndRead(orderId)!;
  },

  getByOrderId(orderId: string): InvoiceHandoffRow | null {
    return database.get<InvoiceHandoffRow>(
      'SELECT * FROM invoice_handoffs WHERE order_id = ?',
      [orderId],
    );
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

  retry(orderId: string, updatedAt = nowIso()): InvoiceHandoffRow | null {
    database.run(
      `UPDATE invoice_handoffs
       SET status = 'WAITING_ELIGIBILITY', channel_id = NULL,
           next_attempt_at = NULL, last_error_code = NULL, last_error = NULL,
           response_json = NULL, completed_at = NULL, updated_at = ?
       WHERE order_id = ? AND status = 'NEEDS_REVIEW'`,
      [updatedAt, orderId],
    );
    return markDirtyAndRead(orderId);
  },
};

export type InvoiceHandoffRepository = typeof invoiceHandoffRepo;
