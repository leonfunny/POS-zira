import { getConfigValue, getSecureAuthToken } from '../config/store';
import logger from '../logger';
import { posEventOutboxRepo } from '../database/repos/pos-event-outbox-repo';
import { apiClient } from '../network/api-client';

const BATCH_SIZE = 50; // backend ArrayMaxSize(50)
const MAX_BATCHES_PER_RUN = 20; // bound a single drain (≤1000 events/cycle)
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const DEAD_LETTER_AFTER_ATTEMPTS = 25; // only for per-event rejections, never network

export interface PosEventSyncStatus {
  pending: number;
  deadLetter: number;
  oldestPendingAt: string | null;
  lastUploadAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
}

function backoffIso(attemptsAfter: number, now: number): string {
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attemptsAfter - 1));
  const jitter = Math.floor(delay * 0.2 * Math.random());
  return new Date(now + delay + jitter).toISOString();
}

export class PosEventUploader {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRunAt: string | null = null;
  private lastUploadAt: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly isOnline: () => boolean = () => true) {}

  startPeriodicSync(intervalMs = 20_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, intervalMs);
    // Kick once shortly after boot so a backlog drains without waiting a full tick.
    setTimeout(() => void this.flush(), 4_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(): PosEventSyncStatus {
    return {
      pending: posEventOutboxRepo.countPending(),
      deadLetter: posEventOutboxRepo.countDeadLetter(),
      oldestPendingAt: posEventOutboxRepo.oldestPendingAt(),
      lastUploadAt: this.lastUploadAt ?? posEventOutboxRepo.lastAckedAt(),
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
    };
  }

  /** Drain ready outbox rows to the backend. Safe to call concurrently (guarded). */
  async flush(): Promise<{ acked: number; failed: number }> {
    if (this.running) return { acked: 0, failed: 0 };
    this.running = true;
    this.lastRunAt = new Date().toISOString();
    let acked = 0;
    let failed = 0;
    try {
      const token = getSecureAuthToken();
      if (!token) return { acked, failed }; // not logged in → nothing to do
      if (!this.isOnline()) return { acked, failed }; // offline → keep buffering
      const deviceId = (getConfigValue('machineId') as string | undefined) || null;

      for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
        const rows = posEventOutboxRepo.listReady(BATCH_SIZE, new Date().toISOString());
        if (rows.length === 0) break;

        const sentAt = new Date().toISOString();
        const events = rows.map((r) => ({ ...posEventOutboxRepo.toEnvelope(r), sentAt }));

        let result;
        try {
          result = await apiClient.postPosEvents(token, { deviceId, events });
        } catch (err) {
          // Whole-batch transport/HTTP failure → transient. Backoff every row,
          // never dead-letter, stop this run (likely offline / server down).
          const msg = err instanceof Error ? err.message : String(err);
          this.lastError = msg;
          const now = Date.now();
          for (const r of rows) {
            posEventOutboxRepo.markFailed(r.event_id, msg, backoffIso(r.attempts + 1, now), false);
            failed++;
          }
          logger.warn(`[PosEventUploader] batch upload failed (${rows.length} events): ${msg}`);
          break;
        }

        const ackable = new Map<string, string | null>();
        for (const a of result.accepted || []) ackable.set(a.eventId, a.serverEventId ?? null);
        for (const d of result.duplicates || []) ackable.set(d.eventId, d.serverEventId ?? null);

        for (const r of rows) {
          if (ackable.has(r.event_id)) {
            posEventOutboxRepo.markAcked(r.event_id, ackable.get(r.event_id) ?? null);
            acked++;
          }
        }

        const now = Date.now();
        for (const rej of result.rejected || []) {
          const row = rows.find((r) => r.event_id === rej.eventId);
          if (!row) continue;
          const dead = row.attempts + 1 >= DEAD_LETTER_AFTER_ATTEMPTS;
          posEventOutboxRepo.markFailed(
            row.event_id,
            `${rej.errorCode}: ${rej.message}`,
            backoffIso(row.attempts + 1, now),
            dead,
          );
          failed++;
          if (dead) {
            logger.warn(`[PosEventUploader] dead-lettered event ${row.event_id} (${row.event_type}) after ${row.attempts + 1} rejects: ${rej.errorCode}`);
          }
        }

        if (acked > 0) {
          this.lastUploadAt = new Date().toISOString();
          this.lastError = null;
        }
        // If nothing acked this batch (all rejected/failed), avoid a tight loop.
        if (rows.length > 0 && acked === 0 && failed >= rows.length) break;
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.warn(`[PosEventUploader] flush error: ${this.lastError}`);
    } finally {
      this.running = false;
    }
    return { acked, failed };
  }
}
