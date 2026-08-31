import logger from '../../logger';

/**
 * Nightly purge of local order history.
 *
 * The POS keeps only the current day locally; everything older lives on the
 * backend (web dashboard). A row is purged only when the backend provably has
 * it and nothing on this device still needs it:
 *
 *   1. synced = 1 AND backend_id present          — backend holds the original
 *   2. no pending outbox / sync work referencing it (fiscal receipt sync,
 *      POS event outbox, receipt print outbox, local sync log)
 *   3. no fiscal attempt left in UNKNOWN_NEEDS_RECONCILIATION
 *   4. its shift is closed (shift totals are computed from local orders)
 *
 * Anything failing these checks is kept and counted, never deleted — an
 * unsynced sale must survive until it reaches the backend.
 */
export interface PurgeDatabase {
  get<T = any>(sql: string, params?: any[]): T | null;
  all<T = any>(sql: string, params?: any[]): T[];
  run(sql: string, params?: any[]): void;
  transaction<T>(fn: () => T): T;
  markDirty?(): void;
}

export interface OrderHistoryPurgeResult {
  purged: number;
  /** eligible-but-not-yet-purged rows carried to the next run (maxPerRun cap) */
  remaining: number;
  /** older rows deliberately kept: unsynced / pending work / open shift */
  kept: number;
  cutoff: string;
}

export interface PurgedUnsyncedOrder {
  order: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
}

export interface OrderHistoryPurgeOptions {
  /**
   * Orders shelved by sync (synced = -1, never reached the backend) created
   * before this ISO timestamp are purged too — after being handed to
   * `exportUnsynced` so the sale is not silently lost. Omit to keep them.
   */
  unsyncedOlderThanIso?: string;
  exportUnsynced?: (orders: PurgedUnsyncedOrder[]) => void;
  /**
   * Fiscal attempts left UNKNOWN_NEEDS_RECONCILIATION block the purge only
   * while newer than this ISO timestamp; older ones are stale June-style
   * leftovers nobody will reconcile. Omit to block on any age.
   */
  staleFiscalUnknownBeforeIso?: string;
  /** rows deleted per transaction; the main process is blocked only for one batch */
  batchSize?: number;
  /** cap per run so a months-old backlog never stalls the counter; rest goes to the next tick */
  maxPerRun?: number;
  /** yields between batches so pending IPC (scan, payment, print) can run */
  yieldBetweenBatches?: () => Promise<void>;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_PER_RUN = 5_000;
const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Local-midnight cutoff in the same `datetime('now')` / ISO shape orders use. */
export function startOfLocalDayIso(now: Date = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

const CHILD_TABLES: Array<{ table: string; column: string }> = [
  { table: 'order_items', column: 'order_id' },
  { table: 'fiscal_attempts', column: 'order_id' },
  { table: 'print_attempts', column: 'order_id' },
  { table: 'receipt_print_outbox', column: 'order_id' },
  { table: 'invoice_handoffs', column: 'order_id' },
  { table: 'pos_billiard_handoffs', column: 'order_id' },
  { table: 'fiscal_receipt_sync_queue', column: 'local_order_id' },
  { table: 'pos_event_outbox', column: 'local_order_id' },
];

function tableExists(db: PurgeDatabase, table: string): boolean {
  try {
    return !!db.get<{ n: number }>(
      "SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
      [table],
    );
  } catch {
    return false;
  }
}

/**
 * SQLite stores `created_at` either as `datetime('now')` ("YYYY-MM-DD HH:MM:SS",
 * UTC) or as an ISO string; both compare correctly against an ISO cutoff after
 * normalising the separator, which the query does via replace().
 */
// Params, in order: cutoff, unsyncedCutoff (or '' = never), staleFiscalBefore (or '' = never)
const ELIGIBLE_SQL = `
  SELECT o.id, o.synced
  FROM orders o
  LEFT JOIN shifts s ON s.id = o.shift_id
  WHERE replace(substr(o.created_at, 1, 19), ' ', 'T') < substr(?, 1, 19)
    AND (
      (o.synced = 1 AND o.backend_id IS NOT NULL AND o.backend_id != '')
      OR (o.synced = -1 AND ? != '' AND replace(substr(o.created_at, 1, 19), ' ', 'T') < substr(?, 1, 19))
    )
    AND (o.shift_id IS NULL OR s.id IS NULL OR s.closed_at IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM fiscal_attempts fa
      WHERE fa.order_id = o.id AND fa.status = 'UNKNOWN_NEEDS_RECONCILIATION'
        AND (? = '' OR replace(substr(COALESCE(fa.created_at, o.created_at), 1, 19), ' ', 'T') >= substr(?, 1, 19))
    )
    AND NOT EXISTS (
      SELECT 1 FROM fiscal_receipt_sync_queue q
      WHERE q.local_order_id = o.id AND q.status != 'SYNCED'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pos_event_outbox e
      WHERE e.local_order_id = o.id AND e.status = 'pending'
    )
    AND NOT EXISTS (
      SELECT 1 FROM receipt_print_outbox r
      WHERE r.order_id = o.id
        AND r.status NOT IN ('COMPLETED', 'CANCELLED', 'FAILED_SAFE', 'NEEDS_REVIEW')
    )
    AND NOT EXISTS (
      SELECT 1 FROM invoice_handoffs ih
      WHERE ih.order_id = o.id
        AND ih.status NOT IN ('COMPLETED', 'NOT_APPLICABLE')
    )
    AND NOT EXISTS (
      SELECT 1 FROM local_sync_log l
      WHERE l.entity_type = 'order' AND l.entity_id = o.id
        AND l.status = 'pending'
    )
`;
// local_sync_log 'rejected' rows are NOT a keep reason: that channel is a
// mirror-only event log; the server rejecting a mirror entry ("order_not_on_server",
// duplicate source_tx) says nothing about the order itself, which is tracked by
// orders.synced/backend_id. Chesaigon POS1 kept 74 delivered orders that way.

const OLDER_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM orders o
  WHERE replace(substr(o.created_at, 1, 19), ' ', 'T') < substr(?, 1, 19)
`;

export async function purgeLocalOrderHistoryBefore(
  db: PurgeDatabase,
  cutoffIso: string,
  options: OrderHistoryPurgeOptions = {},
): Promise<OrderHistoryPurgeResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxPerRun = Math.max(batchSize, options.maxPerRun ?? DEFAULT_MAX_PER_RUN);
  const yieldBetweenBatches = options.yieldBetweenBatches ?? defaultYield;

  const required = ['orders', 'shifts', 'fiscal_attempts', 'fiscal_receipt_sync_queue',
    'pos_event_outbox', 'receipt_print_outbox', 'invoice_handoffs', 'local_sync_log'];
  for (const t of required) {
    if (!tableExists(db, t)) {
      logger.debug(`[OrderHistoryPurge] table ${t} missing; skipping purge`);
      return { purged: 0, remaining: 0, kept: 0, cutoff: cutoffIso };
    }
  }

  const older = db.get<{ n: number }>(OLDER_COUNT_SQL, [cutoffIso])?.n ?? 0;
  if (older === 0) return { purged: 0, remaining: 0, kept: 0, cutoff: cutoffIso };

  const unsyncedCutoff = options.unsyncedOlderThanIso ?? '';
  const staleFiscal = options.staleFiscalUnknownBeforeIso ?? '';
  const eligibleRows = db.all<{ id: string; synced: number }>(
    ELIGIBLE_SQL,
    [cutoffIso, unsyncedCutoff, unsyncedCutoff, staleFiscal, staleFiscal],
  );
  const eligible = eligibleRows.map((r) => r.id);
  if (eligible.length === 0) {
    return { purged: 0, remaining: 0, kept: older, cutoff: cutoffIso };
  }

  const ids = eligible.slice(0, maxPerRun);
  const unsyncedIds = new Set(eligibleRows.filter((r) => r.synced !== 1).map((r) => r.id));
  const existingChildren = CHILD_TABLES.filter((c) => tableExists(db, c.table));
  let purged = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const marks = chunk.map(() => '?').join(',');
    const unsyncedInChunk = chunk.filter((id) => unsyncedIds.has(id));
    if (unsyncedInChunk.length > 0 && options.exportUnsynced) {
      const um = unsyncedInChunk.map(() => '?').join(',');
      const orders = db.all<Record<string, unknown>>(`SELECT * FROM orders WHERE id IN (${um})`, unsyncedInChunk);
      const items = db.all<Record<string, unknown> & { order_id: string }>(
        `SELECT * FROM order_items WHERE order_id IN (${um})`, unsyncedInChunk,
      );
      // Export BEFORE deleting; if the exporter throws, the batch is skipped
      // and the rows survive for the next run.
      options.exportUnsynced(orders.map((order) => ({
        order,
        items: items.filter((it) => it.order_id === order.id),
      })));
    }
    // One short transaction per batch: the event loop is blocked only for
    // this batch, then we yield so a sale in progress is served first.
    db.transaction(() => {
      for (const child of existingChildren) {
        db.run(`DELETE FROM ${child.table} WHERE ${child.column} IN (${marks})`, chunk);
      }
      db.run(
        `DELETE FROM local_sync_log WHERE entity_type = 'order' AND entity_id IN (${marks})`,
        chunk,
      );
      db.run(`DELETE FROM orders WHERE id IN (${marks})`, chunk);
    });
    purged += chunk.length;
    db.markDirty?.();
    if (i + batchSize < ids.length) await yieldBetweenBatches();
  }

  const remaining = eligible.length - purged;
  const kept = older - eligible.length;
  if (remaining === 0 && purged > 0) {
    // Deleting rows leaves free pages behind; the exported pos.db keeps its
    // old size until the database is rewritten. One VACUUM after the last
    // batch (on a now-small in-memory DB) shrinks the file for real.
    try {
      db.run('VACUUM');
      db.markDirty?.();
    } catch (error: any) {
      logger.debug(`[OrderHistoryPurge] VACUUM skipped: ${error?.message || error}`);
    }
  }
  logger.info(`[OrderHistoryPurge] purged ${purged} synced order(s) before ${cutoffIso}; remaining ${remaining} (next run), kept ${kept} (unsynced/pending/open-shift)`);
  return { purged, remaining, kept, cutoff: cutoffIso };
}
