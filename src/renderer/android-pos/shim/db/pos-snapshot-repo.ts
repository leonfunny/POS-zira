/**
 * Crash-survival snapshot storage for the Android POS shim.
 *
 * The authoritative cart lives in ShimPosStore (memory). On Windows that is
 * safe — Electron has no back button and the OS does not reclaim the process
 * mid-sale. On Android both happen, so the cart is serialized here after every
 * change and rehydrated on the next boot.
 *
 * It shares the SQLite image with orders and shifts on purpose: one durability
 * barrier (AndroidDatabase.flush) covers both, and clearSalonData() wipes the
 * snapshot with everything else so a cart can never cross a tenant switch.
 */

import type { AndroidDatabase } from './db';

/** Logical key for the in-progress cart snapshot. */
export const POS_SNAPSHOT_CART_KEY = 'cart';

export interface PosSnapshotRepo {
  /** Upsert the serialized snapshot under `key`. */
  save(key: string, json: string): void;
  /** The stored snapshot, or null when absent. */
  load(key: string): string | null;
  /** Drop the snapshot (checkout completed, logout, tenant switch). */
  clear(key: string): void;
}

export function createPosSnapshotRepo(db: AndroidDatabase): PosSnapshotRepo {
  return {
    save(key, json) {
      db.run(
        'INSERT INTO pos_snapshot (key, value, updated_at) VALUES (?, ?, ?) '
        + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        [key, json, new Date().toISOString()],
      );
    },
    load(key) {
      const row = db.get<{ value: string | null }>(
        'SELECT value FROM pos_snapshot WHERE key = ?',
        [key],
      );
      return row?.value ?? null;
    },
    clear(key) {
      db.run('DELETE FROM pos_snapshot WHERE key = ?', [key]);
    },
  };
}
