import type { AndroidDatabase } from './db';

export interface PrepareRefundAttempt {
  request_id: string;
  scope_key: string;
  local_order_id: string;
  backend_order_id: string;
  shift_id: string | null;
  payload_json: string;
  expected_json: string;
}

export interface RefundAttempt extends PrepareRefundAttempt {
  status: 'PREPARED' | 'UNKNOWN' | 'CONFIRMED' | 'REJECTED';
  response_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const immutableFields = ['request_id', 'scope_key', 'local_order_id', 'backend_order_id',
  'shift_id', 'payload_json', 'expected_json'] as const;
const validText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function assertObjectJson(value: string): void {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
  } catch { throw new Error('ANDROID_REFUND_ATTEMPT_INVALID_JSON'); }
}

/** Durable evidence only. Caller owns authorization, network and explicit flush barriers. */
export function createRefundAttemptRepo(database: AndroidDatabase) {
  const get = (requestId: string): RefundAttempt | null => database.get<RefundAttempt>(
    'SELECT * FROM pos_refund_attempts WHERE request_id = ?', [requestId]);
  const requireAttempt = (requestId: string): RefundAttempt => {
    const row = get(requestId);
    if (!row) throw new Error('ANDROID_REFUND_ATTEMPT_NOT_FOUND');
    return row;
  };
  const assertUnresolved = (row: RefundAttempt) => {
    if (row.status !== 'PREPARED' && row.status !== 'UNKNOWN') throw new Error('ANDROID_REFUND_ATTEMPT_INVALID_TRANSITION');
  };

  return {
    get,
    findUnresolved(localOrderId: string): RefundAttempt | null {
      return database.get<RefundAttempt>(
        "SELECT * FROM pos_refund_attempts WHERE local_order_id = ? AND status IN ('PREPARED', 'UNKNOWN') LIMIT 1", [localOrderId]);
    },
    prepare(record: PrepareRefundAttempt): RefundAttempt {
      for (const field of immutableFields) {
        if (field === 'shift_id' && record[field] === null) continue;
        if (!validText(record[field])) throw new Error(`ANDROID_REFUND_ATTEMPT_INVALID_FIELD: ${field}`);
      }
      assertObjectJson(record.payload_json); assertObjectJson(record.expected_json);
      return database.transaction(() => {
        const existing = get(record.request_id);
        if (existing) {
          if (immutableFields.some(field => existing[field] !== record[field])) throw new Error('ANDROID_REFUND_ATTEMPT_IMMUTABLE_MISMATCH');
          return existing;
        }
        if (database.get(`SELECT request_id FROM pos_refund_attempts
          WHERE (local_order_id = ? OR backend_order_id = ?) AND status IN ('PREPARED', 'UNKNOWN') LIMIT 1`,
        [record.local_order_id, record.backend_order_id])) throw new Error('ANDROID_REFUND_ATTEMPT_UNRESOLVED');
        const now = new Date().toISOString();
        database.run(`INSERT INTO pos_refund_attempts (
          request_id, scope_key, local_order_id, backend_order_id, shift_id, payload_json, expected_json,
          status, response_json, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARED', NULL, NULL, ?, ?)`,
        [...immutableFields.map(field => record[field]), now, now]);
        return requireAttempt(record.request_id);
      });
    },
    markUnknown(requestId: string, error: string | null = null): void {
      const row = requireAttempt(requestId); assertUnresolved(row);
      database.run("UPDATE pos_refund_attempts SET status = 'UNKNOWN', error = ?, updated_at = ? WHERE request_id = ?",
        [error, new Date().toISOString(), requestId]);
    },
    markRejected(requestId: string, error: string | null = null, responseJson: string | null = null): void {
      const row = requireAttempt(requestId); assertUnresolved(row);
      if (responseJson !== null) assertObjectJson(responseJson);
      database.run("UPDATE pos_refund_attempts SET status = 'REJECTED', response_json = ?, error = ?, updated_at = ? WHERE request_id = ?",
        [responseJson, error, new Date().toISOString(), requestId]);
    },
    confirmAndApply(requestId: string, responseJson: string, apply: () => void): { applied: boolean } {
      assertObjectJson(responseJson);
      return database.transaction(() => {
        const row = requireAttempt(requestId);
        if (row.status === 'CONFIRMED') {
          if (row.response_json !== responseJson) throw new Error('ANDROID_REFUND_ATTEMPT_RESPONSE_MISMATCH');
          return { applied: false };
        }
        assertUnresolved(row);
        // A financial transaction must not commit while an async callback is unfinished.
        if (apply.constructor.name === 'AsyncFunction') throw new Error('ANDROID_REFUND_ATTEMPT_ASYNC_CALLBACK');
        const result: unknown = apply();
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('ANDROID_REFUND_ATTEMPT_ASYNC_CALLBACK');
        database.run("UPDATE pos_refund_attempts SET status = 'CONFIRMED', response_json = ?, error = NULL, updated_at = ? WHERE request_id = ?",
          [responseJson, new Date().toISOString(), requestId]);
        return { applied: true };
      });
    },
  };
}
