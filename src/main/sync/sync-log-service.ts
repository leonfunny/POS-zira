/**
 * SyncLogService — Core engine for Path B log-based bidirectional sync.
 *
 * Manages:
 * - Pull: GET /sync/pull?after=N → apply inbound entries to local DB
 * - Push: POST /sync/push → batch outbound entries to server
 * - Real-time: sync:entry socket event → apply single entry
 * - Conflicts: detect, store, and expose for cashier resolution
 * - Mode detection: auto-detect server capability on connect
 *
 * Coexists with Path A services. sync_mode controls which code paths are active.
 */

import { randomUUID } from 'crypto';
import { apiClient } from '../network/api-client';
import { database } from '../database/database';
import { getSecureAuthToken, getConfigValue } from '../config/store';
import { syncLogRepo, type LocalSyncLogRow, type SyncConflictRow } from './sync-log-repo';
import { applyEntry, type SyncLogEntry } from './entity-applicators';
import logger from '../logger';

// ─── Sync modes (progressive upgrade, never auto-downgrade) ─

export const SYNC_MODES = {
  PATH_A: 'path_a',          // Legacy: per-entity endpoints
  PATH_B_PULL: 'path_b_pull', // Pull via /sync/pull, push via legacy
  PATH_B_PUSH: 'path_b_push', // Pull + Push via /sync/push
  PATH_B_FULL: 'path_b_full', // Full bidirectional + real-time sync:entry
} as const;

export type SyncMode = typeof SYNC_MODES[keyof typeof SYNC_MODES];

// Mode ordering for comparisons
const MODE_ORDER: Record<string, number> = {
  [SYNC_MODES.PATH_A]: 0,
  [SYNC_MODES.PATH_B_PULL]: 1,
  [SYNC_MODES.PATH_B_PUSH]: 2,
  [SYNC_MODES.PATH_B_FULL]: 3,
};

export class SyncLogService {
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private pushTimer: ReturnType<typeof setInterval> | null = null;
  private agentSource: string;

  constructor() {
    // Set agent source from config (pos:<agentId>)
    const agentId = getConfigValue('agentId') as string | undefined;
    this.agentSource = `pos:${agentId || 'unknown'}`;

    // Persist agent source for reference
    syncLogRepo.setAgentSource(this.agentSource);

    // Crash recovery: revert any entries stuck in 'pushing' state
    const reverted = syncLogRepo.revertPushingToPending();
    if (reverted > 0) {
      logger.info(`[SyncLog] Crash recovery: reverted ${reverted} pushing → pending entries`);
    }
  }

  // ─── Mode management ──────────────────────────────────────

  getSyncMode(): SyncMode {
    return (syncLogRepo.getSyncMode() as SyncMode) || SYNC_MODES.PATH_A;
  }

  /**
   * Upgrade sync mode (never downgrade automatically).
   */
  upgradeSyncMode(newMode: SyncMode): void {
    const current = this.getSyncMode();
    if ((MODE_ORDER[newMode] ?? 0) > (MODE_ORDER[current] ?? 0)) {
      syncLogRepo.setSyncMode(newMode);
      logger.info(`[SyncLog] Mode upgraded: ${current} → ${newMode}`);
    }
  }

  /**
   * Check if current mode is at least the given level.
   */
  isModeAtLeast(mode: SyncMode): boolean {
    return (MODE_ORDER[this.getSyncMode()] ?? 0) >= (MODE_ORDER[mode] ?? 0);
  }

  /**
   * Force mode (for manual override / fallback).
   */
  forceMode(mode: SyncMode): void {
    syncLogRepo.setSyncMode(mode);
    logger.info(`[SyncLog] Mode forced to: ${mode}`);
  }

  // ─── Server capability detection ─────────────────────────

  /**
   * Detect which Path B endpoints the server supports.
   * Called on socket:connected. Returns { pull, push }.
   */
  async detectServerCapability(): Promise<{ pull: boolean; push: boolean }> {
    const token = getSecureAuthToken();
    if (!token) return { pull: false, push: false };

    const result = { pull: false, push: false };

    try {
      // Test pull endpoint with a minimal request
      const pullResult = await apiClient.syncPull(token, 0, undefined, 1);
      result.pull = pullResult !== null;
    } catch (err: any) {
      logger.debug(`[SyncLog] Pull endpoint detection failed: ${err.message}`);
    }

    try {
      // Test push endpoint with empty batch
      const pushResult = await apiClient.syncPush(token, []);
      result.push = pushResult !== null;
    } catch (err: any) {
      // If server says "entries required" or "non-empty", the endpoint EXISTS —
      // it just rejects empty arrays. That's a valid push endpoint.
      const msg = err.message || '';
      if (msg.includes('entries') || msg.includes('non-empty') || msg.includes('required')) {
        result.push = true;
        logger.debug(`[SyncLog] Push endpoint exists (rejects empty batch, as expected)`);
      } else {
        logger.debug(`[SyncLog] Push endpoint detection failed: ${msg}`);
      }
    }

    logger.info(`[SyncLog] Server capability: pull=${result.pull}, push=${result.push}`);
    return result;
  }

  // ─── Pull from server ────────────────────────────────────

  /**
   * Pull all new entries from server since last_server_seq.
   * Handles pagination (loops until hasMore=false).
   */
  async pullFromServer(): Promise<number> {
    const token = getSecureAuthToken();
    if (!token) return 0;

    let totalApplied = 0;
    let after = syncLogRepo.getLastServerSeq();

    while (true) {
      const result = await apiClient.syncPull(token, after);

      if (result === null) {
        // Server doesn't support pull — fallback
        if (this.isModeAtLeast(SYNC_MODES.PATH_B_PULL)) {
          logger.warn('[SyncLog] Pull endpoint returned null — server may have rolled back');
        }
        break;
      }

      if (!result.entries || result.entries.length === 0) break;

      const applied = database.transaction(() => {
        let count = 0;
        for (const raw of result.entries) {
          // Normalize camelCase ↔ snake_case — server sends camelCase
          const entry = {
            seq: parseInt(raw.seq ?? raw.id, 10),
            entity_type: raw.entity_type || raw.entityType,
            entity_id: raw.entity_id || raw.entityId,
            event: raw.event || 'updated',
            payload: raw.payload,
            source: raw.source || 'server',
            source_tx: raw.source_tx || raw.sourceTx || `server-${raw.seq ?? raw.id}`,
            created_at: raw.created_at || raw.createdAt || new Date().toISOString(),
          };

          // Guard: skip malformed entries
          if (!entry.seq || !entry.entity_type || !entry.entity_id) {
            logger.warn(`[SyncLog] Skipping malformed entry: seq=${raw.seq} type=${raw.entityType || raw.entity_type}`);
            continue;
          }

          const sourceTx = entry.source_tx;
          const source = entry.source;
          const createdAt = entry.created_at;

          // Echo suppression: skip entries from this agent
          if (source === this.agentSource) {
            syncLogRepo.setLastServerSeq(entry.seq);
            continue;
          }

          // Dedup: skip entries we already have
          if (syncLogRepo.hasSourceTx(sourceTx)) {
            syncLogRepo.setLastServerSeq(entry.seq);
            continue;
          }

          // Parse payload
          const rawPayload = entry.payload ?? {};
          const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
          const payloadStr = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);

          // Apply to local database
          const applied = applyEntry({
            seq: entry.seq,
            entity_type: entry.entity_type,
            entity_id: entry.entity_id,
            event: entry.event || 'updated',
            payload,
            source,
            source_tx: sourceTx,
            created_at: createdAt,
          });

          // Record in local log for audit trail
          syncLogRepo.insertAcceptedEntry({
            source_tx: sourceTx,
            entity_type: entry.entity_type,
            entity_id: entry.entity_id,
            event: entry.event || 'updated',
            payload: payloadStr,
            source,
            server_seq: entry.seq,
          });

          if (applied) count++;
          syncLogRepo.setLastServerSeq(entry.seq);
        }
        return count;
      });

      database.save();
      totalApplied += applied;
      after = syncLogRepo.getLastServerSeq();

      // Pagination: continue if server indicates more entries
      if (!result.hasMore) break;
    }

    if (totalApplied > 0) {
      logger.info(`[SyncLog] Pulled and applied ${totalApplied} entries (cursor now at seq=${syncLogRepo.getLastServerSeq()})`);
    }

    // Periodic pruning (piggyback on pull cycle)
    const pruned = syncLogRepo.pruneAccepted(7);
    if (pruned > 0) {
      logger.debug(`[SyncLog] Pruned ${pruned} old accepted entries`);
    }

    return totalApplied;
  }

  // ─── Push to server ──────────────────────────────────────

  /**
   * Push all pending local entries to server in batches of 50.
   * Handles accept/reject per entry. Creates conflicts for rejections.
   */
  async pushToServer(): Promise<{ accepted: number; rejected: number }> {
    const token = getSecureAuthToken();
    if (!token) return { accepted: 0, rejected: 0 };

    let totalAccepted = 0;
    let totalRejected = 0;

    // Loop until all pending entries are pushed
    while (true) {
      const pending = syncLogRepo.getPending(50);
      if (pending.length === 0) break;

      const ids = pending.map(e => e.id);
      syncLogRepo.markPushing(ids);
      database.save();

      try {
        const pushEntries = pending.map(e => ({
          source_tx: e.source_tx,
          entity_type: e.entity_type,
          entity_id: e.entity_id,
          event: e.event,
          payload: JSON.parse(e.payload),
        }));

        const result = await apiClient.syncPush(token, pushEntries);

        if (result === null) {
          // Server doesn't support push yet — revert to pending
          syncLogRepo.revertPushingToPending();
          database.save();
          logger.warn('[SyncLog] Push endpoint returned null — reverting to pending');
          break;
        }

        // Process results
        database.transaction(() => {
          for (const r of result.results) {
            const entry = pending.find(e => e.source_tx === r.source_tx);
            if (!entry) continue;

            if (r.accepted) {
              syncLogRepo.markAccepted(entry.id, r.seq!);
              totalAccepted++;

              // Path A parity: when the server accepts an order/created
              // entry pushed by THIS agent, the local `orders` row is
              // still synced=0 / backend_id=null because echo sync_log
              // suppression skips entries from this agent on pull. Mirror
              // the side effects here so the refund gate
              // (!order.backend_id) clears and the cashier sees the
              // sale as synced. Prefer a backend-supplied canonical id
              // when present (entity_id / entityId / backendId /
              // orderId) — otherwise fall back to the local entry's
              // entity_id, which is the same UUID the client
              // generated.
              if (
                entry.entity_type === 'order' &&
                entry.event === 'created'
              ) {
                const ra = r as Record<string, unknown>;
                const backendId =
                  (typeof ra.entity_id === 'string' && ra.entity_id) ||
                  (typeof ra.entityId === 'string' && ra.entityId) ||
                  (typeof ra.backendId === 'string' && ra.backendId) ||
                  (typeof ra.orderId === 'string' && ra.orderId) ||
                  entry.entity_id;
                database.run(
                  `UPDATE orders
                   SET synced = 1,
                       backend_id = ?,
                       synced_at = datetime('now'),
                       sync_error = NULL
                   WHERE id = ?`,
                  [backendId, entry.entity_id],
                );
              }
            } else {
              syncLogRepo.markRejected(entry.id, r.code || 'UNKNOWN', r.detail || '');
              totalRejected++;

              // Create conflict for cashier if it's actionable
              if (r.code !== 'DUPLICATE') {
                syncLogRepo.insertConflict({
                  log_entry_id: entry.id,
                  conflict_type: r.code || 'UNKNOWN',
                  entity_type: entry.entity_type,
                  entity_id: entry.entity_id,
                  detail: r.detail,
                });
              }
            }
          }
        });
        database.save();

      } catch (err: any) {
        // Network error — revert to pending for retry
        syncLogRepo.revertPushingToPending();
        database.save();
        logger.warn(`[SyncLog] Push failed: ${err.message} — entries reverted to pending`);
        break;
      }
    }

    if (totalAccepted > 0 || totalRejected > 0) {
      logger.info(`[SyncLog] Push results: ${totalAccepted} accepted, ${totalRejected} rejected`);
    }

    return { accepted: totalAccepted, rejected: totalRejected };
  }

  // ─── Real-time entry processing ──────────────────────────

  /**
   * Process a single real-time sync:entry from socket.
   * Handles echo suppression, gap detection, and dedup.
   */
  async processRealtimeEntry(raw: any): Promise<void> {
    // Normalize camelCase ↔ snake_case
    const entry = {
      seq: parseInt(raw.seq ?? raw.id, 10),
      entity_type: raw.entity_type || raw.entityType,
      entity_id: raw.entity_id || raw.entityId,
      event: raw.event || 'updated',
      payload: raw.payload,
      source: raw.source || 'server',
      source_tx: raw.source_tx || raw.sourceTx || `server-${raw.seq ?? raw.id}`,
      created_at: raw.created_at || raw.createdAt || new Date().toISOString(),
    };

    if (!entry.seq || !entry.entity_type || !entry.entity_id) return;

    const sourceTx = entry.source_tx;
    const source = entry.source;
    const createdAt = entry.created_at;

    // Echo suppression
    if (source === this.agentSource) return;

    const lastSeq = syncLogRepo.getLastServerSeq();

    // Gap detection: if we missed entries, do a full pull
    if (entry.seq > lastSeq + 1) {
      logger.info(`[SyncLog] Seq gap detected: have ${lastSeq}, received ${entry.seq}. Triggering pull...`);
      await this.pullFromServer();
      return;
    }

    // Already processed
    if (entry.seq <= lastSeq) return;

    // Dedup
    if (syncLogRepo.hasSourceTx(sourceTx)) return;

    // Parse payload
    const rawPayload = entry.payload ?? {};
    const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
    const payloadStr = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);

    // Apply to local DB
    applyEntry({
      seq: entry.seq,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      event: entry.event || 'updated',
      payload,
      source,
      source_tx: sourceTx,
      created_at: createdAt,
    });

    // Record in local log
    syncLogRepo.insertAcceptedEntry({
      source_tx: sourceTx,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      event: entry.event || 'updated',
      payload: payloadStr,
      source,
      server_seq: entry.seq,
    });

    syncLogRepo.setLastServerSeq(entry.seq);
    database.save();

    logger.debug(`[SyncLog] Applied real-time entry: ${entry.entity_type}/${entry.event} seq=${entry.seq}`);
  }

  // ─── Write local entry (for outbound mutations) ──────────

  /**
   * Write a local sync log entry for a POS mutation.
   * Returns the source_tx UUID for tracking.
   */
  writeLocalEntry(entityType: string, entityId: string, event: string, payload: any): string {
    const sourceTx = randomUUID();

    syncLogRepo.insertEntry({
      source_tx: sourceTx,
      entity_type: entityType,
      entity_id: entityId,
      event,
      payload: JSON.stringify(payload),
      source: this.agentSource,
    });

    logger.debug(`[SyncLog] Wrote local entry: ${entityType}/${event} id=${entityId} tx=${sourceTx.substring(0, 8)}`);
    return sourceTx;
  }

  // ─── Conflict management ─────────────────────────────────

  getUnresolvedConflicts(): SyncConflictRow[] {
    return syncLogRepo.getUnresolvedConflicts();
  }

  resolveConflict(conflictId: number, resolution: string, adjustments?: any): void {
    syncLogRepo.resolveConflict(conflictId, resolution);

    if (resolution === 'retried') {
      // Find the log entry and reset to pending
      const conflicts = syncLogRepo.getUnresolvedConflicts();
      const conflict = conflicts.find(c => c.id === conflictId);
      if (conflict) {
        syncLogRepo.retryRejectedEntry(conflict.log_entry_id);
      }
    }

    logger.info(`[SyncLog] Conflict ${conflictId} resolved: ${resolution}`);
  }

  // ─── Lifecycle ────────────────────────────────────────────

  /**
   * Start periodic pull (15s interval).
   */
  startPeriodicPull(): void {
    if (this.pullTimer) return;
    this.pullTimer = setInterval(async () => {
      try { await this.pullFromServer(); } catch (err: any) {
        logger.debug(`[SyncLog] Periodic pull error: ${err.message}`);
      }
    }, 15_000);
    logger.info('[SyncLog] Started periodic pull (15s interval)');
  }

  /**
   * Start periodic push (10s interval).
   */
  startPeriodicPush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setInterval(async () => {
      try { await this.pushToServer(); } catch (err: any) {
        logger.debug(`[SyncLog] Periodic push error: ${err.message}`);
      }
    }, 10_000);
    logger.info('[SyncLog] Started periodic push (10s interval)');
  }

  /**
   * Stop all timers.
   */
  stop(): void {
    if (this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
    }
    logger.info('[SyncLog] Stopped all sync timers');
  }
}
