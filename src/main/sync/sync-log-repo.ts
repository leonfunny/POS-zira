/**
 * SyncLogRepo — Database operations for Path B sync log tables.
 *
 * Tables: local_sync_log, sync_state, sync_conflicts
 * Created by migration v17.
 */

import { database } from '../database/database';
import logger from '../logger';

// ─── Row types ──────────────────────────────────────────────

export interface LocalSyncLogRow {
  id: number;
  source_tx: string;
  entity_type: string;
  entity_id: string;
  event: string;
  payload: string; // JSON string
  source: string;
  status: string; // pending | pushing | accepted | rejected
  server_seq: number | null;
  rejection_code: string | null;
  rejection_detail: string | null;
  attempts: number;
  created_at: string;
  pushed_at: string | null;
  resolved_at: string | null;
}

export interface SyncConflictRow {
  id: number;
  log_entry_id: number;
  conflict_type: string;
  entity_type: string;
  entity_id: string;
  detail: string | null;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
}

// ─── Repository ─────────────────────────────────────────────

export const syncLogRepo = {
  // ─── local_sync_log ─────────────────────────────────────

  /**
   * Insert a new local sync log entry (outbound — POS mutation).
   * Returns the autoincrement id.
   */
  insertEntry(entry: {
    source_tx: string;
    entity_type: string;
    entity_id: string;
    event: string;
    payload: string;
    source: string;
  }): number {
    database.run(
      `INSERT INTO local_sync_log (source_tx, entity_type, entity_id, event, payload, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.source_tx, entry.entity_type, entry.entity_id, entry.event, entry.payload, entry.source],
    );
    const row = database.get<{ id: number }>('SELECT last_insert_rowid() as id');
    return row?.id ?? 0;
  },

  /**
   * Insert an inbound entry (from server pull or real-time socket).
   */
  insertAcceptedEntry(entry: {
    source_tx: string;
    entity_type: string;
    entity_id: string;
    event: string;
    payload: string;
    source: string;
    server_seq: number;
  }): void {
    database.run(
      `INSERT OR IGNORE INTO local_sync_log
         (source_tx, entity_type, entity_id, event, payload, source, status, server_seq)
       VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?)`,
      [entry.source_tx, entry.entity_type, entry.entity_id, entry.event, entry.payload, entry.source, entry.server_seq],
    );
  },

  /**
   * Get pending entries for push, ordered by id (FIFO).
   */
  getPending(limit: number = 50): LocalSyncLogRow[] {
    return database.all<LocalSyncLogRow>(
      'SELECT * FROM local_sync_log WHERE status = ? ORDER BY id ASC LIMIT ?',
      ['pending', limit],
    );
  },

  /**
   * Mark entries as pushing (in-flight) to prevent double-send.
   */
  markPushing(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    database.run(
      `UPDATE local_sync_log SET status = 'pushing', attempts = attempts + 1, pushed_at = datetime('now')
       WHERE id IN (${placeholders})`,
      ids,
    );
  },

  /**
   * Mark an entry as accepted by server.
   */
  markAccepted(id: number, serverSeq: number): void {
    database.run(
      `UPDATE local_sync_log SET status = 'accepted', server_seq = ? WHERE id = ?`,
      [serverSeq, id],
    );
  },

  /**
   * Mark an entry as rejected by server.
   */
  markRejected(id: number, code: string, detail: string): void {
    database.run(
      `UPDATE local_sync_log SET status = 'rejected', rejection_code = ?, rejection_detail = ? WHERE id = ?`,
      [code, detail, id],
    );
  },

  /**
   * Crash recovery: revert pushing → pending on startup.
   * The source_tx UUID ensures server-side idempotency.
   */
  revertPushingToPending(): number {
    database.run(`UPDATE local_sync_log SET status = 'pending' WHERE status = 'pushing'`);
    const row = database.get<{ cnt: number }>(`SELECT changes() as cnt`);
    return row?.cnt ?? 0;
  },

  /**
   * Check if a source_tx already exists (echo suppression / dedup).
   */
  hasSourceTx(sourceTx: string): boolean {
    const row = database.get<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM local_sync_log WHERE source_tx = ?',
      [sourceTx],
    );
    return (row?.cnt ?? 0) > 0;
  },

  /**
   * Prune old accepted entries (> 7 days).
   */
  pruneAccepted(olderThanDays: number = 7): number {
    database.run(
      `DELETE FROM local_sync_log WHERE status = 'accepted' AND created_at < datetime('now', ?)`,
      [`-${olderThanDays} days`],
    );
    const row = database.get<{ cnt: number }>('SELECT changes() as cnt');
    return row?.cnt ?? 0;
  },

  // ─── sync_state ──────────────────────────────────────────

  getState(key: string): string | null {
    const row = database.get<{ value: string }>('SELECT value FROM sync_state WHERE key = ?', [key]);
    return row?.value ?? null;
  },

  setState(key: string, value: string): void {
    database.run(
      `INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      [key, value],
    );
  },

  getLastServerSeq(): number {
    const val = this.getState('last_server_seq');
    return val ? parseInt(val, 10) : 0;
  },

  setLastServerSeq(seq: number): void {
    this.setState('last_server_seq', String(seq));
  },

  getSyncMode(): string {
    return this.getState('sync_mode') || 'path_a';
  },

  setSyncMode(mode: string): void {
    this.setState('sync_mode', mode);
    logger.info(`[SyncLogRepo] Sync mode set to: ${mode}`);
  },

  getAgentSource(): string {
    return this.getState('agent_source') || 'pos:unknown';
  },

  setAgentSource(source: string): void {
    this.setState('agent_source', source);
  },

  // ─── sync_conflicts ──────────────────────────────────────

  insertConflict(entry: {
    log_entry_id: number;
    conflict_type: string;
    entity_type: string;
    entity_id: string;
    detail?: string;
  }): number {
    database.run(
      `INSERT INTO sync_conflicts (log_entry_id, conflict_type, entity_type, entity_id, detail)
       VALUES (?, ?, ?, ?, ?)`,
      [entry.log_entry_id, entry.conflict_type, entry.entity_type, entry.entity_id, entry.detail ?? null],
    );
    const row = database.get<{ id: number }>('SELECT last_insert_rowid() as id');
    return row?.id ?? 0;
  },

  getUnresolvedConflicts(): SyncConflictRow[] {
    return database.all<SyncConflictRow>(
      'SELECT * FROM sync_conflicts WHERE resolution IS NULL ORDER BY created_at DESC',
    );
  },

  resolveConflict(id: number, resolution: string): void {
    database.run(
      `UPDATE sync_conflicts SET resolution = ?, resolved_at = datetime('now') WHERE id = ?`,
      [resolution, id],
    );
  },

  /**
   * Reset a rejected log entry back to pending for retry.
   */
  retryRejectedEntry(logEntryId: number): void {
    database.run(
      `UPDATE local_sync_log SET status = 'pending', rejection_code = NULL, rejection_detail = NULL WHERE id = ?`,
      [logEntryId],
    );
  },
};
