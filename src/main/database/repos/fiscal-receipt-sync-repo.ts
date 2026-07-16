import { randomUUID } from 'crypto';
import { database } from '../database';

export type FiscalReceiptSyncStatus = 'PENDING' | 'SYNCED';

export interface FiscalReceiptSyncRow {
  id: string;
  local_order_id: string;
  backend_order_id: string;
  event_status: string;
  status: FiscalReceiptSyncStatus;
  event_body_json: string;
  attempts: number;
  last_error: string | null;
  created_at: string | null;
  updated_at: string | null;
  synced_at: string | null;
}

export interface EnqueueFiscalReceiptSyncInput {
  localOrderId: string;
  backendOrderId: string;
  status: string;
  body: Record<string, unknown>;
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class FiscalReceiptOrderPendingSyncError extends Error {
  constructor(readonly localOrderId: string) {
    super(`order ${localOrderId} has not synced to the backend yet`);
    this.name = 'FiscalReceiptOrderPendingSyncError';
  }
}

export function prepareFiscalReceiptSyncBody(
  row: FiscalReceiptSyncRow,
  backendOrderId: string | null | undefined,
): Record<string, unknown> {
  const normalizedBackendOrderId = backendOrderId?.trim();
  if (!normalizedBackendOrderId || !UUID_LIKE.test(normalizedBackendOrderId)) {
    throw new FiscalReceiptOrderPendingSyncError(row.local_order_id);
  }

  return {
    ...(JSON.parse(row.event_body_json) as Record<string, unknown>),
    b2bOrderId: normalizedBackendOrderId,
  };
}

export const fiscalReceiptSyncRepo = {
  enqueue(input: EnqueueFiscalReceiptSyncInput): FiscalReceiptSyncRow {
    const existing = database.get<FiscalReceiptSyncRow>(
      `SELECT * FROM fiscal_receipt_sync_queue
       WHERE local_order_id = ? AND event_status = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.localOrderId, input.status],
    );
    const id = existing?.id || randomUUID();
    const body = {
      ...input.body,
      metadata: {
        ...((input.body.metadata as Record<string, unknown> | undefined) || {}),
        fiscalReceiptSyncId: id,
      },
    };

    if (existing) {
      database.run(
        `UPDATE fiscal_receipt_sync_queue
         SET local_order_id = ?,
             event_body_json = ?,
             status = 'PENDING',
             updated_at = datetime('now'),
             synced_at = NULL
         WHERE id = ?`,
        [input.localOrderId, JSON.stringify(body), id],
      );
    } else {
      database.run(
        `INSERT INTO fiscal_receipt_sync_queue (
          id, local_order_id, backend_order_id, event_status, status, event_body_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, input.localOrderId, input.backendOrderId, input.status, 'PENDING', JSON.stringify(body)],
      );
    }
    database.markDirty();
    return database.get<FiscalReceiptSyncRow>('SELECT * FROM fiscal_receipt_sync_queue WHERE id = ?', [id])!;
  },

  listReady(limit = 25): FiscalReceiptSyncRow[] {
    return database.all<FiscalReceiptSyncRow>(
      `SELECT q.*
       FROM fiscal_receipt_sync_queue q
       JOIN orders o ON o.id = q.local_order_id
       WHERE q.status = 'PENDING'
         AND o.backend_id IS NOT NULL
         AND trim(o.backend_id) <> ''
         AND length(trim(o.backend_id)) = 36
         AND substr(trim(o.backend_id), 9, 1) = '-'
         AND substr(trim(o.backend_id), 14, 1) = '-'
         AND substr(trim(o.backend_id), 19, 1) = '-'
         AND substr(trim(o.backend_id), 24, 1) = '-'
         AND lower(trim(o.backend_id)) NOT GLOB '*[^0-9a-f-]*'
         AND (
           q.attempts = 0
           OR datetime(
             COALESCE(q.updated_at, q.created_at, '1970-01-01 00:00:00'),
             CASE
               WHEN q.attempts = 1 THEN '+1 minute'
               WHEN q.attempts = 2 THEN '+2 minutes'
               WHEN q.attempts = 3 THEN '+5 minutes'
               WHEN q.attempts = 4 THEN '+15 minutes'
               WHEN q.attempts = 5 THEN '+30 minutes'
               ELSE '+60 minutes'
             END
           ) <= datetime('now')
         )
       ORDER BY q.created_at ASC, q.id ASC
       LIMIT ?`,
      [limit],
    );
  },

  markSynced(id: string): void {
    database.run(
      `UPDATE fiscal_receipt_sync_queue
       SET status = 'SYNCED',
           synced_at = datetime('now'),
           updated_at = datetime('now'),
           last_error = NULL
       WHERE id = ?`,
      [id],
    );
    database.markDirty();
  },

  markFailed(id: string, error: string): void {
    database.run(
      `UPDATE fiscal_receipt_sync_queue
       SET attempts = attempts + 1,
           last_error = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
      [error.slice(0, 1000), id],
    );
    database.markDirty();
  },
};
