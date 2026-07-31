import { database } from '../database';
import type { HistorySessionRow } from '../../../shared/billiard-history-contract';

/**
 * Offline read-cache for the billiard history tab. Rows are full mapped
 * HistorySessionRow payloads (JSON) plus a few indexed columns for the
 * filters the UI offers. Populated on every successful online page view;
 * pruned to ~30 days at boot.
 */

export interface HistoryCacheQuery {
  dateFrom: string; // ISO date (inclusive)
  dateTo: string; // ISO date (inclusive)
  status?: string;
  resourceId?: string;
  search?: string;
  limit: number;
  offset: number;
}

function searchBlobOf(row: HistorySessionRow): string {
  return [
    row.tableName,
    row.customer_name ?? '',
    ...row.items.map((item) => item.name),
  ]
    .join(' ')
    .toLowerCase();
}

function buildWhere(query: HistoryCacheQuery): { where: string; params: any[] } {
  // Half-open UTC day range [from, to+1d). The server ranges over the salon's
  // local day; the cache is an offline fallback, so a ±2h boundary skew on
  // day edges is acceptable.
  const upper = new Date(`${query.dateTo}T00:00:00.000Z`);
  upper.setUTCDate(upper.getUTCDate() + 1);
  const clauses: string[] = ['ended_at >= ? AND ended_at < ?'];
  const params: any[] = [`${query.dateFrom}T00:00:00.000Z`, upper.toISOString()];
  if (query.status && query.status !== 'ALL') {
    clauses.push('status = ?');
    params.push(query.status);
  }
  if (query.resourceId) {
    clauses.push('resource_id = ?');
    params.push(query.resourceId);
  }
  if (query.search && query.search.trim()) {
    clauses.push('search_blob LIKE ?');
    params.push(`%${query.search.trim().toLowerCase()}%`);
  }
  return { where: clauses.join(' AND '), params };
}

export const billiardHistoryCacheRepo = {
  upsertMany(rows: HistorySessionRow[]): void {
    if (rows.length === 0) return;
    database.transaction(() => {
      for (const row of rows) {
        database.run(
          `INSERT INTO billiard_history_cache
             (id, ended_at, started_at, status, payment_status, resource_id,
              search_blob, payload, cached_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             ended_at = excluded.ended_at,
             started_at = excluded.started_at,
             status = excluded.status,
             payment_status = excluded.payment_status,
             resource_id = excluded.resource_id,
             search_blob = excluded.search_blob,
             payload = excluded.payload,
             cached_at = excluded.cached_at`,
          [
            row.id,
            row.ended_at,
            row.started_at,
            row.status,
            row.payment_status,
            row.resource_id,
            searchBlobOf(row),
            JSON.stringify(row),
          ],
        );
      }
    });
  },

  query(query: HistoryCacheQuery): { sessions: HistorySessionRow[]; total: number } {
    const { where, params } = buildWhere(query);
    const totalRow = database.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM billiard_history_cache WHERE ${where}`,
      params,
    );
    const rows = database.all<{ payload: string }>(
      `SELECT payload FROM billiard_history_cache
        WHERE ${where}
        ORDER BY ended_at DESC
        LIMIT ? OFFSET ?`,
      [...params, query.limit, query.offset],
    );
    const sessions: HistorySessionRow[] = [];
    for (const row of rows) {
      try {
        sessions.push(JSON.parse(row.payload));
      } catch {
        // A corrupt cache row must never take the whole tab down.
      }
    }
    return { sessions, total: totalRow[0]?.n ?? 0 };
  },

  pruneOlderThan(days = 30): void {
    database.run(
      `DELETE FROM billiard_history_cache
        WHERE ended_at IS NOT NULL
          AND ended_at < datetime('now', ?)`,
      [`-${days} days`],
    );
  },
};
