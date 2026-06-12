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

export const fiscalReceiptSyncRepo = {
  enqueue(input: EnqueueFiscalReceiptSyncInput): FiscalReceiptSyncRow {
    const existing = database.get<FiscalReceiptSyncRow>(
      `SELECT * FROM fiscal_receipt_sync_queue
       WHERE backend_order_id = ? AND event_status = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.backendOrderId, input.status],
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

  listPending(limit = 25): FiscalReceiptSyncRow[] {
    return database.all<FiscalReceiptSyncRow>(
      `SELECT * FROM fiscal_receipt_sync_queue
       WHERE status = 'PENDING'
       ORDER BY created_at ASC, id ASC
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
