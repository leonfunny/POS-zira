import type {
  LanFirstPayloadHash,
  LanFirstPrintFailureClass,
  LanFirstPrintResultStatus,
} from '../../../shared/types';
import { database } from '../database';

export type LanFirstPrintAttemptStatus = LanFirstPrintResultStatus;

export interface LanFirstPrintAttemptRow {
  idempotency_key: string;
  payload_hash: string;
  job_id: string;
  printer_id: string;
  status: LanFirstPrintAttemptStatus;
  failure_class: LanFirstPrintFailureClass | null;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface BeginLanFirstPrintAttemptInput {
  idempotencyKey: string;
  payloadHash: LanFirstPayloadHash | string;
  jobId: string;
  printerId: string;
}

export type BeginLanFirstPrintAttemptDecision =
  | { action: 'PRINT'; row: LanFirstPrintAttemptRow }
  | {
      action: 'NOOP';
      duplicate: true;
      status: LanFirstPrintAttemptStatus;
      failureClass?: LanFirstPrintFailureClass | null;
      row: LanFirstPrintAttemptRow;
    }
  | {
      action: 'REJECT';
      reason: 'PAYLOAD_HASH_MISMATCH' | 'LEDGER_NOT_DURABLE';
      error?: string;
      row?: LanFirstPrintAttemptRow;
    };

export interface MarkLanFirstPrintAttemptFailedInput extends BeginLanFirstPrintAttemptInput {
  failureClass: LanFirstPrintFailureClass;
  errorMessage: string | null;
}

const LEDGER_SAVE_RETRIES = 3;
const LEDGER_SAVE_RETRY_DELAY_MS = 100;
const LEDGER_NOT_DURABLE_MESSAGE = 'LAN_FIRST ledger was not durable before print';

function nowIso(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeErrorMessage(value: string | null | undefined): string | null {
  const text = String(value || '').trim();
  return text ? text.slice(0, 2000) : null;
}

async function flushLedgerToDisk(): Promise<{ success: true } | { success: false; error: string }> {
  for (let attempt = 1; attempt <= LEDGER_SAVE_RETRIES; attempt += 1) {
    const result = await database.save();
    if (result.success) return { success: true };

    const error = result.error || 'unknown database save error';
    if (!/already in progress/i.test(error) || attempt === LEDGER_SAVE_RETRIES) {
      return { success: false, error };
    }
    await delay(LEDGER_SAVE_RETRY_DELAY_MS);
  }
  return { success: false, error: 'database save failed' };
}

function findByIdempotencyKey(idempotencyKey: string): LanFirstPrintAttemptRow | null {
  return database.get<LanFirstPrintAttemptRow>(
    'SELECT * FROM lan_first_print_attempts WHERE idempotency_key = ?',
    [idempotencyKey],
  );
}

function upsertStatus(
  input: BeginLanFirstPrintAttemptInput,
  status: LanFirstPrintAttemptStatus,
  failureClass: LanFirstPrintFailureClass | null,
  errorMessage: string | null,
): LanFirstPrintAttemptRow {
  const updatedAt = nowIso();
  database.run(
    `UPDATE lan_first_print_attempts
     SET status = ?,
         failure_class = ?,
         error_message = ?,
         job_id = ?,
         printer_id = ?,
         updated_at = ?
     WHERE idempotency_key = ?`,
    [
      status,
      failureClass,
      normalizeErrorMessage(errorMessage),
      input.jobId,
      input.printerId,
      updatedAt,
      input.idempotencyKey,
    ],
  );
  return findByIdempotencyKey(input.idempotencyKey)!;
}

function markPrintingAsNotDurable(input: BeginLanFirstPrintAttemptInput): LanFirstPrintAttemptRow {
  const row = database.transaction(() =>
    upsertStatus(input, 'FAILED', 'SAFE_BEFORE_PRINT', LEDGER_NOT_DURABLE_MESSAGE),
  );
  database.markDirty();
  return row;
}

export const lanFirstPrintAttemptRepo = {
  async beginPrintAttempt(input: BeginLanFirstPrintAttemptInput): Promise<BeginLanFirstPrintAttemptDecision> {
    let mustFlush = false;
    const decision = database.transaction<BeginLanFirstPrintAttemptDecision>(() => {
      const existing = findByIdempotencyKey(input.idempotencyKey);

      if (existing) {
        if (existing.payload_hash !== input.payloadHash) {
          return { action: 'REJECT', reason: 'PAYLOAD_HASH_MISMATCH', row: existing };
        }

        if (existing.status === 'COMPLETED' || existing.status === 'PRINTING') {
          return {
            action: 'NOOP',
            duplicate: true,
            status: existing.status,
            failureClass: existing.failure_class,
            row: existing,
          };
        }

        if (existing.status === 'FAILED' && existing.failure_class !== 'SAFE_BEFORE_PRINT') {
          return {
            action: 'NOOP',
            duplicate: true,
            status: existing.status,
            failureClass: existing.failure_class,
            row: existing,
          };
        }

        mustFlush = true;
        return {
          action: 'PRINT',
          row: upsertStatus(input, 'PRINTING', null, null),
        };
      }

      const createdAt = nowIso();
      database.run(
        `INSERT INTO lan_first_print_attempts (
          idempotency_key,
          payload_hash,
          job_id,
          printer_id,
          status,
          failure_class,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.idempotencyKey,
          input.payloadHash,
          input.jobId,
          input.printerId,
          'PRINTING',
          null,
          null,
          createdAt,
          createdAt,
        ],
      );
      mustFlush = true;
      return { action: 'PRINT', row: findByIdempotencyKey(input.idempotencyKey)! };
    });

    if (decision.action !== 'PRINT' || !mustFlush) return decision;

    const flush = await flushLedgerToDisk();
    if (!flush.success) {
      const row = markPrintingAsNotDurable(input);
      return {
        action: 'REJECT',
        reason: 'LEDGER_NOT_DURABLE',
        error: flush.error,
        row,
      };
    }
    return decision;
  },

  findByIdempotencyKey,

  async markCompleted(input: BeginLanFirstPrintAttemptInput): Promise<LanFirstPrintAttemptRow | null> {
    const row = database.transaction(() => upsertStatus(input, 'COMPLETED', null, null));
    await flushLedgerToDisk();
    return row;
  },

  async markFailed(input: MarkLanFirstPrintAttemptFailedInput): Promise<LanFirstPrintAttemptRow | null> {
    const row = database.transaction(() =>
      upsertStatus(input, 'FAILED', input.failureClass, input.errorMessage),
    );
    await flushLedgerToDisk();
    return row;
  },
};
