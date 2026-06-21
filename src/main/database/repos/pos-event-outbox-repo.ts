import { database } from '../database';
import { ulid } from '../../utils/ulid';

export type PosEventOutboxStatus = 'pending' | 'acked' | 'dead_letter';

export type PosEventType =
  | 'SaleCompleted'
  | 'PaymentCaptured'
  | 'RefundIssued'
  | 'ShiftOpened'
  | 'ShiftClosed'
  | 'FiscalReceiptEmitted'
  | 'CashDrawerOpened'
  | 'ReceiptPrintAttempted';

export type PosEventReliabilityClass =
  | 'critical_financial'
  | 'important_business'
  | 'operational'
  | 'insight';

export interface PosEventOutboxRow {
  event_id: string;
  dedupe_key: string;
  event_type: PosEventType;
  schema_version: number;
  salon_id: string | null;
  device_id: string | null;
  local_order_id: string | null;
  shift_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  occurred_at: string;
  payload_json: string;
  reliability_class: PosEventReliabilityClass;
  status: PosEventOutboxStatus;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  server_event_id: string | null;
  acknowledged_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface EnqueuePosEventInput {
  /** Deterministic per-fact key; the same key never creates a second row. */
  dedupeKey: string;
  eventType: PosEventType;
  reliabilityClass: PosEventReliabilityClass;
  schemaVersion?: number;
  salonId?: string | null;
  deviceId?: string | null;
  localOrderId?: string | null;
  shiftId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** Envelope as sent to POST /api/v1/pos-events/batch. */
export interface PosEventEnvelope {
  eventId: string;
  eventType: PosEventType;
  schemaVersion: number;
  salonId?: string;
  deviceId?: string;
  localOrderId?: string;
  shiftId?: string;
  correlationId?: string;
  causationId?: string;
  occurredAt: string;
  sentAt?: string;
  reliabilityClass: PosEventReliabilityClass;
  payload: Record<string, unknown>;
}

export const posEventOutboxRepo = {
  /**
   * Idempotent enqueue. If a row with the same dedupe_key already exists it is
   * returned untouched (never re-queued, never duplicated, status preserved) so
   * an emitter firing twice for one business fact is harmless. Returns the row
   * (existing or newly created). The generated event_id is a ULID and is stable
   * for the life of the row — it is the idempotency key the backend dedupes on.
   */
  enqueue(input: EnqueuePosEventInput): PosEventOutboxRow {
    const existing = database.get<PosEventOutboxRow>(
      'SELECT * FROM pos_event_outbox WHERE dedupe_key = ?',
      [input.dedupeKey],
    );
    if (existing) return existing;

    const eventId = ulid();
    database.run(
      `INSERT INTO pos_event_outbox (
        event_id, dedupe_key, event_type, schema_version, salon_id, device_id,
        local_order_id, shift_id, correlation_id, causation_id, occurred_at,
        payload_json, reliability_class, status, attempts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
      [
        eventId,
        input.dedupeKey,
        input.eventType,
        input.schemaVersion ?? 1,
        input.salonId ?? null,
        input.deviceId ?? null,
        input.localOrderId ?? null,
        input.shiftId ?? null,
        input.correlationId ?? input.localOrderId ?? null,
        input.causationId ?? null,
        input.occurredAt,
        JSON.stringify(input.payload ?? {}),
        input.reliabilityClass,
      ],
    );
    database.markDirty();
    return database.get<PosEventOutboxRow>(
      'SELECT * FROM pos_event_outbox WHERE event_id = ?',
      [eventId],
    )!;
  },

  /** Pending rows whose backoff window has elapsed, oldest first. */
  listReady(limit: number, nowIso: string): PosEventOutboxRow[] {
    return database.all<PosEventOutboxRow>(
      `SELECT * FROM pos_event_outbox
       WHERE status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY event_id ASC
       LIMIT ?`,
      [nowIso, Math.max(1, limit)],
    );
  },

  markAcked(eventId: string, serverEventId: string | null): void {
    database.run(
      `UPDATE pos_event_outbox
       SET status = 'acked',
           server_event_id = ?,
           acknowledged_at = datetime('now'),
           updated_at = datetime('now'),
           last_error = NULL,
           next_attempt_at = NULL
       WHERE event_id = ?`,
      [serverEventId, eventId],
    );
    database.markDirty();
  },

  markFailed(eventId: string, error: string, nextAttemptAt: string, deadLetter = false): void {
    database.run(
      `UPDATE pos_event_outbox
       SET status = ?,
           attempts = attempts + 1,
           last_attempt_at = datetime('now'),
           next_attempt_at = ?,
           last_error = ?,
           updated_at = datetime('now')
       WHERE event_id = ?`,
      [deadLetter ? 'dead_letter' : 'pending', nextAttemptAt, error.slice(0, 1000), eventId],
    );
    database.markDirty();
  },

  countPending(): number {
    return (
      database.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM pos_event_outbox WHERE status = 'pending'",
      )?.n ?? 0
    );
  },

  countDeadLetter(): number {
    return (
      database.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM pos_event_outbox WHERE status = 'dead_letter'",
      )?.n ?? 0
    );
  },

  oldestPendingAt(): string | null {
    return (
      database.get<{ at: string | null }>(
        "SELECT MIN(created_at) as at FROM pos_event_outbox WHERE status = 'pending'",
      )?.at ?? null
    );
  },

  lastAckedAt(): string | null {
    return (
      database.get<{ at: string | null }>(
        "SELECT MAX(acknowledged_at) as at FROM pos_event_outbox WHERE status = 'acked'",
      )?.at ?? null
    );
  },

  /**
   * Keep acked rows for shift reconciliation/diagnostics, then prune old ones so
   * the table never grows unbounded. Never touches pending/dead_letter rows.
   */
  pruneAcked(olderThanDays = 30): number {
    const before = database.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM pos_event_outbox WHERE status = 'acked'",
    )?.n ?? 0;
    database.run(
      `DELETE FROM pos_event_outbox
       WHERE status = 'acked'
         AND acknowledged_at IS NOT NULL
         AND acknowledged_at < datetime('now', ?)`,
      [`-${Math.max(1, olderThanDays)} days`],
    );
    const after = database.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM pos_event_outbox WHERE status = 'acked'",
    )?.n ?? 0;
    if (before !== after) database.markDirty();
    return before - after;
  },

  toEnvelope(row: PosEventOutboxRow): PosEventEnvelope {
    const env: PosEventEnvelope = {
      eventId: row.event_id,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      occurredAt: row.occurred_at,
      reliabilityClass: row.reliability_class,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    };
    // salonId is intentionally NOT sent: the backend derives tenant scope from
    // the JWT ("server auth wins") and validates any provided salonId as a UUID.
    // Omitting it avoids rejecting a whole batch if the local id is ever unclean.
    if (row.device_id) env.deviceId = row.device_id;
    if (row.local_order_id) env.localOrderId = row.local_order_id;
    if (row.shift_id) env.shiftId = row.shift_id;
    if (row.correlation_id) env.correlationId = row.correlation_id;
    if (row.causation_id) env.causationId = row.causation_id;
    return env;
  },
};
