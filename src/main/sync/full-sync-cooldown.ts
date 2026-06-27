import { database } from '../database/database';

/**
 * Rate-limit guard for expensive full (no-`since`) catalog sweeps.
 *
 * A flapping Socket.IO connection — or repeated app restarts — otherwise
 * triggers a full sweep on every (re)connect: the product sweep re-pulls the
 * whole catalogue and the draft sweep re-pulls every draft_product row. Under
 * backend overload this feeds a vicious loop (overload → socket drop →
 * reconnect → full sweep → more load). We stamp the last full-sweep time per
 * stream in `sync_metadata` and refuse another within the cooldown window.
 *
 * This only suppresses *redundant* sweeps: callers still fall back to a full
 * sweep whenever the local mirror is actually empty, so the cooldown can never
 * leave the cashier with no catalogue.
 */
export const FULL_SYNC_COOLDOWN_MS = 15 * 60 * 1000;

function metadataKey(stream: string): string {
  return `${stream}_last_full_sync`;
}

/** True if a full sweep for `stream` completed within `cooldownMs`. */
export function fullSyncOnCooldown(
  stream: string,
  cooldownMs: number = FULL_SYNC_COOLDOWN_MS,
): boolean {
  const row = database.get<{ value: string }>(
    'SELECT value FROM sync_metadata WHERE key = ?',
    [metadataKey(stream)],
  );
  if (!row?.value) return false;
  const last = Date.parse(row.value);
  if (!Number.isFinite(last)) return false;
  return Date.now() - last < cooldownMs;
}

/** Record that a full sweep for `stream` just completed. */
export function markFullSync(stream: string): void {
  database.run(
    "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    [metadataKey(stream), new Date().toISOString()],
  );
}
