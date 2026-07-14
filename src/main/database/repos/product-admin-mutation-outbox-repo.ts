import { randomUUID } from 'crypto';
import { database } from '../database';

export type ProductAdminMutationType =
  | 'CREATE_PRODUCT'
  | 'CREATE_CATEGORY'
  | 'ADJUST_STOCK'
  | 'RECEIVE_STOCK'
  | 'UPLOAD_MAIN_IMAGE';

export type ProductAdminMutationStatus =
  | 'PENDING'
  | 'IN_FLIGHT'
  | 'COMMITTED'
  | 'APPLIED'
  | 'FAILED_FINAL';

export interface ProductAdminMutationOutboxRow {
  mutation_id: string;
  tenant_key: string;
  device_id: string;
  mutation_type: ProductAdminMutationType;
  target_variant_id: string | null;
  idempotency_key: string | null;
  intent_hash: string;
  request_json: string;
  staged_file_path: string | null;
  staged_file_hash: string | null;
  status: ProductAdminMutationStatus;
  attempts: number;
  outcome_ambiguous: number;
  dispatched_at: string | null;
  next_attempt_at: string | null;
  last_error_code: string | null;
  last_error_status: number | null;
  last_error: string | null;
  response_json: string | null;
  committed_at: string | null;
  local_effects_applied_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueProductAdminMutationInput {
  mutationId?: string;
  tenantKey: string;
  deviceId: string;
  mutationType: ProductAdminMutationType;
  targetVariantId?: string | null;
  idempotencyKey?: string | null;
  intentHash: string;
  requestJson: string;
  stagedFilePath?: string | null;
  stagedFileHash?: string | null;
}

const unresolvedStatuses = "('PENDING', 'IN_FLIGHT', 'COMMITTED')";

function requestIsScrubbed(status: ProductAdminMutationStatus): boolean {
  return status === 'COMMITTED' || status === 'APPLIED' || status === 'FAILED_FINAL';
}

function idempotencyConflict(): Error {
  const error = new Error('product-admin-idempotency-key-reused') as Error & {
    code?: string;
    status?: number;
  };
  error.code = 'IDEMPOTENCY_KEY_REUSED';
  error.status = 409;
  return error;
}

export const productAdminMutationOutboxRepo = {
  enqueue(input: EnqueueProductAdminMutationInput): ProductAdminMutationOutboxRow {
    const existingByKey = input.idempotencyKey
      ? database.get<ProductAdminMutationOutboxRow>(
        `SELECT * FROM product_admin_mutation_outbox
         WHERE tenant_key = ? AND idempotency_key = ? LIMIT 1`,
        [input.tenantKey, input.idempotencyKey],
      )
      : null;
    if (existingByKey) {
      if (existingByKey.mutation_type !== input.mutationType
        || existingByKey.target_variant_id !== (input.targetVariantId ?? null)
        || existingByKey.intent_hash !== input.intentHash
        || (!requestIsScrubbed(existingByKey.status)
          && existingByKey.request_json !== input.requestJson)
        || existingByKey.staged_file_hash !== (input.stagedFileHash ?? null)) {
        throw idempotencyConflict();
      }
      return existingByKey;
    }

    const existing = database.get<ProductAdminMutationOutboxRow>(
      `SELECT * FROM product_admin_mutation_outbox
       WHERE tenant_key = ? AND mutation_type = ? AND intent_hash = ?
         AND status IN ${unresolvedStatuses}
       ORDER BY created_at ASC LIMIT 1`,
      [input.tenantKey, input.mutationType, input.intentHash],
    );
    if (existing) {
      if ((!requestIsScrubbed(existing.status) && existing.request_json !== input.requestJson)
        || existing.staged_file_hash !== (input.stagedFileHash ?? null)) {
        throw new Error('product-admin-intent-hash-collision');
      }
      return existing;
    }

    const mutationId = input.mutationId || randomUUID();
    database.run(
      `INSERT INTO product_admin_mutation_outbox (
         mutation_id, tenant_key, device_id, mutation_type, target_variant_id,
         idempotency_key, intent_hash, request_json, staged_file_path,
         staged_file_hash, status, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, datetime('now'), datetime('now'))`,
      [
        mutationId,
        input.tenantKey,
        input.deviceId,
        input.mutationType,
        input.targetVariantId ?? null,
        input.idempotencyKey ?? null,
        input.intentHash,
        input.requestJson,
        input.stagedFilePath ?? null,
        input.stagedFileHash ?? null,
      ],
    );
    database.markDirty();
    return this.getById(mutationId)!;
  },

  getById(mutationId: string): ProductAdminMutationOutboxRow | null {
    return database.get<ProductAdminMutationOutboxRow>(
      'SELECT * FROM product_admin_mutation_outbox WHERE mutation_id = ?',
      [mutationId],
    );
  },

  listReplayable(tenantKey: string, limit = 25): ProductAdminMutationOutboxRow[] {
    return database.all<ProductAdminMutationOutboxRow>(
      `SELECT * FROM product_admin_mutation_outbox
       WHERE tenant_key = ? AND status IN ${unresolvedStatuses}
         AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
       ORDER BY created_at ASC, mutation_id ASC LIMIT ?`,
      [tenantKey, Math.max(1, limit)],
    );
  },

  listStagedFilePaths(tenantKey: string): Set<string> {
    const rows = database.all<{ staged_file_path: string | null }>(
      `SELECT staged_file_path FROM product_admin_mutation_outbox
       WHERE tenant_key = ?
         AND status IN ('PENDING', 'IN_FLIGHT')
         AND staged_file_path IS NOT NULL`,
      [tenantKey],
    );
    return new Set(rows.map((row) => row.staged_file_path).filter((value): value is string => !!value));
  },

  findUnresolvedForTarget(
    tenantKey: string,
    targetVariantId: string,
  ): ProductAdminMutationOutboxRow | null {
    return database.get<ProductAdminMutationOutboxRow>(
      `SELECT * FROM product_admin_mutation_outbox
       WHERE tenant_key = ? AND target_variant_id = ?
         AND status IN ${unresolvedStatuses}
       ORDER BY created_at ASC LIMIT 1`,
      [tenantKey, targetVariantId],
    );
  },

  markInFlight(mutationId: string): void {
    database.run(
      `UPDATE product_admin_mutation_outbox
       SET status = 'IN_FLIGHT', attempts = attempts + 1,
           dispatched_at = COALESCE(dispatched_at, datetime('now')),
           next_attempt_at = NULL, updated_at = datetime('now')
       WHERE mutation_id = ? AND status IN ('PENDING', 'IN_FLIGHT')`,
      [mutationId],
    );
    database.markDirty();
  },

  markAmbiguous(
    mutationId: string,
    code: string | null,
    status: number | null,
    error: string,
  ): void {
    database.run(
      `UPDATE product_admin_mutation_outbox
       SET status = 'IN_FLIGHT', last_error_code = ?, last_error_status = ?, last_error = ?,
           outcome_ambiguous = 1,
           next_attempt_at = datetime('now', '+30 seconds'), updated_at = datetime('now')
       WHERE mutation_id = ? AND status = 'IN_FLIGHT'`,
      [code, status, error.slice(0, 1000), mutationId],
    );
    database.markDirty();
  },

  markCommitted(mutationId: string, responseJson: string): void {
    database.run(
      `UPDATE product_admin_mutation_outbox
       SET status = 'COMMITTED', request_json = '{}', response_json = ?, committed_at = datetime('now'),
           outcome_ambiguous = 0,
           next_attempt_at = NULL, last_error_code = NULL, last_error_status = NULL,
           last_error = NULL,
           updated_at = datetime('now')
       WHERE mutation_id = ? AND status IN ('PENDING', 'IN_FLIGHT', 'COMMITTED')`,
      [responseJson, mutationId],
    );
    database.markDirty();
  },

  markApplied(mutationId: string): void {
    database.run(
      `UPDATE product_admin_mutation_outbox
       SET status = 'APPLIED', local_effects_applied_at = datetime('now'),
           updated_at = datetime('now')
       WHERE mutation_id = ? AND status = 'COMMITTED'`,
      [mutationId],
    );
    database.markDirty();
  },

  markFailedFinal(
    mutationId: string,
    code: string | null,
    status: number | null,
    error: string,
  ): void {
    database.run(
      `UPDATE product_admin_mutation_outbox
       SET status = 'FAILED_FINAL', request_json = '{}',
           last_error_code = ?, last_error_status = ?, last_error = ?,
           next_attempt_at = NULL, updated_at = datetime('now')
       WHERE mutation_id = ? AND status IN ('PENDING', 'IN_FLIGHT')
         AND outcome_ambiguous = 0`,
      [code, status, error.slice(0, 1000), mutationId],
    );
    database.markDirty();
  },
};
